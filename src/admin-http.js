// Operator surface. Bound to 127.0.0.1 by default — it exposes the relay's
// internals and must never face the public internet. Scrape it from a Prometheus
// sidecar or over an SSH tunnel.
//
//   GET /                               status page (HTML)
//   GET /status.json                    everything the page shows, as data
//   GET /qr.svg                         the public key as a scannable square
//   GET /ui.css /ui.js /format.js       the page's assets
//   GET /healthz                        process is up
//   GET /readyz                         listening + bootstrapped + not firewalled
//   GET /metrics                        Prometheus text
//   GET /.well-known/mirall-relay.json  capability doc (public key, region, caps)
//
// Every one of those is anonymous and a read. There is deliberately no "test
// reachability" button: scripts/probe.js stands up two throwaway DHT nodes, and
// putting that behind an unauthenticated port turns a diagnostic surface into
// one that can be made to do work.
//
// /admin/* is the one exception and is kept strictly apart from the above:
// minting an invite is a write THAT EMITS A SECRET, so it takes a bearer token.
// The rule for the split is that the anonymous page shows numbers, never names
// or secrets — member labels and tickets exist only behind the token.
import http from 'node:http'
import net from 'node:net'
import b4a from 'b4a'
import idEnc from 'hypercore-id-encoding'
import { decodeKeyOrThrow } from './config.js'
import { mirrorMembers, mirrorRelayStats } from './metrics.js'
import { capabilityDoc, statusSnapshot } from './status.js'
import { loadAssets, uiPaths, etagFor, renderPage, standaloneQr } from './admin-ui.js'

export { capabilityDoc }

// Achievable only because the page has no inline script, no inline style and no
// external resource — which is why ui.css and ui.js are files rather than being
// embedded in the template. Sent on every response, not just the HTML one: a
// policy that only covers the document leaves /qr.svg and /status.json ungoverned
// when they are opened directly.
const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

const BASE_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin'
}

// A page on the internet can point its own hostname at 127.0.0.1 and read this
// port out of the operator's browser. Validating Host is the standard answer, but
// a fixed allowlist would break every reverse proxy — which is how Umbrel and
// StartOS serve this port. So the check runs only where it cannot break anything:
// a loopback bind, where nothing but loopback reaches us directly and a rebinding
// request necessarily carries the DNS NAME the browser resolved. An IP literal is
// always fine — there is nothing to rebind.
//
// SCOPE: only the routes this feature added. /healthz, /readyz, /metrics and the
// capability doc are pre-existing machine endpoints that deployments already
// address by hostname (a Prometheus target, an /etc/hosts alias, an SSH-tunnel
// name), and silently 403ing them on upgrade would take monitoring down while
// looking like a network fault.
function normalizeHost (value) {
  let name = String(value).trim()
  if (name.startsWith('[')) {
    const end = name.indexOf(']')
    name = end === -1 ? name.slice(1) : name.slice(1, end)
  } else if ((name.match(/:/g) || []).length === 1) {
    name = name.slice(0, name.lastIndexOf(':'))
  }
  return name.replace(/\.$/, '').toLowerCase()
}

function isLoopback (value) {
  const name = normalizeHost(value)
  if (name === 'localhost' || name === '::1') return true
  if (name.startsWith('::ffff:')) return isLoopback(name.slice(7))
  return net.isIPv4(name) && name.startsWith('127.')
}

// Naming hosts is an explicit request for the guard, whatever the bind — which is
// the only way to get it on a container that binds 0.0.0.0 behind a published
// loopback port.
export function guardsHost (cfg) {
  return isLoopback(cfg.adminHost) || !!cfg.adminAllowedHosts
}

export function hostAllowed (cfg, host) {
  if (!guardsHost(cfg)) return true
  // An HTTP/1.0 client sends no Host at all. `Host:` with an empty value is a
  // different thing entirely — Node rejects a MISSING one on HTTP/1.1 with 400,
  // so a blank string only ever arrives from someone who chose to send it.
  if (host === undefined || host === null) return true
  const name = normalizeHost(host)
  if (!name) return false
  if (isLoopback(name) || net.isIP(name) !== 0) return true
  return !!cfg.adminAllowedHosts && cfg.adminAllowedHosts.some((allowed) => normalizeHost(allowed) === name)
}

function send (res, status, body, type, extra = {}) {
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    ...extra
  })
  res.end(body)
}

function json (res, status, body) {
  send(res, status, JSON.stringify(body, null, 2), 'application/json; charset=utf-8', { 'cache-control': 'no-store' })
}

function notFound (res) {
  return json(res, 404, { error: 'not found' })
}

function cached (req, res, body, type, etag) {
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...BASE_HEADERS, etag })
    return res.end()
  }
  return send(res, 200, body, type, { etag, 'cache-control': 'no-cache' })
}

// Small on purpose: every body this surface accepts is a label or a key.
const MAX_BODY = 4096

function readJson (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let done = false
    const chunks = []
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > MAX_BODY) {
        done = true
        // Stop reading, but do NOT destroy the request: the response shares that
        // socket, and destroying it turns a 413 into a connection reset the
        // client can only report as "fetch failed".
        req.pause()
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('body is not JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// A ttlMs that is present but not a positive finite number would fall through
// firewall.ban's `ttlMs > 0` test and become a PERMANENT ban, which is not what
// anyone who typed "1h" or sent a 0 meant — and the only way back is a DELETE.
function banTtl (value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error('ttlMs must be a positive number of milliseconds'), { status: 400 })
  }
  return value
}

// The same normalisation the firewall does at its top: z-base-32 or hex in,
// 32-byte hex out, throwing on anything else. decodeKeyOrThrow's error carries
// no code, and an unparsable key from a client is a 400 rather than the 500 the
// status ladder would otherwise give it.
function hexOfKey (value) {
  try {
    return b4a.toString(decodeKeyOrThrow(value), 'hex')
  } catch (err) {
    throw Object.assign(err, { status: 400 })
  }
}

export function makeAdminServer (cfg, { metrics, relay, firewall, roster, meter, auth, logger }) {
  // The square only changes when the identity does, which is never.
  let qrCache = null
  function qrFor (publicKey) {
    if (!qrCache || qrCache.key !== publicKey) {
      const body = standaloneQr(publicKey)
      qrCache = { key: publicKey, body, etag: etagFor(body) }
    }
    return qrCache
  }

  const snapshot = () => statusSnapshot({ cfg, relay, metrics, firewall, roster, version: relay.version })

  // Every route behind the token. Reached only after the auth check below, so
  // nothing here re-tests it.
  async function adminRoute (req, res, path) {
    const [, , resource, ...rest] = path.split('/') // '', 'admin', <resource>, <id...>
    const reveal = /[?&]reveal=1(&|$)/.test(req.url || '')

    try {
      // Inside the try: decodeURIComponent throws URIError on a malformed escape
      // like %zz, and outside it that rejection escaped the handler entirely —
      // no response was ever written and the socket was pinned for good.
      const id = rest.length ? decodeURIComponent(rest.join('/')) : null

      // A ticket names the relay's public key, so there is nothing to mint or
      // reprint until the identity exists. Same answer as /qr.svg gives.
      if (resource === 'invites' && req.method !== 'DELETE' && !relay.publicKey) {
        return json(res, 503, { error: 'no identity yet' })
      }

      if (resource === 'invites' && req.method === 'POST' && !id) {
        const { label } = await readJson(req)
        const member = roster.add(label)
        // The label is logged; the ticket and the seed never are.
        logger?.info({ label: member.label }, 'invite minted')
        return json(res, 201, {
          label: member.label,
          publicKey: member.publicKey,
          created: member.created,
          ticket: roster.ticketFor(member.label, relay.publicKey)
        })
      }

      if (resource === 'invites' && req.method === 'GET' && !id) {
        const members = roster.listPublic().map((m) => ({
          ...m,
          sessions: meter.sessionCount(hexOfKey(m.publicKey)),
          ...(reveal && !m.revoked ? { ticket: roster.ticketFor(m.label, relay.publicKey) } : {})
        }))
        return json(res, 200, { members, active: roster.active, total: roster.total })
      }

      if (resource === 'invites' && req.method === 'DELETE' && id) {
        const revoked = roster.revoke(id)
        const closed = revoked.keyHex ? relay.destroySessionsFor(revoked.keyHex) : 0
        logger?.warn({ label: revoked.label, sessions: closed }, 'invite revoked')
        return json(res, 200, { label: revoked.label, revoked: revoked.revoked, sessionsClosed: closed })
      }

      if (resource === 'bans' && req.method === 'POST' && !id) {
        const { key, ttlMs } = await readJson(req)
        const keyHex = hexOfKey(key)
        const ttl = banTtl(ttlMs)
        firewall.ban(keyHex, ttl)
        const closed = relay.destroySessionsFor(keyHex)
        return json(res, 200, {
          key: idEnc.normalize(String(key).trim()),
          // Echoed so a caller can see that it got the ban it asked for.
          permanent: ttl === null,
          ttlMs: ttl,
          sessionsClosed: closed
        })
      }

      if (resource === 'bans' && req.method === 'DELETE' && id) {
        // Its own statement: inside an argument list, idEnc.normalize(id) is
        // evaluated first and throws a code-less error, which the ladder below
        // reports as a 500 rather than the 400 a bad key deserves.
        const keyHex = hexOfKey(id)
        return json(res, 200, { key: idEnc.normalize(id), wasBanned: firewall.unban(keyHex) })
      }

      return notFound(res)
    } catch (err) {
      // A malformed roster on disk is the server's problem; every other coded
      // error came out of the caller's request.
      const BY_CODE = { duplicate: 409, 'not-found': 404, malformed: 500 }
      const status = err.status || BY_CODE[err.code] || (err.code ? 400 : 500)
      if (status >= 500) logger?.warn({ err: err.message, path }, 'admin write failed')
      return json(res, status, { error: err.code || 'internal error', message: err.message })
    }
  }

  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0]
    const ui = cfg.adminUi !== false
    const isAdmin = path === '/admin' || path.startsWith('/admin/')

    // The Host guard covers the write surface too: it is browser-reachable, and
    // a proxy that is trusted for the page is the same proxy trusted here.
    if ((uiPaths.has(path) || isAdmin) && !hostAllowed(cfg, req.headers.host)) {
      logger?.warn(
        { host: req.headers.host, path },
        'refused a request whose Host is neither loopback nor in MIRALL_RELAY_ADMIN_ALLOWED_HOSTS'
      )
      return json(res, 403, {
        error: 'host not allowed',
        hint: 'add this Host to MIRALL_RELAY_ADMIN_ALLOWED_HOSTS if it is a proxy you run'
      })
    }

    // Above the method guard, because /admin/* is the one place that legitimately
    // takes POST and DELETE.
    if (isAdmin) {
      if (!cfg.adminWrite || !auth) return notFound(res)
      if (!auth.check(req.headers.authorization)) {
        res.setHeader('www-authenticate', 'Bearer realm="mirall-relay"')
        return json(res, 401, { error: 'unauthorized' })
      }
      // node:http does not await this handler, so an escaping rejection would be
      // a request that never answers and a socket that is never released.
      return adminRoute(req, res, path).catch((err) => {
        logger?.warn({ err: err.message, path }, 'admin request failed')
        if (!res.headersSent) json(res, 500, { error: 'internal error' })
      })
    }

    // Everything else here is a read; anything else is a misdirected request.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' })
    }

    try {
      if (ui && uiPaths.has(path)) {
        const asset = loadAssets().get(path)
        if (asset) return cached(req, res, asset.body, asset.type, asset.etag)
      }

      switch (path) {
        case '/': {
          if (!ui) return notFound(res)
          const body = renderPage(await snapshot())
          return send(res, 200, body, 'text/html; charset=utf-8', { 'cache-control': 'no-store' })
        }

        case '/status.json':
          return ui ? json(res, 200, await snapshot()) : notFound(res)

        case '/qr.svg': {
          if (!ui) return notFound(res)
          const publicKey = relay.publicKeyZ32
          if (!publicKey) return json(res, 503, { error: 'no identity yet' })
          const qr = qrFor(publicKey)
          return cached(req, res, qr.body, 'image/svg+xml; charset=utf-8', qr.etag)
        }

        case '/healthz':
          return json(res, 200, { ok: true })

        case '/readyz': {
          const firewalled = relay.firewalled
          const ok = relay.ready && firewalled === false
          return json(res, ok ? 200 : 503, {
            ready: relay.ready,
            firewalled,
            // Additive, and the point of the whole field: ASSUME_REACHABLE forces
            // `firewalled` to false, so on its own it cannot tell a verified relay
            // from one that was told to assume. Anything consuming this endpoint —
            // a platform health check, an uptime probe — needs both.
            probed: !cfg.assumeReachable,
            publicKey: relay.publicKeyZ32
          })
        }

        case '/.well-known/mirall-relay.json':
          return json(res, 200, capabilityDoc(cfg, relay))

        case '/metrics': {
          mirrorRelayStats(metrics, relay.relayStats())
          mirrorMembers(metrics, roster)
          const body = await metrics.registry.metrics()
          return send(res, 200, body, metrics.registry.contentType, { 'cache-control': 'no-store' })
        }

        default:
          return notFound(res)
      }
    } catch (err) {
      logger?.warn({ err: err.message, path }, 'admin request failed')
      return json(res, 500, { error: 'internal error' })
    }
  })

  server.on('error', (err) => logger?.error({ err: err.message }, 'admin server error'))

  return {
    server,
    listen () {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.adminPort, cfg.adminHost, () => {
          server.removeListener('error', reject)
          logger?.info({ host: cfg.adminHost, port: cfg.adminPort, ui: cfg.adminUi !== false }, 'admin http listening')
          resolve(server.address())
        })
      })
    },
    close () {
      return new Promise((resolve) => server.close(resolve))
    }
  }
}
