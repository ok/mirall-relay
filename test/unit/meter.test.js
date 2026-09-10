import test from 'node:test'
import assert from 'node:assert/strict'
import { makeMeter, BAN_AFTER_VIOLATIONS } from '../../src/meter.js'
import { fakeClock } from '../helpers/clock.js'
import { fakeStream, fakeMetrics, fakeFirewall } from '../helpers/fake-stream.js'
import { DEFAULTS } from '../../src/config.js'

function make (overrides = {}, now = fakeClock(0)) {
  const metrics = fakeMetrics()
  const firewall = fakeFirewall()
  const meter = makeMeter(
    { ...DEFAULTS, ...overrides },
    metrics,
    null,
    firewall,
    { now, autoStart: false }
  )
  return { meter, metrics, firewall, now }
}

test('sessions are capped per key and released on close', () => {
  const { meter } = make({ maxSessionsPerKey: 2 })

  assert.equal(meter.canAcceptSession('aa'), true)
  const close1 = meter.openSession('aa')
  const close2 = meter.openSession('aa')
  assert.equal(meter.sessionCount('aa'), 2)
  assert.equal(meter.canAcceptSession('aa'), false, 'third session refused')
  assert.equal(meter.canAcceptSession('bb'), true, 'a different peer is unaffected')

  close1()
  assert.equal(meter.canAcceptSession('aa'), true)
  close2()
  assert.equal(meter.sessionCount('aa'), 0)
  assert.equal(meter._sessionsByKey.has('aa'), false, 'the map must not leak keys')
})

test('closing a session twice does not corrupt the count', () => {
  const { meter } = make()
  const close = meter.openSession('aa')
  close()
  close()
  assert.equal(meter.sessionCount('aa'), 0)
})

test('the global link ceiling refuses new sessions', () => {
  const { meter } = make({ maxActiveLinks: 2 })
  meter.register(fakeStream(), 'aa')
  assert.equal(meter.canAcceptSession('bb'), true)
  meter.register(fakeStream(), 'aa')
  assert.equal(meter.canAcceptSession('bb'), false, 'at the ceiling, admit nobody new')
})

test('registering tracks the link and closing releases it', () => {
  const { meter, metrics } = make()
  const s = fakeStream()
  meter.register(s, 'aa')
  assert.equal(meter.activeLinks, 1)
  assert.equal(metrics.read('linksActive'), 1)
  assert.equal(metrics.read('linksOpened'), 1)

  s.destroy()
  assert.equal(meter.activeLinks, 0)
  assert.equal(metrics.read('linksActive'), 0)
})

test('bytes are accounted from bytesReceived only', () => {
  // bytesTransmitted is structurally 0 on a relayTo()-bridged stream. If the
  // meter ever adds it back in, this test still passes for the wrong reason —
  // so assert the exact total, not merely "> 0".
  const { meter, metrics } = make()
  const s = fakeStream()
  meter.register(s, 'aa')

  s.receive(1000)
  s.bytesTransmitted = 999999 // must be ignored
  meter._sampleOnce()

  assert.equal(metrics.read('bytesRelayed'), 1000)
  assert.equal(s.destroyed, false)
})

test('bytesRelayed accumulates deltas rather than re-counting totals', () => {
  const { meter, metrics, now } = make()
  const s = fakeStream()
  meter.register(s, 'aa')

  s.receive(100); now.advance(1000); meter._sampleOnce()
  s.receive(50); now.advance(1000); meter._sampleOnce()

  assert.equal(metrics.read('bytesRelayed'), 150)
})

test('a link that closes between ticks still has its bytes counted', () => {
  // The sampler runs on an interval; a short transfer can begin and end inside
  // one tick. Without a settle-on-close those bytes vanish from the egress
  // metric operators budget against.
  const { meter, metrics } = make()
  const s = fakeStream()
  meter.register(s, 'aa')

  s.receive(4096)
  s.destroy() // no _sampleOnce() in between

  assert.equal(metrics.read('bytesRelayed'), 4096)
  assert.equal(meter.activeLinks, 0)
})

test('settling on close does not double-count already-sampled bytes', () => {
  const { meter, metrics, now } = make()
  const s = fakeStream()
  meter.register(s, 'aa')

  s.receive(1000)
  now.advance(1000)
  meter._sampleOnce()
  assert.equal(metrics.read('bytesRelayed'), 1000)

  s.receive(500)
  s.destroy()

  assert.equal(metrics.read('bytesRelayed'), 1500)
})

test('a torn-down link banks its final bytes', () => {
  const { meter, metrics } = make({ maxLinkBytes: 100 })
  const s = fakeStream()
  meter.register(s, 'aa')

  s.receive(4096)
  meter._sampleOnce() // trips the byte cap and tears down

  assert.equal(s.destroyed, true)
  assert.equal(metrics.read('bytesRelayed'), 4096, 'the bytes that broke the cap still count')
})

test('the byte cap tears the link down', () => {
  const { meter, metrics } = make({ maxLinkBytes: 100 })
  const s = fakeStream()
  meter.register(s, 'aa')

  s.receive(101)
  meter._sampleOnce()

  assert.equal(s.destroyed, true)
  assert.equal(metrics.read('linksTornByCap', { cap: 'bytes' }), 1)
  assert.equal(meter.activeLinks, 0)
})

test('the duration cap tears the link down', () => {
  const { meter, metrics, now } = make({ maxLinkMs: 1000 })
  const s = fakeStream()
  meter.register(s, 'aa')

  now.advance(999)
  meter._sampleOnce()
  assert.equal(s.destroyed, false, 'not yet')

  now.advance(2)
  meter._sampleOnce()
  assert.equal(s.destroyed, true)
  assert.equal(metrics.read('linksTornByCap', { cap: 'duration' }), 1)
})

test('a brief burst above the rate cap is tolerated', () => {
  const { meter, now } = make({ maxLinkRate: 1000, overRateGraceMs: 5000 })
  const s = fakeStream()
  meter.register(s, 'aa')

  now.advance(1000); s.receive(5000); meter._sampleOnce() // 5000 B/s, over
  now.advance(1000); s.receive(100); meter._sampleOnce() // back under
  now.advance(1000); s.receive(100); meter._sampleOnce()

  assert.equal(s.destroyed, false, 'a ramp-up spike is not abuse')
})

test('a sustained overrun past the grace window tears the link down', () => {
  const { meter, metrics, now } = make({ maxLinkRate: 1000, overRateGraceMs: 3000 })
  const s = fakeStream()
  meter.register(s, 'aa')

  for (let i = 0; i < 5; i++) {
    now.advance(1000)
    s.receive(5000)
    meter._sampleOnce()
  }

  assert.equal(s.destroyed, true)
  assert.equal(metrics.read('linksTornByCap', { cap: 'rate' }), 1)
})

test('one over-cap link does not stop the others from being checked', () => {
  // One offender must not end the sampling pass; later links need the same cap
  // checks in the same tick.
  const { meter, metrics } = make({ maxLinkBytes: 100 })
  const a = fakeStream()
  const b = fakeStream()
  const c = fakeStream()
  meter.register(a, 'aa')
  meter.register(b, 'bb')
  meter.register(c, 'cc')

  a.receive(101)
  b.receive(101)
  c.receive(101)
  meter._sampleOnce()

  assert.equal(a.destroyed, true)
  assert.equal(b.destroyed, true)
  assert.equal(c.destroyed, true)
  assert.equal(metrics.read('linksTornByCap', { cap: 'bytes' }), 3)
})

test('repeat cap violations get the peer banned', () => {
  const { meter, firewall } = make({ maxLinkBytes: 100 })

  for (let i = 0; i < BAN_AFTER_VIOLATIONS; i++) {
    const s = fakeStream()
    meter.register(s, 'aa')
    s.receive(101)
    meter._sampleOnce()
  }

  assert.equal(firewall.isBanned('aa'), true)
})

test('a long honest transfer is not treated as abuse', () => {
  const { meter, firewall, now } = make({ maxLinkMs: 1000 })

  for (let i = 0; i < BAN_AFTER_VIOLATIONS + 2; i++) {
    const s = fakeStream()
    meter.register(s, 'slow')
    now.advance(1001)
    meter._sampleOnce()
  }

  assert.equal(firewall.isBanned('slow'), false, 'duration teardowns must not ban')
})

test('start/stop are idempotent and leave no timer behind', () => {
  const { meter } = make({ meterMs: 10 })
  meter.start()
  meter.start()
  meter.stop()
  meter.stop()
})
