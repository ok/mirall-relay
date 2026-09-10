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
    // relay_dht_firewalled is unfalsifiable when MIRALL_RELAY_ASSUME_REACHABLE
    // forces it to 0. Alert on whether reachability was actually probed.
    reachabilityProbed: new client.Gauge({
      registers,
      name: 'relay_reachability_probed',
      help: '1 when relay_dht_firewalled came from hyperdht probing, 0 when it was asserted with MIRALL_RELAY_ASSUME_REACHABLE'
    }),
    ready: new client.Gauge({
      registers,
      name: 'relay_ready',
      help: '1 when the relay is listening and bootstrapped'
    }),
    // Counts only. A per-member label would be bounded by roster size, but a
    // member label is a person's name and /metrics is not authenticated.
    members: new client.Gauge({
      registers,
      name: 'relay_members_total',
      help: 'Members on the roster, by state — active members are the ones admitted in invite mode',
      labelNames: ['state'] // active | revoked
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

// Read our own counters back out of the registry.
//
// WHY NOT A SECOND TALLY: /metrics and the status page must never disagree about
// how many bytes this relay moved — that number is the operator's egress bill, and
// two independent accumulators would eventually differ by exactly the amount
// nobody can explain. getSingleMetric returns undefined for a name that was never
// registered, so a trimmed registry degrades to zero instead of throwing inside a
// request handler.
export async function snapshotCounters (metrics) {
  const rows = async (name) => {
    const metric = metrics?.registry.getSingleMetric(name)
    return metric ? (await metric.get()).values : []
  }
  const total = (values) => values.reduce((sum, row) => sum + row.value, 0)
  const byLabel = (values, label) => Object.fromEntries(values.map((row) => [row.labels[label], row.value]))

  const rejected = await rows('relay_sessions_rejected_total')
  const torn = await rows('relay_links_torn_by_cap_total')

  return {
    bytesRelayed: total(await rows('relay_bytes_relayed_total')),
    linksActive: total(await rows('relay_links_active')),
    linksOpened: total(await rows('relay_links_opened_total')),
    sessionsAccepted: total(await rows('relay_sessions_accepted_total')),
    sessionsRejected: byLabel(rejected, 'reason'),
    sessionsRejectedTotal: total(rejected),
    linksTornByCap: byLabel(torn, 'cap'),
    linksTornByCapTotal: total(torn)
  }
}

// Mirror the roster's counts into the registry, on scrape and for the same
// reason as the line below: the roster is written by TWO processes, so a value
// copied at load or on a reload callback goes stale the moment the admin API or
// the CLI adds a member. Read it where it is asked for instead.
export function mirrorMembers (metrics, roster) {
  if (!roster || !metrics?.m.members) return
  metrics.m.members.set({ state: 'active' }, roster.active)
  metrics.m.members.set({ state: 'revoked' }, roster.total - roster.active)
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
