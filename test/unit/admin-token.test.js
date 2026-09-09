// The bearer token guarding /admin/*. Handled like the seed: file first, env as
// an override, and never a silent re-mint.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadOrCreateToken } from '../../src/admin-token.js'

function tmpToken (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-token-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'admin-token')
}

test('a token is generated 0600 on first boot', (t) => {
  const file = tmpToken(t)
  const auth = loadOrCreateToken({ adminTokenFile: file, adminToken: null })

  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'as sensitive as the seed')
  assert.equal(auth.source.created, true)
  assert.equal(auth.source.from, 'file')
  assert.match(fs.readFileSync(file, 'utf8').trim(), /^[a-z0-9]{52}$/, '32 bytes of z-base-32')
})

test('the token is logged exactly once, on the boot that created it', (t) => {
  const file = tmpToken(t)
  const lines = []
  const logger = { warn: (obj) => lines.push(obj) }

  loadOrCreateToken({ adminTokenFile: file, adminToken: null }, logger)
  const token = fs.readFileSync(file, 'utf8').trim()
  // An operator on a platform with no shell has nothing but the container log.
  assert.ok(lines.some((line) => line.adminToken === token))

  lines.length = 0
  loadOrCreateToken({ adminTokenFile: file, adminToken: null }, logger)
  assert.deepEqual(lines, [], 'a secret is not reprinted on every restart')
})

test('an existing token file is reused', (t) => {
  const file = tmpToken(t)
  const first = loadOrCreateToken({ adminTokenFile: file, adminToken: null })
  const token = fs.readFileSync(file, 'utf8').trim()
  const before = fs.statSync(file).mtimeMs

  const second = loadOrCreateToken({ adminTokenFile: file, adminToken: null })
  assert.equal(second.source.created, false)
  assert.equal(fs.statSync(file).mtimeMs, before, 'not rewritten')
  assert.equal(first.check('Bearer ' + token), true)
  assert.equal(second.check('Bearer ' + token), true)
})

test('the env token wins over the file', (t) => {
  const file = tmpToken(t)
  const auth = loadOrCreateToken({ adminTokenFile: file, adminToken: '  sekrit  ' })
  assert.equal(auth.source.from, 'env')
  assert.equal(auth.check('Bearer sekrit'), true, 'trimmed, like every other env value')
  assert.equal(fs.existsSync(file), false, 'and no file is minted behind it')
})

test('an empty token file is a hard error', (t) => {
  const file = tmpToken(t)
  fs.writeFileSync(file, '\n')
  // Minting a second token here would silently invalidate the operator's copy.
  assert.throws(() => loadOrCreateToken({ adminTokenFile: file, adminToken: null }), /is empty/)
})

test('check() accepts the exact bearer and nothing else', (t) => {
  const file = tmpToken(t)
  const auth = loadOrCreateToken({ adminTokenFile: file, adminToken: null })
  const token = fs.readFileSync(file, 'utf8').trim()

  assert.equal(auth.check('Bearer ' + token), true)
  assert.equal(auth.check('Bearer ' + token.toUpperCase()), false)
  assert.equal(auth.check('Bearer ' + token.slice(0, -1)), false, 'a wrong length must not throw')
  assert.equal(auth.check('Bearer ' + token + 'x'), false)
  assert.equal(auth.check('bearer ' + token), false, 'the scheme is case-sensitive here')
})

test('check() rejects a missing or malformed header', (t) => {
  const auth = loadOrCreateToken({ adminTokenFile: tmpToken(t), adminToken: null })
  for (const header of [undefined, null, '', 'Basic x', 'Bearer', 'Bearer ']) {
    assert.equal(auth.check(header), false, String(header))
  }
})
