// The reachability re-probe. Driven by a stand-in DHT and a hand-cranked timer,
// so every branch runs without a network or a clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startReprobe } from '../../src/reprobe.js'

function fakeTimers () {
  const pending = []
  return {
    pending,
    setTimer: (fn, ms) => { const t = { fn, ms, unref () {} }; pending.push(t); return t },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i !== -1) pending.splice(i, 1) },
    async fire () { const t = pending.shift(); await t.fn(); return t.ms }
  }
}

function fakeDht (passesOnProbe) {
  const dht = {
    firewalled: true,
    probes: 0,
    async _updateNetworkState () {
      dht.probes++
      if (dht.probes === passesOnProbe) dht.firewalled = false
    }
  }
  return dht
}

test('a reachable node is never re-probed', () => {
  const timers = fakeTimers()
  const dht = { firewalled: false, _updateNetworkState: () => assert.fail('must not probe') }
  startReprobe(dht, timers)
  assert.equal(timers.pending.length, 0)
})

test('a firewalled node is re-probed until a probe passes, then left alone', async () => {
  const timers = fakeTimers()
  const dht = fakeDht(3)
  const results = []
  startReprobe(dht, { ...timers, onResult: (firewalled) => results.push(firewalled) })

  await timers.fire()
  await timers.fire()
  assert.equal(dht.firewalled, true)
  await timers.fire()
  assert.equal(dht.firewalled, false)
  assert.equal(dht.probes, 3)
  assert.equal(timers.pending.length, 0, 'nothing is scheduled once it is reachable')
  assert.deepEqual(results, [true, true, false])
})

test('the wait doubles up to a ceiling, so a truly closed port is not hammered', async () => {
  const timers = fakeTimers()
  startReprobe(fakeDht(Infinity), { ...timers, intervalMs: 1000, maxIntervalMs: 5000 })
  const waits = []
  for (let i = 0; i < 5; i++) waits.push(await timers.fire())
  assert.deepEqual(waits, [1000, 2000, 4000, 5000, 5000])
})

test('a probe that throws does not end the retries', async () => {
  const timers = fakeTimers()
  const dht = { firewalled: true, _updateNetworkState: async () => { throw new Error('socket closed') } }
  startReprobe(dht, timers)
  await timers.fire()
  assert.equal(timers.pending.length, 1)
})

test('stop cancels the pending probe, and one in flight schedules nothing after it', async () => {
  const timers = fakeTimers()
  const reprobe = startReprobe(fakeDht(Infinity), timers)
  reprobe.stop()
  assert.equal(timers.pending.length, 0)

  const late = fakeTimers()
  const dht = fakeDht(Infinity)
  const running = startReprobe(dht, late)
  const probe = late.fire()
  running.stop()
  await probe
  assert.equal(late.pending.length, 0)
})

test('a dht-rpc without the private hook degrades to doing nothing', () => {
  // The hook is dht-rpc internals. If a bump removes it the relay must still
  // start; it just loses the self-heal, and says so once.
  const timers = fakeTimers()
  let warned = 0
  const reprobe = startReprobe({ firewalled: true }, { ...timers, onUnsupported: () => warned++ })
  assert.equal(timers.pending.length, 0)
  assert.equal(warned, 1)
  reprobe.stop()
})
