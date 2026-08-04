// Prometheus surface. Two families:
//   relay_*        — our own accounting (sessions, links, bytes, teardowns)
//   relay_bl_*     — blind-relay's native counters, mirrored on scrape so the
//                    library's view and ours can be compared when they disagree
import client from 'prom-client'

export function makeMetrics ({ collectDefault = true } = {}) {
  const registry = new client.Registry()
  if (collectDefault) client.collectDefaultMetrics({ register: registry })

  // Every metric is scoped to THIS registry. Without an explicit `registers`,
  // prom-client also auto-registers into its process-global default registry,
  // so a second makeMetrics() in the same process throws on duplicate names —
  // which breaks tests and any future multi-instance embedding.
  const registers = [registry]

  const m = {
    sessionsAccepted: new client.Counter({
      registers,
      name: 'relay_sessions_accepted_total',
      help: 'Inbound DHT connections accepted as relay sessions'
    }),
    sessionsRejected: new client.Counter({
      registers,
      name: 'relay_sessions_rejected_total',
      help: 'Inbound connections refused, by reason',
      labelNames: ['reason']
    }),
    linksActive: new client.Gauge({
      registers,
      name: 'relay_links_active',
      help: 'Bridged raw streams currently open (two per relayed connection)'
    }),
    linksOpened: new client.Counter({
      registers,
      name: 'relay_links_opened_total',
      help: 'Bridged raw streams opened since boot'
    }),
    linksTornByCap: new client.Counter({
      registers,
      name: 'relay_links_torn_by_cap_total',
      help: 'Bridged streams destroyed for exceeding a cap, by cap',
      labelNames: ['cap']
    }),
    bytesRelayed: new client.Counter({
      registers,
      name: 'relay_bytes_relayed_total',
      help: 'Bytes observed entering bridged streams (each relayed byte counted once)'
    }),
    dhtFirewalled: new client.Gauge({
      registers,
      name: 'relay_dht_firewalled',
      help: '1 when our DHT node believes it is firewalled — a relay in this state is useless'
    }),
    ready: new client.Gauge({
      registers,
      name: 'relay_ready',
      help: '1 when the relay is listening and bootstrapped'
    }),
    // blind-relay's own counters, refreshed on scrape
    blSessions: new client.Gauge({
      registers,
      name: 'relay_bl_sessions',
      help: 'blind-relay session counters',
      labelNames: ['state']
    }),
    blPairings: new client.Gauge({
      registers,
      name: 'relay_bl_pairings',
      help: 'blind-relay pairing counters',
      labelNames: ['state']
    }),
    blStreams: new client.Gauge({
      registers,
      name: 'relay_bl_streams',
      help: 'blind-relay stream counters',
      labelNames: ['state']
    })
  }

  return { registry, m }
}

// Mirror blind-relay's `server.stats` into the registry. Called immediately
// before rendering /metrics so a scrape always reflects the live library state
// rather than whatever a timer last happened to copy.
export function mirrorRelayStats (metrics, stats) {
  if (!stats) return
  const { m } = metrics
  for (const [state, value] of Object.entries(stats.sessions)) m.blSessions.set({ state }, value)
  for (const [state, value] of Object.entries(stats.pairings)) m.blPairings.set({ state }, value)
  for (const [state, value] of Object.entries(stats.streams)) m.blStreams.set({ state }, value)
}
