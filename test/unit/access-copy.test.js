// The mode wording both operator pages share.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { modePill, modeWord, rosterNotice } from '../../src/operator/access-copy.js'

const invite = (active, total = active) => ({ mode: 'invite', members: { active, total }, allowlisted: active })

test('each mode gets its own pill, in the operator’s words', () => {
  assert.deepEqual(modePill({ mode: 'open', members: null }), { text: 'Public relay', tone: 'idle' })
  assert.deepEqual(modePill(invite(3)), { text: 'Private relay · 3 members', tone: 'good' })
  assert.deepEqual(modePill(invite(1)), { text: 'Private relay · 1 member', tone: 'good' })
  assert.deepEqual(modePill({ mode: 'allowlist', allowlisted: 2 }), { text: 'Restricted · 2 static keys', tone: 'idle' })
  assert.deepEqual(modePill({ mode: 'allowlist', allowlisted: 1 }), { text: 'Restricted · 1 static key', tone: 'idle' })
})

test('an empty private relay is a warning, not an error and not "public"', () => {
  // Legitimate and fail-closed: also what revoking the last member produces.
  assert.deepEqual(modePill(invite(0)), { text: 'Private relay · no members', tone: 'warn' })
  assert.deepEqual(modePill(invite(0, 4)), { text: 'Private relay · no members', tone: 'warn' }, 'revoked members do not count')
})

test('a missing access block reads as public rather than throwing', () => {
  assert.equal(modePill(undefined).text, 'Public relay')
  assert.equal(modePill({}).text, 'Public relay')
  assert.equal(modeWord(undefined), 'Public')
})

test('the mode word matches the pill', () => {
  assert.equal(modeWord({ mode: 'open' }), 'Public')
  assert.equal(modeWord({ mode: 'allowlist' }), 'Restricted')
  assert.equal(modeWord({ mode: 'invite' }), 'Private')
})

test('a private relay needs no caveat on the members page', () => {
  assert.equal(rosterNotice(invite(0)), null)
  assert.equal(rosterNotice(invite(5)), null)
})

test('a public relay is told invites work but exclude nobody yet', () => {
  const text = rosterNotice({ mode: 'open' })
  assert.match(text, /public/)
  assert.match(text, /already work/)
  assert.match(text, /MIRALL_RELAY_ACCESS=invite/, 'the env var stays for operators without a settings screen')
  assert.match(text, /Private/, 'and the word a settings screen uses is there too')
})

test('an allowlist relay is NOT told invites already work', () => {
  // In allowlist mode a roster member is refused, so the public-mode sentence
  // would be a lie here.
  const text = rosterNotice({ mode: 'allowlist', allowlisted: 2 })
  assert.doesNotMatch(text, /already work/)
  assert.match(text, /do not connect yet/)
  assert.match(text, /MIRALL_RELAY_ALLOWLIST/)
})

test('the module is DOM-free, so the server can import it', () => {
  const source = readFileSync(new URL('../../src/operator/access-copy.js', import.meta.url), 'utf8')
  assert.ok(!/\bdocument\b|\bwindow\b/.test(source))
})
