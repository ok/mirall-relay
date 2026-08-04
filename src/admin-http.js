// Operator surface. Bound to 127.0.0.1 by default — it exposes the relay's
// internals and must never face the public internet. Scrape it from a Prometheus
// sidecar or over an SSH tunnel.
//
//   GET /healthz                        process is up
//   GET /readyz                         listening + bootstrapped + not firewalled
//   GET /metrics                        Prometheus text
//   GET /.well-known/mirall-relay.json  capability doc (public key, region, caps)
import http from 'node:http'
import { mirrorRelayStats } from './metrics.js'

function json (res, status, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  res.end(payload)
}

export function capabilityDoc (cfg, relay) {
  return {
    service: 'mirall-relay',
    version: relay.version,
    protocol: 'blind-relay',
    relayThrough: true,
    publicKey: relay.publicKeyZ32,
    region: cfg.region,
    operator: cfg.operator,
    caps: {
      maxSessionsPerKey: cfg.maxSessionsPerKey,
      maxActiveLinks: cfg.maxActiveLinks,
      maxLinkBytes: cfg.maxLinkBytes,
      maxLinkRateBytesPerSecond: cfg.maxLinkRate,
      maxLinkDurationMs: cfg.maxLinkMs
    },
    // Stated plainly because it is the whole promise of a blind relay.
    privacy: 'This relay bridges end-to-end-encrypted streams. It cannot read peer identities, space topics, file names or content.'
  }
}

export function makeAdminServer (cfg, { metrics, relay, logger }) {
  const server = http.createServer(async (req, res) => {
    // Everything here is a read; anything else is a misdirected request.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' })
    }

    const path = (req.url || '').split('?')[0]

    try {
      switch (path) {
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
          res.writeHead(200, { 'content-type': metrics.registry.contentType })
          return res.end(body)
        }

        default:
          return json(res, 404, { error: 'not found' })
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
          logger?.info({ host: cfg.adminHost, port: cfg.adminPort }, 'admin http listening')
          resolve(server.address())
        })
      })
    },
    close () {
      return new Promise((resolve) => server.close(resolve))
    }
  }
}
