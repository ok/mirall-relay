import test from 'node:test'
import assert from 'node:assert/strict'
import { makeMetrics, mirrorRelayStats } from '../../src/metrics.js'
import { capabilityDoc } from '../../src/admin-http.js'
import { DEFAULTS } from '../../src/config.js'

test('the registry renders Prometheus text with our metric families', async () => {
  const metrics = makeMetrics({ collectDefault: false })
  metrics.m.sessionsAccepted.inc()
  metrics.m.sessionsRejected.inc({ reason: 'banned' })
  metrics.m.linksActive.set(3)
  metrics.m.bytesRelayed.inc(4096)
  metrics.m.dhtFirewalled.set(0)

  const text = await metrics.registry.metrics()

  assert.match(text, /relay_sessions_accepted_total 1/)
  assert.match(text, /relay_sessions_rejected_total\{reason="banned"\} 1/)
  assert.match(text, /relay_links_active 3/)
  assert.match(text, /relay_bytes_relayed_total 4096/)
  assert.match(text, /relay_dht_firewalled 0/)
  assert.match(metrics.registry.contentType, /text\/plain/)
})

test('every metric carries a HELP line', async () => {
  const metrics = makeMetrics({ collectDefault: false })
  const text = await metrics.registry.metrics()
  for (const name of ['relay_sessions_accepted_total', 'relay_links_active', 'relay_bytes_relayed_total']) {
    assert.match(text, new RegExp(`# HELP ${name} \\S`), `${name} needs help text`)
  }
})

test("blind-relay's own counters are mirrored, including derived getters", async () => {
  const metrics = makeMetrics({ collectDefault: false })
  mirrorRelayStats(metrics, {
    sessions: { accepted: 7, opened: 6, closed: 2, active: 5 },
    pairings: { requested: 4, matched: 3, cancelled: 1, pending: 0, active: 3 },
    streams: { opened: 6, closed: 0, errors: 0, active: 6 }
  })

  const text = await metrics.registry.metrics()
  assert.match(text, /relay_bl_sessions\{state="accepted"\} 7/)
  assert.match(text, /relay_bl_sessions\{state="active"\} 5/)
  assert.match(text, /relay_bl_pairings\{state="matched"\} 3/)
  assert.match(text, /relay_bl_streams\{state="active"\} 6/)
})

test('mirroring a missing stats object is a no-op, not a crash', () => {
  const metrics = makeMetrics({ collectDefault: false })
  assert.doesNotThrow(() => mirrorRelayStats(metrics, null))
})

test('the capability doc exposes the public key, labels and caps — and no secrets', () => {
  const cfg = { ...DEFAULTS, region: 'eu-fsn1', operator: 'mirall' }
  const doc = capabilityDoc(cfg, {
    version: '1.2.3',
    publicKeyZ32: 'abc123'
  })

  assert.equal(doc.service, 'mirall-relay')
  assert.equal(doc.protocol, 'blind-relay')
  assert.equal(doc.relayThrough, true)
  assert.equal(doc.publicKey, 'abc123')
  assert.equal(doc.region, 'eu-fsn1')
  assert.equal(doc.caps.maxLinkBytes, DEFAULTS.maxLinkBytes)
  assert.match(doc.privacy, /cannot read/)

  const serialised = JSON.stringify(doc)
  assert.doesNotMatch(serialised, /seed/i, 'the capability doc is public — no seed material')
  assert.doesNotMatch(serialised, /secret/i)
})
