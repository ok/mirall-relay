// The bearer token for /admin/*. The anonymous status page has no auth by design
// (it exposes nothing secret); the write surface mints and revokes memberships,
// so it does. Same handling rules as the seed: file first, env only as an
// override, never in a response body, never in the status snapshot.
import fs from 'node:fs'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import crypto from 'hypercore-crypto'
import idEnc from 'hypercore-id-encoding'
import b4a from 'b4a'

export const TOKEN_MODE = 0o600
const BEARER = 'Bearer '

export function loadOrCreateToken (cfg, logger = null) {
  if (cfg.adminToken) return makeAuth(String(cfg.adminToken).trim(), { from: 'env', path: null, created: false })

  const file = cfg.adminTokenFile
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8').trim()
    // Never mint a second token over an existing file: the operator's copy would
    // stop working with no way to tell that from a typo.
    if (!text) throw new Error(`admin token file ${file} is empty`)
    return makeAuth(text, { from: 'file', path: file, created: false })
  }

  const token = idEnc.encode(crypto.randomBytes(32))
  const dir = path.dirname(file)
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true })
  const fd = fs.openSync(file, 'wx', TOKEN_MODE)
  try {
    fs.writeSync(fd, token + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // Logged EXACTLY once, on the boot that created it. An operator on StartOS or
  // Umbrel has no shell; this line in the container log is how they get it.
  logger?.warn({ tokenFile: file }, 'a new admin token was generated — copy it from this line, it is not shown again')
  logger?.warn({ adminToken: token }, 'admin token')
  return makeAuth(token, { from: 'file', path: file, created: true })
}

function makeAuth (token, source) {
  const expected = b4a.from(token)
  return {
    source,
    // Length is compared first because timingSafeEqual throws on a mismatch;
    // the length of a token is not a secret worth a branch-free compare.
    check (header) {
      const value = String(header || '')
      if (!value.startsWith(BEARER)) return false
      const given = b4a.from(value.slice(BEARER.length).trim())
      if (given.byteLength !== expected.byteLength) return false
      return timingSafeEqual(given, expected)
    }
  }
}
