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
// Everything here is still a read. There is deliberately no "test reachability"
// button: scripts/probe.js stands up two throwaway DHT nodes, and putting that
// behind an unauthenticated port turns a diagnostic surface into one that can be
// made to do work.
import http from 'node:http'
import net from 'node:net'
import { mirrorRelayStats } from './metrics.js'
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

export function makeAdminServer (cfg, { metrics, relay, firewall, logger }) {
  // The square only changes when the identity does, which is never.
  let qrCache = null
  function qrFor (publicKey) {
    if (!qrCache || qrCache.key !== publicKey) {
      const body = standaloneQr(publicKey)
      qrCache = { key: publicKey, body, etag: etagFor(body) }
    }
    return qrCache
  }

  const snapshot = () => statusSnapshot({ cfg, relay, metrics, firewall, version: relay.version })

  const server = http.createServer(async (req, res) => {
    // Everything here is a read; anything else is a misdirected request.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' })
    }

    const path = (req.url || '').split('?')[0]
    const ui = cfg.adminUi !== false

    if (uiPaths.has(path) && !hostAllowed(cfg, req.headers.host)) {
      logger?.warn(
        { host: req.headers.host, path },
        'refused a request whose Host is neither loopback nor in MIRALL_RELAY_ADMIN_ALLOWED_HOSTS'
      )
      return json(res, 403, {
        error: 'host not allowed',
        hint: 'add this Host to MIRALL_RELAY_ADMIN_ALLOWED_HOSTS if it is a proxy you run'
      })
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
            publicKey: relay.publicKeyZ32
          })
        }

        case '/.well-known/mirall-relay.json':
          return json(res, 200, capabilityDoc(cfg, relay))

        case '/metrics': {
          mirrorRelayStats(metrics, relay.relayStats())
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
