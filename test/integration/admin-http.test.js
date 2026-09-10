// The operator surface, exercised over real HTTP against a running relay.
import test from 'node:test'
import assert from 'node:assert/strict'
import idEnc from 'hypercore-id-encoding'
import b4a from 'b4a'
import { createTestnet, startTestRelay, relayedPair, waitFor } from '../helpers/make-relay.js'
import { withHttpRelay, httpRelay, request, jsonRequest, urlOf } from '../helpers/http-relay.js'

test('/healthz reports the process is up', async (t) => {
  const relay = await withHttpRelay(t)
  const out = await jsonRequest(urlOf(relay, '/healthz'))
  assert.equal(out.statusCode, 200)
  assert.deepEqual(out.json, { ok: true })
})

test('/readyz reports readiness and reachability', async (t) => {
  const relay = await withHttpRelay(t)
  const out = await jsonRequest(urlOf(relay, '/readyz'))

  assert.equal(out.json.ready, true)
  assert.equal(out.json.firewalled, false, 'the testnet relay is directly reachable')
  assert.equal(out.statusCode, 200)
  assert.equal(out.json.publicKey, relay.relay.publicKeyZ32)
})

test('/readyz turns 503 once the relay is closed', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())
  const relay = httpRelay(await startTestRelay(testnet, {}, { admin: true }), testnet)

  assert.equal((await request(urlOf(relay, '/readyz'))).statusCode, 200)

  await relay.relay.close()
  const out = await jsonRequest(urlOf(relay, '/readyz'))
  assert.equal(out.statusCode, 503, 'a load balancer must be able to drain us')
  assert.equal(out.json.ready, false)

  await relay.admin.close()
})

test('the capability doc carries the key a user would paste into Mirall', async (t) => {
  const relay = await withHttpRelay(t, {
    MIRALL_RELAY_REGION: 'eu-fsn1',
    MIRALL_RELAY_OPERATOR: 'example'
  })
  const out = await jsonRequest(urlOf(relay, '/.well-known/mirall-relay.json'))
  assert.equal(out.statusCode, 200)
  const doc = out.json

  assert.equal(doc.service, 'mirall-relay')
  assert.equal(doc.region, 'eu-fsn1')
  assert.equal(doc.operator, 'example')
  assert.equal(doc.publicKey, relay.relay.publicKeyZ32)
  assert.deepEqual(
    b4a.from(idEnc.decode(doc.publicKey)),
    b4a.from(relay.relay.publicKey),
    'the advertised key must decode to the relay identity'
  )
  assert.equal(typeof doc.caps.maxLinkBytes, 'number')
})

test('/metrics renders Prometheus text reflecting live traffic', async (t) => {
  const relay = await withHttpRelay(t, { MIRALL_RELAY_METER_MS: '50' })

  const pair = await relayedPair(relay.testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())

  pair.b.on('data', () => {})
  pair.a.write(b4a.alloc(64 * 1024, 1))

  await waitFor(async () => {
    const { body } = await request(urlOf(relay, '/metrics'))
    return /relay_bytes_relayed_total (\d+)/.test(body) && Number(RegExp.$1) > 0
  }, { message: 'bytes to show up on /metrics', timeoutMs: 30_000 })

  const out = await request(urlOf(relay, '/metrics'))
  assert.match(out.headers['content-type'], /text\/plain/)
  assert.match(out.body, /relay_links_active \d+/)
  assert.match(out.body, /relay_ready 1/)
  assert.match(out.body, /relay_dht_firewalled 0/)
  // blind-relay's own counters are mirrored on render, not on a timer
  assert.match(out.body, /relay_bl_pairings\{state="matched"\} 1/)
})

test('unknown paths 404 and writes to the anonymous surface are refused', async (t) => {
  const relay = await withHttpRelay(t)
  const statusOf = async (path, opts) => (await request(urlOf(relay, path), opts)).statusCode

  assert.equal(await statusOf('/'), 200, 'the root is the status page')
  assert.equal(await statusOf('/nope'), 404)
  // /admin/* is the ONE place that takes a write. The page shell there is served
  // without a token — it is what asks for one — but everything that returns a
  // name or a secret answers 401 rather than 404, so an operator who forgot the
  // token is told which of the two problems they have.
  assert.equal(await statusOf('/admin'), 308)
  assert.equal(await statusOf('/admin/'), 200, 'the members page')
  assert.equal(await statusOf('/admin/invites'), 401, 'the data behind it')
  assert.equal(await statusOf('/healthz', { method: 'POST' }), 405)
  assert.equal(await statusOf('/metrics', { method: 'DELETE' }), 405)
})

test('the admin surface binds to loopback only', async (t) => {
  const relay = await withHttpRelay(t)
  assert.equal(relay.cfg.adminHost, '127.0.0.1', 'never expose relay internals publicly by default')
  assert.equal(relay.admin.server.address().address, '127.0.0.1')
})

test('/readyz and /metrics both say whether reachability was measured', async (t) => {
  // ASSUME_REACHABLE forces firewalled:false, so on its own that field cannot
  // tell a verified relay from one that was told to assume. A platform health
  // check reading only `firewalled` reports "reachable from the internet" on
  // evidence that does not exist — which is what every StartOS surface did.
  const relay = await withHttpRelay(t)
  const { json } = await jsonRequest(urlOf(relay, '/readyz'))
  assert.equal(json.firewalled, false)
  assert.equal(json.probed, false, 'the test rig sets ASSUME_REACHABLE')

  const { body } = await request(urlOf(relay, '/metrics'))
  assert.match(body, /relay_dht_firewalled 0/)
  assert.match(body, /relay_reachability_probed 0/, 'the alertable form of the same fact')
  assert.match(body, /# HELP relay_reachability_probed .*asserted/)
})

test('a relay that probes for itself reports probed on both surfaces', async (t) => {
  // Override the rig's ASSUME_REACHABLE so hyperdht makes its own determination.
  const relay = await withHttpRelay(t, { MIRALL_RELAY_ASSUME_REACHABLE: 'false' })

  assert.equal((await jsonRequest(urlOf(relay, '/readyz'))).json.probed, true)
  assert.match((await request(urlOf(relay, '/metrics'))).body, /relay_reachability_probed 1/)
})
