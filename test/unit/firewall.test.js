import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'
import { makeFirewall } from '../../src/firewall.js'
import { fakeClock } from '../../src/clock.js'
import { fakeMetrics } from '../helpers/fake-stream.js'
import { DEFAULTS } from '../../src/config.js'

const KEY_A = b4a.alloc(32, 1)
const KEY_B = b4a.alloc(32, 2)
const HEX_A = b4a.toString(KEY_A, 'hex')
const HEX_B = b4a.toString(KEY_B, 'hex')

function make (overrides = {}, now = fakeClock(), members = null) {
  const metrics = fakeMetrics()
  const fw = makeFirewall({ ...DEFAULTS, ...overrides }, metrics, { now, members })
  return { fw, metrics, now }
}

// The live view src/roster.js hands the firewall, without a file behind it.
// Same three members: has, keys and size.
function memberSet (...keys) {
  const set = new Set(keys)
  return {
    has: (keyHex) => set.has(keyHex),
    keys: () => set,
    get size () { return set.size },
    _set: set
  }
}

test('an unknown key is allowed on an open relay', () => {
  const { fw } = make()
  assert.equal(fw.firewall(KEY_A), false, 'firewall returns true to REJECT')
})

test('a banned key is rejected and counted', () => {
  const { fw, metrics } = make({ banlist: [HEX_A] })
  assert.equal(fw.firewall(KEY_A), true)
  assert.equal(metrics.read('sessionsRejected', { reason: 'banned' }), 1)
  assert.equal(fw.firewall(KEY_B), false, 'other keys are unaffected')
})

test('banning at runtime takes effect immediately', () => {
  const { fw } = make()
  assert.equal(fw.firewall(KEY_A), false)
  fw.ban(HEX_A)
  assert.equal(fw.isBanned(HEX_A), true)
  assert.equal(fw.firewall(KEY_A), true)
  assert.equal(fw.unban(HEX_A), true)
  assert.equal(fw.firewall(KEY_A), false)
})

test('allowlist mode turns the relay private', () => {
  const { fw, metrics } = make({ allowlist: [HEX_A] })
  assert.equal(fw.firewall(KEY_A), false, 'listed key allowed')
  assert.equal(fw.firewall(KEY_B), true, 'unlisted key rejected')
  assert.equal(metrics.read('sessionsRejected', { reason: 'not-allowlisted' }), 1)
  assert.equal(fw.allowlisted, 1)
})

test('the session rate cap trips on the (N+1)th attempt in a window', () => {
  const now = fakeClock(1000)
  const { fw, metrics } = make({ sessionRate: 3 }, now)

  assert.equal(fw.firewall(KEY_A), false)
  assert.equal(fw.firewall(KEY_A), false)
  assert.equal(fw.firewall(KEY_A), false)
  assert.equal(fw.firewall(KEY_A), true, '4th within the minute is a storm')
  assert.equal(metrics.read('sessionsRejected', { reason: 'session-rate' }), 1)
})

test('the rate window is per key', () => {
  const now = fakeClock()
  const { fw } = make({ sessionRate: 1 }, now)
  assert.equal(fw.firewall(KEY_A), false)
  assert.equal(fw.firewall(KEY_A), true)
  assert.equal(fw.firewall(KEY_B), false, 'one noisy peer must not lock out another')
})

test('the rate window resets after a minute', () => {
  const now = fakeClock()
  const { fw } = make({ sessionRate: 1 }, now)
  assert.equal(fw.firewall(KEY_A), false)
  assert.equal(fw.firewall(KEY_A), true)

  now.advance(60_001)
  assert.equal(fw.firewall(KEY_A), false, 'a fresh window admits again')
})

test('a banned key is rejected before it can consume rate budget', () => {
  const now = fakeClock()
  const { fw } = make({ sessionRate: 5, banlist: [HEX_A] }, now)
  for (let i = 0; i < 10; i++) assert.equal(fw.firewall(KEY_A), true)
  assert.equal(fw._windows.size, 0, 'no window was ever created for the banned key')
})

test('stale rate windows are garbage-collected', () => {
  const now = fakeClock()
  const { fw } = make({ sessionRate: 10 }, now)
  fw.firewall(KEY_A)
  assert.equal(fw._windows.size, 1)

  now.advance(60_000 + 5 * 60_000 + 1)
  fw.gc()
  assert.equal(fw._windows.size, 0, 'a churn of one-shot keys must not grow the map')
})

test('an active window survives garbage collection', () => {
  const now = fakeClock()
  const { fw } = make({ sessionRate: 10 }, now)
  fw.firewall(KEY_A)
  now.advance(1000)
  fw.gc()
  assert.equal(fw._windows.size, 1)
})

test('open mode with no allowlist is unchanged', () => {
  // Regression: the roster must not gate a relay that never asked to be gated.
  const { fw } = make({ access: 'open' }, fakeClock(), memberSet(HEX_B))
  assert.equal(fw.firewall(KEY_A), false)
  assert.equal(fw.allowlisted, null)
  assert.equal(fw.gated, false)
})

test('an ALLOWLIST in open mode means exactly that list, roster or no roster', () => {
  // The roster is the dynamic half of the admitted set in INVITE mode only.
  // An operator who flips back to open with an ALLOWLIST to pin the relay to two
  // keys must not keep admitting every member a previous invite phase minted —
  // and adminWrite is on by default, so a roster can exist either way.
  const { fw } = make({ access: 'open', allowlist: [HEX_B] }, fakeClock(), memberSet(HEX_A))
  assert.equal(fw.gated, true)
  assert.equal(fw.firewall(KEY_B), false, 'the listed key')
  assert.equal(fw.firewall(KEY_A), true, 'a roster member is NOT admitted in open mode')
  assert.equal(fw.allowlisted, 1, 'and is not counted as admitted either')
})

test('invite mode with an empty roster admits nobody', () => {
  // The load-bearing case. Revoking the last member must refuse everyone rather
  // than quietly reverting to an open relay.
  const { fw, metrics } = make({ access: 'invite' }, fakeClock(), memberSet())
  assert.equal(fw.firewall(KEY_A), true)
  assert.equal(metrics.read('sessionsRejected', { reason: 'not-allowlisted' }), 1)
  assert.equal(fw.allowlisted, 0, 'gated with nobody on the list, not "not gated"')
})

test('invite mode with no roster at all still admits nobody', () => {
  const { fw } = make({ access: 'invite' })
  assert.equal(fw.firewall(KEY_A), true)
})

test('a roster member is admitted in invite mode', () => {
  const { fw } = make({ access: 'invite' }, fakeClock(), memberSet(HEX_A))
  assert.equal(fw.firewall(KEY_A), false)
  assert.equal(fw.firewall(KEY_B), true)
  assert.equal(fw.allowlisted, 1)
})

test('a static ALLOWLIST entry is admitted alongside the roster', () => {
  // Union, not replacement: ALLOWLIST keeps its meaning in invite mode.
  const { fw } = make({ access: 'invite', allowlist: [HEX_B] }, fakeClock(), memberSet(HEX_A))
  assert.equal(fw.firewall(KEY_A), false, 'roster member')
  assert.equal(fw.firewall(KEY_B), false, 'static entry')
  assert.equal(fw.allowlisted, 2)
})

test('a key on both lists is counted once', () => {
  // "Keys admitted" is how many peers can connect, and this key is one peer.
  const { fw } = make({ access: 'invite', allowlist: [HEX_A] }, fakeClock(), memberSet(HEX_A, HEX_B))
  assert.equal(fw.allowlisted, 2, 'A is on both lists; B is only on the roster')
})

test('a revoked member is refused', () => {
  const members = memberSet(HEX_A)
  const { fw } = make({ access: 'invite' }, fakeClock(), members)
  assert.equal(fw.firewall(KEY_A), false)
  members._set.delete(HEX_A)
  assert.equal(fw.firewall(KEY_A), true, 'the view is live, not a boot-time copy')
})

test('a banned member is refused before membership is consulted', () => {
  const { fw, metrics } = make({ access: 'invite', banlist: [HEX_A] }, fakeClock(), memberSet(HEX_A))
  assert.equal(fw.firewall(KEY_A), true)
  assert.equal(metrics.read('sessionsRejected', { reason: 'banned' }), 1)
  assert.equal(metrics.read('sessionsRejected', { reason: 'not-allowlisted' }), 0)
})

test('refusals are counted for the last hour', () => {
  // The operator-side half of a refusal the client cannot diagnose: it sees a
  // failed handshake and cannot tell it from an offline relay.
  const now = fakeClock()
  const { fw } = make({ access: 'invite' }, now, memberSet())
  for (let i = 0; i < 3; i++) fw.firewall(KEY_A)
  assert.equal(fw.refusedLastHour, 3)

  now.advance(30 * 60_000)
  fw.firewall(KEY_A)
  assert.equal(fw.refusedLastHour, 4, 'half an hour later, both are still in the window')

  now.advance(31 * 60_000)
  assert.equal(fw.refusedLastHour, 1, 'the first three have aged out, the fourth has not')

  now.advance(30 * 60_000)
  assert.equal(fw.refusedLastHour, 0)
})

test('refusal accounting is bounded however many times a peer is refused', () => {
  // The membership reject returns BEFORE the session-rate check, so nothing caps
  // this path: an unauthenticated peer must not be able to grow memory by
  // retrying. One counter per minute, sixty of them, whatever the traffic.
  const now = fakeClock()
  const { fw } = make({ access: 'invite' }, now, memberSet())
  for (let i = 0; i < 50_000; i++) fw.firewall(KEY_A)

  assert.equal(fw.refusedLastHour, 50_000, 'still counted honestly')
  assert.equal(fw._refusals.length, 60, 'and in fixed space')
  assert.equal(fw._windows.size, 0, 'the rate window is never even reached')
})

test('an admitted connection is not counted as a refusal', () => {
  const { fw } = make({ access: 'invite' }, fakeClock(), memberSet(HEX_A))
  fw.firewall(KEY_A)
  assert.equal(fw.refusedLastHour, 0)
})

test('a TTL ban expires', () => {
  const now = fakeClock()
  const { fw } = make({}, now)
  fw.ban(HEX_A, 1000)
  assert.equal(fw.firewall(KEY_A), true)
  assert.equal(fw.bannedCount, 1)

  now.advance(1001)
  assert.equal(fw.isBanned(HEX_A), false)
  assert.equal(fw.firewall(KEY_A), false)
  assert.equal(fw.bannedCount, 0)
})

test('a ban with no TTL is permanent', () => {
  const now = fakeClock()
  const { fw } = make({}, now)
  fw.ban(HEX_A)
  now.advance(365 * 24 * 3600_000)
  assert.equal(fw.isBanned(HEX_A), true, 'cfg.banlist and the auto-ban must not decay')
})

test('expired bans are swept by the gc', () => {
  const now = fakeClock()
  const { fw } = make({}, now)
  fw.ban(HEX_A, 1000)
  now.advance(1001)
  fw.gc()
  assert.equal(fw._bans.size, 0)
})
