// Admission control against a real DHT: a rejected peer must never get a bridge.
import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'
import {
  createTestnet, startTestRelay, makeEchoPeer, makeDialer, roundTrip, waitFor, metricValue
} from '../helpers/make-relay.js'

test('a banned key cannot open a relay session', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const dialer = await makeDialer(testnet)
  t.after(() => dialer.destroy())
  const bannedHex = b4a.toString(dialer.dht.defaultKeyPair.publicKey, 'hex')

  const relay = await startTestRelay(testnet, { MIRALL_RELAY_BANLIST: bannedHex })
  t.after(() => relay.stop())

  const peer = await makeEchoPeer(testnet)
  t.after(() => peer.destroy())

  const socket = dialer.dht.connect(peer.publicKey, { relayThrough: relay.relay.publicKey })
  socket.on('error', () => {})
  t.after(() => socket.destroy())

  await waitFor(
    async () => (await metricValue(relay.metrics, 'relay_sessions_rejected_total', { reason: 'banned' })) > 0,
    { message: 'the ban to be enforced', timeoutMs: 30_000 }
  )

  assert.equal(
    relay.relay.relayStats().pairings.matched, 0,
    'a banned peer must never get a bridge'
  )
})

test('allowlist mode admits the listed peer and refuses everyone else', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const allowed = await makeDialer(testnet)
  const blocked = await makeDialer(testnet)
  t.after(() => { allowed.destroy(); blocked.destroy() })

  const peer = await makeEchoPeer(testnet)
  t.after(() => peer.destroy())

  // The echo peer also connects to the relay as the announcing side. A private
  // relay is allowlisted per peer, not per connection, so the responder key must
  // be listed too.
  const allowlist = [
    b4a.toString(allowed.dht.defaultKeyPair.publicKey, 'hex'),
    b4a.toString(peer.dht.defaultKeyPair.publicKey, 'hex')
  ].join(',')

  const relay = await startTestRelay(testnet, { MIRALL_RELAY_ALLOWLIST: allowlist })
  t.after(() => relay.stop())

  const ok = allowed.dht.connect(peer.publicKey, { relayThrough: relay.relay.publicKey })
  ok.on('error', () => {})
  t.after(() => ok.destroy())

  const reply = await roundTrip(ok, 'allowed')
  assert.equal(b4a.toString(reply), 'echo:allowed')
  await waitFor(() => relay.relay.relayStats().pairings.matched >= 1, { message: 'the allowed pairing' })

  const denied = blocked.dht.connect(peer.publicKey, { relayThrough: relay.relay.publicKey })
  denied.on('error', () => {})
  t.after(() => denied.destroy())

  await waitFor(
    async () => (await metricValue(relay.metrics, 'relay_sessions_rejected_total', { reason: 'not-allowlisted' })) > 0,
    { message: 'the allowlist to reject the stranger', timeoutMs: 30_000 }
  )
})

test('runtime bans take effect without a restart', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  const relay = await startTestRelay(testnet)
  t.after(() => relay.stop())

  const peer = await makeEchoPeer(testnet)
  t.after(() => peer.destroy())
  const dialer = await makeDialer(testnet)
  t.after(() => dialer.destroy())

  const first = dialer.dht.connect(peer.publicKey, { relayThrough: relay.relay.publicKey })
  first.on('error', () => {})
  t.after(() => first.destroy())

  assert.equal(b4a.toString(await roundTrip(first, 'before')), 'echo:before')
  await waitFor(() => relay.relay.relayStats().pairings.matched >= 1, { message: 'the first pairing' })

  // Runtime bans follow the runbook path: identify a key from logs, ban it, and
  // refuse it on the next connection.
  relay.firewall.ban(b4a.toString(dialer.dht.defaultKeyPair.publicKey, 'hex'))
  assert.equal(relay.firewall.firewall(dialer.dht.defaultKeyPair.publicKey), true)

  const before = await metricValue(relay.metrics, 'relay_sessions_rejected_total', { reason: 'banned' })
  const second = dialer.dht.connect(peer.publicKey, { relayThrough: relay.relay.publicKey })
  second.on('error', () => {})
  t.after(() => second.destroy())

  await waitFor(
    async () => (await metricValue(relay.metrics, 'relay_sessions_rejected_total', { reason: 'banned' })) > before,
    { message: 'the runtime ban to be enforced', timeoutMs: 30_000 }
  )
})
