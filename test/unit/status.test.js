// The status snapshot. Driven by a stand-in relay so every reachability branch is
// reachable without standing up a DHT.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../../src/config.js'
import { makeMetrics } from '../../src/metrics.js'
import { makeFirewall } from '../../src/firewall.js'
import { caps, capabilityDoc, reachabilityState, statusSnapshot } from '../../src/status.js'

const SEED = 'ab'.repeat(32)
const KEY = 'yb3dq6h9c1x8kwmp4z7ejr5tn9adg2hf6bcxsq8vw3ymp4z7ejab'

function fakeRelay (overrides = {}) {
  return {
    version: '9.9.9',
    ready: true,
    closing: false,
    firewalled: false,
    startedAt: Date.now() - 90_000,
    publicKeyZ32: KEY,
    seedSource: { from: 'file', path: '/data/seed' },
    relayStats: () => ({
      sessions: { accepted: 3, opened: 3, closed: 1, active: 2 },
      pairings: { requested: 4, matched: 2, cancelled: 0, pending: 1, active: 1 },
      streams: { opened: 2, closed: 0, errors: 0, active: 2 }
    }),
    networkInfo: () => ({
      host: '203.0.113.9',
      port: 49737,
      randomized: false,
      bootstrapped: true,
      ephemeral: false,
      nodes: 12,
      address: { host: '0.0.0.0', port: 49737, family: 4 }
    }),
    ...overrides
  }
}

// Counts only — the snapshot must never be able to reach a label.
function fakeRoster (active = 0, total = active) {
  return { active, total, file: '/data/members.json', members: { has: () => false, size: active } }
}

function build (env = {}, relayOverrides = {}, roster = null) {
  const cfg = loadConfig([], { MIRALL_RELAY_SEED: SEED, ...env })
  const metrics = makeMetrics({ collectDefault: false })
  const firewall = makeFirewall(cfg, metrics, roster ? { members: roster.members } : {})
  const relay = fakeRelay(relayOverrides)
  return {
    cfg,
    metrics,
    firewall,
    relay,
    roster,
    snapshot: () => statusSnapshot({ cfg, relay, metrics, firewall, roster, version: relay.version })
  }
}

test('reachabilityState reports what the DHT believes', () => {
  assert.equal(reachabilityState({ ready: true, closing: false, firewalled: false }), 'reachable')
  assert.equal(reachabilityState({ ready: true, closing: false, firewalled: true }), 'firewalled')
  assert.equal(reachabilityState({ ready: false, closing: false, firewalled: null }), 'starting')
  assert.equal(reachabilityState({ ready: false, closing: true, firewalled: false }), 'stopped')
  assert.equal(reachabilityState({ ready: true, closing: false, firewalled: null }), 'unknown')
})

test('asserted reachability is never reported as measured', async (t) => {
  // THE one that matters. ASSUME_REACHABLE passes firewalled: false straight into
  // the DHT, so `state` alone would tell an operator their relay was verified
  // when nothing verified anything.
  const measured = await build().snapshot()
  assert.equal(measured.reachability.state, 'reachable')
  assert.equal(measured.reachability.probed, true)

  const asserted = await build({ MIRALL_RELAY_ASSUME_REACHABLE: 'true' }).snapshot()
  assert.equal(asserted.reachability.state, 'reachable')
  assert.equal(asserted.reachability.probed, false)
})

test('the snapshot carries the key, the labels and where the seed came from', async () => {
  const status = await build({ MIRALL_RELAY_REGION: 'eu-fsn1', MIRALL_RELAY_OPERATOR: 'example' }).snapshot()
  assert.equal(status.identity.publicKey, KEY)
  assert.equal(status.identity.seedFrom, 'file')
  assert.equal(status.identity.seedPath, '/data/seed')
  assert.deepEqual(status.labels, { region: 'eu-fsn1', operator: 'example' })
  assert.equal(status.version, '9.9.9')
  assert.equal(status.uptimeSeconds, 90)
})

test('the snapshot never contains the seed or anything derived from it', async () => {
  const text = JSON.stringify(await build().snapshot())
  assert.ok(!text.includes(SEED), 'the seed must never reach an unauthenticated surface')
  assert.ok(!/secretKey/i.test(text))
  assert.ok(!/\bseed"\s*:/.test(text), 'only seedFrom and seedPath, never a seed value')
})

test('counters come from the registry, so /metrics and the page cannot disagree', async () => {
  const { metrics, snapshot } = build()
  metrics.m.bytesRelayed.inc(4096)
  metrics.m.linksOpened.inc(3)
  metrics.m.linksActive.set(2)
  metrics.m.sessionsAccepted.inc(5)
  metrics.m.sessionsRejected.inc({ reason: 'banned' }, 2)
  metrics.m.sessionsRejected.inc({ reason: 'session-rate' })
  metrics.m.linksTornByCap.inc({ cap: 'rate' })

  const { traffic } = await snapshot()
  assert.equal(traffic.bytesRelayed, 4096)
  assert.equal(traffic.linksOpened, 3)
  assert.equal(traffic.linksActive, 2)
  assert.equal(traffic.sessionsAccepted, 5)
  assert.deepEqual(traffic.sessionsRejected, { banned: 2, 'session-rate': 1 })
  assert.equal(traffic.sessionsRejectedTotal, 3, 'the headline number is the sum of the reasons')
  assert.deepEqual(traffic.linksTornByCap, { rate: 1 })
  assert.equal(traffic.linksTornByCapTotal, 1)
})

test("blind-relay's own pairing counters ride along", async () => {
  const { traffic } = await build().snapshot()
  assert.equal(traffic.pairings.matched, 2)
  assert.equal(traffic.pairings.pending, 1)
  assert.equal(traffic.sessions.active, 2)
})

test('a relay that has not started yet still produces a snapshot', async () => {
  const status = await build({}, {
    ready: false,
    startedAt: null,
    firewalled: null,
    publicKeyZ32: null,
    relayStats: () => null,
    networkInfo: () => ({ host: null, port: null, randomized: false, bootstrapped: false, ephemeral: false, nodes: 0, address: null })
  }).snapshot()

  assert.equal(status.reachability.state, 'starting')
  assert.equal(status.identity.publicKey, null)
  assert.equal(status.uptimeSeconds, 0)
  assert.equal(status.startedAt, null)
  assert.equal(status.traffic.pairings, null)
})

test('access mode flips to allowlist and counts what is on the lists', async () => {
  const open = await build().snapshot()
  assert.equal(open.access.mode, 'open')
  assert.equal(open.access.allowlisted, null)

  const closed = await build({
    MIRALL_RELAY_ALLOWLIST: 'a'.repeat(64),
    MIRALL_RELAY_BANLIST: `${'b'.repeat(64)},${'c'.repeat(64)}`
  }).snapshot()
  assert.equal(closed.access.mode, 'allowlist')
  assert.equal(closed.access.allowlisted, 1)
  assert.equal(closed.access.banned, 2)
})

test('caps() is the single definition the capability doc also uses', async () => {
  const { cfg, relay, snapshot } = build({ MIRALL_RELAY_MAX_LINK_BYTES: '1GiB' })
  const status = await snapshot()
  assert.deepEqual(status.caps, caps(cfg))
  assert.deepEqual(capabilityDoc(cfg, relay).caps, status.caps)
  assert.equal(status.caps.maxLinkBytes, 1024 ** 3)
})

test('the symmetric-NAT signal is reported separately from the firewall verdict', async () => {
  const status = await build({}, {
    networkInfo: () => ({ host: '203.0.113.9', port: 0, randomized: true, bootstrapped: true, ephemeral: false, nodes: 4, address: null })
  }).snapshot()

  assert.equal(status.reachability.state, 'reachable', 'the DHT is happy')
  assert.equal(status.reachability.portRandomized, true, 'and the relay is still unusable')
})

test('an ephemeral node reports whether it CHOSE to be one', async () => {
  // A firewalled node is kept ephemeral by hyperdht's adaptive mode regardless of
  // config, so these two have to be separate or the page blames the wrong thing.
  const consequence = await build({}, {
    networkInfo: () => ({ host: null, port: null, randomized: false, bootstrapped: true, ephemeral: true, nodes: 3, address: null })
  }).snapshot()
  assert.equal(consequence.reachability.ephemeral, true)
  assert.equal(consequence.reachability.ephemeralConfigured, false)
  assert.equal(consequence.reachability.inRoutingTable, false)

  const chosen = await build({ MIRALL_RELAY_EPHEMERAL: 'true' }).snapshot()
  assert.equal(chosen.reachability.ephemeralConfigured, true)
})

test('the bound address is normalised, whatever udx calls the host field', async () => {
  const status = await build({}, {
    networkInfo: () => ({ host: null, port: null, randomized: false, bootstrapped: true, ephemeral: false, nodes: 1, address: { host: '0.0.0.0', port: 49737, family: 4 } })
  }).snapshot()
  assert.equal(status.reachability.bound.host, '0.0.0.0')
  assert.equal(status.reachability.bound.port, 49737)
})

test('access mode reports invite', async () => {
  const status = await build({ MIRALL_RELAY_ACCESS: 'invite' }, {}, fakeRoster(2, 3)).snapshot()
  assert.equal(status.access.mode, 'invite')
  assert.deepEqual(status.access.members, { active: 2, total: 3 })
})

test('access mode still reports allowlist and open', async () => {
  // Regression on both: an existing operator's configuration means what it did.
  assert.equal((await build().snapshot()).access.mode, 'open')
  assert.equal((await build({ MIRALL_RELAY_ALLOWLIST: 'a'.repeat(64) }).snapshot()).access.mode, 'allowlist')
})

test('invite mode with an empty roster reports zero members, not "open"', async () => {
  // The operator staring at the page wondering why nobody connects needs this
  // to say "invite, 0 members", never "open".
  const status = await build({ MIRALL_RELAY_ACCESS: 'invite' }, {}, fakeRoster(0)).snapshot()
  assert.equal(status.access.mode, 'invite')
  assert.equal(status.access.members.active, 0)
  assert.equal(status.access.allowlisted, 0, 'gated with nobody admitted')
})

test('the snapshot carries member counts, never labels', async () => {
  const { snapshot } = build({ MIRALL_RELAY_ACCESS: 'invite' }, {}, {
    active: 1,
    total: 1,
    file: '/data/members.json',
    members: { has: () => false, size: 1 },
    // Present on the real roster, and the snapshot must not reach for them.
    list: () => [{ label: 'ben', seedHex: 'ab'.repeat(32) }],
    listPublic: () => [{ label: 'ben' }]
  })
  const text = JSON.stringify(await snapshot())
  assert.ok(!text.includes('ben'), 'a label is a person\'s name')
  assert.ok(!text.includes('members.json'), 'not even the path to the secret')
  assert.ok(!/[0-9a-f]{64}/i.test(text))
})

test('refusedLastHour is reported', async () => {
  const { firewall, snapshot } = build({ MIRALL_RELAY_ACCESS: 'invite' }, {}, fakeRoster(0))
  assert.equal((await snapshot()).access.refusedLastHour, 0)

  firewall.firewall(Buffer.alloc(32, 9))
  firewall.firewall(Buffer.alloc(32, 8))
  assert.equal((await snapshot()).access.refusedLastHour, 2, 'the page mirrors the firewall')
})

test('a snapshot without a roster still renders', async () => {
  // src/status.js is called from tests and tools that have no roster to hand.
  const status = await build().snapshot()
  assert.equal(status.access.members, null)
  assert.equal(status.access.refusedLastHour, 0)
})
