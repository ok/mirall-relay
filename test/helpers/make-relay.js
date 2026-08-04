// Test rig: a fully wired relay on a local hyperdht testnet, plus the throwaway
// peers used to drive traffic through it.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import Relay from 'blind-relay'
import b4a from 'b4a'
import { loadConfig } from '../../src/config.js'
import { createRelay } from '../../src/index.js'

export { createTestnet }

function tmpSeedFile () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-relay-test-'))
  return { dir, file: path.join(dir, 'seed') }
}

// Build a config from DEFAULTS with test-appropriate overrides. Anything not
// named here keeps the production default, so the tests exercise the real values.
export function testConfig (testnet, overrides = {}) {
  const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')
  const { file } = tmpSeedFile()
  const env = {
    MIRALL_RELAY_BOOTSTRAP: bootstrap,
    MIRALL_RELAY_SEED_FILE: file,
    MIRALL_RELAY_HOST: '127.0.0.1',
    MIRALL_RELAY_PORT: '0', // let the OS pick, so suites can run in parallel
    MIRALL_RELAY_ADMIN_PORT: '0',
    MIRALL_RELAY_ASSUME_REACHABLE: 'true', // testnet nodes are directly reachable
    MIRALL_RELAY_LOG_LEVEL: 'silent',
    ...overrides
  }
  return loadConfig([], env)
}

// Start a relay on the testnet. Returns the composed app plus a stop() that is
// safe to call twice.
export async function startTestRelay (testnet, overrides = {}, opts = {}) {
  const cfg = testConfig(testnet, overrides)
  const app = createRelay(cfg, { silent: true, collectDefault: false, ...opts })
  await app.relay.start()
  if (opts.admin) await app.admin.listen()

  let stopped = false
  app.stop = async () => {
    if (stopped) return
    stopped = true
    if (opts.admin) await app.admin.close().catch(() => {})
    await app.relay.close()
  }
  return app
}

// An echo server peer. Everything it receives comes back with an 'echo:' prefix.
export async function makeEchoPeer (testnet, opts = {}) {
  const dht = new DHT({ bootstrap: testnet.bootstrap, ...opts.dht })
  const server = dht.createServer(opts.serverOpts || {}, (socket) => {
    socket.on('error', () => {})
    socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data])))
    opts.onconnection?.(socket)
  })
  await server.listen()
  return {
    dht,
    server,
    publicKey: server.publicKey,
    destroy: () => dht.destroy().catch(() => {})
  }
}

export async function makeDialer (testnet, opts = {}) {
  const dht = new DHT({ bootstrap: testnet.bootstrap, ...opts })
  return { dht, destroy: () => dht.destroy().catch(() => {}) }
}

// Connect and complete one request/response, resolving with the reply.
export function roundTrip (socket, payload = 'ping', timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('round-trip timed out')), timeoutMs)
    timer.unref?.()
    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
    socket.once('data', (data) => { clearTimeout(timer); resolve(data) })
    socket.once('open', () => socket.write(Buffer.from(payload)))
  })
}

// Build a genuinely relayed UDX stream pair through the relay.
//
// WHY THIS EXISTS: on a loopback testnet every peer is directly reachable, so
// hyperdht's direct hole-punch always wins the race against the relayed path.
// The bridge is still built (pairings.matched increments) but is abandoned before
// any payload crosses it — which makes "connect two peers and write" useless for
// proving the DATA plane. This helper does what hyperdht's own relayConnection()
// does (hyperdht/lib/connect.js:777-830), with no direct path to lose to, so
// every byte written here provably traverses the relay.
export async function relayedPair (testnet, relayPublicKey, { timeoutMs = 20_000 } = {}) {
  const token = Relay.token()
  const nodes = [new DHT({ bootstrap: testnet.bootstrap }), new DHT({ bootstrap: testnet.bootstrap })]

  async function side (dht, isInitiator) {
    const socket = dht.connect(relayPublicKey)
    socket.on('error', () => {})
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay connect timed out')), timeoutMs)
      timer.unref?.()
      socket.once('open', () => { clearTimeout(timer); resolve() })
      socket.once('error', (err) => { clearTimeout(timer); reject(err) })
    })

    const client = Relay.Client.from(socket, { id: socket.publicKey })
    const raw = dht.createRawStream()
    const request = client.pair(isInitiator, token, raw)

    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pairing timed out')), timeoutMs)
      timer.unref?.()
      request.on('error', (err) => { clearTimeout(timer); reject(err) })
      request.on('data', (remoteId) => {
        clearTimeout(timer)
        const { remotePort, remoteHost, socket: udpSocket } = socket.rawStream
        raw.connect(udpSocket, remoteId, remotePort, remoteHost)
        resolve()
      })
    })

    return { dht, socket, client, raw, connected }
  }

  const a = await side(nodes[0], true)
  const b = await side(nodes[1], false)
  await Promise.all([a.connected, b.connected])

  // Prime BOTH directions before handing the bridge over.
  //
  // The relay learns each peer's UDP address from the first packet it receives
  // from them (blind-relay/index.js:345 — the firewall probe calls
  // stream.connect() with the observed address). Until a peer has sent something,
  // the relay literally cannot address it, so a bridge primed in one direction
  // only silently drops everything going the other way. hyperdht never hits this
  // because its Noise handshake flows both ways immediately.
  const PRIME = b4a.from('prime')
  const primed = Promise.all([a, b].map((side) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge priming timed out')), timeoutMs)
    timer.unref?.()
    side.raw.once('data', () => { clearTimeout(timer); resolve() })
  })))
  a.raw.write(PRIME)
  b.raw.write(PRIME)
  await primed

  return {
    a: a.raw,
    b: b.raw,
    primeBytes: PRIME.byteLength,
    async destroy () {
      for (const s of [a.raw, b.raw]) { try { s.destroy() } catch { /* gone */ } }
      for (const s of [a.socket, b.socket]) { try { s.destroy() } catch { /* gone */ } }
      for (const dht of nodes) await dht.destroy().catch(() => {})
    }
  }
}

// Read a live prom-client value out of the registry, so integration tests assert
// on the same numbers /metrics would report.
export async function metricValue (metrics, name, labels = null) {
  const metric = metrics.registry.getSingleMetric(name)
  if (!metric) return 0
  const { values } = await metric.get()
  const match = values.find((v) => {
    if (!labels) return true
    return Object.entries(labels).every(([k, val]) => v.labels[k] === val)
  })
  return match ? match.value : 0
}

// Poll until the predicate is truthy. Accepts async predicates so callers can
// await metricValue() directly.
export async function waitFor (predicate, { timeoutMs = 15_000, intervalMs = 25, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs).unref?.())
  }
}
