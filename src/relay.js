// The relay node: a HyperDHT server whose every inbound connection becomes a
// blind-relay session.
//
// Data plane:    two UDX raw streams bridged natively by relayTo()
// Control plane: blind-relay's pair/unpair over a Protomux channel on each
//                peer's Noise connection to us
// What we see:   ciphertext, source IPs, timings, byte counts. Nothing else —
//                the peers' Noise handshake runs end-to-end OVER the relayed
//                stream, so identities, space topics, file names and content are
//                never available to this process.
//
// ONE SHARED Relay.Server — NOT one per connection.
// blind-relay matches the two halves of a pairing in a Server-scoped map
// (`this._server._pairing`, blind-relay/index.js:163,178). The two peers of a
// relayed connection arrive on two SEPARATE DHT connections and therefore two
// separate sessions; if each connection had its own Relay.Server their tokens
// would live in different maps and would never match, so no bridge would ever
// form. Per-connection attribution is instead taken from the session's 'pair'
// event, which carries the freshly minted stream (blind-relay/index.js:204).
import DHT from 'hyperdht'
import Relay from 'blind-relay'
import b4a from 'b4a'
import { bootstrapNodes } from './config.js'
import { loadOrCreateSeed, keyPairFromSeed, publicKeyZ32 } from './keys.js'

export class RelayNode {
  constructor (cfg, deps = {}) {
    this.cfg = cfg
    this.logger = deps.logger
    this.metrics = deps.metrics
    this.firewall = deps.firewall
    this.meter = deps.meter
    this.version = deps.version || '0.0.0'

    this.dht = null
    this.server = null // hyperdht server (our listening identity)
    this.relay = null // the single blind-relay.Server
    this.keyPair = null
    this.ready = false
    this.closing = false
    this._sessions = new Set()
  }

  get publicKey () {
    return this.keyPair ? this.keyPair.publicKey : null
  }

  get publicKeyZ32 () {
    return this.keyPair ? publicKeyZ32(this.keyPair) : null
  }

  get firewalled () {
    return this.dht ? !!this.dht.firewalled : null
  }

  get address () {
    try {
      return this.dht ? this.dht.address() : null
    } catch {
      return null
    }
  }

  relayStats () {
    return this.relay ? this.relay.stats : null
  }

  async start () {
    const { cfg, logger } = this

    const seed = loadOrCreateSeed(cfg)
    this.keyPair = keyPairFromSeed(seed)

    const bootstrap = bootstrapNodes(cfg)
    this.dht = new DHT({
      port: cfg.port,
      host: cfg.host,
      ephemeral: cfg.ephemeral,
      ...(bootstrap ? { bootstrap } : {}),
      // Only claim direct reachability when the operator asserts it. Lying here
      // makes hyperdht skip its own probing and every connection then fails in a
      // way that looks like a client bug.
      ...(cfg.assumeReachable ? { firewalled: false } : {})
    })

    this.relay = new Relay.Server({
      createStream: (opts) => this.dht.createRawStream(opts)
    })
    this.relay.on('error', (err) => {
      logger?.warn({ err: err.message }, 'blind-relay server error')
    })

    this.server = this.dht.createServer(
      { firewall: (remotePublicKey) => this.firewall.firewall(remotePublicKey) },
      (socket) => this._onconnection(socket)
    )

    await this.server.listen(this.keyPair)
    await this.dht.fullyBootstrapped()

    this.ready = true
    this.metrics?.m.ready.set(1)
    this.metrics?.m.dhtFirewalled.set(this.firewalled ? 1 : 0)

    if (this.firewalled) {
      logger?.error(
        { publicKey: this.publicKeyZ32 },
        'DHT node reports FIREWALLED — a relay must be reachable from the public internet. ' +
        'Check that the UDP port is open and forwarded; clients will not be able to reach this relay.'
      )
    }

    logger?.info({
      publicKey: this.publicKeyZ32,
      firewalled: this.firewalled,
      ephemeral: !!this.dht.ephemeral,
      // The port to open in the firewall and publish from a container. Reported
      // separately because dht.address() is NOT it while firewalled: dht-rpc's
      // `socket` getter returns the ephemeral CLIENT socket in that state
      // (dht-rpc/index.js:139), so the address below shows a random high port and
      // reads like the configured port was ignored. It wasn't.
      port: this.cfg.port,
      address: this.address
    }, 'relay listening')

    return this
  }

  _onconnection (socket) {
    const { cfg, metrics, meter, logger } = this
    // An abrupt peer loss must never take the process down.
    socket.on('error', () => {})

    const keyHex = b4a.toString(socket.remotePublicKey, 'hex')

    // Bound half-open pairings globally. Only an accepted session can create
    // one, so refusing new sessions is what actually caps the memory.
    if (this.relay.stats.pairings.pending >= cfg.maxPending) {
      metrics?.m.sessionsRejected.inc({ reason: 'pending-pairings' })
      socket.destroy()
      return
    }

    if (!meter.canAcceptSession(keyHex)) {
      metrics?.m.sessionsRejected.inc({ reason: 'concurrency' })
      socket.destroy()
      return
    }

    metrics?.m.sessionsAccepted.inc()
    const closeSession = meter.openSession(keyHex)

    const session = this.relay.accept(socket, { id: socket.remotePublicKey })
    this._sessions.add(session)

    // The ONLY hook that ties a minted stream back to the peer that asked for
    // it. createStream() is a Server-level callback with no session context.
    session.on('pair', (isInitiator, token, stream) => {
      meter.register(stream, keyHex)
      logger?.debug({ key: keyHex, isInitiator }, 'link paired')
    })

    session.on('error', (err) => {
      logger?.debug({ err: err.message, key: keyHex }, 'relay session error')
    })

    session.on('close', () => {
      this._sessions.delete(session)
      closeSession()
    })

    // A session that never emits 'close' (abrupt transport loss) still releases
    // its slot when the underlying socket goes.
    socket.once('close', () => {
      this._sessions.delete(session)
      closeSession()
    })
  }

  async close () {
    if (this.closing) return
    this.closing = true
    this.ready = false
    this.metrics?.m.ready.set(0)

    this.meter?.stop()
    this.firewall?.stop()

    if (this.relay) {
      try { await this.relay.close() } catch { /* best effort */ }
    }
    if (this.server) {
      try { await this.server.close() } catch { /* best effort */ }
    }
    if (this.dht) {
      try { await this.dht.destroy() } catch { /* best effort */ }
    }
    this.logger?.info('relay closed')
  }
}
