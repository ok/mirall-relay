import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { keygenCommand } from '../../bin/keygen.js'

function seedPath (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-keygen-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'seed')
}

// The ceremony prints the seed, so nothing it writes may reach the test log.
function quietly (fn) {
  const write = process.stdout.write
  process.stdout.write = () => true
  try {
    return fn()
  } finally {
    process.stdout.write = write
  }
}

test('the seed file path is taken spaced or inline, under either flag name', (t) => {
  for (const argv of [
    (file) => ['--seed-file', file],
    (file) => [`--seed-file=${file}`],
    (file) => ['--out', file],
    (file) => [`--out=${file}`]
  ]) {
    const file = seedPath(t)
    const { seedFile } = quietly(() => keygenCommand(argv(file)))
    assert.equal(seedFile, file)
    assert.match(fs.readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/)
  }
})

test('no flag prints an identity without writing one down', (t) => {
  const { publicKey, seedFile } = quietly(() => keygenCommand([]))
  assert.equal(seedFile, null)
  assert.ok(publicKey.length > 0)
})

test('an unknown argument is refused rather than ignored', () => {
  assert.throws(() => keygenCommand(['--nope']), /unknown flag --nope/)
  assert.throws(() => keygenCommand(['seed']), /unexpected argument "seed"/)
  assert.throws(() => keygenCommand(['--seed-file']), /--seed-file requires a value/)
})
