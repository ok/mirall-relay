// The browser surface over real HTTP against a running relay.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import b4a from 'b4a'
import { standaloneQr } from '../../src/operator/status/page.js'
import { createTestnet, startTestRelay, relayedPair, waitFor } from '../helpers/make-relay.js'

async function withRelay (t, overrides = {}) {
  const testnet = await createTestnet(4)
  const relay = await startTestRelay(testnet, overrides, { admin: true })
  t.after(async () => { await relay.stop(); await testnet.destroy() })
  const { port } = relay.admin.server.address()
  return { relay, port, base: `http://127.0.0.1:${port}` }
}

// fetch() refuses to set Host — it is a forbidden header — so a test written with
// fetch would silently send the real one and assert nothing. Do not "simplify"
// this back.
function request (port, path, { host, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      // `host: ''` must reach the wire as a blank Host, not fall back to Node's
      // default — testing the empty case is the whole point of one of these.
      headers: host === undefined ? {} : { host }
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('/ serves a status page with the public key in the markup', async (t) => {
  const { relay, base } = await withRelay(t, {
    MIRALL_RELAY_REGION: 'eu-fsn1',
    MIRALL_RELAY_OPERATOR: 'example'
  })
  const res = await fetch(base + '/')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)

  const html = await res.text()
  assert.ok(html.includes(relay.relay.publicKeyZ32), 'the key must be gettable without a terminal')
  assert.match(html, /eu-fsn1/)
  assert.match(html, /Settings → Network/)
  assert.match(html, /<svg /, 'the QR is inline')
})

test('/ is served under a policy that forbids everything the page does not use', async (t) => {
  const { base } = await withRelay(t)
  const res = await fetch(base + '/')
  const csp = res.headers.get('content-security-policy')

  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /style-src 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.ok(!csp.includes('unsafe-inline'), 'the whole point of external assets')

  // Every response, not just the document: a policy that only covers / leaves
  // /qr.svg and /status.json ungoverned when they are opened directly.
  for (const path of ['/status.json', '/qr.svg', '/ui.css', '/metrics']) {
    const other = await fetch(base + path)
    assert.equal(other.headers.get('content-security-policy'), csp, path)
  }

  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

test('/status.json agrees with every other endpoint about the identity', async (t) => {
  const { relay, base } = await withRelay(t)
  const status = await (await fetch(base + '/status.json')).json()
  const ready = await (await fetch(base + '/readyz')).json()
  const doc = await (await fetch(base + '/.well-known/mirall-relay.json')).json()

  assert.equal(status.identity.publicKey, relay.relay.publicKeyZ32)
  assert.equal(status.identity.publicKey, ready.publicKey)
  assert.equal(status.identity.publicKey, doc.publicKey)
  assert.deepEqual(status.caps, doc.caps)
  assert.equal(status.version, doc.version)
})

test('/status.json reports the testnet relay as reachable but unprobed', async (t) => {
  // The test rig sets ASSUME_REACHABLE, so this is exactly the case where a
  // single enum would have claimed a measurement nobody took.
  const { base } = await withRelay(t)
  const { reachability } = await (await fetch(base + '/status.json')).json()

  assert.equal(reachability.state, 'reachable')
  assert.equal(reachability.firewalled, false)
  assert.equal(reachability.probed, false)
  assert.equal(reachability.bootstrapped, true)
  assert.equal(typeof reachability.port, 'number')
})

test('/status.json never carries the seed', async (t) => {
  const seedHex = 'ab'.repeat(32)
  const { base } = await withRelay(t, { MIRALL_RELAY_SEED: seedHex })
  const body = await (await fetch(base + '/status.json')).text()
  assert.ok(!body.includes(seedHex))
  assert.ok(!body.includes('ab'.repeat(16)))
})

test('relayed bytes reach /status.json, and never disagree with /metrics', async (t) => {
  const testnet = await createTestnet(4)
  const relay = await startTestRelay(testnet, { MIRALL_RELAY_METER_MS: '50' }, { admin: true })
  t.after(async () => { await relay.stop(); await testnet.destroy() })
  const base = `http://127.0.0.1:${relay.admin.server.address().port}`

  const pair = await relayedPair(testnet, relay.relay.publicKey)
  t.after(() => pair.destroy())

  pair.b.on('data', () => {})
  pair.a.write(b4a.alloc(64 * 1024, 1))

  const status = await waitFor(async () => {
    const body = await (await fetch(base + '/status.json')).json()
    return body.traffic.bytesRelayed > 0 ? body : null
  }, { message: 'bytes to show up on /status.json', timeoutMs: 30_000 })

  const text = await (await fetch(base + '/metrics')).text()
  const scraped = Number(/relay_bytes_relayed_total (\d+)/.exec(text)[1])

  // The same counter read twice: the page can only ever be behind, never ahead.
  assert.ok(scraped >= status.traffic.bytesRelayed, `${scraped} < ${status.traffic.bytesRelayed}`)
  assert.equal(status.traffic.pairings.matched, 1)
  assert.ok(status.traffic.sessionsAccepted >= 2, 'both halves of the pair opened a session')
  assert.ok(status.uptimeSeconds >= 0)
})

test('/qr.svg is the running relay key, as a file you can save', async (t) => {
  const { relay, base } = await withRelay(t)
  const res = await fetch(base + '/qr.svg')

  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/)
  assert.equal(await res.text(), standaloneQr(relay.relay.publicKeyZ32))
})

test('the page assets are cacheable and answer 304 to a matching if-none-match', async (t) => {
  const { base } = await withRelay(t)
  for (const [path, type] of [['/ui.css', /text\/css/], ['/ui.js', /javascript/], ['/format.js', /javascript/]]) {
    const first = await fetch(base + path)
    assert.equal(first.status, 200, path)
    assert.match(first.headers.get('content-type'), type, path)

    const etag = first.headers.get('etag')
    assert.match(etag, /^"[A-Za-z0-9_-]+"$/, path)

    const second = await fetch(base + path, { headers: { 'if-none-match': etag } })
    assert.equal(second.status, 304, path)
    assert.equal(await second.text(), '')
  }
})

test('ui.js imports format.js, so both have to be served for the page to refresh', async (t) => {
  const { base } = await withRelay(t)
  const script = await (await fetch(base + '/ui.js')).text()
  assert.match(script, /from '\.\/format\.js'/)
  assert.equal((await fetch(base + '/format.js')).status, 200)
})

test('MIRALL_RELAY_ADMIN_UI=false leaves the JSON endpoints exactly as they were', async (t) => {
  const { base } = await withRelay(t, { MIRALL_RELAY_ADMIN_UI: 'false' })

  for (const path of ['/', '/status.json', '/qr.svg', '/ui.css', '/ui.js', '/format.js']) {
    assert.equal((await fetch(base + path)).status, 404, path)
  }
  assert.equal((await fetch(base + '/healthz')).status, 200)
  assert.equal((await fetch(base + '/readyz')).status, 200)
  assert.equal((await fetch(base + '/metrics')).status, 200)
  assert.equal((await fetch(base + '/.well-known/mirall-relay.json')).status, 200)
})

test('MIRALL_RELAY_ADMIN_UI=false leaves the management page enabled', async (t) => {
  const { base } = await withRelay(t, { MIRALL_RELAY_ADMIN_UI: 'false' })

  assert.equal((await fetch(base + '/admin/', { redirect: 'manual' })).status, 200)
  assert.equal((await fetch(base + '/admin/style.css')).status, 200)
  assert.equal((await fetch(base + '/admin/app.js')).status, 200)
  assert.equal((await fetch(base + '/admin/invites')).status, 401)
})

test('a loopback-bound admin server refuses a rebound Host on the browser surface', async (t) => {
  // DNS rebinding: a page on the internet points its own hostname at 127.0.0.1
  // and reads this port out of the operator's browser. The Host header still says
  // where the browser thought it was going.
  const { port } = await withRelay(t)

  for (const path of ['/', '/status.json', '/qr.svg', '/ui.css', '/ui.js', '/format.js']) {
    assert.equal((await request(port, path, { host: 'evil.example' })).status, 403, path)
  }

  assert.equal((await request(port, '/status.json', { host: `127.0.0.1:${port}` })).status, 200)
  assert.equal((await request(port, '/status.json', { host: `localhost:${port}` })).status, 200)
})

test('the guard leaves the pre-existing machine endpoints alone', async (t) => {
  // /healthz, /readyz, /metrics and the capability doc are addressed by hostname
  // in real deployments — a Prometheus target, an /etc/hosts alias, an SSH-tunnel
  // name. 403ing them on upgrade would take monitoring down silently and read as
  // a network fault. This change does not touch their contract.
  const { port } = await withRelay(t)
  for (const path of ['/healthz', '/readyz', '/metrics', '/.well-known/mirall-relay.json']) {
    assert.equal((await request(port, path, { host: 'monitoring.internal' })).status, 200, path)
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
  // Node answers a MISSING Host on HTTP/1.1 with 400 itself, so `Host:` with
  // nothing after it only ever arrives from someone who chose to send it — and it
  // used to be read as "no Host header" and waved through with the full body.
  const { port } = await withRelay(t)

  const blank = await rawRequest(port, ['GET /status.json HTTP/1.1', 'Host:'])
  assert.equal(blank.status, 403)
  assert.ok(!blank.body.includes('publicKey'), 'and it certainly does not get a body')

  // An HTTP/1.0 client legitimately sends none, and must still work.
  const http10 = await rawRequest(port, ['GET /status.json HTTP/1.0'])
  assert.equal(http10.status, 200)
})

test('a refusal says what to do about it, and is logged', async (t) => {
  const { port } = await withRelay(t)
  const res = await request(port, '/status.json', { host: 'relay.internal' })
  assert.equal(res.status, 403)
  assert.match(res.body, /MIRALL_RELAY_ADMIN_ALLOWED_HOSTS/, 'a 403 with no way forward is a dead end')
})

test('MIRALL_RELAY_ADMIN_ALLOWED_HOSTS lets a named proxy through', async (t) => {
  const { port } = await withRelay(t, { MIRALL_RELAY_ADMIN_ALLOWED_HOSTS: 'relay.internal' })
  assert.equal((await request(port, '/status.json', { host: 'relay.internal' })).status, 200)
  assert.equal((await request(port, '/status.json', { host: 'relay.internal:9200' })).status, 200)
  assert.equal((await request(port, '/status.json', { host: 'evil.example' })).status, 403)
})

test('naming hosts turns the guard on even where the bind would not', async (t) => {
  // The Dockerfile binds 0.0.0.0 and the README publishes it to host loopback, so
  // the bind alone cannot tell us the port is private. This is how a container
  // deployment opts in.
  const { port } = await withRelay(t, {
    MIRALL_RELAY_ADMIN_HOST: '0.0.0.0',
    MIRALL_RELAY_ADMIN_ALLOWED_HOSTS: 'relay.internal'
  })
  assert.equal((await request(port, '/status.json', { host: 'relay.internal' })).status, 200)
  assert.equal((await request(port, '/status.json', { host: 'evil.example' })).status, 403)
})

test('a non-loopback bind accepts any Host, because a platform proxy owns it', async (t) => {
  // Umbrel and StartOS both front this port with a proxy that sets its own Host.
  // Guarding here would break every container deployment for no gain: on a
  // non-loopback bind the attacker can reach the port directly anyway.
  const { port } = await withRelay(t, { MIRALL_RELAY_ADMIN_HOST: '0.0.0.0' })
  assert.equal((await request(port, '/status.json', { host: 'mirall-relay.umbrel.local' })).status, 200)
})

test('the new routes are still read-only', async (t) => {
  const { base } = await withRelay(t)
  for (const path of ['/', '/status.json', '/qr.svg', '/ui.css']) {
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 405, path)
    assert.equal((await fetch(base + path, { method: 'DELETE' })).status, 405, path)
  }
})

test('HEAD works on the page, so an uptime check can use it', async (t) => {
  const { base } = await withRelay(t)
  const res = await fetch(base + '/', { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.ok(Number(res.headers.get('content-length')) > 0)
  assert.equal(await res.text(), '')
})
