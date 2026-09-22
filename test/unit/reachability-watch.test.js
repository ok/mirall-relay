// The reachability transition log. Driven by a hand-cranked state and timer, so
// every branch runs without a network or a clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { watchReachability } from '../../src/reachability-watch.js'

function fakeTimers () {
  const pending = []
  return {
    pending,
    setTimer: (fn, ms) => { const t = { fn, ms, unref () {} }; pending.push(t); return t },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i !== -1) pending.splice(i, 1) },
    fire () { const t = pending.shift(); t.fn(); return t.ms }
  }
}

function watch (initial) {
  const timers = fakeTimers()
  const changes = []
  let state = initial
  const watcher = watchReachability({
    read: () => state,
    onChange: (prev, next) => changes.push([prev, next]),
    unknownWarnMs: 1000,
    ...timers
  })
  return { timers, changes, watcher, set (next) { state = next; watcher.check() } }
}

test('each transition is reported once, and a repeat is not', () => {
  const w = watch('reachable')
  w.watcher.check()
  w.set('port-unstable')
  w.set('port-unstable')
  w.set('reachable')
  assert.deepEqual(w.changes, [[null, 'reachable'], ['reachable', 'port-unstable'], ['port-unstable', 'reachable']])
})

test('a relay that starts out not directly reachable says so on the first check', () => {
  const w = watch('port-unstable')
  w.watcher.check()
  assert.deepEqual(w.changes, [[null, 'port-unstable']])
})

test('an address that does not settle is reported once more when it lasts', () => {
  const w = watch('reachable')
  w.watcher.check()
  w.set('unknown')
  assert.equal(w.timers.pending.length, 1)
  assert.equal(w.timers.fire(), 1000)
  assert.deepEqual(w.changes.at(-1), ['unknown', 'unknown-long'])
  assert.equal(w.timers.pending.length, 0, 'once, not on a loop')
})

test('an address that settles in time never gets the long warning', () => {
  const w = watch('reachable')
  w.watcher.check()
  w.set('unknown')
  w.set('reachable')
  assert.equal(w.timers.pending.length, 0)
  assert.deepEqual(w.changes.at(-1), ['unknown', 'reachable'])
})

test('stop() clears the timer and silences later checks', () => {
  const w = watch('unknown')
  w.watcher.check()
  w.watcher.stop()
  assert.equal(w.timers.pending.length, 0)
  w.set('reachable')
  assert.deepEqual(w.changes, [[null, 'unknown']])
})
