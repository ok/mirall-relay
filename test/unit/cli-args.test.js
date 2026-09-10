import test from 'node:test'
import assert from 'node:assert/strict'
import { camel, parseLongOptions } from '../../src/cli-args.js'

test('spaced and inline values parse the same way', () => {
  const spec = { relay: { value: true }, timeout: { value: true } }
  assert.deepEqual(parseLongOptions(['--relay', 'abc', '--timeout=10'], spec).flags, {
    relay: 'abc',
    timeout: '10'
  })
})

test('positionals are kept on either side of a spaced flag', () => {
  const spec = { 'roster-file': { value: true } }
  const opts = { allowPositionals: true }
  // The label must not be mistaken for the flag's value, and the flag's value
  // must not be mistaken for a label.
  assert.deepEqual(
    parseLongOptions(['--roster-file', '/data/members.json', 'ben'], spec, opts),
    { flags: { 'roster-file': '/data/members.json' }, positionals: ['ben'] }
  )
  assert.deepEqual(
    parseLongOptions(['ben', '--roster-file', '/data/members.json'], spec, opts),
    { flags: { 'roster-file': '/data/members.json' }, positionals: ['ben'] }
  )
})

test('a positional is an error unless the caller allows one', () => {
  assert.throws(() => parseLongOptions(['ben'], {}), /unexpected argument "ben"/)
})

test('an unknown flag is refused', () => {
  assert.throws(() => parseLongOptions(['--nope'], { relay: { value: true } }), /unknown flag --nope/)
  assert.throws(() => parseLongOptions(['--nope=1'], { relay: { value: true } }), /unknown flag --nope/)
})

test('a value flag with no value is an error', () => {
  assert.throws(() => parseLongOptions(['--relay'], { relay: { value: true } }), /--relay requires a value/)
})

test('bareBooleanValue is what lets a bare flag mean true downstream', () => {
  const spec = { ephemeral: { value: true } }
  assert.deepEqual(parseLongOptions(['--ephemeral'], spec, { bareBooleanValue: '' }).flags, { ephemeral: '' })
})

test('a boolean flag takes no value and defaults are filled in', () => {
  const spec = { help: { value: false, aliases: ['-h'] }, bytes: { value: true, parse: Number, default: 7 } }
  assert.deepEqual(parseLongOptions(['--help'], spec).flags, { help: true, bytes: 7 })
  assert.deepEqual(parseLongOptions(['-h'], spec).flags, { help: true, bytes: 7 })
  assert.deepEqual(parseLongOptions(['--bytes', '9'], spec).flags, { bytes: 9 })
  assert.throws(() => parseLongOptions(['--help=1'], spec), /--help does not take a value/)
})

test('camel turns a kebab-case flag into its config key', () => {
  assert.equal(camel('max-link-bytes'), 'maxLinkBytes')
  assert.equal(camel('port'), 'port')
})
