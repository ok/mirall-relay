// Documentation drift guard.
//
// A configuration option that exists but is documented nowhere is invisible: an
// operator cannot tune what they cannot find. `--over-rate-grace-ms` shipped that
// way and nobody noticed until a manual read-through, so this pins it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const CONFIG = read('src/config.js')
const HELP = read('bin/mirall-relay.js')
const ENV_EXAMPLE = read('deploy/mirall-relay.env.example')
const README = read('README.md')
const OPERATIONS = read('OPERATIONS.md')

// Every env suffix declared in config.js's SPEC table.
const OPTIONS = [...CONFIG.matchAll(/\['([A-Z_]+)',/g)].map((m) => m[1])

function envName (suffix) {
  return 'MIRALL_RELAY_' + suffix
}

function flagName (suffix) {
  return '--' + suffix.toLowerCase().replace(/_/g, '-')
}

test('the SPEC table was parsed (the guard below is only as good as this)', () => {
  assert.ok(OPTIONS.length >= 20, `expected to find the option table, got ${OPTIONS.length}`)
  assert.ok(OPTIONS.includes('ALLOWLIST'))
  assert.ok(OPTIONS.includes('BANLIST'))
})

test('every option appears in --help', () => {
  const missing = OPTIONS.filter((o) => !HELP.includes(flagName(o)))
  assert.deepEqual(missing.map(flagName), [], 'undocumented flags')
})

test('every option appears in the deployment env template', () => {
  const missing = OPTIONS.filter((o) => !ENV_EXAMPLE.includes(envName(o)))
  assert.deepEqual(missing.map(envName), [], 'options missing from deploy/mirall-relay.env.example')
})

// The README is deliberately "the essentials", not exhaustive — but the options
// an operator reaches for under pressure have to be there.
const README_MUST_COVER = [
  'SEED_FILE', 'SEED', 'PORT', 'ASSUME_REACHABLE', 'ADMIN_HOST',
  'ACCESS', 'ALLOWLIST', 'BANLIST',
  'MAX_SESSIONS_PER_KEY', 'MAX_ACTIVE_LINKS', 'MAX_LINK_RATE', 'MAX_LINK_BYTES'
]

test('the README documents the options an operator actually needs', () => {
  const missing = README_MUST_COVER.filter((o) => !README.includes(envName(o)))
  assert.deepEqual(missing.map(envName), [], 'options missing from the README table')
})

test('README_MUST_COVER only names options that really exist', () => {
  const bogus = README_MUST_COVER.filter((o) => !OPTIONS.includes(o))
  assert.deepEqual(bogus, [], 'the guard list has drifted from config.js')
})

test('both access-control lists are explained, not just listed', () => {
  // A bare table row for ALLOWLIST is a trap: the both-peers rule and the
  // ephemeral-key caveat are what make the difference between it working and
  // silently locking a relay against itself.
  assert.match(README, /[Bb]oth peers/, 'the both-peers allowlist rule must be stated')
  assert.match(README, /BANLIST/, 'the banlist must be documented alongside the allowlist')
})

test('the invite workflow is documented, not just the flags', () => {
  // A member roster nobody can find out how to fill is a feature that does not
  // exist. The flag table alone does not tell an operator how to mint one.
  assert.match(README, /mirall-relay invite create/, 'the README must show how to mint an invite')
  assert.match(OPERATIONS, /invite revoke/, 'and OPERATIONS must carry the revoke runbook')
  assert.match(README, /ACCESS=invite|`invite`/, 'and name the mode that turns it on')
})

test('the roster is named beside the seed in the backup rules', () => {
  // Second piece of durable state, and the one that reads as disposable right up
  // until it locks out every member.
  // Whitespace-tolerant: these are wrapped prose, not literals, and a reflow
  // must not read as the sentence having been deleted.
  assert.match(OPERATIONS, /members\.json/, 'the roster must appear in the runbook')
  assert.match(OPERATIONS, /locks\s+out\s+every\s+member/, 'with what losing it costs')
  assert.match(OPERATIONS, /hands\s+over\s+every\s+membership/, 'and what leaking it costs')
})
