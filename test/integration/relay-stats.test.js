// Proves the assumption the whole metering design rests on:
//
//   Do UDX byte counters advance on a relayTo()-bridged stream?
//
// They do — but ONLY bytesReceived. bytesTransmitted and the JS 'data' event are
// both structurally unavailable once relayTo() takes over, because forwarding
// happens inside the native layer. If this ever changes, byte and rate caps
// cannot be enforced by sampling and src/meter.js has to be redesigned, so the
// assertions here are specific rather than "something moved".
//
// These tests use relayedPair() rather than two hyperdht peers: on loopback the
// direct hole-punch always beats the relayed path, so a peer-to-peer test builds
// the bridge and then abandons it before any payload crosses. See the helper.
import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'
import {
  createTestnet, startTestRelay, relayedPair, waitFor, metricValue
} from '../helpers/make-relay.js'

const CHUNK = b4a.alloc(64 * 1024, 7)
const CHUNKS = 4
const TOTAL = CHUNK.byteLength * CHUNKS

// Push TOTAL bytes from one end of the bridge to the other.
async function pump (pair) {
  let received = 0
  pair.b.on('data', (d) => { received += d.byteLength })
  for (let i = 0; i < CHUNKS; i++) pair.a.write(CHUNK)
  await waitFor(() => received >= TOTAL, { message: 'the payload to cross the bridge', timeoutMs: 30_000 })
  return received
}

test('bytesReceived advances on bridged streams and bytesTransmitted stays zero', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  // A long meter interval keeps the sampler from tearing anything down mid-test;
  // sampling is driven by hand below.
  const relay = await startTestRelay(testnet, { MIRALL_RELAY_METER_MS: '600000' })
  t.after(() => relay.stop())

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())

  await waitFor(() => relay.meter.activeLinks >= 2, { message: 'both halves of the bridge to register' })
  assert.equal(relay.relay.relayStats().pairings.matched, 1)

  const received = await pump(pair)
  assert.ok(received >= TOTAL)

  const links = [...relay.meter._links]
  assert.equal(links.length, 2, 'a relayed connection is exactly two bridged streams')

  const ingress = links.reduce((sum, rec) => sum + rec.stream.bytesReceived, 0)
  assert.ok(
    ingress >= TOTAL,
    `bridged ingress (${ingress}) must cover the payload (${TOTAL}) — ` +
    'if this fails, sampling cannot meter relayed traffic at all'
  )

  for (const rec of links) {
    assert.equal(
      rec.stream.bytesTransmitted, 0,
      'relayTo() forwards natively, so tx accounting stays at zero — the meter must never read it'
    )
    assert.equal(rec.stream.packetsTransmitted, 0)
  }
})

test('a bridged stream never emits JS data events', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet, { MIRALL_RELAY_METER_MS: '600000' })
  t.after(() => relay.stop())

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())

  await waitFor(() => relay.meter.activeLinks >= 2, { message: 'the bridge' })

  // This is WHY the meter polls counters instead of counting chunks.
  let dataEvents = 0
  for (const rec of [...relay.meter._links]) rec.stream.on('data', () => { dataEvents++ })

  await pump(pair)
  assert.equal(dataEvents, 0, 'relayTo() bypasses the JS read path entirely')
})

test('sampling turns bridged ingress into relay_bytes_relayed_total', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet, { MIRALL_RELAY_METER_MS: '50' })
  t.after(() => relay.stop())

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())

  await waitFor(() => relay.meter.activeLinks >= 2, { message: 'the bridge' })
  await pump(pair)

  const relayed = await waitFor(
    async () => {
      const value = await metricValue(relay.metrics, 'relay_bytes_relayed_total')
      return value >= TOTAL ? value : 0
    },
    { message: 'relay_bytes_relayed_total to cover the payload', timeoutMs: 30_000 }
  )

  assert.ok(relayed >= TOTAL, `expected >= ${TOTAL} relayed bytes, got ${relayed}`)
  assert.equal(await metricValue(relay.metrics, 'relay_links_opened_total'), 2)
  assert.equal(await metricValue(relay.metrics, 'relay_sessions_accepted_total'), 2)
})

test('closing a bridged stream releases the link', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet)
  t.after(() => relay.stop())

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  await waitFor(() => relay.meter.activeLinks >= 2, { message: 'the bridge' })

  await pair.destroy()

  await waitFor(() => relay.meter.activeLinks === 0, { message: 'links to drain', timeoutMs: 30_000 })
  assert.equal(await metricValue(relay.metrics, 'relay_links_active'), 0)
})

test('blind-relay stats are mirrored into the registry on render', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet)
  t.after(() => relay.stop())

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())
  await waitFor(() => relay.relay.relayStats().pairings.matched >= 1, { message: 'a pairing' })

  const { mirrorRelayStats } = await import('../../src/metrics.js')
  mirrorRelayStats(relay.metrics, relay.relay.relayStats())
  const text = await relay.metrics.registry.metrics()

  assert.match(text, /relay_bl_pairings\{state="matched"\} 1/)
  assert.match(text, /relay_bl_sessions\{state="accepted"\} 2/)
  assert.match(text, /relay_bl_streams\{state="active"\} 2/)
})
