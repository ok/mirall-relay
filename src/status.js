// One description of what this relay is and how it is doing, shared by every
// surface that reports it: /.well-known/mirall-relay.json, /status.json, and the
// HTML page. A second copy of the caps block would eventually disagree with the
// first, and the caps are what a client uses to decide whether to bother.
import { snapshotCounters } from './metrics.js'

// Stated plainly because it is the whole promise of a blind relay.
export const PRIVACY =
  'This relay bridges end-to-end-encrypted streams. It cannot read peer identities, space topics, file names or content.'

export function caps (cfg) {
  return {
    maxSessionsPerKey: cfg.maxSessionsPerKey,
    maxActiveLinks: cfg.maxActiveLinks,
    maxLinkBytes: cfg.maxLinkBytes,
    maxLinkRateBytesPerSecond: cfg.maxLinkRate,
    maxLinkDurationMs: cfg.maxLinkMs
  }
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
    caps: caps(cfg),
    privacy: PRIVACY
  }
}

// What the DHT believes. Kept separate from `probed` below, because
// MIRALL_RELAY_ASSUME_REACHABLE passes firewalled: false straight into the DHT
// constructor (src/relay.js) — so this reads 'reachable' whether the node measured
// its reachability or was merely told to assume it.
export function reachabilityState (relay) {
  if (relay.closing) return 'stopped'
  if (!relay.ready) return 'starting'
  if (relay.firewalled === true) return 'firewalled'
  if (relay.firewalled === false) return 'reachable'
  return 'unknown'
}

// The access block, in one place. Both surfaces that report it — the anonymous
// snapshot below and GET /admin/invites — call this, for the reason stated at the
// top of the file: a second copy eventually disagrees with the first, and the two
// pages would then differ about what mode the relay is even in.
export function accessBlock (cfg, firewall, roster) {
  return {
    // Three states, and the difference matters to an operator staring at the
    // page wondering why nobody connects: 'invite' with 0 members admits
    // nobody, and says so.
    mode: cfg.access === 'invite' ? 'invite' : (cfg.allowlist ? 'allowlist' : 'open'),
    allowlisted: firewall ? firewall.allowlisted : null,
    banned: firewall ? firewall.bannedCount : 0,
    // Counts only. Never labels: the snapshot is served to anyone who can reach
    // the admin port, and a member label is a person's name.
    members: roster ? { active: roster.active, total: roster.total } : null,
    refusedLastHour: firewall ? firewall.refusedLastHour : 0,
    // Whether /admin/ is served, so the page can offer the operator a way to
    // manage members instead of only telling them the count. A boolean about
    // configuration, not a name or a secret — the rule for this surface holds.
    managed: cfg.adminWrite !== false
  }
}

// Public status payload consumed by the server-rendered page and operators'
// scripts. Keep it anonymous: no member labels, no tickets, no seed material.
export async function statusSnapshot ({ cfg, relay, metrics, firewall, roster, version }) {
  const counters = await snapshotCounters(metrics)
  const net = relay.networkInfo()
  const bl = relay.relayStats()

  return {
    service: 'mirall-relay',
    version,
    ready: relay.ready,
    startedAt: relay.startedAt ? new Date(relay.startedAt).toISOString() : null,
    uptimeSeconds: relay.startedAt ? Math.round((Date.now() - relay.startedAt) / 1000) : 0,
    labels: { region: cfg.region, operator: cfg.operator },
    identity: {
      publicKey: relay.publicKeyZ32,
      // The seed itself never appears here. Where it came from does: an operator
      // whose seed says 'file' at a path inside a container with no volume is one
      // container replacement away from stranding every client, and OPERATIONS.md
      // names that as one of the two ways an identity is lost by accident.
      seedFrom: relay.seedSource.from,
      seedPath: relay.seedSource.path,
      seedCreated: !!relay.seedSource.created
    },
    reachability: {
      state: reachabilityState(relay),
      firewalled: relay.firewalled,
      probed: !cfg.assumeReachable,
      port: cfg.port,
      bindHost: cfg.host,
      publicHost: net.host,
      publicPort: net.port,
      portRandomized: net.randomized,
      bootstrapped: net.bootstrapped,
      // hyperdht's adaptive mode keeps a firewalled node ephemeral whatever the
      // operator asked for, so the observed state and the configured one are two
      // different facts. Only the configured one is anybody's mistake.
      ephemeral: net.ephemeral,
      ephemeralConfigured: !!cfg.ephemeral,
      inRoutingTable: !net.ephemeral,
      dhtNodes: net.nodes,
      bound: net.address
    },
    traffic: {
      bytesRelayed: counters.bytesRelayed,
      linksActive: counters.linksActive,
      linksOpened: counters.linksOpened,
      linksTornByCap: counters.linksTornByCap,
      linksTornByCapTotal: counters.linksTornByCapTotal,
      sessionsAccepted: counters.sessionsAccepted,
      sessionsRejected: counters.sessionsRejected,
      sessionsRejectedTotal: counters.sessionsRejectedTotal,
      pairings: bl ? { ...bl.pairings } : null,
      sessions: bl ? { accepted: bl.sessions.accepted, active: bl.sessions.active } : null
    },
    caps: caps(cfg),
    access: accessBlock(cfg, firewall, roster),
    privacy: PRIVACY
  }
}
