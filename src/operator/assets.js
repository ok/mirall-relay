import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

export function assetPath (...parts) {
  return path.join(ROOT, ...parts)
}

export function etagFor (body) {
  return `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`
}

export function textAsset (filename, type) {
  const body = fs.readFileSync(filename)
  return { body, type, etag: etagFor(body) }
}

export function readAssets (routes) {
  const out = new Map()
  for (const [route, [file, type]] of Object.entries(routes)) {
    try {
      out.set(route, textAsset(file, type))
    } catch { /* missing asset: that route 404s, the relay still runs */ }
  }
  return out
}
