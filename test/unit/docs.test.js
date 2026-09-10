// Documentation drift guard.
//
// A configuration option that exists but is documented nowhere is invisible: an
// operator cannot tune what they cannot find. `--over-rate-grace-ms` shipped that
// way and nobody noticed until a manual read-through, so this pins it.
//
// The option metadata in src/config.js is the source of truth here: every check
// below is driven from OPTIONS, so adding an option adds its documentation
// obligations with it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { OPTIONS, ENV_PREFIX, validateOptionsMetadata } from '../../src/config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// The rendered help, not the source of bin/mirall-relay.js: the option table is
// generated, so only running it proves an operator can see the flag.
const HELP = execFileSync(process.execPath, [path.join(ROOT, 'bin/mirall-relay.js'), '--help'], { encoding: 'utf8' })
const ENV_EXAMPLE = read('deploy/mirall-relay.env.example')
const README = read('README.md')
const OPERATIONS = read('OPERATIONS.md')

const envName = (o) => ENV_PREFIX + o.env
const flagName = (o) => '--' + o.flag
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('the option table is internally consistent', () => {
  assert.doesNotThrow(() => validateOptionsMetadata(OPTIONS))
  assert.ok(OPTIONS.length >= 20, `expected the full option table, got ${OPTIONS.length}`)
  for (const o of OPTIONS) {
    assert.equal(o.flag, o.env.toLowerCase().replace(/_/g, '-'), `${o.flag} and ${o.env} must name the same option`)
  }
})

test('every option appears in --help', () => {
  const missing = OPTIONS.filter((o) => !new RegExp(`${escapeRe(flagName(o))}\\b`).test(HELP))
  assert.deepEqual(missing.map(flagName), [], 'undocumented flags')
})

test('--help names the environment equivalent and every default', () => {
  assert.match(HELP, new RegExp(`${ENV_PREFIX}\\*`), 'the env equivalence must be stated once')
  for (const o of OPTIONS) {
    if (o.helpDefault === null || (o.helpDefault === undefined && o.default === null)) continue
    const shown = o.helpDefault ?? String(o.default)
    assert.match(HELP, new RegExp(`\\[${escapeRe(shown)}\\]`), `${flagName(o)} must show its default`)
  }
})

test('every option appears in the deployment env template', () => {
  const missing = OPTIONS.filter((o) => !ENV_EXAMPLE.includes(envName(o) + '='))
  assert.deepEqual(missing.map(envName), [], 'options missing from deploy/mirall-relay.env.example')
})

test('the env template sets exactly the values the metadata says it does', () => {
  // envExample is the deployment value an operator inherits by copying the file;
  // null means the option must stay commented out, so copying it changes nothing.
  for (const o of OPTIONS) {
    const set = new RegExp(`^${escapeRe(envName(o))}=(.*)$`, 'm')
    if (o.envExample === null) {
      assert.doesNotMatch(ENV_EXAMPLE, set, `${envName(o)} must be commented out in the template`)
      continue
    }
    const m = ENV_EXAMPLE.match(set)
    assert.ok(m, `${envName(o)} must be set in the template`)
    assert.equal(m[1], o.envExample, `${envName(o)} drifted from its metadata`)
  }
})

test('the env template hands out no usable secret', () => {
  // A template that ships a real-looking seed or token invites an operator to
  // deploy someone else's identity.
  for (const o of OPTIONS.filter((o) => o.sensitive)) {
    assert.equal(o.envExample, null, `${envName(o)} is a secret and must not carry an example value`)
    assert.doesNotMatch(ENV_EXAMPLE, new RegExp(`${escapeRe(envName(o))}=\\S{16,}`), `${envName(o)} must not show a usable value`)
  }
})

// The README is deliberately "the essentials", not exhaustive — but the options
// an operator reaches for under pressure have to be there, and `docsRequired`
// is where that judgement lives.
test('the README documents the options an operator actually needs', () => {
  const required = OPTIONS.filter((o) => o.docsRequired)
  assert.ok(required.length >= 10, 'the required-in-README set has thinned out')
  const missing = required.filter((o) => !README.includes(envName(o)))
  assert.deepEqual(missing.map(envName), [], 'options missing from the README table')
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
