// Durable membership. Nothing here opens a socket; the file IS the contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import idEnc from 'hypercore-id-encoding'
import { openRoster, ROSTER_VERSION } from '../../src/roster.js'
import { memberPublicKeyZ32, mintSeed } from '../../src/ticket.js'

const RELAY_KEY = b4a.alloc(32, 7)

function tmpRoster (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-roster-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'members.json')
}

function open (t, overrides = {}) {
  const roster = openRoster({ rosterFile: tmpRoster(t), ...overrides })
  t.after(() => roster.close())
  return roster
}

function hexOf (publicKey) {
  return b4a.toString(idEnc.decode(publicKey), 'hex')
}

function errorFrom (fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected a RosterError, got a value')
}

// A hand-written roster, the way `invite create` in another process leaves one.
function writeRoster (file, members, version = ROSTER_VERSION) {
  fs.writeFileSync(file, JSON.stringify({ version, members }, null, 2))
}

function memberRow (label) {
  const seed = mintSeed()
  return {
    label,
    publicKey: memberPublicKeyZ32(seed),
    seedHex: b4a.toString(seed, 'hex'),
    created: new Date().toISOString(),
    revoked: null
  }
}

test('a missing roster opens empty rather than failing', (t) => {
  const roster = open(t)
  assert.equal(roster.total, 0)
  assert.equal(roster.active, 0)
  assert.deepEqual(roster.list(), [])
})

test('a fresh roster is created 0600', (t) => {
  const roster = open(t)
  roster.add('ben')
  // Same mode as the seed: this file holds every member's secret.
  assert.equal(fs.statSync(roster.file).mode & 0o777, 0o600)
})

test('add mints a distinct seed per member', (t) => {
  const roster = open(t)
  const ben = roster.add('ben')
  const ada = roster.add('ada')
  assert.notEqual(ben.publicKey, ada.publicKey)
  assert.notEqual(ben.seedHex, ada.seedHex)
  assert.equal(roster.active, 2)
  assert.equal(roster.total, 2)
  assert.ok(roster.members.has(hexOf(ben.publicKey)))
})

test('labels are unique case-insensitively', (t) => {
  const roster = open(t)
  roster.add('ben')
  assert.equal(errorFrom(() => roster.add('Ben')).code, 'duplicate')
  assert.equal(roster.total, 1)
})

test('a bad label is refused', (t) => {
  const roster = open(t)
  for (const label of ['', 'a b', '../x', 'x'.repeat(65), '-lead', null, 'ben/../ada']) {
    assert.equal(errorFrom(() => roster.add(label)).code, 'bad-label', String(label))
  }
  assert.equal(roster.total, 0)
})

test('revoke keeps the row and drops the key', (t) => {
  const roster = open(t)
  const ben = roster.add('ben')
  const keyHex = hexOf(ben.publicKey)
  assert.equal(roster.members.has(keyHex), true)

  const revoked = roster.revoke('ben')
  assert.equal(revoked.keyHex, keyHex)
  assert.ok(revoked.revoked, 'the timestamp answers "why can Ben not connect" three days later')
  assert.equal(roster.members.has(keyHex), false)
  assert.equal(roster.list().length, 1, 'the row survives')
  assert.equal(roster.active, 0)
  assert.equal(roster.total, 1)
})

test('revoking twice is idempotent', (t) => {
  const roster = open(t)
  roster.add('ben')
  const first = roster.revoke('ben')
  const second = roster.revoke('BEN')
  assert.equal(second.revoked, first.revoked)
  assert.equal(second.keyHex, null, 'nothing left to tear down')
})

test('revoking an unknown label is not-found', (t) => {
  const roster = open(t)
  assert.equal(errorFrom(() => roster.revoke('nobody')).code, 'not-found')
  assert.equal(errorFrom(() => roster.ticketFor('nobody', RELAY_KEY)).code, 'not-found')
  assert.equal(errorFrom(() => roster.get('nobody')).code, 'not-found')
})

test('the write is atomic', (t) => {
  const roster = open(t)
  const dir = path.dirname(roster.file)
  roster.add('ben')
  roster.add('ada')
  roster.revoke('ben')
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file survives')
  assert.equal(JSON.parse(fs.readFileSync(roster.file, 'utf8')).members.length, 2)
})

test('a malformed roster refuses to load', (t) => {
  const file = tmpRoster(t)
  fs.writeFileSync(file, '{')
  // NOT an empty roster: in invite mode that would lock out every member.
  assert.equal(errorFrom(() => openRoster({ rosterFile: file })).code, 'malformed')
})

test('a roster with a bad seed refuses to load', (t) => {
  const file = tmpRoster(t)
  writeRoster(file, [{ ...memberRow('ben'), seedHex: 'zz' }])
  assert.equal(errorFrom(() => openRoster({ rosterFile: file })).code, 'malformed')
})

test('a public key that does not match its seed refuses to load', (t) => {
  const file = tmpRoster(t)
  writeRoster(file, [{ ...memberRow('ben'), publicKey: memberPublicKeyZ32(mintSeed()) }])
  // The redundancy is there precisely so a corrupted seed is caught instead of
  // silently deriving a different member.
  assert.equal(errorFrom(() => openRoster({ rosterFile: file })).code, 'malformed')
})

test('an unknown version refuses to load', (t) => {
  const file = tmpRoster(t)
  writeRoster(file, [memberRow('ben')], 2)
  assert.equal(errorFrom(() => openRoster({ rosterFile: file })).code, 'malformed')
})

test('listPublic never carries a seed', (t) => {
  const roster = open(t)
  roster.add('ben')
  roster.add('ada')
  const text = JSON.stringify(roster.listPublic())
  assert.ok(!text.includes('seedHex'))
  assert.ok(!/[0-9a-f]{64}/i.test(text), 'not even an unlabelled 64-hex run')
  assert.deepEqual(Object.keys(roster.listPublic()[0]).sort(), ['created', 'label', 'publicKey', 'revoked'])
})

test('ticketFor mints the ticket the operator hands over', (t) => {
  const roster = open(t)
  const ben = roster.add('ben')
  const ticket = roster.ticketFor('BEN', RELAY_KEY)
  assert.match(ticket, /^mirall:\/\/relay\//)
  assert.equal(memberPublicKeyZ32(b4a.from(ben.seedHex, 'hex')), ben.publicKey)
})

test('an out-of-process write is picked up', (t) => {
  const roster = open(t)
  const ada = memberRow('ada')
  writeRoster(roster.file, [ada])

  assert.equal(roster.members.has(hexOf(ada.publicKey)), false, 'not until it reloads')
  roster._reload('test')
  assert.equal(roster.members.has(hexOf(ada.publicKey)), true)
  assert.equal(roster.total, 1)
})

test('a reload that fails keeps the previous membership', (t) => {
  const roster = open(t)
  const ben = roster.add('ben')
  fs.writeFileSync(roster.file, '{ "version": 1, "members": [')

  roster._reload('test')
  assert.equal(roster.members.has(hexOf(ben.publicKey)), true, 'a mangled file must not empty the roster')
  assert.equal(roster.active, 1)
})

test('onChange reports removed keys only', (t) => {
  const file = tmpRoster(t)
  const seen = []
  const roster = openRoster({ rosterFile: file }, { onChange: (keys) => seen.push(keys) })
  t.after(() => roster.close())

  const ben = roster.add('ben')
  const ada = memberRow('ada')
  writeRoster(file, [{ ...ben }, ada])
  roster._reload('test')
  assert.deepEqual(seen, [], 'adding a member is not a revocation')

  writeRoster(file, [{ ...ben, revoked: new Date().toISOString() }, ada])
  roster._reload('test')
  assert.deepEqual(seen, [[hexOf(ben.publicKey)]])

  // Deleting a row outright is a removal too — the key stops being admitted
  // either way, and the live sessions have to go with it.
  writeRoster(file, [{ ...ben, revoked: new Date().toISOString() }])
  roster._reload('test')
  assert.deepEqual(seen[1], [hexOf(ada.publicKey)])
})

test('a member survives reopening the same file', (t) => {
  const file = tmpRoster(t)
  const first = openRoster({ rosterFile: file })
  const ben = first.add('ben')
  first.close()

  const second = openRoster({ rosterFile: file })
  t.after(() => second.close())
  assert.equal(second.members.has(hexOf(ben.publicKey)), true)
  assert.equal(second.get('ben').seedHex, ben.seedHex)
})

test('a failed write leaves no phantom member behind', (t) => {
  const roster = open(t)
  const alice = roster.add('alice')
  const dir = path.dirname(roster.file)

  fs.chmodSync(dir, 0o500) // no writes into the directory
  try {
    assert.throws(() => roster.add('ghost'), /EACCES|EPERM|EROFS/)
  } finally {
    fs.chmodSync(dir, 0o700) // before the tmpdir cleanup hook needs it
  }

  // Mutating doc BEFORE the write meant the next successful write committed the
  // ghost too — and admitted it at the firewall — for an operation the caller
  // was told had failed, and whose ticket was never handed to anybody.
  const carol = roster.add('carol')
  assert.deepEqual(roster.listPublic().map((m) => m.label), ['alice', 'carol'])
  assert.equal(roster.members.has(hexOf(alice.publicKey)), true)
  assert.equal(roster.members.has(hexOf(carol.publicKey)), true)
  assert.equal(roster.total, 2, 'no ghost on disk')
  assert.equal(roster.active, 2, 'and none admitted')
})

test('a leftover temp file does not break every future write', (t) => {
  const roster = open(t)
  roster.add('alice')
  // What a SIGKILL or a full disk between the open and the rename leaves behind.
  // In the container the relay is pid 1 on every restart, so the name repeats and
  // 'wx' would have made this permanent — on a distroless image with no shell to
  // delete it with.
  fs.writeFileSync(`${roster.file}.${process.pid}.tmp`, 'junk from a killed write')

  assert.doesNotThrow(() => roster.add('bob'))
  assert.equal(roster.total, 2)
})

test('a write adopts a concurrent writer\'s changes instead of clobbering them', (t) => {
  const file = tmpRoster(t)
  const relay = openRoster({ rosterFile: file })
  t.after(() => relay.close())
  const alice = relay.add('alice')

  // The CLI, in another process, against the same file. The relay's copy is now
  // stale — up to a poll interval, and up to forever in a process that is not
  // watching.
  const cli = openRoster({ rosterFile: file })
  const ben = cli.add('ben')
  cli.close()

  // Ben's ticket has already been handed over at this point, so writing our
  // cached document would delete a member who is expecting to connect.
  const carol = relay.add('carol')
  assert.deepEqual(relay.listPublic().map((m) => m.label), ['alice', 'ben', 'carol'])
  for (const m of [alice, ben, carol]) {
    assert.equal(relay.members.has(hexOf(m.publicKey)), true, m.label)
  }
})

test('a concurrent revocation is not resurrected by a later write', (t) => {
  const file = tmpRoster(t)
  const relay = openRoster({ rosterFile: file })
  t.after(() => relay.close())
  const ben = relay.add('ben')

  const cli = openRoster({ rosterFile: file })
  cli.revoke('ben')
  cli.close()

  // The dangerous direction: an add that wrote our cached copy would put ben back
  // as active, undoing a revocation the operator believes is done.
  relay.add('carol')
  assert.equal(relay.members.has(hexOf(ben.publicKey)), false)
  assert.ok(relay.get('ben').revoked)
})

test('a write over a malformed roster is refused, not overwritten', (t) => {
  const roster = open(t)
  roster.add('alice')
  fs.writeFileSync(roster.file, '{ "version": 1, "members": [')

  // Overwriting it with our copy would destroy whatever the other writer was
  // half-way through, and there is no recovering a seed that is gone.
  assert.equal(errorFrom(() => roster.add('bob')).code, 'malformed')
  assert.equal(errorFrom(() => roster.revoke('alice')).code, 'malformed')
})

test('a reload does not leave the poller seeing its own work as a change', (t) => {
  const file = tmpRoster(t)
  const reasons = []
  const roster = openRoster({ rosterFile: file }, {
    logger: { info: (obj) => reasons.push(obj.reason), error () {}, warn () {} }
  })
  t.after(() => roster.close())

  writeRoster(file, [memberRow('ada')])
  roster._reload('fs.watch')
  // reload() has to stamp `last`, or the 5s poller fires a second full reload for
  // the same edit — twice the keypair derivation and two 'roster reloaded' lines.
  assert.deepEqual(reasons, ['fs.watch'])
  assert.equal(roster._stale(), false, 'the file matches what we last read')
})
