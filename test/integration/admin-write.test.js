// The token-gated write surface, over real HTTP against a running relay.
//
// The load-bearing property under test is the SPLIT: the anonymous page keeps
// showing numbers, and every name and every secret lives behind the token.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import b4a from 'b4a'
import idEnc from 'hypercore-id-encoding'
import { createTestnet, startTestRelay } from '../helpers/make-relay.js'
import { withHttpRelay, request, jsonRequest, rawHttpRequest, bearer, adminHeaders, urlOf } from '../helpers/http-relay.js'
import { decodeTicket, memberPublicKeyZ32 } from '../../src/ticket.js'

const inviteRelay = (t, overrides = {}) => withHttpRelay(t, { MIRALL_RELAY_ACCESS: 'invite', ...overrides })

test('POST /admin/invites without a token is 401', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  const res = await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', body: { label: 'ben' } })

  assert.equal(res.statusCode, 401)
  assert.match(res.headers['www-authenticate'], /^Bearer /)

  const listing = await jsonRequest(urlOf(relay, '/admin/invites'), { headers: auth })
  assert.equal(listing.statusCode, 200)
  assert.equal(listing.json.access.members.total, 0, 'nothing was created')
})

test('a wrong token is 401 and creates nothing', async (t) => {
  const relay = await inviteRelay(t)
  const res = await jsonRequest(urlOf(relay, '/admin/invites'), {
    method: 'POST',
    headers: bearer('z'.repeat(52)),
    body: { label: 'ben' }
  })
  assert.equal(res.statusCode, 401)

  const listing = await jsonRequest(urlOf(relay, '/admin/invites'), { headers: bearer(relay.adminToken) })
  assert.equal(listing.json.access.members.total, 0)
})

test('a valid token mints a ticket', async (t) => {
  const relay = await inviteRelay(t)
  const res = await jsonRequest(urlOf(relay, '/admin/invites'), {
    method: 'POST',
    headers: bearer(relay.adminToken),
    body: { label: 'ben' }
  })
  assert.equal(res.statusCode, 201)

  assert.equal(res.json.label, 'ben')
  // expectRelayPublicKey is the assertion: a ticket for another relay is its own
  // error, not a member who silently never connects.
  const ticket = decodeTicket(res.json.ticket, { expectRelayPublicKey: relay.relay.publicKey })
  assert.ok(b4a.equals(ticket.relayPublicKey, relay.relay.publicKey), 'the ticket names THIS relay')
  assert.equal(memberPublicKeyZ32(ticket.memberSeed), res.json.publicKey)
})

test('the minted member is admitted by the firewall', async (t) => {
  const relay = await inviteRelay(t)
  const before = b4a.from(idEnc.decode(memberPublicKeyZ32(b4a.alloc(32, 3))))
  assert.equal(relay.firewall.firewall(before), true, 'a stranger is refused')

  const res = await jsonRequest(urlOf(relay, '/admin/invites'), {
    method: 'POST',
    headers: bearer(relay.adminToken),
    body: { label: 'ben' }
  })
  const memberKey = b4a.from(idEnc.decode(res.json.publicKey))
  assert.equal(relay.firewall.firewall(memberKey), false, 'the roster view is live')
})

test('a duplicate label is 409 and a bad one is 400', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  const mint = (label) => jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label } })

  assert.equal((await mint('ben')).statusCode, 201)

  const dup = await mint('Ben')
  assert.equal(dup.statusCode, 409)
  assert.equal(dup.json.error, 'duplicate')

  const bad = await mint('a b')
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json.error, 'bad-label')
})

test('GET /admin/invites never returns a seed', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  for (const label of ['ben', 'ada']) {
    await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label } })
  }

  const res = await jsonRequest(urlOf(relay, '/admin/invites'), { headers: auth })
  assert.ok(!res.body.includes('seedHex'))
  assert.ok(!/[0-9a-f]{64}/i.test(res.body), 'not even an unlabelled 64-hex run')

  assert.deepEqual(res.json.access.members, { active: 2, total: 2 })
  assert.equal(res.json.members[0].sessions, 0, 'the live session count comes from the meter')
  assert.equal(res.json.members[0].ticket, undefined, 'a ticket is a secret, not a listing field')
})

test('GET /admin/invites?reveal=1 returns tickets', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  for (const label of ['ben', 'ada']) {
    await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label } })
  }
  await jsonRequest(urlOf(relay, '/admin/invites/ada'), { method: 'DELETE', headers: auth })

  const { json } = await jsonRequest(urlOf(relay, '/admin/invites?reveal=1'), { headers: auth })
  const ben = json.members.find((m) => m.label === 'ben')
  const ada = json.members.find((m) => m.label === 'ada')

  assert.ok(b4a.equals(
    decodeTicket(ben.ticket, { expectRelayPublicKey: relay.relay.publicKey }).relayPublicKey,
    relay.relay.publicKey
  ))
  assert.equal(ada.ticket, undefined, 'a revoked member has no ticket to reprint')
})

test('DELETE revokes and reports sessionsClosed', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  const ben = await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label: 'ben' } })
  const memberKey = b4a.from(idEnc.decode(ben.json.publicKey))
  assert.equal(relay.firewall.firewall(memberKey), false)

  const res = await jsonRequest(urlOf(relay, '/admin/invites/ben'), { method: 'DELETE', headers: auth })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.label, 'ben')
  assert.ok(res.json.revoked)
  assert.equal(res.json.sessionsClosed, 0, 'nothing was connected')
  assert.equal(relay.firewall.firewall(memberKey), true, 'refused immediately, not on next boot')

  const gone = await jsonRequest(urlOf(relay, '/admin/invites/nobody'), { method: 'DELETE', headers: auth })
  assert.equal(gone.statusCode, 404)
})

test('bans can be set and cleared over the surface', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  const ben = await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label: 'ben' } })
  const memberKey = b4a.from(idEnc.decode(ben.json.publicKey))

  const banned = await jsonRequest(urlOf(relay, '/admin/bans'), {
    method: 'POST',
    headers: auth,
    body: { key: ben.json.publicKey }
  })
  assert.equal(banned.statusCode, 200)
  assert.equal(banned.json.sessionsClosed, 0)
  assert.equal(relay.firewall.isBanned(b4a.toString(memberKey, 'hex')), true)

  const cleared = await jsonRequest(urlOf(relay, `/admin/bans/${ben.json.publicKey}`), { method: 'DELETE', headers: auth })
  assert.equal(cleared.statusCode, 200)
  assert.equal(cleared.json.wasBanned, true)
  assert.equal(relay.firewall.firewall(memberKey), false)

  const garbage = await jsonRequest(urlOf(relay, '/admin/bans'), { method: 'POST', headers: auth, body: { key: 'garbage' } })
  assert.equal(garbage.statusCode, 400)
})

test('a malformed percent-escape in the path answers rather than hanging', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  const res = await jsonRequest(urlOf(relay, '/admin/invites/%zz'), { method: 'DELETE', headers: auth })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json.error, 'bad-path')

  const listing = await jsonRequest(urlOf(relay, '/admin/invites'), { headers: auth })
  assert.equal(listing.statusCode, 200, 'and the server is still serving')
})

test('a ttlMs that is not a positive number is refused, not silently permanent', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  const ben = await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label: 'ben' } })
  const keyHex = b4a.toString(idEnc.decode(ben.json.publicKey), 'hex')
  const ban = (body) => jsonRequest(urlOf(relay, '/admin/bans'), { method: 'POST', headers: auth, body })

  // Every one of these falls through firewall.ban's `ttlMs > 0` test and would
  // become a PERMANENT ban whose only exit is a DELETE.
  // Not Infinity or NaN: JSON.stringify turns both into null, so they cannot
  // reach the server as anything but an omitted TTL.
  for (const ttlMs of ['1h', 0, -1000, {}, true]) {
    const res = await ban({ key: ben.json.publicKey, ttlMs })
    assert.equal(res.statusCode, 400, JSON.stringify(ttlMs))
    assert.equal(relay.firewall.isBanned(keyHex), false, 'and nothing was banned')
  }

  // An explicit null is the JSON way to say "no value", so it means the same as
  // omitting the field — and the response says so rather than leaving the caller
  // to infer it.
  const asNull = await ban({ key: ben.json.publicKey, ttlMs: null })
  assert.equal(asNull.json.permanent, true)
  const cleared = await jsonRequest(urlOf(relay, `/admin/bans/${ben.json.publicKey}`), { method: 'DELETE', headers: auth })
  assert.equal(cleared.statusCode, 200)

  const timed = await ban({ key: ben.json.publicKey, ttlMs: 60_000 })
  assert.equal(timed.statusCode, 200)
  assert.deepEqual(
    { permanent: timed.json.permanent, ttlMs: 60_000 },
    { permanent: false, ttlMs: 60_000 },
    'and a real TTL reports itself as temporary'
  )

  const forever = await ban({ key: ben.json.publicKey })
  assert.equal(forever.json.permanent, true, 'an omitted ttlMs is still permanent')
})

test('an unparsable key is 400 on the DELETE path too', async (t) => {
  const relay = await inviteRelay(t)
  // Key parsing errors are client faults on every admin path.
  const res = await jsonRequest(urlOf(relay, '/admin/bans/garbage'), {
    method: 'DELETE',
    headers: bearer(relay.adminToken)
  })
  assert.equal(res.statusCode, 400)
})

test('an oversized body is refused', async (t) => {
  const relay = await inviteRelay(t)
  const res = await jsonRequest(urlOf(relay, '/admin/invites'), {
    method: 'POST',
    headers: bearer(relay.adminToken),
    body: { label: 'x'.repeat(8192) }
  })
  assert.equal(res.statusCode, 413)
})

test('a non-JSON body is 400', async (t) => {
  const relay = await inviteRelay(t)
  const res = await jsonRequest(urlOf(relay, '/admin/invites'), {
    method: 'POST',
    headers: bearer(relay.adminToken),
    body: 'not json'
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json.error, 'invalid-json')
})

test('writes to a non-admin path are still 405', async (t) => {
  const relay = await inviteRelay(t)
  const res = await request(urlOf(relay, '/status.json'), { method: 'POST' })
  assert.equal(res.statusCode, 405)
})

test('the Host guard covers /admin/*', async (t) => {
  const relay = await inviteRelay(t)
  const headers = adminHeaders(relay.adminToken, { 'content-type': 'application/json' })
  const mint = (host) => rawHttpRequest({
    port: relay.port,
    path: '/admin/invites',
    method: 'POST',
    host,
    headers,
    body: JSON.stringify({ label: 'ben' })
  })

  // The write surface is browser-reachable too, so DNS rebinding reaches it the
  // same way it reaches the page — and a valid token does not help, because the
  // browser attaches nothing of the sort.
  assert.equal((await mint('evil.example')).statusCode, 403)
  assert.equal((await mint('127.0.0.1')).statusCode, 201, 'loopback is fine')
})

test('ADMIN_WRITE=false removes the JSON surface', async (t) => {
  const relay = await inviteRelay(t, { MIRALL_RELAY_ADMIN_WRITE: 'false' })

  assert.equal(relay.auth, null, 'and no token file is minted for a surface that does not exist')
  assert.equal(fs.existsSync(relay.cfg.adminTokenFile), false)

  const res = await jsonRequest(urlOf(relay, '/admin/invites'), {
    method: 'POST',
    headers: bearer('anything'),
    body: { label: 'ben' }
  })
  assert.equal(res.statusCode, 404, 'removed, not merely unauthorized')
  assert.equal((await request(urlOf(relay, '/status.json'))).statusCode, 200, 'the page is untouched')
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
  await withHttpRelay(t, {
    MIRALL_RELAY_ADMIN_HOST: '127.0.0.1',
    MIRALL_RELAY_ADMIN_ALLOWED_HOSTS: 'relay.internal'
  }, { logger })

  // Named hosts turn the guard ON whatever the bind, so this one is protected.
  assert.equal(lines.some((line) => line.includes('/admin/* write surface')), false)

  // No admin server on this one — the warning is a boot-time property of the
  // config, so it does not need the port listening.
  const bare = await createTestnet(4)
  const exposed = await startTestRelay(bare, { MIRALL_RELAY_ADMIN_HOST: '0.0.0.0' }, { logger })
  t.after(async () => { await exposed.stop(); await bare.destroy() })
  assert.ok(
    lines.some((line) => line.includes('/admin/* write surface') && line.includes('MIRALL_RELAY_ADMIN_WRITE=false')),
    'an inert rebinding guard over a write surface has to be said out loud'
  )
})

test('one member\'s ticket is revealed without fetching everybody\'s', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  for (const label of ['ben', 'ada']) {
    await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label } })
  }

  // The page uses this route. The bulk ?reveal=1 attaches a live bearer
  // credential for EVERY active member, so using it to show one person's invite
  // would pull the whole roster's secrets to the caller to discard all but one.
  const one = await jsonRequest(urlOf(relay, '/admin/invites/ben?reveal=1'), { headers: auth })
  assert.equal(one.json.label, 'ben')
  assert.equal(one.json.sessions, 0)
  assert.ok(b4a.equals(
    decodeTicket(one.json.ticket, { expectRelayPublicKey: relay.relay.publicKey }).relayPublicKey,
    relay.relay.publicKey
  ))
  assert.ok(!one.body.includes('ada'), 'and nobody else is in the response')

  const without = await jsonRequest(urlOf(relay, '/admin/invites/ben'), { headers: auth })
  assert.equal(without.json.ticket, undefined, 'the ticket is opt-in even for one member')
  assert.equal(without.json.publicKey, one.json.publicKey)
  assert.ok(!/[0-9a-f]{64}/i.test(without.body), 'and never a seed')

  const nobody = await jsonRequest(urlOf(relay, '/admin/invites/nobody'), { headers: auth })
  assert.equal(nobody.statusCode, 404)
})

test('a revoked member has no ticket to reveal', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label: 'ben' } })
  await jsonRequest(urlOf(relay, '/admin/invites/ben'), { method: 'DELETE', headers: auth })

  const gone = await jsonRequest(urlOf(relay, '/admin/invites/ben?reveal=1'), { headers: auth })
  assert.equal(gone.json.ticket, undefined)
  assert.ok(gone.json.revoked)
})

test('the management page is served without a token, and carries no data', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)

  // A <link> and a <script src> cannot send an Authorization header, so the
  // shell and its assets are the only three paths under /admin/ served without
  // one. They are what ASKS for the token.
  const before = await request(urlOf(relay, '/admin/'))

  // A label that cannot collide with the page's own example copy.
  await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label: 'zonk-7' } })

  const page = await request(urlOf(relay, '/admin/'))
  assert.equal(page.statusCode, 200)
  assert.match(page.headers['content-type'], /text\/html/)

  assert.equal(page.body, before.body, 'the shell is static — minting a member cannot change it')
  assert.ok(!page.body.includes('zonk-7'), 'no member reaches it')
  assert.ok(!/mirall:\/\/relay\/[a-z0-9]/.test(page.body), 'and no ticket')

  for (const [path, type] of [['/admin/style.css', /text\/css/], ['/admin/app.js', /javascript/], ['/admin/copy-button.js', /javascript/]]) {
    const res = await request(urlOf(relay, path))
    assert.equal(res.statusCode, 200, path)
    assert.match(res.headers['content-type'], type)
  }
})

test('/admin redirects to the trailing slash', async (t) => {
  const relay = await inviteRelay(t)
  // Without it the page's relative asset URLs resolve against the root and the
  // stylesheet 404s.
  const res = await request(urlOf(relay, '/admin'))
  assert.equal(res.statusCode, 308)
  assert.equal(res.headers.location, 'admin/')
})

test('serving the page does not open the data behind it', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label: 'ben' } })

  // The carve-out is exactly three paths. Everything that returns a name or a
  // secret still needs the bearer.
  for (const path of ['/admin/invites', '/admin/invites?reveal=1']) {
    assert.equal((await request(urlOf(relay, path))).statusCode, 401, path)
  }
  assert.equal((await request(urlOf(relay, '/admin/invites/ben'), { method: 'DELETE' })).statusCode, 401)
  assert.equal((await request(urlOf(relay, '/admin/invites/ben?reveal=1'))).statusCode, 401)
  assert.equal((await request(urlOf(relay, '/admin/'), { method: 'POST' })).statusCode, 405, 'the shell is a read')
})

test('ADMIN_WRITE=false removes the page too', async (t) => {
  const relay = await withHttpRelay(t, { MIRALL_RELAY_ADMIN_WRITE: 'false' })

  for (const path of ['/admin/', '/admin', '/admin/style.css', '/admin/app.js', '/admin/copy-button.js']) {
    assert.equal((await request(urlOf(relay, path))).statusCode, 404, path)
  }
})

test('the listing carries what the page renders from, in one round trip', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  for (const label of ['ben', 'ada']) {
    await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label } })
  }
  await jsonRequest(urlOf(relay, '/admin/invites/ada'), { method: 'DELETE', headers: auth })

  const { json } = await jsonRequest(urlOf(relay, '/admin/invites'), { headers: auth })
  // Not /status.json: that is the anonymous surface and ADMIN_UI turns it off,
  // which must not take the only way to mint an invite with it.
  assert.equal(json.relay.publicKey, relay.relay.publicKeyZ32)
  assert.equal(json.access.mode, 'invite')
  assert.deepEqual(json.access.members, { active: 1, total: 2 })
  assert.equal(typeof json.access.refusedLastHour, 'number')
  assert.equal(json.members.length, 2)
  // One copy of each count. Two in one payload is the shape that disagrees.
  assert.equal(json.active, undefined)
  assert.equal(json.total, undefined)
})

test('the token never appears in /status.json, /metrics or the page', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label: 'ben' } })

  for (const path of ['/status.json', '/metrics', '/', '/.well-known/mirall-relay.json', '/readyz']) {
    const { body } = await request(urlOf(relay, path))
    assert.ok(!body.includes(relay.adminToken), `${path} must not carry the admin token`)
    assert.ok(!body.includes('ben'), `${path} shows numbers, never names`)
    assert.ok(!/[0-9a-f]{64}/i.test(body), `${path} must not carry a 64-hex run`)
  }
})

test('the anonymous page reports membership as counts', async (t) => {
  const relay = await inviteRelay(t)
  const auth = bearer(relay.adminToken)
  for (const label of ['ben', 'ada']) {
    await jsonRequest(urlOf(relay, '/admin/invites'), { method: 'POST', headers: auth, body: { label } })
  }
  await jsonRequest(urlOf(relay, '/admin/invites/ada'), { method: 'DELETE', headers: auth })

  const status = await jsonRequest(urlOf(relay, '/status.json'))
  assert.equal(status.json.access.mode, 'invite')
  assert.deepEqual(status.json.access.members, { active: 1, total: 2 })

  const metrics = await request(urlOf(relay, '/metrics'))
  assert.match(metrics.body, /relay_members_total\{state="active"\} 1/)
  assert.match(metrics.body, /relay_members_total\{state="revoked"\} 1/)
})
