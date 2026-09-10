// The probe is the deployment gate — if it can report success against a broken
// relay, or failure against a working one, every runbook step that depends on it
// is worthless. So exercise the SHIPPED script as a subprocess, not its internals.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createTestnet, startTestRelay } from '../helpers/make-relay.js'

const execFile = promisify(execFileCb)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function runProbe (args) {
  return execFile('node', ['scripts/probe.js', ...args], { cwd: ROOT })
    .then(({ stdout }) => ({ code: 0, out: JSON.parse(stdout) }))
    .catch((err) => ({ code: err.code, out: safeJson(err.stdout), stderr: err.stderr }))
}

function safeJson (text) {
  try { return JSON.parse(text) } catch { return null }
}

function bootstrapArg (testnet) {
  return testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')
}

test('the probe reports success and real throughput against a live relay', async (t) => {
  const testnet = await createTestnet(4)
  const relay = await startTestRelay(testnet, { MIRALL_RELAY_METER_MS: '50' })
  t.after(async () => { await relay.stop(); await testnet.destroy() })

  const { code, out } = await runProbe([
    '--relay', relay.relay.publicKeyZ32,
    '--bootstrap', bootstrapArg(testnet),
    '--bytes', '131072'
  ])

  assert.equal(code, 0)
  assert.equal(out.ok, true)
  assert.equal(out.bridged, true)
  assert.ok(out.bytes >= 131072, `expected the payload to arrive, got ${out.bytes}`)
  assert.ok(out.throughputMbps > 0)
})

test('the probe fails against a relay key that nothing is listening on', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())

  // Well-formed key, no relay behind it — the exact shape of a typo'd or stale
  // configuration, which must fail loudly rather than hang or pass.
  const { code, out } = await runProbe([
    '--relay', 'f'.repeat(64),
    '--bootstrap', bootstrapArg(testnet),
    '--timeout', '4000'
  ])

  assert.equal(code, 1)
  assert.equal(out.ok, false)
  assert.equal(out.bridged, false)
  assert.match(out.error, /could not connect to the relay/)
})

test('the probe rejects a malformed key before touching the network', async () => {
  const { code, out, stderr } = await runProbe(['--relay', 'obviously-not-a-key'])
  assert.equal(code, 1)
  // Either the JSON error path or the usage path is acceptable; what matters is
  // that it is refused rather than dialled.
  assert.ok((out && /not a valid key/.test(out.error)) || /not a valid key/.test(stderr || ''))
})

test('the probe refuses to run without a relay key', async () => {
  const { code, stderr } = await runProbe([])
  assert.equal(code, 1)
  assert.match(stderr, /--relay <public-key> is required/)
})

test('the probe refuses an unknown flag and a nonsense cap', async () => {
  const unknown = await runProbe(['--relay', 'f'.repeat(64), '--nope'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /unknown flag --nope/)

  const bytes = await runProbe(['--relay', 'f'.repeat(64), '--bytes', 'lots'])
  assert.equal(bytes.code, 1)
  assert.match(bytes.stderr, /--bytes must be a positive integer/)

  const timeout = await runProbe(['--relay', 'f'.repeat(64), '--timeout', '0'])
  assert.equal(timeout.code, 1)
  assert.match(timeout.stderr, /--timeout must be a positive number/)
})

test('--help prints usage and exits 0, spelled either way', async () => {
  for (const flag of ['--help', '-h']) {
    const { stdout } = await execFile('node', ['scripts/probe.js', flag], { cwd: ROOT })
    assert.match(stdout, /node scripts\/probe\.js --relay <public-key>/)
  }
})
