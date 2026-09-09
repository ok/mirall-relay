// The invite codec, pinned against the cross-repo vector.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'hypercore-crypto'
import z32 from 'z32'
import b4a from 'b4a'
import {
  PAYLOAD_CHARS, SCHEME, TICKET_BYTES, TICKET_VERSION,
  decodeTicket, encodeTicket, looksLikeTicket, memberPublicKeyZ32, mintSeed
} from '../../src/ticket.js'
import { encodeQr } from '../../src/qr.js'

// The vector below is duplicated verbatim in mirall-app. If this test fails,
// one of the two repos has drifted and the invite format is broken — do not
// "fix" it by regenerating the expected string.
const RELAY_SEED = 'f50ded0ad862192ce2c8e2e977a471fa773352ae07c3ce9fe2ea28b648a16210'
const MEMBER_SEED = '9d73b3a76df0938ff055a76e4c096c54cc245b35d4db31b582faba9dde94ae4e'
const TICKET = 'mirall://relay/ygqac38xcbqmffk19weyomkrzhny5qbt5oag7iqzbwscj4b88h7758musqus5hrut9afmj5qjorsaigcrtpumig5gg4af6i4uzxjjm1qhz55ppy'
const MEMBER_KEY = 'mrgq43jtgdacci91sdt9fxogdzc7wxtcu71mqi45sgf6e61p3rxy'
const RELAY_KEY = 'usdgj55ym13jkwz7nyrn4tf9yog5ocqhgbzpmiapfunqoj398xqo'

const relaySeed = b4a.from(RELAY_SEED, 'hex')
const memberSeed = b4a.from(MEMBER_SEED, 'hex')
const relayPublicKey = crypto.keyPair(relaySeed).publicKey
const payload = TICKET.slice(SCHEME.length)

// assert.throws does not hand back the error, and the whole contract here is
// that each failure has its OWN code — never one generic "invalid".
function codeOf (fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected a TicketError, got a value')
}

test('the pinned vector encodes exactly', () => {
  assert.equal(encodeTicket(relayPublicKey, memberSeed), TICKET)
})

test('the pinned vector decodes exactly', () => {
  const ticket = decodeTicket(TICKET)
  assert.equal(ticket.version, TICKET_VERSION)
  assert.equal(ticket.relayPublicKey.byteLength, 32)
  assert.equal(ticket.memberSeed.byteLength, 32)
  assert.ok(b4a.equals(ticket.relayPublicKey, relayPublicKey))
  assert.ok(b4a.equals(ticket.memberSeed, memberSeed))
})

test('the member public key derives from the seed', () => {
  assert.equal(memberPublicKeyZ32(memberSeed), MEMBER_KEY)
})

test('a bare payload decodes', () => {
  assert.equal(payload.length, PAYLOAD_CHARS)
  assert.ok(b4a.equals(decodeTicket(payload).memberSeed, memberSeed))
})

test('case and surrounding whitespace are tolerated', () => {
  // A chat client that title-cases the first letter must not cost a member
  // their invite.
  const mangled = '  ' + TICKET.toUpperCase() + '\n'
  assert.ok(b4a.equals(decodeTicket(mangled).memberSeed, memberSeed))
})

// Contract §2.5.1, the negative vector. The byte-equality is asserted alongside
// the rejection ON PURPOSE: it is the only thing that explains why the rejection
// has to come from the LENGTH gate. Without it this test reads as a style
// preference to the next person and gets "simplified" into a decode-then-check,
// which silently accepts every paste that lost its last character.
const TRUNCATED = payload.slice(0, -1)

test('a truncated ticket decodes to identical bytes and must still be refused', () => {
  assert.equal(TRUNCATED.length, 110)
  assert.ok(
    b4a.equals(z32.decode(TRUNCATED), z32.decode(payload)),
    '110 and 111 characters carry the same 69 bytes — the final character is 3 slack bits'
  )

  // So the version byte passes, and so does the checksum. Only the length knows.
  const bytes = z32.decode(TRUNCATED)
  assert.equal(bytes[0], TICKET_VERSION, 'the version check cannot catch this')
  assert.ok(
    b4a.equals(bytes.subarray(65), crypto.hash(bytes.subarray(0, 65)).subarray(0, 4)),
    'and neither can the checksum'
  )

  const err = codeOf(() => decodeTicket(SCHEME + TRUNCATED))
  assert.equal(err.code, 'invalid-format')
  assert.equal(err.name, 'TicketError')
  assert.equal(codeOf(() => decodeTicket(TRUNCATED)).code, 'invalid-format', 'bare payload too')
})

test('a ticket with one character too many is refused', () => {
  // 112 characters decode to 70 bytes, so this one is caught either way.
  assert.equal(z32.decode(payload + 'y').byteLength, 70)
  assert.equal(codeOf(() => decodeTicket(payload + 'y')).code, 'invalid-format')
})

test('a ticket for another relay is wrong-relay', () => {
  const other = crypto.keyPair(b4a.alloc(32, 9)).publicKey
  // Its own code: "wrong relay" and "corrupt paste" have opposite fixes, and an
  // operator running two relays is the one person who can produce this.
  const err = codeOf(() => decodeTicket(TICKET, { expectRelayPublicKey: other }))
  assert.equal(err.code, 'wrong-relay')
  assert.equal(err.name, 'TicketError')

  // And the check passes for the relay that minted it.
  assert.ok(b4a.equals(
    decodeTicket(TICKET, { expectRelayPublicKey: relayPublicKey }).memberSeed,
    memberSeed
  ))
})

test('expectRelayPublicKey is opt-in', () => {
  // The client path stays exactly as the contract specifies it: one relay, so
  // nothing to compare against.
  assert.ok(b4a.equals(decodeTicket(TICKET).relayPublicKey, relayPublicKey))
  assert.ok(b4a.equals(decodeTicket(TICKET, {}).relayPublicKey, relayPublicKey))
})

test('a truncated ticket is refused before the relay check too', () => {
  // Order matters: a 110-char paste for the wrong relay is still a format error,
  // because the operator's fix is "copy the whole thing" either way.
  const other = crypto.keyPair(b4a.alloc(32, 9)).publicKey
  assert.equal(
    codeOf(() => decodeTicket(TRUNCATED, { expectRelayPublicKey: other })).code,
    'invalid-format'
  )
})

test('a ticket with one flipped character is checksum-failed', () => {
  // Flip a character in the seed region, well clear of the checksum bytes.
  const at = 50
  const swap = payload[at] === 'y' ? 'b' : 'y'
  const mutated = payload.slice(0, at) + swap + payload.slice(at + 1)
  assert.notEqual(mutated, payload)
  const err = codeOf(() => decodeTicket(SCHEME + mutated))
  assert.equal(err.code, 'checksum-failed')
})

test('an unknown version is unsupported-version', () => {
  const body = b4a.concat([b4a.from([2]), relayPublicKey, memberSeed])
  const sum = crypto.hash(body).subarray(0, 4)
  const err = codeOf(() => decodeTicket(z32.encode(b4a.concat([body, sum]))))
  assert.equal(err.code, 'unsupported-version')
})

test('a 52-char relay key is not a ticket', () => {
  assert.equal(looksLikeTicket(RELAY_KEY), false)
  assert.equal(looksLikeTicket(TICKET), true)
  assert.equal(looksLikeTicket(payload), true)
  assert.equal(looksLikeTicket(null), false)
  const err = codeOf(() => decodeTicket(RELAY_KEY))
  assert.equal(err.code, 'invalid-format')
})

test('non-z32 characters are invalid-format', () => {
  // l, v and 2 are outside z-base-32's alphabet — the exclusions that make it
  // hard to mistype in the first place.
  const err = codeOf(() => decodeTicket('lv2'.repeat(37)))
  assert.equal(err.code, 'invalid-format')
})

test('encodeTicket refuses anything that is not two 32-byte values', () => {
  assert.throws(() => encodeTicket(b4a.alloc(31), memberSeed), /relay key must be 32 bytes/)
  assert.throws(() => encodeTicket(relayPublicKey, b4a.alloc(33)), /member seed must be 32 bytes/)
})

test('the ticket fits the QR encoder', () => {
  // src/qr.js tops out at version 9; a ticket that did not fit would need a
  // bigger encoder, not a smaller square.
  assert.ok(encodeQr(TICKET).version <= 9)
})

test('every mint is distinct', () => {
  const keys = new Set()
  for (let i = 0; i < 1000; i++) {
    const seed = mintSeed()
    assert.equal(seed.byteLength, 32)
    keys.add(memberPublicKeyZ32(seed))
  }
  assert.equal(keys.size, 1000)
})

test('the wire format is 69 bytes of z-base-32', () => {
  assert.equal(z32.decode(payload).byteLength, TICKET_BYTES)
})
