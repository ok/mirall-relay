// Composition root: build the whole object graph from a config, in one place, so
// `bin/` and the integration tests wire the service identically.
import fs from 'node:fs'
import { makeLogger, nullLogger } from './logger.js'
import { makeMetrics, mirrorMembers } from './metrics.js'
import { makeFirewall } from './firewall.js'
import { makeMeter } from './meter.js'
import { makeAdminServer, guardsHost } from './admin-http.js'
import { openRoster } from './roster.js'
import { loadOrCreateToken } from './admin-token.js'
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

  // Declared before the firewall because the firewall holds the live view, and
  // before the relay because a reload has to be able to reach its sessions.
  let relay = null
  const roster = openRoster(cfg, {
    watch: opts.watchRoster !== false,
    logger,
    // A member removed by ANY writer — this process's admin API, or the CLI in
    // another process — loses their live sessions here.
    onChange: (removedKeys) => {
      for (const keyHex of removedKeys) {
        const n = relay?.destroySessionsFor(keyHex) || 0
        if (n) logger.info({ key: keyHex, sessions: n }, 'closed sessions for a revoked member')
      }
    }
  })
  // relay_members_total is refreshed on scrape (src/metrics.js), not here: the
  // roster has two writers and a value copied at boot would be wrong by the
  // first `invite create`.
  mirrorMembers(metrics, roster)

  const firewall = makeFirewall(cfg, metrics, { members: roster.members })
  const meter = makeMeter(cfg, metrics, logger, firewall, {
    onBan: (keyHex) => relay?.destroySessionsFor(keyHex)
  })
  relay = new RelayNode(cfg, { logger, metrics, firewall, meter, version: VERSION })

  const auth = cfg.adminWrite ? loadOrCreateToken(cfg, logger) : null
  // `meter` is new here: GET /admin/invites reports each member's live session
  // count, which only the meter knows.
  const admin = makeAdminServer(cfg, { metrics, relay, firewall, roster, meter, auth, logger })

  // The token is the only thing in front of invite minting, ticket reveal and
  // permanent bans, and on a non-loopback bind with no named hosts the
  // DNS-rebinding guard is inert by design (it would break every platform proxy).
  // An operator who published this port broadly before upgrading had an
  // information leak; they now have a write surface, and should hear it said.
  if (cfg.adminWrite && !guardsHost(cfg)) {
    logger.warn(
      { adminHost: cfg.adminHost, adminPort: cfg.adminPort, tokenFrom: auth?.source.from },
      'the /admin/* write surface is bound off loopback with no MIRALL_RELAY_ADMIN_ALLOWED_HOSTS, so the rebinding guard is inert and the bearer token is its only protection — publish this port to loopback or a private network only, or set MIRALL_RELAY_ADMIN_WRITE=false'
    )
  }

  if (cfg.access === 'invite' && roster.active === 0) {
    logger.warn(
      { rosterFile: roster.file },
      'access is invite and the roster is empty — this relay is refusing every connection. Mint the first invite with `mirall-relay invite create <label>`'
    )
  }

  return { cfg, logger, metrics, roster, firewall, meter, relay, admin, auth }
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
  app.roster?.close()
  await app.relay.close()
}

export { RelayNode, makeMetrics, makeFirewall, makeMeter, makeAdminServer, makeLogger, openRoster }
