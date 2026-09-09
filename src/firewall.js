// Connection admission. Composes three independent signals; ANY of them rejects.
//
//   1. ban set      — keys evicted for abuse (operator-configured, or added at
//                     runtime by the meter after repeated cap violations)
//   2. membership   — when the relay is gated, the union of the static ALLOWLIST
//                     and the live roster is the only set that may connect
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
// One counter per minute for an hour. A ring of 60 integers rather than a list of
// timestamps because the membership refusal happens BEFORE the session-rate check
// and therefore has no cap in front of it: an unauthenticated peer hammering a
// gated relay would otherwise add an entry per attempt and hold it for an hour.
const REFUSAL_BUCKETS = 60
const BUCKET_MS = 60_000

function hexOf (value) {
  return b4a.toString(idEnc.decode(String(value).trim()), 'hex')
}

export function makeFirewall (cfg, metrics, { now = monotonicMs, members = null } = {}) {
  // keyHex -> expiry. Infinity is a permanent ban, which is what cfg.banlist and
  // the meter's auto-ban both mint; a TTL is only ever set through ban(key, ms).
  const bans = new Map()
  for (const keyHex of (cfg.banlist || []).map(hexOf)) bans.set(keyHex, Infinity)
  // Static, config-managed entries. The roster is the dynamic half and arrives
  // as `members`; in invite mode the effective set is their union.
  const staticAllow = cfg.allowlist ? new Set(cfg.allowlist.map(hexOf)) : null
  const inviteMode = cfg.access === 'invite'
  const gated = inviteMode || !!staticAllow
  const windows = new Map() // keyHex -> { count, resetAt }
  // Refusals are the only diagnosis available for a member who cannot connect —
  // the client sees a failed handshake and cannot tell it from an offline relay
  // (contract §7.1).
  //
  // This counter is NOT purely "a member is misconfigured". A Mirall client in
  // `auto` mode offers its relay key to every peer that dials it, so a member's
  // own space peers can adopt our key and be refused here without ever having
  // been given an invite. Newer clients suppress that for a private relay; older
  // ones do not. So read a non-zero count as "someone tried and was not on the
  // roster", never as "someone is attacking us".
  const refusals = Array.from({ length: REFUSAL_BUCKETS }, () => ({ minute: -1, count: 0 }))

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

  function admitted (keyHex) {
    if (staticAllow?.has(keyHex)) return true
    // Only in invite mode. With ACCESS=open an ALLOWLIST means exactly the list
    // it names, as it always has, so a roster left over from invite mode — or
    // one built through the admin API, which is on by default — must not widen
    // it behind the operator's back.
    if (inviteMode && members?.has(keyHex)) return true
    return false
  }

  function noteRefusal () {
    const minute = Math.floor(now() / BUCKET_MS)
    const slot = refusals[minute % REFUSAL_BUCKETS]
    // A slot from an hour ago is reused rather than accumulated onto.
    if (slot.minute !== minute) {
      slot.minute = minute
      slot.count = 0
    }
    slot.count++
  }

  function refusedSince (minutes) {
    const minute = Math.floor(now() / BUCKET_MS)
    let total = 0
    for (const slot of refusals) {
      if (slot.minute >= 0 && minute - slot.minute < minutes) total += slot.count
    }
    return total
  }

  // Reject-only; it never mutates state on the reject paths that precede the
  // rate check, so a banned peer cannot also consume another peer's budget.
  function firewall (remotePublicKey) {
    const keyHex = b4a.toString(remotePublicKey, 'hex')
    if (isBanned(keyHex)) return reject('banned')
    if (gated && !admitted(keyHex)) {
      noteRefusal()
      return reject('not-allowlisted')
    }
    if (rateExceeded(keyHex)) return reject('session-rate')
    return false
  }

  // A ban with no TTL stays permanent, exactly as before: cfg.banlist and the
  // meter's auto-ban are unaffected by the expiry map.
  function ban (keyHex, ttlMs = null) {
    bans.set(keyHex, ttlMs > 0 ? now() + ttlMs : Infinity)
  }

  function unban (keyHex) {
    return bans.delete(keyHex)
  }

  function isBanned (keyHex) {
    const expiresAt = bans.get(keyHex)
    if (expiresAt === undefined) return false
    if (now() >= expiresAt) {
      bans.delete(keyHex)
      return false
    }
    return true
  }

  function sweepBans (t) {
    for (const [keyHex, expiresAt] of bans) {
      if (t >= expiresAt) bans.delete(keyHex)
    }
  }

  function gc () {
    const t = now()
    for (const [keyHex, w] of windows) {
      if (t >= w.resetAt + GC_AFTER_MS) windows.delete(keyHex)
    }
    sweepBans(t)
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
    get bannedCount () {
      sweepBans(now())
      return bans.size
    },
    // null means "not gated" — an open relay has no admitted set to count, which
    // is a different fact from a gated relay whose set happens to be empty.
    //
    // A real union, not a sum: a key on both the ALLOWLIST and the roster can
    // only connect once, and counting it twice is what the status page shows as
    // "keys admitted".
    get allowlisted () {
      if (!gated) return null
      if (!inviteMode || !members) return staticAllow ? staticAllow.size : 0
      if (!staticAllow) return members.size
      const union = new Set(staticAllow)
      for (const keyHex of members.keys()) union.add(keyHex)
      return union.size
    },
    get refusedLastHour () {
      return refusedSince(REFUSAL_BUCKETS)
    },
    get gated () { return gated },
    _windows: windows,
    _bans: bans,
    _refusals: refusals
  }
}
