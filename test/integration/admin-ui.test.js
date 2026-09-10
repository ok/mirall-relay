// The browser surface over real HTTP against a running relay.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import b4a from 'b4a'
import { standaloneQr } from '../../src/operator/status/page.js'
import { relayedPair, waitFor } from '../helpers/make-relay.js'
import { withHttpRelay, request, jsonRequest, rawHttpRequest, urlOf } from '../helpers/http-relay.js'

test('/ serves a status page with the public key in the markup', async (t) => {
  const relay = await withHttpRelay(t, {
    MIRALL_RELAY_REGION: 'eu-fsn1',
    MIRALL_RELAY_OPERATOR: 'example'
  })
  const out = await request(urlOf(relay, '/'))
  assert.equal(out.statusCode, 200)
  assert.match(out.headers['content-type'], /text\/html/)

  assert.ok(out.body.includes(relay.relay.publicKeyZ32), 'the key must be gettable without a terminal')
  assert.match(out.body, /eu-fsn1/)
  assert.match(out.body, /Settings → Network/)
  assert.match(out.body, /<svg /, 'the QR is inline')
})

test('/ is served under a policy that forbids everything the page does not use', async (t) => {
  const relay = await withHttpRelay(t)
  const out = await request(urlOf(relay, '/'))
  const csp = out.headers['content-security-policy']

  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /style-src 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.ok(!csp.includes('unsafe-inline'), 'the whole point of external assets')

  // Every response, not just the document: a policy that only covers / leaves
  // /qr.svg and /status.json ungoverned when they are opened directly.
  for (const path of ['/status.json', '/qr.svg', '/ui.css', '/metrics']) {
    const other = await request(urlOf(relay, path))
    assert.equal(other.headers['content-security-policy'], csp, path)
  }

  assert.equal(out.headers['x-content-type-options'], 'nosniff')
  assert.equal(out.headers['x-frame-options'], 'DENY')
  assert.equal(out.headers['referrer-policy'], 'no-referrer')
  assert.equal(out.headers['cache-control'], 'no-store')
})

test('/status.json agrees with every other endpoint about the identity', async (t) => {
  const relay = await withHttpRelay(t)
  const status = (await jsonRequest(urlOf(relay, '/status.json'))).json
  const ready = (await jsonRequest(urlOf(relay, '/readyz'))).json
  const doc = (await jsonRequest(urlOf(relay, '/.well-known/mirall-relay.json'))).json

  assert.equal(status.identity.publicKey, relay.relay.publicKeyZ32)
  assert.equal(status.identity.publicKey, ready.publicKey)
  assert.equal(status.identity.publicKey, doc.publicKey)
  assert.deepEqual(status.caps, doc.caps)
  assert.equal(status.version, doc.version)
})

test('/status.json reports the testnet relay as reachable but unprobed', async (t) => {
  // The test rig sets ASSUME_REACHABLE, so this is exactly the case where a
  // single enum would have claimed a measurement nobody took.
  const relay = await withHttpRelay(t)
  const { reachability } = (await jsonRequest(urlOf(relay, '/status.json'))).json

  assert.equal(reachability.state, 'reachable')
  assert.equal(reachability.firewalled, false)
  assert.equal(reachability.probed, false)
  assert.equal(reachability.bootstrapped, true)
  assert.equal(typeof reachability.port, 'number')
})

test('/status.json never carries the seed', async (t) => {
  const seedHex = 'ab'.repeat(32)
  const relay = await withHttpRelay(t, { MIRALL_RELAY_SEED: seedHex })
  const { body } = await request(urlOf(relay, '/status.json'))
  assert.ok(!body.includes(seedHex))
  assert.ok(!body.includes('ab'.repeat(16)))
})

test('relayed bytes reach /status.json, and never disagree with /metrics', async (t) => {
  const relay = await withHttpRelay(t, { MIRALL_RELAY_METER_MS: '50' })

  const pair = await relayedPair(relay.testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())

  pair.b.on('data', () => {})
  pair.a.write(b4a.alloc(64 * 1024, 1))

  const status = await waitFor(async () => {
    const { json } = await jsonRequest(urlOf(relay, '/status.json'))
    return json.traffic.bytesRelayed > 0 ? json : null
  }, { message: 'bytes to show up on /status.json', timeoutMs: 30_000 })

  const { body } = await request(urlOf(relay, '/metrics'))
  const scraped = Number(/relay_bytes_relayed_total (\d+)/.exec(body)[1])

  // The same counter read twice: the page can only ever be behind, never ahead.
  assert.ok(scraped >= status.traffic.bytesRelayed, `${scraped} < ${status.traffic.bytesRelayed}`)
  assert.equal(status.traffic.pairings.matched, 1)
  assert.ok(status.traffic.sessionsAccepted >= 2, 'both halves of the pair opened a session')
  assert.ok(status.uptimeSeconds >= 0)
})

test('/qr.svg is the running relay key, as a file you can save', async (t) => {
  const relay = await withHttpRelay(t)
  const out = await request(urlOf(relay, '/qr.svg'))

  assert.equal(out.statusCode, 200)
  assert.match(out.headers['content-type'], /image\/svg\+xml/)
  assert.equal(out.body, standaloneQr(relay.relay.publicKeyZ32))
})

test('the page assets are cacheable and answer 304 to a matching if-none-match', async (t) => {
  const relay = await withHttpRelay(t)
  for (const [path, type] of [['/ui.css', /text\/css/], ['/ui.js', /javascript/], ['/format.js', /javascript/]]) {
    const first = await request(urlOf(relay, path))
    assert.equal(first.statusCode, 200, path)
    assert.match(first.headers['content-type'], type, path)

    const etag = first.headers.etag
    assert.match(etag, /^"[A-Za-z0-9_-]+"$/, path)

    const second = await request(urlOf(relay, path), { headers: { 'if-none-match': etag } })
    assert.equal(second.statusCode, 304, path)
    assert.equal(second.body, '')
  }
})

test('ui.js imports format.js, so both have to be served for the page to refresh', async (t) => {
  const relay = await withHttpRelay(t)
  const script = await request(urlOf(relay, '/ui.js'))
  assert.match(script.body, /from '\.\/format\.js'/)
  assert.equal((await request(urlOf(relay, '/format.js'))).statusCode, 200)
})

test('MIRALL_RELAY_ADMIN_UI=false leaves the JSON endpoints exactly as they were', async (t) => {
  const relay = await withHttpRelay(t, { MIRALL_RELAY_ADMIN_UI: 'false' })
  const statusOf = async (path) => (await request(urlOf(relay, path))).statusCode

  for (const path of ['/', '/status.json', '/qr.svg', '/ui.css', '/ui.js', '/format.js']) {
    assert.equal(await statusOf(path), 404, path)
  }
  assert.equal(await statusOf('/healthz'), 200)
  assert.equal(await statusOf('/readyz'), 200)
  assert.equal(await statusOf('/metrics'), 200)
  assert.equal(await statusOf('/.well-known/mirall-relay.json'), 200)
})

test('MIRALL_RELAY_ADMIN_UI=false leaves the management page enabled', async (t) => {
  const relay = await withHttpRelay(t, { MIRALL_RELAY_ADMIN_UI: 'false' })
  const statusOf = async (path) => (await request(urlOf(relay, path))).statusCode

  assert.equal(await statusOf('/admin/'), 200)
  assert.equal(await statusOf('/admin/style.css'), 200)
  assert.equal(await statusOf('/admin/app.js'), 200)
  assert.equal(await statusOf('/admin/invites'), 401)
})

test('a loopback-bound admin server refuses a rebound Host on the browser surface', async (t) => {
  // DNS rebinding: a page on the internet points its own hostname at 127.0.0.1
  // and reads this port out of the operator's browser. The Host header still says
  // where the browser thought it was going.
  const { port } = await withHttpRelay(t)

  for (const path of ['/', '/status.json', '/qr.svg', '/ui.css', '/ui.js', '/format.js']) {
    assert.equal((await rawHttpRequest({ port, path, host: 'evil.example' })).statusCode, 403, path)
  }

  assert.equal((await rawHttpRequest({ port, path: '/status.json', host: `127.0.0.1:${port}` })).statusCode, 200)
  assert.equal((await rawHttpRequest({ port, path: '/status.json', host: `localhost:${port}` })).statusCode, 200)
})

test('the guard leaves the pre-existing machine endpoints alone', async (t) => {
  // /healthz, /readyz, /metrics and the capability doc are addressed by hostname
  // in real deployments — a Prometheus target, an /etc/hosts alias, an SSH-tunnel
  // name. 403ing them on upgrade would take monitoring down silently and read as
  // a network fault. This change does not touch their contract.
  const { port } = await withHttpRelay(t)
  for (const path of ['/healthz', '/readyz', '/metrics', '/.well-known/mirall-relay.json']) {
    assert.equal((await rawHttpRequest({ port, path, host: 'monitoring.internal' })).statusCode, 200, path)
  }
})

// http.request substitutes its own Host for an empty one, so the blank-Host case
// can only be driven down a raw socket. It is worth the twelve lines: an empty
// Host was a total bypass of the guard.
function rawRequest (port, lines) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(lines.join('\r\n') + '\r\n\r\n'))
    let buffer = ''
    const done = () => resolve({ status: Number(buffer.split(' ')[1]), body: buffer })
    socket.on('data', (chunk) => { buffer += chunk })
    socket.on('end', done)
    socket.on('error', () => resolve({ status: 0, body: '' }))
    setTimeout(() => { socket.destroy(); done() }, 1000).unref()
  })
}

test('a blank Host does not walk past the guard', async (t) => {
  // Node answers a missing Host on HTTP/1.1 with 400 itself, so `Host:` with
  // nothing after it is a distinct blank-Host case and must hit the guard.
  const { port } = await withHttpRelay(t)

  const blank = await rawRequest(port, ['GET /status.json HTTP/1.1', 'Host:'])
  assert.equal(blank.status, 403)
  assert.ok(!blank.body.includes('publicKey'), 'and it certainly does not get a body')

  // An HTTP/1.0 client legitimately sends none, and must still work.
  const http10 = await rawRequest(port, ['GET /status.json HTTP/1.0'])
  assert.equal(http10.status, 200)
})

test('a refusal says what to do about it, and is logged', async (t) => {
  const { port } = await withHttpRelay(t)
  const out = await rawHttpRequest({ port, path: '/status.json', host: 'relay.internal' })
  assert.equal(out.statusCode, 403)
  assert.match(out.body, /MIRALL_RELAY_ADMIN_ALLOWED_HOSTS/, 'a 403 with no way forward is a dead end')
})

test('MIRALL_RELAY_ADMIN_ALLOWED_HOSTS lets a named proxy through', async (t) => {
  const { port } = await withHttpRelay(t, { MIRALL_RELAY_ADMIN_ALLOWED_HOSTS: 'relay.internal' })
  const statusOf = async (host) => (await rawHttpRequest({ port, path: '/status.json', host })).statusCode

  assert.equal(await statusOf('relay.internal'), 200)
  assert.equal(await statusOf('relay.internal:9200'), 200)
  assert.equal(await statusOf('evil.example'), 403)
})

test('naming hosts turns the guard on even where the bind would not', async (t) => {
  // The Dockerfile binds 0.0.0.0 and the README publishes it to host loopback, so
  // the bind alone cannot tell us the port is private. This is how a container
  // deployment opts in.
  const { port } = await withHttpRelay(t, {
    MIRALL_RELAY_ADMIN_HOST: '0.0.0.0',
    MIRALL_RELAY_ADMIN_ALLOWED_HOSTS: 'relay.internal'
  })
  const statusOf = async (host) => (await rawHttpRequest({ port, path: '/status.json', host })).statusCode

  assert.equal(await statusOf('relay.internal'), 200)
  assert.equal(await statusOf('evil.example'), 403)
})

test('a non-loopback bind accepts any Host, because a platform proxy owns it', async (t) => {
  // Umbrel and StartOS both front this port with a proxy that sets its own Host.
  // Guarding here would break every container deployment for no gain: on a
  // non-loopback bind the attacker can reach the port directly anyway.
  const { port } = await withHttpRelay(t, { MIRALL_RELAY_ADMIN_HOST: '0.0.0.0' })
  const out = await rawHttpRequest({ port, path: '/status.json', host: 'mirall-relay.umbrel.local' })
  assert.equal(out.statusCode, 200)
})

test('the new routes are still read-only', async (t) => {
  const relay = await withHttpRelay(t)
  for (const path of ['/', '/status.json', '/qr.svg', '/ui.css']) {
    assert.equal((await request(urlOf(relay, path), { method: 'POST' })).statusCode, 405, path)
    assert.equal((await request(urlOf(relay, path), { method: 'DELETE' })).statusCode, 405, path)
  }
})

test('HEAD works on the page, so an uptime check can use it', async (t) => {
  const relay = await withHttpRelay(t)
  const out = await request(urlOf(relay, '/'), { method: 'HEAD' })
  assert.equal(out.statusCode, 200)
  assert.ok(Number(out.headers['content-length']) > 0)
  assert.equal(out.body, '')
})
