// The operator surface, exercised over real HTTP against a running relay.
import test from 'node:test'
import assert from 'node:assert/strict'
import idEnc from 'hypercore-id-encoding'
import b4a from 'b4a'
import { createTestnet, startTestRelay, relayedPair, waitFor } from '../helpers/make-relay.js'

async function withRelay (t, overrides = {}) {
  const testnet = await createTestnet(4)
  const relay = await startTestRelay(testnet, overrides, { admin: true })
  t.after(async () => { await relay.stop(); await testnet.destroy() })
  const { port } = relay.admin.server.address()
  return { relay, base: `http://127.0.0.1:${port}` }
}

test('/healthz reports the process is up', async (t) => {
  const { base } = await withRelay(t)
  const res = await fetch(base + '/healthz')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})

test('/readyz reports readiness and reachability', async (t) => {
  const { relay, base } = await withRelay(t)
  const res = await fetch(base + '/readyz')
  const body = await res.json()

  assert.equal(body.ready, true)
  assert.equal(body.firewalled, false, 'the testnet relay is directly reachable')
  assert.equal(res.status, 200)
  assert.equal(body.publicKey, relay.relay.publicKeyZ32)
})

test('/readyz turns 503 once the relay is closed', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())
  const relay = await startTestRelay(testnet, {}, { admin: true })
  const { port } = relay.admin.server.address()
  const base = `http://127.0.0.1:${port}`

  assert.equal((await fetch(base + '/readyz')).status, 200)

  await relay.relay.close()
  const res = await fetch(base + '/readyz')
  assert.equal(res.status, 503, 'a load balancer must be able to drain us')
  assert.equal((await res.json()).ready, false)

  await relay.admin.close()
})

test('the capability doc carries the key a user would paste into Mirall', async (t) => {
  const { relay, base } = await withRelay(t, {
    MIRALL_RELAY_REGION: 'eu-fsn1',
    MIRALL_RELAY_OPERATOR: 'example'
  })
  const res = await fetch(base + '/.well-known/mirall-relay.json')
  assert.equal(res.status, 200)
  const doc = await res.json()

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
  const testnet = await createTestnet(4)
  const relay = await startTestRelay(testnet, { MIRALL_RELAY_METER_MS: '50' }, { admin: true })
  t.after(async () => { await relay.stop(); await testnet.destroy() })
  const { port } = relay.admin.server.address()
  const base = `http://127.0.0.1:${port}`

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())

  pair.b.on('data', () => {})
  pair.a.write(b4a.alloc(64 * 1024, 1))

  await waitFor(async () => {
    const text = await (await fetch(base + '/metrics')).text()
    return /relay_bytes_relayed_total (\d+)/.test(text) && Number(RegExp.$1) > 0
  }, { message: 'bytes to show up on /metrics', timeoutMs: 30_000 })

  const res = await fetch(base + '/metrics')
  assert.match(res.headers.get('content-type'), /text\/plain/)
  const text = await res.text()
  assert.match(text, /relay_links_active \d+/)
  assert.match(text, /relay_ready 1/)
  assert.match(text, /relay_dht_firewalled 0/)
  // blind-relay's own counters are mirrored on render, not on a timer
  assert.match(text, /relay_bl_pairings\{state="matched"\} 1/)
})

test('unknown paths 404 and writes to the anonymous surface are refused', async (t) => {
  const { base } = await withRelay(t)
  assert.equal((await fetch(base + '/')).status, 200, 'the root is the status page')
  assert.equal((await fetch(base + '/nope')).status, 404)
  // /admin/* is the ONE place that takes a write. The page shell there is served
  // without a token — it is what asks for one — but everything that returns a
  // name or a secret answers 401 rather than 404, so an operator who forgot the
  // token is told which of the two problems they have.
  assert.equal((await fetch(base + '/admin', { redirect: 'manual' })).status, 308)
  assert.equal((await fetch(base + '/admin/')).status, 200, 'the members page')
  assert.equal((await fetch(base + '/admin/invites')).status, 401, 'the data behind it')
  assert.equal((await fetch(base + '/healthz', { method: 'POST' })).status, 405)
  assert.equal((await fetch(base + '/metrics', { method: 'DELETE' })).status, 405)
})

test('the admin surface binds to loopback only', async (t) => {
  const { relay } = await withRelay(t)
  assert.equal(relay.cfg.adminHost, '127.0.0.1', 'never expose relay internals publicly by default')
  assert.equal(relay.admin.server.address().address, '127.0.0.1')
})

test('/readyz and /metrics both say whether reachability was measured', async (t) => {
  // ASSUME_REACHABLE forces firewalled:false, so on its own that field cannot
  // tell a verified relay from one that was told to assume. A platform health
  // check reading only `firewalled` reports "reachable from the internet" on
  // evidence that does not exist — which is what every StartOS surface did.
  const { base } = await withRelay(t)
  const body = await (await fetch(base + '/readyz')).json()
  assert.equal(body.firewalled, false)
  assert.equal(body.probed, false, 'the test rig sets ASSUME_REACHABLE')

  const text = await (await fetch(base + '/metrics')).text()
  assert.match(text, /relay_dht_firewalled 0/)
  assert.match(text, /relay_reachability_probed 0/, 'the alertable form of the same fact')
  assert.match(text, /# HELP relay_reachability_probed .*asserted/)
})

test('a relay that probes for itself reports probed on both surfaces', async (t) => {
  const testnet = await createTestnet(4)
  // Override the rig's ASSUME_REACHABLE so hyperdht makes its own determination.
  const relay = await startTestRelay(testnet, { MIRALL_RELAY_ASSUME_REACHABLE: 'false' }, { admin: true })
  t.after(async () => { await relay.stop(); await testnet.destroy() })
  const base = `http://127.0.0.1:${relay.admin.server.address().port}`

  assert.equal((await (await fetch(base + '/readyz')).json()).probed, true)
  assert.match(await (await fetch(base + '/metrics')).text(), /relay_reachability_probed 1/)
})
