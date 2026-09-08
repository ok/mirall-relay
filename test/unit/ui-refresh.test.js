// The browser refresh loop's decisions. src/ui/ui.js only touches the DOM inside
// start(), which is guarded on `document` existing — so importing it here runs
// nothing, and the three things that can silently stop the page updating are
// testable without a browser or a DOM library.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readField, shouldReload, applyFields, reachabilitySignature } from '../../src/ui.js'
import { formatField } from '../../src/format.js'

const STATUS = {
  uptimeSeconds: 11520,
  reachability: {
    state: 'reachable',
    probed: true,
    portRandomized: false,
    ephemeralConfigured: false,
    publicHost: '203.0.113.9',
    publicPort: 49737,
    port: 49737,
    bootstrapped: true,
    dhtNodes: 128,
    bound: { host: '0.0.0.0', port: 49737, family: 4 }
  },
  traffic: { bytesRelayed: 1536, pairings: { matched: 7 } },
  access: { banned: 0 }
}

function fakeNode (field, format, textContent = '') {
  return { dataset: { field, format }, textContent }
}

function fakeRoot (nodes) {
  return { querySelectorAll: () => nodes }
}

test('readField walks the dotted paths the page actually uses', () => {
  // Every one of these strings appears in a data-field attribute in the rendered
  // page; a typo in the walk stops every counter silently.
  assert.equal(readField(STATUS, 'traffic.bytesRelayed'), 1536)
  assert.equal(readField(STATUS, 'traffic.pairings.matched'), 7)
  assert.equal(readField(STATUS, 'uptimeSeconds'), 11520)
  assert.equal(readField(STATUS, 'access.banned'), 0)
  assert.equal(readField(STATUS, 'reachability.bootstrapped'), true)
})

test('readField gives up rather than throwing on a path that is not there', () => {
  assert.equal(readField(STATUS, 'traffic.nope'), undefined)
  assert.equal(readField(STATUS, 'traffic.pairings.nope.deeper'), undefined)
  assert.equal(readField({ traffic: { pairings: null } }, 'traffic.pairings.matched'), undefined)
})

test('formatField uses the same formatters the server rendered with', () => {
  assert.equal(formatField(1536, 'bytes'), '1.5 KiB')
  assert.equal(formatField(11520, 'duration'), '3h 12m')
  assert.equal(formatField(1234, 'count'), '1,234')
  assert.equal(formatField(true, 'bool'), 'yes')
  assert.equal(formatField('plain', undefined), 'plain')
})

test('applyFields patches only what changed', () => {
  const changed = fakeNode('traffic.bytesRelayed', 'bytes', '0 B')
  const unchanged = fakeNode('uptimeSeconds', 'duration', '3h 12m')
  const missing = fakeNode('traffic.nothing', 'count', 'keep me')

  applyFields(fakeRoot([changed, unchanged, missing]), STATUS)

  assert.equal(changed.textContent, '1.5 KiB')
  assert.equal(unchanged.textContent, '3h 12m')
  assert.equal(missing.textContent, 'keep me', 'an absent field must not blank the cell')
})

test('any change to the server-rendered reachability block asks for the page again', () => {
  // The verdict, the symmetric-NAT note, the remediation list, the observed
  // address and the local socket are all server-rendered prose, and NONE of them
  // is a data-field. Patching numbers over a stale verdict would be a lie.
  const dataset = { reachability: reachabilitySignature(STATUS.reachability) }
  assert.equal(shouldReload(STATUS, dataset), false)

  const changes = [
    ['state', { state: 'firewalled' }],
    ['probed', { probed: false }],
    // The one that mattered: dht-rpc's NAT sampler starts empty and learns the
    // host and port minutes into a run, so randomization is not a boot constant.
    // Keying the reload on state alone meant a page left open could never show
    // the symmetric-NAT warning the runbook advertises it for.
    ['portRandomized', { portRandomized: true }],
    ['publicHost', { publicHost: '198.51.100.7' }],
    ['publicPort', { publicPort: 0 }],
    ['bound port', { bound: { host: '0.0.0.0', port: 54949, family: 4 } }]
  ]
  for (const [what, patch] of changes) {
    const next = { reachability: { ...STATUS.reachability, ...patch } }
    assert.equal(shouldReload(next, dataset), true, `${what} must trigger a reload`)
  }
})

test('the signature ignores what the page patches in place', () => {
  // dhtNodes and bootstrapped ARE data-fields, so they must not force a reload
  // every five seconds.
  const dataset = { reachability: reachabilitySignature(STATUS.reachability) }
  const churn = { reachability: { ...STATUS.reachability, dhtNodes: 999, bootstrapped: false } }
  assert.equal(shouldReload(churn, dataset), false)
})
