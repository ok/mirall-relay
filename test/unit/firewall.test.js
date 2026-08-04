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

function make (overrides = {}, now = fakeClock()) {
  const metrics = fakeMetrics()
  const fw = makeFirewall({ ...DEFAULTS, ...overrides }, metrics, { now })
  return { fw, metrics, now }
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
