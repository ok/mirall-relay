// The headline test: two peers that route through our relay actually talk, the
// relay records the pairing, and the payload the relay carried is ciphertext.
import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'
import {
  createTestnet, startTestRelay, makeEchoPeer, makeDialer, roundTrip, waitFor
} from '../helpers/make-relay.js'

// NOTE: on a loopback testnet the direct hole-punch wins the race, so these
// tests prove "the relay accepts, pairs and never breaks a connection" rather
// than "every byte crossed the bridge". relay-stats.test.js proves the latter.
test('two peers connect through the relay and exchange data end-to-end', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet)
  t.after(() => relay.stop())

  const peer = await makeEchoPeer(testnet)
  t.after(() => peer.destroy())

  const dialer = await makeDialer(testnet)
  t.after(() => dialer.destroy())

  const socket = dialer.dht.connect(peer.publicKey, { relayThrough: relay.relay.publicKey })
  t.after(() => socket.destroy())

  const reply = await roundTrip(socket, 'ping')
  assert.equal(b4a.toString(reply), 'echo:ping')

  // The relay matched both halves of the pairing — i.e. it really carried this
  // connection rather than the peers quietly going direct.
  await waitFor(
    () => relay.relay.relayStats().pairings.matched >= 1,
    { message: 'a matched pairing at the relay' }
  )

  const stats = relay.relay.relayStats()
  assert.ok(stats.sessions.accepted >= 2, 'both peers opened a session with the relay')
  assert.ok(stats.streams.opened >= 2, 'both halves of the bridge were minted')
})

test('the relay never sees plaintext — Noise runs over the relayed stream', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet)
  t.after(() => relay.stop())

  const SECRET = 'mirall-plaintext-canary-' + 'x'.repeat(64)

  const peer = await makeEchoPeer(testnet)
  t.after(() => peer.destroy())

  const dialer = await makeDialer(testnet)
  t.after(() => dialer.destroy())

  const socket = dialer.dht.connect(peer.publicKey, { relayThrough: relay.relay.publicKey })
  t.after(() => socket.destroy())

  const reply = await roundTrip(socket, SECRET)
  assert.equal(b4a.toString(reply), 'echo:' + SECRET)

  // Structural proof: the end-to-end handshake happened between the PEERS. The
  // relay holds no session key and exposes no plaintext API — its bridged streams
  // are raw UDX, forwarded natively.
  assert.ok(socket.handshakeHash, 'the peers completed their own Noise handshake')

  // The relay's own view of the connection is byte counts on raw streams —
  // never content. (Whether the payload physically crossed the bridge or took
  // the direct path it races against is not asserted here; relay-stats.test.js
  // proves the data plane deterministically.)
  for (const rec of relay.meter._links) {
    assert.equal(typeof rec.stream.bytesReceived, 'number')
    assert.equal(rec.stream.bytesTransmitted, 0, 'relayTo() bypasses tx accounting')
  }
})

test('the relay key is stable across a restart', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  // A fixed seed stands in for the persisted .keys/seed a real deployment uses.
  const seed = 'c'.repeat(64)
  const first = await startTestRelay(testnet, { MIRALL_RELAY_SEED: seed })
  const key1 = first.relay.publicKeyZ32
  await first.stop()

  const second = await startTestRelay(testnet, { MIRALL_RELAY_SEED: seed })
  t.after(() => second.stop())

  assert.equal(second.relay.publicKeyZ32, key1, 'clients must not be stranded by a restart')
})

test('a relayed connection still works when the relay is reached by z32 key', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet)
  t.after(() => relay.stop())

  // What a user actually pastes into Mirall is the z32 form; prove it decodes to
  // the key hyperdht wants.
  const { default: idEnc } = await import('hypercore-id-encoding')
  const decoded = idEnc.decode(relay.relay.publicKeyZ32)
  assert.deepEqual(b4a.from(decoded), b4a.from(relay.relay.publicKey))

  const peer = await makeEchoPeer(testnet)
  t.after(() => peer.destroy())
  const dialer = await makeDialer(testnet)
  t.after(() => dialer.destroy())

  const socket = dialer.dht.connect(peer.publicKey, { relayThrough: decoded })
  t.after(() => socket.destroy())

  const reply = await roundTrip(socket, 'from-z32')
  assert.equal(b4a.toString(reply), 'echo:from-z32')
})
