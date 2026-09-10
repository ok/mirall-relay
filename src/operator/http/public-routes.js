import { mirrorMembers, mirrorRelayStats } from '../../metrics.js'
import { capabilityDoc, statusSnapshot } from '../../status.js'
import { loadAssets, uiPaths, etagFor, renderPage, standaloneQr } from '../../admin-ui.js'
import { cached, json, notFound, send } from './responses.js'

export function createPublicRoutes ({ cfg, metrics, relay, firewall, roster }) {
  let qrCache = null

  function qrFor (publicKey) {
    if (!qrCache || qrCache.key !== publicKey) {
      const body = standaloneQr(publicKey)
      qrCache = { key: publicKey, body, etag: etagFor(body) }
    }
    return qrCache
  }

  const snapshot = () => statusSnapshot({ cfg, relay, metrics, firewall, roster, version: relay.version })

  return async function publicRoute (req, res, path) {
    const ui = cfg.adminUi !== false

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
  }
}
