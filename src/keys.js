// The relay's identity: an ed25519 keypair derived deterministically from a
// 32-byte seed.
//
// The PUBLIC key is what clients configure as their relayThrough target, so it
// must be STABLE across restarts, redeploys and host moves. The SEED is the only
// secret and the only durable state in the whole service — losing it strands
// every client that has the derived public key configured, exactly like losing
// the OTA upgrade key.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'hypercore-crypto'
import idEnc from 'hypercore-id-encoding'
import b4a from 'b4a'

export const SEED_MODE = 0o600

// Precedence: explicit hex seed -> mounted secret file -> seed file (created on
// first run). Generating persists 0600 before returning, so a crash between
// generate and use can never produce two different identities.
export function loadOrCreateSeed ({ seed = null, seedSecretFile = null, seedFile = null } = {}) {
  if (seed) return b4a.from(seed, 'hex')

  // A mounted secret is authoritative and read-only: never fall through to
  // generating when one is present but malformed — that would silently mint a
  // new identity and strand every configured client.
  if (seedSecretFile && fs.existsSync(seedSecretFile)) {
    return readSeedFile(seedSecretFile)
  }

  if (!seedFile) throw new Error('no seed, seedSecretFile or seedFile configured')

  if (fs.existsSync(seedFile)) return readSeedFile(seedFile)

  const fresh = crypto.randomBytes(32)
  writeSeed(seedFile, fresh)
  return fresh
}

function readSeedFile (file) {
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error(`seed file ${file} does not contain a 64-hex seed`)
  }
  return b4a.from(text, 'hex')
}

export function writeSeed (seedFile, seed) {
  const dir = path.dirname(seedFile)
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true })
  // 'wx' so we never clobber an existing identity by accident.
  const fd = fs.openSync(seedFile, 'wx', SEED_MODE)
  try {
    fs.writeSync(fd, b4a.toString(seed, 'hex') + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function keyPairFromSeed (seed) {
  if (seed.byteLength !== 32) throw new Error(`seed must be 32 bytes, got ${seed.byteLength}`)
  return crypto.keyPair(seed)
}

// z-base-32, the format the Hypercore ecosystem (and Mirall's UI) uses.
export function publicKeyZ32 (keyPair) {
  return idEnc.normalize(idEnc.encode(keyPair.publicKey))
}

export function generateSeed () {
  return crypto.randomBytes(32)
}
