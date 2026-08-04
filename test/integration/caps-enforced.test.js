// Caps must tear real bridges down and refuse real connections, not merely
// increment counters. Data-plane caps use relayedPair() because a hyperdht peer
// pair on loopback sends its payload over the direct path (see the helper).
import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'
import DHT from 'hyperdht'
import Relay from 'blind-relay'
import {
  createTestnet, startTestRelay, relayedPair, waitFor, metricValue
} from '../helpers/make-relay.js'

const CHUNK = b4a.alloc(64 * 1024, 3)

function connectToRelay (dht, relayPublicKey, timeoutMs = 20_000) {
  const socket = dht.connect(relayPublicKey)
  socket.on('error', () => {})
  return {
    socket,
    opened: new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay connect timed out')), timeoutMs)
      timer.unref?.()
      socket.once('open', () => { clearTimeout(timer); resolve() })
      socket.once('error', (err) => { clearTimeout(timer); reject(err) })
    })
  }
}

test('the duration cap tears a live bridge down', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet, {
    // Comfortably longer than pairing + priming: the clock starts when the relay
    // mints the stream, so too tight a cap tears the bridge down during setup.
    MIRALL_RELAY_MAX_LINK_MS: '5000',
    MIRALL_RELAY_METER_MS: '50'
  })
  t.after(() => relay.stop())

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())
  assert.equal(relay.meter.activeLinks, 2)

  await waitFor(
    async () => (await metricValue(relay.metrics, 'relay_links_torn_by_cap_total', { cap: 'duration' })) > 0,
    { message: 'the duration cap to fire', timeoutMs: 30_000 }
  )
  await waitFor(() => relay.meter.activeLinks === 0, { message: 'links to drain' })

  // A slow-but-honest transfer must not get the peer banned.
  assert.equal(relay.firewall.bannedCount, 0)
})

test('the byte cap tears a bridge carrying too much down', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet, {
    MIRALL_RELAY_MAX_LINK_BYTES: '16384',
    MIRALL_RELAY_METER_MS: '50'
  })
  t.after(() => relay.stop())

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())

  pair.b.on('data', () => {}) // keep the receiver draining
  for (let i = 0; i < 4; i++) pair.a.write(CHUNK) // well past the 16 KB cap

  await waitFor(
    async () => (await metricValue(relay.metrics, 'relay_links_torn_by_cap_total', { cap: 'bytes' })) > 0,
    { message: 'the byte cap to fire', timeoutMs: 30_000 }
  )
})

test('a sustained overrun trips the rate cap', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet, {
    MIRALL_RELAY_MAX_LINK_RATE: '2048', // 2 KiB/s
    MIRALL_RELAY_OVER_RATE_GRACE_MS: '200',
    MIRALL_RELAY_MAX_LINK_BYTES: '1GB', // isolate the rate cap from the byte cap
    MIRALL_RELAY_MAX_LINK_MS: '600000',
    MIRALL_RELAY_METER_MS: '50'
  })
  t.after(() => relay.stop())

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())

  pair.b.on('data', () => {})
  const pump = setInterval(() => {
    try { pair.a.write(CHUNK) } catch { /* torn down */ }
  }, 50)
  t.after(() => clearInterval(pump))

  await waitFor(
    async () => (await metricValue(relay.metrics, 'relay_links_torn_by_cap_total', { cap: 'rate' })) > 0,
    { message: 'the rate cap to fire', timeoutMs: 30_000 }
  )
  clearInterval(pump)
})

test('the per-key session cap refuses a second concurrent session', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet, { MIRALL_RELAY_MAX_SESSIONS_PER_KEY: '1' })
  t.after(() => relay.stop())

  // One identity, two connections to the relay -> two sessions from the same
  // remote public key. The second must be refused at admission.
  const dht = new DHT({ bootstrap: testnet.bootstrap })
  t.after(() => dht.destroy())

  const first = connectToRelay(dht, relay.relay.publicKey)
  await first.opened
  t.after(() => first.socket.destroy())
  await waitFor(() => relay.meter.sessionCount(
    b4a.toString(dht.defaultKeyPair.publicKey, 'hex')
  ) === 1, { message: 'the first session to register' })

  const second = connectToRelay(dht, relay.relay.publicKey)
  second.opened.catch(() => {}) // this connection is SUPPOSED to be refused
  t.after(() => second.socket.destroy())

  await waitFor(
    async () => (await metricValue(relay.metrics, 'relay_sessions_rejected_total', { reason: 'concurrency' })) > 0,
    { message: 'the concurrency cap to fire', timeoutMs: 30_000 }
  )
})

test('a closed session frees its slot', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet, { MIRALL_RELAY_MAX_SESSIONS_PER_KEY: '1' })
  t.after(() => relay.stop())

  const dht = new DHT({ bootstrap: testnet.bootstrap })
  t.after(() => dht.destroy())
  const keyHex = b4a.toString(dht.defaultKeyPair.publicKey, 'hex')

  const first = connectToRelay(dht, relay.relay.publicKey)
  await first.opened
  await waitFor(() => relay.meter.sessionCount(keyHex) === 1, { message: 'session 1' })

  first.socket.destroy()
  await waitFor(() => relay.meter.sessionCount(keyHex) === 0, {
    message: 'the slot to be released — leaking it would lock the peer out permanently'
  })

  const second = connectToRelay(dht, relay.relay.publicKey)
  await second.opened
  t.after(() => second.socket.destroy())
  await waitFor(() => relay.meter.sessionCount(keyHex) === 1, { message: 'session 2 to be admitted' })
})

test('half-open pairings are bounded, and the ceiling refuses new sessions', async (t) => {
  const testnet = await createTestnet(4)

  // maxPending of 1 means the very first half-open pairing closes the door. A
  // DoS bound has to hold at the boundary, not merely far above it.
  const relay = await startTestRelay(testnet, {
    MIRALL_RELAY_MAX_PENDING: '1',
    MIRALL_RELAY_MAX_SESSIONS_PER_KEY: '50'
  })

  // One ordered teardown rather than a stack of t.after() calls: those unwind in
  // reverse registration order, which here would destroy a peer's DHT before its
  // socket and hang the run.
  const nodes = []
  const sockets = []
  t.after(async () => {
    for (const s of sockets) { try { s.destroy() } catch { /* gone */ } }
    for (const d of nodes) await d.destroy().catch(() => {})
    await relay.stop()
    await testnet.destroy()
  })

  // A pairing whose counterpart never arrives: exactly the memory-flood shape.
  const flooder = new DHT({ bootstrap: testnet.bootstrap })
  nodes.push(flooder)
  const { socket, opened } = connectToRelay(flooder, relay.relay.publicKey)
  sockets.push(socket)
  await opened

  const client = Relay.Client.from(socket, { id: socket.publicKey })
  const request = client.pair(true, Relay.token(), flooder.createRawStream())
  // BlindRelayRequest is a lazy Readable: its _open() — which is what actually
  // SENDS the pair message — does not run until the stream is read. Without a
  // reader the request sits inert and the relay never sees the pairing at all.
  request.on('error', () => {})
  request.resume()

  await waitFor(() => relay.relay.relayStats().pairings.pending >= 1, { message: 'a pending pairing' })

  // With the ceiling reached, further sessions are refused outright.
  for (let i = 0; i < 4; i++) {
    const dht = new DHT({ bootstrap: testnet.bootstrap })
    nodes.push(dht)
    const conn = connectToRelay(dht, relay.relay.publicKey)
    conn.opened.catch(() => {}) // expected to be refused by the ceiling
    sockets.push(conn.socket)
  }

  await waitFor(
    async () => (await metricValue(relay.metrics, 'relay_sessions_rejected_total', { reason: 'pending-pairings' })) >= 4,
    { message: 'the pending-pairing ceiling to refuse every new session', timeoutMs: 30_000 }
  )

  // The point of the bound: pending pairings plateau instead of growing, and no
  // extra session slipped through behind them.
  assert.equal(relay.relay.relayStats().pairings.pending, 1)
  assert.equal(await metricValue(relay.metrics, 'relay_sessions_accepted_total'), 1)
})
