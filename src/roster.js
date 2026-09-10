// The member roster: the durable half of invite-mode access control.
//
// SECRET FILE. It holds every member's seed, so it is exactly as sensitive as
// ./.keys/seed — same mode, same backup rule, and it must never reach a log, a
// metric, /status.json or the status page. Losing it locks out every member;
// leaking it hands over every membership.
//
// The file, not this process, is the source of truth: `mirall-relay invite` runs
// as a separate process against the same volume, so a running relay watches for
// changes rather than assuming it is the only writer.
import fs from 'node:fs'
import path from 'node:path'
import b4a from 'b4a'
import idEnc from 'hypercore-id-encoding'
import { mintSeed, encodeTicket, memberPublicKeyZ32 } from './ticket.js'

export const ROSTER_MODE = 0o600
export const ROSTER_VERSION = 1
const RELOAD_DEBOUNCE_MS = 150
const POLL_MS = 5000

// On-disk schema: { version: 1, members: [{ label, publicKey, seedHex, created,
// revoked }] }. seedHex is required to reprint an invite; listPublic never
// exposes it.

// Labels reach a CLI argument and a URL path segment, so they are deliberately
// narrow. Not a display name: the operator's own handle for a person.
const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export class RosterError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'RosterError'
    this.code = code // bad-label | duplicate | not-found | malformed
  }
}

function normalized (publicKey) {
  try {
    return idEnc.normalize(String(publicKey ?? ''))
  } catch {
    return null
  }
}

function readFile (file) {
  if (!fs.existsSync(file)) return { version: ROSTER_VERSION, members: [] }

  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    // Never fall through to an empty roster. In invite mode that would lock out
    // every member; in a future mode it could do worse. Same rule as a malformed
    // mounted seed (src/keys.js).
    throw new RosterError('malformed', `roster ${file} is not valid JSON: ${err.message}`)
  }
  if (!doc || doc.version !== ROSTER_VERSION || !Array.isArray(doc.members)) {
    throw new RosterError('malformed', `roster ${file} is not a version ${ROSTER_VERSION} roster`)
  }
  for (const m of doc.members) {
    if (!LABEL.test(String(m?.label ?? ''))) throw new RosterError('malformed', `roster ${file} has an invalid label`)
    if (!/^[0-9a-f]{64}$/i.test(String(m?.seedHex ?? ''))) throw new RosterError('malformed', `roster ${file} has an invalid seed for ${m.label}`)
    // publicKey is redundant with seedHex and stored anyway, so a corrupted seed
    // is detectable here rather than silently deriving a different member.
    if (memberPublicKeyZ32(b4a.from(m.seedHex, 'hex')) !== normalized(m.publicKey)) {
      throw new RosterError('malformed', `roster ${file} has a public key that does not match the seed for ${m.label}`)
    }
  }
  return doc
}

// Atomic: a crash mid-write leaves either the old file or the new one, never a
// truncated roster. Unlike writeSeed's 'wx', this one is meant to replace.
//
// 'w' rather than 'wx' on the temp file, deliberately. The temp name is ours, and
// a write killed between the open and the rename leaves one behind — under 'wx'
// that would make every future write fail EEXIST forever, and in the container
// the pid is 1 on every restart so the name repeats exactly. Truncating our own
// stale temp is what makes this self-healing; the rename is still the atomic step.
function writeFile (file, doc) {
  const dir = path.dirname(file)
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w', ROSTER_MODE)
    fs.writeSync(fd, JSON.stringify(doc, null, 2) + '\n')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    throw err
  }
}

export function openRoster (cfg, { watch = false, onChange = null, logger = null } = {}) {
  const file = cfg.rosterFile
  let doc = readFile(file)
  let keys = keySet(doc)
  let timer = null
  let watcher = null
  let poller = null
  let last = stampOf(file)

  function keySet (d) {
    return new Set(
      d.members
        .filter((m) => !m.revoked)
        .map((m) => b4a.toString(idEnc.decode(m.publicKey), 'hex'))
    )
  }

  function stampOf (f) {
    try {
      const s = fs.statSync(f)
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return 'none'
    }
  }

  function find (label) {
    const wanted = String(label ?? '').toLowerCase()
    return doc.members.find((m) => m.label.toLowerCase() === wanted)
  }

  // Take a document as the new truth and report what it dropped. A key that
  // stopped being admitted is a key whose live sessions have to go, whichever
  // writer removed it.
  function adopt (next, reason) {
    const before = keys
    doc = next
    keys = keySet(doc)
    const removed = [...before].filter((k) => !keys.has(k))
    logger?.info({ reason, members: keys.size, removed: removed.length }, 'roster reloaded')
    if (removed.length) onChange?.(removed)
  }

  function reload (reason) {
    let next
    try {
      next = readFile(file)
    } catch (err) {
      // A half-written or hand-mangled file must not silently empty the roster.
      logger?.error({ err: err.message, file }, 'roster reload failed — keeping the previous membership')
      return
    }
    // Before adopting, so the poller does not see its own successful reload as a
    // fresh change and schedule a second one for the same edit.
    last = stampOf(file)
    adopt(next, reason)
  }

  function schedule (reason) {
    clearTimeout(timer)
    timer = setTimeout(() => reload(reason), RELOAD_DEBOUNCE_MS)
    timer.unref?.()
  }

  // Read-modify-write, not write-what-we-remember. This process's copy can be a
  // poll interval stale and the CLI is a second writer against the same file, so
  // writing the cached document would drop a member the other writer added
  // seconds ago — after their ticket had already been handed over. A malformed
  // file throws here and aborts the write rather than being overwritten by us.
  function refresh () {
    adopt(readFile(file), 'pre-write')
  }

  // Only assign after the bytes are down, so a failed write cannot leave a
  // phantom member in memory for the next successful write to commit.
  function commit (next) {
    writeFile(file, next)
    doc = next
    keys = keySet(next)
    last = stampOf(file)
  }

  if (watch) {
    try {
      const dir = path.dirname(file) || '.'
      fs.mkdirSync(dir, { recursive: true })
      watcher = fs.watch(dir, (_event, name) => {
        if (!name || name === path.basename(file)) schedule('fs.watch')
      })
      watcher.unref?.()
    } catch (err) {
      logger?.warn({ err: err.message }, 'fs.watch unavailable — polling the roster instead')
    }
    // Belt and braces: fs.watch misses events on some container filesystems, and
    // a missed revocation is a member who stays admitted.
    poller = setInterval(() => {
      const stamp = stampOf(file)
      if (stamp !== last) { last = stamp; schedule('poll') }
    }, POLL_MS)
    poller.unref?.()
  }

  return {
    // The live membership view handed to the firewall. keys() is what lets it
    // size the union with a static ALLOWLIST without double-counting an entry
    // that is on both.
    members: {
      has: (keyHex) => keys.has(keyHex),
      keys: () => keys,
      get size () { return keys.size }
    },

    list () {
      return doc.members.map((m) => ({ ...m }))
    },

    // Never returns seedHex. Callers that need the ticket ask for it explicitly.
    listPublic () {
      return doc.members.map(({ label, publicKey, created, revoked }) => ({ label, publicKey, created, revoked }))
    },

    add (label) {
      if (!LABEL.test(String(label ?? ''))) {
        throw new RosterError('bad-label', 'a label is 1-64 characters of letters, digits, dot, dash or underscore')
      }
      refresh()
      if (find(label)) {
        throw new RosterError('duplicate', `a member labelled ${label} already exists`)
      }
      const seed = mintSeed()
      const member = {
        label: String(label),
        publicKey: memberPublicKeyZ32(seed),
        seedHex: b4a.toString(seed, 'hex'),
        created: new Date().toISOString(),
        revoked: null
      }
      commit({ ...doc, members: [...doc.members, member] })
      return { ...member }
    },

    revoke (label) {
      refresh()
      const m = find(label)
      if (!m) throw new RosterError('not-found', `no member labelled ${label}`)
      if (m.revoked) return { ...m, keyHex: null }
      const keyHex = b4a.toString(idEnc.decode(m.publicKey), 'hex')
      const revoked = { ...m, revoked: new Date().toISOString() }
      commit({ ...doc, members: doc.members.map((x) => (x === m ? revoked : x)) })
      return { ...revoked, keyHex }
    },

    get (label) {
      const m = find(label)
      if (!m) throw new RosterError('not-found', `no member labelled ${label}`)
      return { ...m }
    },

    ticketFor (label, relayPublicKey) {
      const m = find(label)
      if (!m) throw new RosterError('not-found', `no member labelled ${label}`)
      return encodeTicket(relayPublicKey, b4a.from(m.seedHex, 'hex'))
    },

    get file () { return file },
    get active () { return keys.size },
    get total () { return doc.members.length },
    _reload: reload,
    _stale: () => stampOf(file) !== last,
    close () {
      clearTimeout(timer)
      watcher?.close()
      clearInterval(poller)
    }
  }
}
