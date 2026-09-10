// The invite contract, executed against a real DHT.
//
// This is the test that proves the design: it derives the client's DHT identity
// from a ticket EXACTLY as mirall-app will, so a drift in either half fails here
// rather than in a support thread.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import idEnc from 'hypercore-id-encoding'
import { createTestnet, startTestRelay, makeMemberNode, metricValue, waitFor } from '../helpers/make-relay.js'
import { decodeTicket, memberPublicKeyZ32 } from '../../src/ticket.js'

function rosterFile (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-invite-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'members.json')
}

async function inviteRelay (t, overrides = {}) {
  const testnet = await createTestnet(3)
  const relay = await startTestRelay(testnet, { MIRALL_RELAY_ACCESS: 'invite', ...overrides })
  t.after(async () => { await relay.stop(); await testnet.destroy() })
  return { testnet, relay }
}

// The far side destroying our socket surfaces as ECONNRESET, and events.once()
// would reject on that — the reset IS the teardown, so wait for 'close' alone.
function closes (socket) {
  return new Promise((resolve) => socket.once('close', resolve))
}

// Open a connection and wait for it to establish, or for the refusal to show up
// as a failure. A refused peer sees a handshake that never completes, so the
// only honest assertion is a timeout.
function opens (socket, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
    socket.on('error', () => {})
    socket.once('open', () => { clearTimeout(timer); resolve(true) })
  })
}

test('a ticket holder is admitted and a stranger is refused', async (t) => {
  const { testnet, relay } = await inviteRelay(t)

  const member = relay.roster.add('ben')
  const ticket = decodeTicket(relay.roster.ticketFor('ben', relay.relay.publicKey), {
    expectRelayPublicKey: relay.relay.publicKey
  })
  assert.equal(memberPublicKeyZ32(ticket.memberSeed), member.publicKey)

  // EXACTLY what the client does: the DHT node's defaultKeyPair IS the member
  // identity, because hyperdht dials a relay with dht.defaultKeyPair and no
  // per-connection keypair (connect.js:47,793).
  const node = makeMemberNode(testnet, ticket.memberSeed)
  t.after(() => node.destroy())
  assert.equal(b4a.toString(node.publicKey, 'hex'), b4a.toString(idEnc.decode(member.publicKey), 'hex'))

  assert.equal(await opens(node.dht.connect(relay.relay.publicKey), 15_000), true, 'the member is admitted')

  const stranger = makeMemberNode(testnet, b4a.alloc(32, 42))
  t.after(() => stranger.destroy())
  assert.equal(await opens(stranger.dht.connect(relay.relay.publicKey), 3000), false, 'and a stranger is not')

  assert.equal(
    await metricValue(relay.metrics, 'relay_sessions_rejected_total', { reason: 'not-allowlisted' }),
    1
  )
})

test('an empty roster in invite mode refuses everyone', async (t) => {
  const { testnet, relay } = await inviteRelay(t)
  // Including the very key that WOULD be admitted after `add` — the empty case
  // is a closed relay, not an open one.
  const seed = b4a.alloc(32, 7)
  const node = makeMemberNode(testnet, seed)
  t.after(() => node.destroy())

  assert.equal(relay.firewall.firewall(node.publicKey), true)
  assert.equal(await opens(node.dht.connect(relay.relay.publicKey), 3000), false)

  relay.roster.add('late')
  assert.equal(relay.firewall.firewall(node.publicKey), true, 'a different member does not admit this one')
})

test('open mode is unaffected', async (t) => {
  // Existing open-mode deployments keep their admission behavior.
  const { testnet, relay } = await inviteRelay(t, { MIRALL_RELAY_ACCESS: 'open' })
  const stranger = makeMemberNode(testnet, b4a.alloc(32, 11))
  t.after(() => stranger.destroy())

  assert.equal(relay.firewall.allowlisted, null, 'an open relay has no admitted set to count')
  assert.equal(await opens(stranger.dht.connect(relay.relay.publicKey), 15_000), true)
})

test('a static ALLOWLIST key still works in invite mode', async (t) => {
  const seed = b4a.alloc(32, 3)
  const listed = memberPublicKeyZ32(seed)
  const { testnet, relay } = await inviteRelay(t, { MIRALL_RELAY_ALLOWLIST: listed })

  const node = makeMemberNode(testnet, seed)
  t.after(() => node.destroy())
  // Union, not replacement.
  assert.equal(await opens(node.dht.connect(relay.relay.publicKey), 15_000), true)

  const member = relay.roster.add('ben')
  assert.equal(relay.firewall.allowlisted, 2)
  assert.equal(relay.firewall.firewall(idEnc.decode(member.publicKey)), false)
})

test('revoking closes the member\'s live sessions', async (t) => {
  const { testnet, relay } = await inviteRelay(t)
  const member = relay.roster.add('ben')
  const ticket = decodeTicket(relay.roster.ticketFor('ben', relay.relay.publicKey), {
    expectRelayPublicKey: relay.relay.publicKey
  })

  const node = makeMemberNode(testnet, ticket.memberSeed)
  t.after(() => node.destroy())
  const socket = node.dht.connect(relay.relay.publicKey)
  assert.equal(await opens(socket, 15_000), true)

  const keyHex = b4a.toString(idEnc.decode(member.publicKey), 'hex')
  await waitFor(() => relay.relay._sessionsByKey.has(keyHex), { message: 'the session to be indexed' })

  const closed = closes(socket)
  const revoked = relay.roster.revoke('ben')
  // A revocation that only blocks the NEXT connection is not what an operator
  // dealing with a stolen laptop means.
  assert.equal(relay.relay.destroySessionsFor(revoked.keyHex), 1)
  await closed

  assert.equal(relay.firewall.firewall(idEnc.decode(member.publicKey)), true)
})

test('an out-of-process revoke is picked up', async (t) => {
  const file = rosterFile(t)
  const { testnet, relay } = await inviteRelay(t, { MIRALL_RELAY_ROSTER_FILE: file })

  const member = relay.roster.add('ben')
  const ticket = decodeTicket(relay.roster.ticketFor('ben', relay.relay.publicKey), {
    expectRelayPublicKey: relay.relay.publicKey
  })
  const keyHex = b4a.toString(idEnc.decode(member.publicKey), 'hex')

  const node = makeMemberNode(testnet, ticket.memberSeed)
  t.after(() => node.destroy())
  const socket = node.dht.connect(relay.relay.publicKey)
  assert.equal(await opens(socket, 15_000), true)
  await waitFor(() => relay.relay._sessionsByKey.has(keyHex), { message: 'the session to be indexed' })

  // What `mirall-relay invite revoke` in another process leaves behind. The file
  // is the source of truth; this process is only one of its writers.
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc.members[0].revoked = new Date().toISOString()
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))

  const closed = closes(socket)
  await waitFor(() => !relay.roster.members.has(keyHex), {
    timeoutMs: 20_000,
    message: 'the watcher to notice a roster written by another process'
  })
  await closed
  assert.equal(relay.firewall.firewall(idEnc.decode(member.publicKey)), true)
})

test('a member survives a relay restart', async (t) => {
  const file = rosterFile(t)
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())

  const first = await startTestRelay(testnet, {
    MIRALL_RELAY_ACCESS: 'invite',
    MIRALL_RELAY_ROSTER_FILE: file
  })
  const member = first.roster.add('ben')
  const seedHex = first.roster.get('ben').seedHex
  await first.stop()

  const second = await startTestRelay(testnet, {
    MIRALL_RELAY_ACCESS: 'invite',
    MIRALL_RELAY_ROSTER_FILE: file
  })
  t.after(() => second.stop())

  assert.equal(second.roster.get('ben').seedHex, seedHex, 'the seed is stored so a reissue is a lookup')
  assert.equal(second.firewall.firewall(idEnc.decode(member.publicKey)), false)

  const node = makeMemberNode(testnet, b4a.from(seedHex, 'hex'))
  t.after(() => node.destroy())
  assert.equal(await opens(node.dht.connect(second.relay.publicKey), 15_000), true)
})
