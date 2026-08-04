#!/usr/bin/env node
// Deployment verification: prove a live relay actually bridges traffic.
//
//   node scripts/probe.js --relay <z32-public-key>
//
// This does exactly what a pair of Mirall peers does when they fall back to a
// relay (hyperdht/lib/connect.js:777-830): two throwaway nodes connect to the
// relay, present the same pairing token, and get their raw UDX streams bridged.
// Then it pushes a payload across and measures it.
//
// WHY NOT "connect two peers with relayThrough": both probe peers run on this
// host, so they hole-punch to each other directly and hyperdht abandons the
// relayed path it built in parallel. The round-trip then succeeds while the
// relay carries nothing — a green light that means nothing. Pairing directly
// leaves no direct path to lose to, so a success here is unambiguous.
import DHT from 'hyperdht'
import Relay from 'blind-relay'
import b4a from 'b4a'
import { decodeKeyOrThrow, parseBootstrapEntry } from '../src/config.js'

const DEFAULT_TIMEOUT_MS = 30_000
const PAYLOAD_BYTES = 256 * 1024

const USAGE = `probe — verify a mirall-relay deployment

  node scripts/probe.js --relay <public-key> [options]

  --relay KEY          the relay's z-base-32 (or hex) public key   [required]
  --bootstrap h:p,...  DHT bootstrap override                      [mainline]
  --bytes N            payload to push across the bridge           [262144]
  --timeout MS         overall timeout                             [30000]

Exit codes: 0 the relay bridged real traffic - 1 it did not.
`

function parseArgs (argv) {
  const out = { relay: null, bootstrap: null, timeout: DEFAULT_TIMEOUT_MS, bytes: PAYLOAD_BYTES, help: false }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], undefined]
    const value = inline !== undefined ? inline : argv[i + 1]
    const step = () => { if (inline === undefined) i++ }
    switch (flag) {
      case '--relay': out.relay = value; step(); break
      case '--bootstrap': out.bootstrap = value; step(); break
      case '--timeout': out.timeout = Number(value); step(); break
      case '--bytes': out.bytes = Number(value); step(); break
      case '--help': case '-h': out.help = true; break
      default: throw new Error(`unknown argument ${JSON.stringify(argv[i])}`)
    }
  }
  if (!out.help && !out.relay) throw new Error('--relay <public-key> is required')
  return out
}

function deadline (ms, message) {
  return new Promise((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms).unref())
}

function race (promise, ms, message) {
  return Promise.race([promise, deadline(ms, message)])
}

// One side of a relayed pair: connect to the relay and ask it to bridge a raw
// stream under `token`.
//
// The returned `paired` promise MUST NOT be awaited before the other side has
// also called this. The relay only answers once BOTH halves of a token have
// arrived, so awaiting the first side's response before starting the second
// deadlocks — the second half never gets sent.
async function joinBridge (dht, relayKey, token, isInitiator, timeoutMs) {
  const socket = dht.connect(relayKey)
  socket.on('error', () => {})
  try {
    await race(new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    }), timeoutMs, 'timed out connecting to the relay')
  } catch (err) {
    // hyperdht's own errors here (PEER_NOT_FOUND, HOLEPUNCH_ABORTED) are accurate
    // but tell an operator nothing about what to do. Say what it means, and keep
    // the original as the cause.
    throw new Error(
      `could not connect to the relay: ${err.message}. ` +
      'Check the key is correct, the relay is running, and its UDP port is reachable.',
      { cause: err }
    )
  }

  const client = Relay.Client.from(socket, { id: socket.publicKey })
  const stream = dht.createRawStream()
  const request = client.pair(isInitiator, token, stream)
  request.on('error', () => {})

  const paired = race(new Promise((resolve, reject) => {
    request.on('error', reject)
    // Reading the request is what actually SENDS the pair message: it is a lazy
    // Readable (blind-relay's BlindRelayRequest._open).
    request.on('data', (remoteId) => {
      const { remotePort, remoteHost, socket: udpSocket } = socket.rawStream
      stream.connect(udpSocket, remoteId, remotePort, remoteHost)
      resolve()
    })
  }), timeoutMs, 'the relay never completed the pairing')

  return { socket, stream, paired }
}

async function main () {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(err.message + '\n\n' + USAGE)
    process.exit(1)
  }

  if (args.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  const relayKey = decodeKeyOrThrow(args.relay)
  const bootstrap = args.bootstrap
    ? args.bootstrap.split(/[,\s]+/).filter(Boolean).map(parseBootstrapEntry)
    : null
  const dhtOpts = bootstrap ? { bootstrap } : {}

  const nodes = [new DHT(dhtOpts), new DHT(dhtOpts)]
  const cleanup = async () => {
    for (const node of nodes) await node.destroy().catch(() => {})
  }

  try {
    const token = Relay.token()
    const a = await joinBridge(nodes[0], relayKey, token, true, args.timeout)
    const b = await joinBridge(nodes[1], relayKey, token, false, args.timeout)
    await Promise.all([a.paired, b.paired])

    // Both ends must send before the relay can address either of them: it learns
    // each peer's UDP address from that peer's first inbound packet.
    const primed = Promise.all([a, b].map((side) =>
      new Promise((resolve) => side.stream.once('data', resolve))))
    a.stream.write(b4a.from('probe'))
    b.stream.write(b4a.from('probe'))
    await race(primed, args.timeout, 'the bridge never carried a packet in both directions')

    const payload = b4a.alloc(args.bytes, 7)
    let received = 0
    const delivered = new Promise((resolve) => {
      b.stream.on('data', (chunk) => {
        received += chunk.byteLength
        if (received >= payload.byteLength) resolve()
      })
    })

    const startedAt = Date.now()
    a.stream.write(payload)
    await race(delivered, args.timeout,
      `only ${received} of ${payload.byteLength} bytes crossed the relay`)
    const elapsedMs = Math.max(1, Date.now() - startedAt)

    process.stdout.write(JSON.stringify({
      ok: true,
      relay: args.relay,
      bridged: true,
      bytes: received,
      elapsedMs,
      throughputMbps: Number(((received * 8) / 1e6 / (elapsedMs / 1000)).toFixed(2))
    }, null, 2) + '\n')

    await cleanup()
    process.exit(0)
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      relay: args.relay,
      bridged: false,
      error: err.message
    }, null, 2) + '\n')
    await cleanup()
    process.exit(1)
  }
}

main()
