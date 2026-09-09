// Cap enforcement for bridged links.
//
// WHY POLLING: blind-relay bridges the two raw streams with UDX's native
// `relayTo()` fast-path (blind-relay/index.js:312, udx-native/lib/stream.js:249).
// Packets are forwarded inside the native layer, so JS 'data' events NEVER fire
// on a bridged stream and there is no per-chunk hook to account from. The only
// observable is the UDX counter pair on the stream handle, which we sample.
//
// MEASURED BEHAVIOUR (udx-native 1.20.7, 256 KB through a bridge):
//   stream.bytesReceived     advances      <- ingress, this is our signal
//   stream.bytesTransmitted  stays 0       <- relayed egress is never accounted
//   stream.packetsTransmitted stays 0
//   'data' events            never fire
// So we read bytesReceived ONLY. Summing tx+rx would look thorough and measure
// exactly the same thing, while implying the tx term does something.
//
// CONSEQUENCE — caps are PER DIRECTION. A relayed connection is two streams; each
// counts only the bytes entering it, i.e. one direction of travel. maxLinkBytes
// therefore bounds each direction separately, so a saturated bidirectional
// transfer may move up to 2x maxLinkBytes in total. That is intentional and
// documented rather than silently halved: the operator's real constraint is
// egress, and each direction egresses once.
import { monotonicMs } from './clock.js'

// A key that trips a byte or rate cap this many times is not misconfigured, it is
// abusive. Hand it to the firewall.
export const BAN_AFTER_VIOLATIONS = 3

export function makeMeter (cfg, metrics, logger, firewall, { now = monotonicMs, autoStart = true, onBan = null } = {}) {
  const links = new Set() // { stream, keyHex, startedAt, lastBytes, lastAt, overRateSince }
  const sessionsByKey = new Map() // keyHex -> open session count
  const violations = new Map() // keyHex -> cap-teardown count
  let timer = null

  function sessionCount (keyHex) {
    return sessionsByKey.get(keyHex) || 0
  }

  // Checked before accepting an inbound connection as a relay session.
  function canAcceptSession (keyHex) {
    if (links.size >= cfg.maxActiveLinks) return false
    return sessionCount(keyHex) < cfg.maxSessionsPerKey
  }

  function openSession (keyHex) {
    sessionsByKey.set(keyHex, sessionCount(keyHex) + 1)
    let closed = false
    return function closeSession () {
      if (closed) return
      closed = true
      const next = sessionCount(keyHex) - 1
      if (next <= 0) sessionsByKey.delete(keyHex)
      else sessionsByKey.set(keyHex, next)
    }
  }

  // Track a bridged stream minted by blind-relay's createStream. Attribution
  // comes from the session that emitted 'pair', so keyHex is the remote peer
  // that asked for this link.
  function register (stream, keyHex) {
    const t = now()
    const rec = { stream, keyHex, startedAt: t, lastBytes: 0, lastAt: t, overRateSince: 0 }
    links.add(rec)
    metrics?.m.linksActive.set(links.size)
    metrics?.m.linksOpened.inc()
    stream.once('close', () => {
      // Final accounting BEFORE dropping the link. A short-lived bridge that
      // opens and closes between two sampling ticks would otherwise contribute
      // nothing at all to relay_bytes_relayed_total — which is the number
      // operators budget egress against, so silently under-reporting it is worse
      // than a little extra work on close.
      settle(rec)
      links.delete(rec)
      metrics?.m.linksActive.set(links.size)
    })
    return rec
  }

  // Read the counter one last time and bank whatever has not been sampled yet.
  // Reading a destroyed udx stream's native counters can throw, so treat a
  // failure as "nothing further to count" rather than letting it escape a
  // 'close' handler.
  function settle (rec) {
    try {
      const total = rec.stream.bytesReceived
      const delta = Math.max(0, total - rec.lastBytes)
      if (delta > 0) metrics?.m.bytesRelayed.inc(delta)
      rec.lastBytes = total
    } catch { /* stream already gone */ }
  }

  function sample () {
    const t = now()
    for (const rec of links) {
      // See the header: ingress only. tx is structurally zero under relayTo().
      const total = rec.stream.bytesReceived
      const dtSeconds = Math.max(1, t - rec.lastAt) / 1000
      const delta = Math.max(0, total - rec.lastBytes)
      const rate = delta / dtSeconds

      metrics?.m.bytesRelayed.inc(delta)
      rec.lastBytes = total
      rec.lastAt = t

      if (total > cfg.maxLinkBytes) { tear(rec, 'bytes'); continue }
      if (t - rec.startedAt > cfg.maxLinkMs) { tear(rec, 'duration'); continue }

      if (rate > cfg.maxLinkRate) {
        // A burst is normal; only a SUSTAINED overrun is abuse. Without the
        // grace window every TCP-like ramp-up would trip the cap.
        if (!rec.overRateSince) rec.overRateSince = t
        else if (t - rec.overRateSince > cfg.overRateGraceMs) { tear(rec, 'rate'); continue }
      } else {
        rec.overRateSince = 0
      }
    }
  }

  function tear (rec, cap) {
    settle(rec)
    metrics?.m.linksTornByCap.inc({ cap })
    logger?.warn({ cap, key: rec.keyHex, bytes: rec.lastBytes }, 'tearing down over-cap relay link')
    links.delete(rec)
    metrics?.m.linksActive.set(links.size)
    try { rec.stream.destroy() } catch { /* already gone */ }

    if (cap === 'duration') return // a long-lived honest transfer is not abuse
    const count = (violations.get(rec.keyHex) || 0) + 1
    violations.set(rec.keyHex, count)
    if (count >= BAN_AFTER_VIOLATIONS && firewall && !firewall.isBanned(rec.keyHex)) {
      firewall.ban(rec.keyHex)
      logger?.warn({ key: rec.keyHex, violations: count }, 'banning peer after repeated cap violations')
      // Same gap as revocation: a ban that leaves the offender's existing links
      // running only takes effect on their next reconnect, which for a peer
      // saturating a link is never.
      onBan?.(rec.keyHex)
    }
  }

  function start () {
    if (timer) return
    timer = setInterval(sample, cfg.meterMs)
    timer.unref?.()
  }

  function stop () {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  if (autoStart) start()

  return {
    canAcceptSession,
    openSession,
    register,
    sessionCount,
    start,
    stop,
    // exposed for tests: drive one sampling pass deterministically
    _sampleOnce: sample,
    _settle: settle,
    _links: links,
    _sessionsByKey: sessionsByKey,
    _violations: violations,
    get activeLinks () { return links.size }
  }
}
