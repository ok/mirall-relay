// Composition root: build the whole object graph from a config, in one place, so
// `bin/` and the integration tests wire the service identically.
import fs from 'node:fs'
import { makeLogger, nullLogger } from './logger.js'
import { makeMetrics } from './metrics.js'
import { makeFirewall } from './firewall.js'
import { makeMeter } from './meter.js'
import { makeAdminServer } from './admin-http.js'
import { RelayNode } from './relay.js'

export const VERSION = readVersion()

function readVersion () {
  try {
    const url = new URL('../package.json', import.meta.url)
    return JSON.parse(fs.readFileSync(url, 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

export function createRelay (cfg, opts = {}) {
  const logger = opts.logger || (opts.silent ? nullLogger() : makeLogger(cfg))
  // Default metrics (process CPU/heap/fds) are noise in tests and duplicate
  // registration across many instances, so tests opt out.
  const metrics = opts.metrics || makeMetrics({ collectDefault: opts.collectDefault !== false })
  const firewall = makeFirewall(cfg, metrics)
  const meter = makeMeter(cfg, metrics, logger, firewall)
  const relay = new RelayNode(cfg, { logger, metrics, firewall, meter, version: VERSION })
  const admin = makeAdminServer(cfg, { metrics, relay, logger })

  return { cfg, logger, metrics, firewall, meter, relay, admin }
}

export async function startRelay (cfg, opts = {}) {
  const app = createRelay(cfg, opts)
  await app.relay.start()
  if (opts.admin !== false) await app.admin.listen()
  return app
}

export async function stopRelay (app) {
  if (!app) return
  try { await app.admin.close() } catch { /* best effort */ }
  await app.relay.close()
}

export { RelayNode, makeMetrics, makeFirewall, makeMeter, makeAdminServer, makeLogger }
