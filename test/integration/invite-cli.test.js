// The invite CLI as an operator runs it: a subprocess, a real roster file, and
// labels that may sit on either side of a relay flag.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFile = promisify(execFileCb)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SEED = 'b'.repeat(64)

function rosterFile (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-invite-cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'members.json')
}

function runInvite (args) {
  return execFile('node', ['bin/mirall-relay.js', 'invite', ...args, '--seed', SEED], { cwd: ROOT })
    .then(({ stdout }) => ({ code: 0, stdout }))
    .catch((err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr }))
}

test('a label is accepted after a spaced relay flag', async (t) => {
  const file = rosterFile(t)
  const { code, stdout } = await runInvite(['create', '--roster-file', file, 'ben'])
  assert.equal(code, 0, stdout)
  assert.match(stdout, /member\s+ben/)
  assert.match(stdout, /invite\s+\S+/)
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).members[0].label, /^ben$/)
})

test('a label is accepted before a spaced relay flag', async (t) => {
  const file = rosterFile(t)
  const { code, stdout } = await runInvite(['create', 'ben', '--roster-file', file])
  assert.equal(code, 0, stdout)
  assert.match(stdout, /member\s+ben/)
})

test('an inline relay flag leaves the label alone', async (t) => {
  const file = rosterFile(t)
  await runInvite(['create', `--roster-file=${file}`, 'ben'])
  const { code, stdout } = await runInvite(['list', `--roster-file=${file}`])
  assert.equal(code, 0, stdout)
  assert.match(stdout, /^ben\s/m)
  assert.match(stdout, /1 active of 1/)
})

test('an unknown flag is a configuration error, not a label', async (t) => {
  const file = rosterFile(t)
  const { code, stderr } = await runInvite(['create', '--nope', 'ben', '--roster-file', file])
  assert.equal(code, 78)
  assert.match(stderr, /configuration error: unknown flag --nope/)
})
