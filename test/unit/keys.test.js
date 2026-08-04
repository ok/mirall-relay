import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import idEnc from 'hypercore-id-encoding'
import b4a from 'b4a'
import { loadOrCreateSeed, keyPairFromSeed, publicKeyZ32, generateSeed, writeSeed } from '../../src/keys.js'

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-relay-keys-'))
}

test('the keypair is deterministic from the seed', () => {
  // THE load-bearing guarantee: clients configure the derived public key, so it
  // must survive restarts, redeploys and host moves unchanged.
  const seed = generateSeed()
  const a = keyPairFromSeed(seed)
  const b = keyPairFromSeed(seed)
  assert.deepEqual(a.publicKey, b.publicKey)
  assert.deepEqual(a.secretKey, b.secretKey)
})

test('different seeds give different identities', () => {
  const a = keyPairFromSeed(generateSeed())
  const b = keyPairFromSeed(generateSeed())
  assert.notDeepEqual(a.publicKey, b.publicKey)
})

test('keyPairFromSeed rejects a wrong-sized seed', () => {
  assert.throws(() => keyPairFromSeed(b4a.alloc(16)), /seed must be 32 bytes/)
})

test('the z32 public key round-trips through hypercore-id-encoding', () => {
  const kp = keyPairFromSeed(generateSeed())
  const encoded = publicKeyZ32(kp)
  assert.equal(typeof encoded, 'string')
  assert.deepEqual(b4a.from(idEnc.decode(encoded)), b4a.from(kp.publicKey))
})

test('loadOrCreateSeed generates once, then returns the same seed', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'seed')

  const first = loadOrCreateSeed({ seedFile: file })
  assert.equal(first.byteLength, 32)
  assert.ok(fs.existsSync(file))

  const second = loadOrCreateSeed({ seedFile: file })
  assert.deepEqual(first, second, 'a restart must not mint a new identity')
})

test('the seed file is written 0600', { skip: process.platform === 'win32' }, () => {
  const file = path.join(tmpDir(), 'seed')
  loadOrCreateSeed({ seedFile: file })
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600)
})

test('nested seed directories are created', () => {
  const file = path.join(tmpDir(), 'deep', 'nested', 'seed')
  const seed = loadOrCreateSeed({ seedFile: file })
  assert.equal(seed.byteLength, 32)
})

test('an explicit seed wins over the seed file and does not touch disk', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'seed')
  const hex = 'b'.repeat(64)

  const seed = loadOrCreateSeed({ seed: hex, seedFile: file })
  assert.equal(b4a.toString(seed, 'hex'), hex)
  assert.equal(fs.existsSync(file), false, 'an env-provided seed must not be persisted')
})

test('a corrupt seed file fails loudly instead of silently re-keying', () => {
  const file = path.join(tmpDir(), 'seed')
  fs.writeFileSync(file, 'this is not a seed')
  assert.throws(() => loadOrCreateSeed({ seedFile: file }), /does not contain a 64-hex seed/)
})

test('writeSeed refuses to clobber an existing identity', () => {
  const file = path.join(tmpDir(), 'seed')
  writeSeed(file, generateSeed())
  assert.throws(() => writeSeed(file, generateSeed()), /EEXIST/)
})

test('loadOrCreateSeed needs somewhere to look', () => {
  assert.throws(() => loadOrCreateSeed({}), /no seed, seedSecretFile or seedFile/)
})

test('a mounted secret file supplies the seed without writing anything', () => {
  // Replaces what the old shell entrypoint did, so the runtime image needs no
  // shell. The secret is read-only: nothing is persisted alongside it.
  const dir = tmpDir()
  const secret = path.join(dir, 'relay_seed')
  const seedFile = path.join(dir, 'seed')
  const hex = 'd'.repeat(64)
  fs.writeFileSync(secret, hex + '\n')

  const seed = loadOrCreateSeed({ seedSecretFile: secret, seedFile })
  assert.equal(b4a.toString(seed, 'hex'), hex)
  assert.equal(fs.existsSync(seedFile), false, 'a mounted secret must not be copied to disk')
})

test('an explicit seed still beats a mounted secret', () => {
  const dir = tmpDir()
  const secret = path.join(dir, 'relay_seed')
  fs.writeFileSync(secret, 'd'.repeat(64))

  const seed = loadOrCreateSeed({ seed: 'e'.repeat(64), seedSecretFile: secret })
  assert.equal(b4a.toString(seed, 'hex'), 'e'.repeat(64))
})

test('a malformed secret fails loudly rather than minting a new identity', () => {
  // The dangerous failure mode: falling through to "generate a seed" would look
  // healthy and silently strand every client configured with the old key.
  const dir = tmpDir()
  const secret = path.join(dir, 'relay_seed')
  const seedFile = path.join(dir, 'seed')
  fs.writeFileSync(secret, 'not-a-seed')

  assert.throws(
    () => loadOrCreateSeed({ seedSecretFile: secret, seedFile }),
    /does not contain a 64-hex seed/
  )
  assert.equal(fs.existsSync(seedFile), false)
})

test('an absent secret path falls through to the seed file', () => {
  const dir = tmpDir()
  const seed = loadOrCreateSeed({
    seedSecretFile: path.join(dir, 'no-such-secret'),
    seedFile: path.join(dir, 'seed')
  })
  assert.equal(seed.byteLength, 32)
})
