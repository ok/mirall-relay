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
import { resolveSeed, keyPairFromSeed, publicKeyZ32 } from './keys.js'
import { startReprobe } from './reprobe.js'
import { watchReachability } from './reachability-watch.js'
import { reachabilityState } from './status.js'

const REPROBE_LOGGED = 6

// udx's socket.address() returns { host, family, port } — NOT Node's dgram shape
// with `address`. Normalised here so the status snapshot has one contract and a
// udx change cannot silently render "undefined:54949" on the page.
function boundAddress (address) {
  if (!address) return null
  return {
    host: address.host || address.address || null,
    port: address.port,
    family: address.family
  }
}

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
    this.reprobe = null
    this.reach = null
    this.keyPair = null
    this.ready = false
    this.closing = false
    this.startedAt = null
    this.seedSource = { from: 'none', path: null, created: false }
    this._sessions = new Set()
    // Sessions indexed by remote key, so a revocation or a ban can reach the
    // connections a peer already holds. The Set above stays the lifecycle owner.
    this._sessionsByKey = new Map() // keyHex -> Set of { session, socket }
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

  get publicAddress () {
    try {
      return this.dht ? this.dht.remoteAddress() : null
    } catch {
      return null
    }
  }

  relayStats () {
    return this.relay ? this.relay.stats : null
  }

  // What the DHT believes about our place on the network. `host` and `port` are
  // dht-rpc's NAT sampler view (dht-rpc/index.js:126,130) — the address other
  // nodes actually observe, which is the number to compare against the port an
  // operator forwarded.
  //
  // `publicAddress` is the verdict the firewalled flag does not catch. It is
  // dht.remoteAddress(), the exact predicate hyperdht uses to offer clients a
  // direct connection (hyperdht/lib/server.js:273,361): null when the host is
  // unknown, when the port is randomized per destination, or when the observed
  // port differs from the bound one. A relay without it reports firewalled: false
  // and still cannot be connected to directly.
  networkInfo () {
    const { dht } = this
    if (!dht) return { host: null, port: null, publicAddress: null, randomized: false, bootstrapped: false, ephemeral: false, nodes: 0, address: null }
    return {
      host: dht.host || null,
      port: dht.port || null,
      publicAddress: this.publicAddress,
      randomized: !!dht.randomized,
      bootstrapped: !!dht.bootstrapped,
      ephemeral: !!dht.ephemeral,
      nodes: dht.nodes ? dht.nodes.length : 0,
      address: boundAddress(this.address)
    }
  }

  async start () {
    const { cfg, logger } = this

    const { seed, ...source } = resolveSeed(cfg)
    this.seedSource = source
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
    this.startedAt = Date.now()
    this.metrics?.m.ready.set(1)
    this.metrics?.m.dhtFirewalled.set(this.firewalled ? 1 : 0)
    this.metrics?.m.reachabilityProbed.set(cfg.assumeReachable ? 0 : 1)

    if (this.seedSource.created) {
      logger?.warn(
        { publicKey: this.publicKeyZ32, seedFile: this.seedSource.path },
        'a NEW identity was generated — if this path is not persistent storage, every client given this key is stranded when this process is replaced'
      )
    }

    if (this.firewalled) {
      logger?.error(
        // The address the probe was aimed at. Not the expected one means the
        // verdict is about the wrong network path, not about the port.
        { publicKey: this.publicKeyZ32, publicHost: this.dht.host || null, publicPort: this.dht.port || null },
        'DHT node reports FIREWALLED — a relay must be reachable from the public internet. ' +
        'Check that the UDP port is open and forwarded; clients will not be able to reach this relay.'
      )
    }

    this.reach = watchReachability({
      read: () => reachabilityState(this),
      onChange: (prev, next) => this._logReachability(prev, next)
    })
    this.dht.on('nat-update', () => this.reach.check())

    // Asserted reachability was never probed, so there is nothing to re-run.
    if (!cfg.assumeReachable) {
      this.reprobe = startReprobe(this.dht, {
        onResult: (firewalled, attempt) => {
          this.metrics?.m.dhtFirewalled.set(firewalled ? 1 : 0)
          // A firewalled -> reachable flip does not always emit 'nat-update'.
          this.reach.check()
          // warn, not info: a relay that was red and recovered, or is still red
          // after a retry, is what an operator reading a quiet log is looking for.
          // Only the scheduled ramp is logged, so a closed port does not fill the log.
          const seen = { attempt, publicHost: this.dht.host || null, publicPort: this.dht.port || null }
          if (!firewalled) logger?.warn({ publicKey: this.publicKeyZ32, ...seen }, 'reachability re-probe passed — the relay is now reachable')
          else if (attempt <= REPROBE_LOGGED) logger?.warn(seen, 'reachability re-probe failed — still firewalled')
        },
        onUnsupported: () => logger?.warn('this dht-rpc has no re-probe hook — a firewalled verdict will stand until restart')
      })
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

    // Once at ready: 'nat-update' has already fired during bootstrap, so a relay
    // that starts out not directly reachable would otherwise never say so.
    this.reach.check()

    return this
  }

  // Entering and leaving 'firewalled' is logged by start() and the re-probe.
  _logReachability (prev, next) {
    const { logger } = this
    const net = this.networkInfo()
    const seen = { publicHost: net.host, publicPort: net.port }
    if (next === 'port-unstable') {
      logger?.warn(
        { publicKey: this.publicKeyZ32, ...seen, boundPort: net.address ? net.address.port : null, portRandomized: net.randomized },
        'outbound UDP port is being rewritten — peers see this relay on a different port than it listens on, so they cannot connect to it directly and most cannot hole-punch to it either. ' +
        'Causes: a NAT or tunnel in front of the host that rewrites ports, stale conntrack state on the host, or Docker port publishing (-p …/udp) instead of host networking. ' +
        'See OPERATIONS.md "The relay is up but nothing connects".'
      )
    } else if (next === 'unknown-long') {
      logger?.warn(
        { publicKey: this.publicKeyZ32, minutes: 10 },
        'public address still not settled after 10 minutes — the DHT sees this relay at inconsistent addresses (an egress that alternates public IPs, or a broken uplink)'
      )
    } else if (next === 'unknown') {
      logger?.info(
        { publicKey: this.publicKeyZ32 },
        'public address not settled — the DHT is re-learning it, as after a network change; peers cannot connect directly until it does'
      )
    } else if (next === 'reachable' && prev === 'port-unstable') {
      logger?.warn(seen, 'outbound UDP port is stable again — peers can connect to this relay directly')
    } else if (next === 'reachable' && prev === 'unknown') {
      logger?.info(seen, 'public address settled — peers can connect to this relay directly')
    }
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

    const held = { session, socket }
    let peers = this._sessionsByKey.get(keyHex)
    if (!peers) {
      peers = new Set()
      this._sessionsByKey.set(keyHex, peers)
    }
    peers.add(held)

    // The ONLY hook that ties a minted stream back to the peer that asked for
    // it. createStream() is a Server-level callback with no session context.
    session.on('pair', (isInitiator, token, stream) => {
      meter.register(stream, keyHex)
      logger?.debug({ key: keyHex, isInitiator }, 'link paired')
    })

    session.on('error', (err) => {
      logger?.debug({ err: err.message, key: keyHex }, 'relay session error')
    })

    const forget = () => {
      this._sessions.delete(session)
      const live = this._sessionsByKey.get(keyHex)
      if (live) {
        live.delete(held)
        if (live.size === 0) this._sessionsByKey.delete(keyHex)
      }
    }

    session.on('close', () => {
      forget()
      closeSession()
    })

    // A session that never emits 'close' (abrupt transport loss) still releases
    // its slot when the underlying socket goes.
    socket.once('close', () => {
      forget()
      closeSession()
    })
  }

  // Drop every live session a key holds. Destroying the SOCKET (not just the
  // blind-relay session) is what actually tears the bridged links: the session
  // is a Protomux channel on that socket, and the meter releases the links from
  // the stream 'close' that follows.
  //
  // Revocation and auto-ban must take effect on live sessions, not only on the
  // peer's next reconnect.
  destroySessionsFor (keyHex) {
    const peers = this._sessionsByKey.get(keyHex)
    if (!peers) return 0
    const n = peers.size
    for (const held of [...peers]) {
      try { held.socket.destroy() } catch { /* already gone */ }
    }
    this._sessionsByKey.delete(keyHex)
    return n
  }

  async close () {
    if (this.closing) return
    this.closing = true
    this.ready = false
    this.metrics?.m.ready.set(0)

    this.reprobe?.stop()
    this.reach?.stop()
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
