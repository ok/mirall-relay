// Connection admission. Composes three independent signals; ANY of them rejects.
//
//   1. ban set      — keys evicted for abuse (operator-configured, or added at
//                     runtime by the meter after repeated cap violations)
//   2. allowlist    — when set, the relay is private: nothing else may connect
//   3. session rate — a per-key sliding window that stops reconnect storms and
//                     the pending-pairing memory flood they cause
//
// hyperdht's convention: the firewall returns TRUE to REJECT.
// It is called as firewall(remotePublicKey, remotePayload, clientAddress)
// (hyperdht/lib/server.js:253).
import b4a from 'b4a'
import idEnc from 'hypercore-id-encoding'
import { monotonicMs } from './clock.js'

const WINDOW_MS = 60_000
// Drop rate-window entries this long after they expire, so a churn of one-shot
// keys cannot grow the map without bound.
const GC_AFTER_MS = 5 * 60_000

function hexOf (value) {
  return b4a.toString(idEnc.decode(String(value).trim()), 'hex')
}

export function makeFirewall (cfg, metrics, { now = monotonicMs } = {}) {
  const banned = new Set((cfg.banlist || []).map(hexOf))
  const allow = cfg.allowlist ? new Set(cfg.allowlist.map(hexOf)) : null
  const windows = new Map() // keyHex -> { count, resetAt }

  function reject (reason) {
    metrics?.m.sessionsRejected.inc({ reason })
    return true
  }

  function rateExceeded (keyHex) {
    const t = now()
    let w = windows.get(keyHex)
    if (!w || t >= w.resetAt) {
      w = { count: 0, resetAt: t + WINDOW_MS }
      windows.set(keyHex, w)
    }
    return ++w.count > cfg.sessionRate
  }

  // Reject-only; it never mutates state on the reject paths that precede the
  // rate check, so a banned peer cannot also consume another peer's budget.
  function firewall (remotePublicKey) {
    const keyHex = b4a.toString(remotePublicKey, 'hex')
    if (banned.has(keyHex)) return reject('banned')
    if (allow && !allow.has(keyHex)) return reject('not-allowlisted')
    if (rateExceeded(keyHex)) return reject('session-rate')
    return false
  }

  function ban (keyHex) {
    banned.add(keyHex)
  }

  function unban (keyHex) {
    return banned.delete(keyHex)
  }

  function isBanned (keyHex) {
    return banned.has(keyHex)
  }

  function gc () {
    const t = now()
    for (const [keyHex, w] of windows) {
      if (t >= w.resetAt + GC_AFTER_MS) windows.delete(keyHex)
    }
  }

  const gcTimer = setInterval(gc, GC_AFTER_MS)
  gcTimer.unref?.()

  return {
    firewall,
    ban,
    unban,
    isBanned,
    gc,
    stop: () => clearInterval(gcTimer),
    get bannedCount () { return banned.size },
    get allowlisted () { return allow ? allow.size : null },
    _windows: windows
  }
}
