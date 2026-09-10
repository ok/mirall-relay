import test from 'node:test'
import assert from 'node:assert/strict'
import * as clock from '../../src/clock.js'

test('exports only the production clock', () => {
  assert.deepEqual(Object.keys(clock).sort(), ['monotonicMs'])
})

test('monotonicMs never steps backwards', () => {
  const first = clock.monotonicMs()
  assert.equal(typeof first, 'number')
  assert.ok(clock.monotonicMs() >= first)
})
