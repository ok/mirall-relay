// The token-gated write surface, over real HTTP against a running relay.
//
// The load-bearing property under test is the SPLIT: the anonymous page keeps
// showing numbers, and every name and every secret lives behind the token.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import b4a from 'b4a'
import idEnc from 'hypercore-id-encoding'
import { createTestnet, startTestRelay } from '../helpers/make-relay.js'
import { decodeTicket, memberPublicKeyZ32 } from '../../src/ticket.js'

async function withRelay (t, overrides = {}) {
  const testnet = await createTestnet(4)
  const relay = await startTestRelay(testnet, { MIRALL_RELAY_ACCESS: 'invite', ...overrides }, { admin: true })
  t.after(async () => { await relay.stop(); await testnet.destroy() })
  const { port } = relay.admin.server.address()
  const token = fs.readFileSync(relay.cfg.adminTokenFile, 'utf8').trim()

  const call = (path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts,
    headers: {
      ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token || token}` }),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...opts.headers
    }
  })
  return { relay, token, call, base: `http://127.0.0.1:${port}` }
}

const post = (call, path, body, opts = {}) =>
  call(path, { method: 'POST', body: JSON.stringify(body), ...opts })

test('POST /admin/invites without a token is 401', async (t) => {
  const { call } = await withRelay(t)
  const res = await post(call, '/admin/invites', { label: 'ben' }, { token: null })

  assert.equal(res.status, 401)
  assert.match(res.headers.get('www-authenticate'), /^Bearer /)
  assert.equal((await call('/admin/invites')).status, 200)
  assert.equal((await (await call('/admin/invites')).json()).total, 0, 'nothing was created')
})

test('a wrong token is 401 and creates nothing', async (t) => {
  const { call } = await withRelay(t)
  const res = await post(call, '/admin/invites', { label: 'ben' }, { token: 'z'.repeat(52) })
  assert.equal(res.status, 401)
  assert.equal((await (await call('/admin/invites')).json()).total, 0)
})

test('a valid token mints a ticket', async (t) => {
  const { relay, call } = await withRelay(t)
  const res = await post(call, '/admin/invites', { label: 'ben' })
  assert.equal(res.status, 201)

  const body = await res.json()
  assert.equal(body.label, 'ben')
  // expectRelayPublicKey is the assertion: a ticket for another relay is its own
  // error, not a member who silently never connects.
  const ticket = decodeTicket(body.ticket, { expectRelayPublicKey: relay.relay.publicKey })
  assert.ok(b4a.equals(ticket.relayPublicKey, relay.relay.publicKey), 'the ticket names THIS relay')
  assert.equal(memberPublicKeyZ32(ticket.memberSeed), body.publicKey)
})

test('the minted member is admitted by the firewall', async (t) => {
  const { relay, call } = await withRelay(t)
  const before = b4a.from(idEnc.decode(memberPublicKeyZ32(b4a.alloc(32, 3))))
  assert.equal(relay.firewall.firewall(before), true, 'a stranger is refused')

  const body = await (await post(call, '/admin/invites', { label: 'ben' })).json()
  const memberKey = b4a.from(idEnc.decode(body.publicKey))
  assert.equal(relay.firewall.firewall(memberKey), false, 'the roster view is live')
})

test('a duplicate label is 409 and a bad one is 400', async (t) => {
  const { call } = await withRelay(t)
  assert.equal((await post(call, '/admin/invites', { label: 'ben' })).status, 201)

  const dup = await post(call, '/admin/invites', { label: 'Ben' })
  assert.equal(dup.status, 409)
  assert.equal((await dup.json()).error, 'duplicate')

  const bad = await post(call, '/admin/invites', { label: 'a b' })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'bad-label')
})

test('GET /admin/invites never returns a seed', async (t) => {
  const { call } = await withRelay(t)
  await post(call, '/admin/invites', { label: 'ben' })
  await post(call, '/admin/invites', { label: 'ada' })

  const res = await call('/admin/invites')
  const text = await res.text()
  assert.ok(!text.includes('seedHex'))
  assert.ok(!/[0-9a-f]{64}/i.test(text), 'not even an unlabelled 64-hex run')

  const body = JSON.parse(text)
  assert.equal(body.active, 2)
  assert.equal(body.total, 2)
  assert.equal(body.members[0].sessions, 0, 'the live session count comes from the meter')
  assert.equal(body.members[0].ticket, undefined, 'a ticket is a secret, not a listing field')
})

test('GET /admin/invites?reveal=1 returns tickets', async (t) => {
  const { relay, call } = await withRelay(t)
  await post(call, '/admin/invites', { label: 'ben' })
  await post(call, '/admin/invites', { label: 'ada' })
  await call('/admin/invites/ada', { method: 'DELETE' })

  const body = await (await call('/admin/invites?reveal=1')).json()
  const ben = body.members.find((m) => m.label === 'ben')
  const ada = body.members.find((m) => m.label === 'ada')

  assert.ok(b4a.equals(
    decodeTicket(ben.ticket, { expectRelayPublicKey: relay.relay.publicKey }).relayPublicKey,
    relay.relay.publicKey
  ))
  assert.equal(ada.ticket, undefined, 'a revoked member has no ticket to reprint')
})

test('DELETE revokes and reports sessionsClosed', async (t) => {
  const { relay, call } = await withRelay(t)
  const ben = await (await post(call, '/admin/invites', { label: 'ben' })).json()
  const memberKey = b4a.from(idEnc.decode(ben.publicKey))
  assert.equal(relay.firewall.firewall(memberKey), false)

  const res = await call('/admin/invites/ben', { method: 'DELETE' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.label, 'ben')
  assert.ok(body.revoked)
  assert.equal(body.sessionsClosed, 0, 'nothing was connected')
  assert.equal(relay.firewall.firewall(memberKey), true, 'refused immediately, not on next boot')

  assert.equal((await call('/admin/invites/nobody', { method: 'DELETE' })).status, 404)
})

test('bans can be set and cleared over the surface', async (t) => {
  const { relay, call } = await withRelay(t)
  const ben = await (await post(call, '/admin/invites', { label: 'ben' })).json()
  const memberKey = b4a.from(idEnc.decode(ben.publicKey))

  const banned = await post(call, '/admin/bans', { key: ben.publicKey })
  assert.equal(banned.status, 200)
  assert.equal((await banned.json()).sessionsClosed, 0)
  assert.equal(relay.firewall.isBanned(b4a.toString(memberKey, 'hex')), true)

  const cleared = await call(`/admin/bans/${ben.publicKey}`, { method: 'DELETE' })
  assert.equal(cleared.status, 200)
  assert.equal((await cleared.json()).wasBanned, true)
  assert.equal(relay.firewall.firewall(memberKey), false)

  assert.equal((await post(call, '/admin/bans', { key: 'garbage' })).status, 400)
})

test('a malformed percent-escape in the path answers rather than hanging', async (t) => {
  const { call } = await withRelay(t)
  // decodeURIComponent throws URIError on %zz. Outside the handler's try that
  // rejection escaped, no response was written, and the socket was pinned for
  // the life of the process — one request per leak, repeatable by anyone with
  // the token.
  const res = await call('/admin/invites/%zz', { method: 'DELETE' })
  assert.equal(res.status, 500)
  assert.equal((await res.json()).error, 'internal error')

  assert.equal((await call('/admin/invites')).status, 200, 'and the server is still serving')
})

test('a ttlMs that is not a positive number is refused, not silently permanent', async (t) => {
  const { relay, call } = await withRelay(t)
  const ben = await (await post(call, '/admin/invites', { label: 'ben' })).json()
  const keyHex = b4a.toString(idEnc.decode(ben.publicKey), 'hex')

  // Every one of these falls through firewall.ban's `ttlMs > 0` test and would
  // become a PERMANENT ban whose only exit is a DELETE.
  // Not Infinity or NaN: JSON.stringify turns both into null, so they cannot
  // reach the server as anything but an omitted TTL.
  for (const ttlMs of ['1h', 0, -1000, {}, true]) {
    const res = await post(call, '/admin/bans', { key: ben.publicKey, ttlMs })
    assert.equal(res.status, 400, JSON.stringify(ttlMs))
    assert.equal(relay.firewall.isBanned(keyHex), false, 'and nothing was banned')
  }

  // An explicit null is the JSON way to say "no value", so it means the same as
  // omitting the field — and the response says so rather than leaving the caller
  // to infer it.
  const asNull = await post(call, '/admin/bans', { key: ben.publicKey, ttlMs: null })
  assert.equal((await asNull.json()).permanent, true)
  assert.equal((await call(`/admin/bans/${ben.publicKey}`, { method: 'DELETE' })).status, 200)

  const timed = await post(call, '/admin/bans', { key: ben.publicKey, ttlMs: 60_000 })
  assert.equal(timed.status, 200)
  assert.deepEqual(
    { permanent: (await timed.json()).permanent, ttlMs: 60_000 },
    { permanent: false, ttlMs: 60_000 },
    'and a real TTL reports itself as temporary'
  )

  const forever = await post(call, '/admin/bans', { key: ben.publicKey })
  assert.equal((await forever.json()).permanent, true, 'an omitted ttlMs is still permanent')
})

test('an unparsable key is 400 on the DELETE path too', async (t) => {
  const { call } = await withRelay(t)
  // idEnc.normalize(id) used to be evaluated before hexOfKey(id) in the same
  // argument list, so this reported 500 and logged the server as at fault.
  const res = await call('/admin/bans/garbage', { method: 'DELETE' })
  assert.equal(res.status, 400)
})

test('an oversized body is refused', async (t) => {
  const { call } = await withRelay(t)
  const res = await post(call, '/admin/invites', { label: 'x'.repeat(8192) })
  assert.equal(res.status, 413)
})

test('a non-JSON body is 400', async (t) => {
  const { call } = await withRelay(t)
  const res = await call('/admin/invites', {
    method: 'POST',
    body: 'not json',
    headers: { 'content-type': 'application/json' }
  })
  assert.equal(res.status, 400)
})

test('writes to a non-admin path are still 405', async (t) => {
  const { base } = await withRelay(t)
  assert.equal((await fetch(base + '/status.json', { method: 'POST' })).status, 405)
})

// fetch() refuses to send a Host header — it is a forbidden name — and the guard
// is about exactly that header, so this one request goes out raw.
function requestWithHost (port, path, host, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path, method: 'POST', headers: { host, ...headers } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ label: 'ben' }))
  })
}

test('the Host guard covers /admin/*', async (t) => {
  const { relay, token } = await withRelay(t)
  const { port } = relay.admin.server.address()
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // The write surface is browser-reachable too, so DNS rebinding reaches it the
  // same way it reaches the page — and a valid token does not help, because the
  // browser attaches nothing of the sort.
  assert.equal(await requestWithHost(port, '/admin/invites', 'evil.example', auth), 403)
  assert.equal(await requestWithHost(port, '/admin/invites', '127.0.0.1', auth), 201, 'loopback is fine')
})

test('ADMIN_WRITE=false removes the surface', async (t) => {
  const testnet = await createTestnet(4)
  const relay = await startTestRelay(testnet, {
    MIRALL_RELAY_ACCESS: 'invite',
    MIRALL_RELAY_ADMIN_WRITE: 'false'
  }, { admin: true })
  t.after(async () => { await relay.stop(); await testnet.destroy() })
  const base = `http://127.0.0.1:${relay.admin.server.address().port}`

  assert.equal(relay.auth, null, 'and no token file is minted for a surface that does not exist')
  assert.equal(fs.existsSync(relay.cfg.adminTokenFile), false)

  const res = await fetch(base + '/admin/invites', {
    method: 'POST',
    headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'ben' })
  })
  assert.equal(res.status, 404, 'removed, not merely unauthorized')
  assert.equal((await fetch(base + '/status.json')).status, 200, 'the page is untouched')
})

test('a write surface off loopback says so at boot', async (t) => {
  const lines = []
  const logger = {
    info () {},
    debug () {},
    error () {},
    fatal () {},
    trace () {},
    warn: (obj, msg) => lines.push(String(msg))
  }
  const testnet = await createTestnet(4)
  const relay = await startTestRelay(testnet, {
    MIRALL_RELAY_ADMIN_HOST: '127.0.0.1',
    MIRALL_RELAY_ADMIN_ALLOWED_HOSTS: 'relay.internal'
  }, { admin: true, logger })
  t.after(async () => { await relay.stop(); await testnet.destroy() })

  // Named hosts turn the guard ON whatever the bind, so this one is protected.
  assert.equal(lines.some((line) => line.includes('/admin/* write surface')), false)

  const bare = await createTestnet(4)
  const exposed = await startTestRelay(bare, { MIRALL_RELAY_ADMIN_HOST: '0.0.0.0' }, { logger })
  t.after(async () => { await exposed.stop(); await bare.destroy() })
  assert.ok(
    lines.some((line) => line.includes('/admin/* write surface') && line.includes('MIRALL_RELAY_ADMIN_WRITE=false')),
    'an inert rebinding guard over a write surface has to be said out loud'
  )
})

test('the token never appears in /status.json, /metrics or the page', async (t) => {
  const { token, call, base } = await withRelay(t)
  await post(call, '/admin/invites', { label: 'ben' })

  for (const path of ['/status.json', '/metrics', '/', '/.well-known/mirall-relay.json', '/readyz']) {
    const text = await (await fetch(base + path)).text()
    assert.ok(!text.includes(token), `${path} must not carry the admin token`)
    assert.ok(!text.includes('ben'), `${path} shows numbers, never names`)
    assert.ok(!/[0-9a-f]{64}/i.test(text), `${path} must not carry a 64-hex run`)
  }
})

test('the anonymous page reports membership as counts', async (t) => {
  const { call, base } = await withRelay(t)
  await post(call, '/admin/invites', { label: 'ben' })
  await post(call, '/admin/invites', { label: 'ada' })
  await call('/admin/invites/ada', { method: 'DELETE' })

  const status = await (await fetch(base + '/status.json')).json()
  assert.equal(status.access.mode, 'invite')
  assert.deepEqual(status.access.members, { active: 1, total: 2 })

  const metrics = await (await fetch(base + '/metrics')).text()
  assert.match(metrics, /relay_members_total\{state="active"\} 1/)
  assert.match(metrics, /relay_members_total\{state="revoked"\} 1/)
})
