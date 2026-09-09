// The invite ticket: the one wire format shared with the Mirall client.
//
// 69 bytes — version, relay public key, member seed, checksum — as z-base-32,
// behind a mirall://relay/ prefix. Both guards below are load-bearing and they
// catch DIFFERENT things: the checksum catches an altered or internally mangled
// paste, and the LENGTH catches a truncated one. Neither substitutes for the
// other — see the note on PAYLOAD_CHARS. A ticket that decodes to something
// plausible but wrong becomes a connection that silently never works, which is
// the worst failure mode this feature has.
//
// CHANGING THIS FILE IS A PROTOCOL CHANGE. test/unit/ticket.test.js pins the
// vector that mirall-app pins too; if it fails, one side has drifted.
import crypto from 'hypercore-crypto'
import idEnc from 'hypercore-id-encoding'
import z32 from 'z32'
import b4a from 'b4a'

export const TICKET_VERSION = 1
export const TICKET_BYTES = 69
// NORMATIVE, and not a formality. 111 z-base-32 characters carry 555 bits for 552
// bits of payload, so the final character is 3 slack bits and nothing else:
// z32.decode(payload.slice(0, 110)) returns the IDENTICAL 69 bytes, version passes
// and the checksum passes. Losing the last character of a paste is the commonest
// clipboard failure there is, and this constant is the ONLY thing that catches it.
// Do not "simplify" the length check away on the grounds that decode and the
// checksum already validate. Contract §2.5.1 pins the vector.
export const PAYLOAD_CHARS = 111
export const SCHEME = 'mirall://relay/'

const BODY_BYTES = 65 // version + key + seed
const SUM_BYTES = 4

export class TicketError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'TicketError'
    // The first three are the contract's (§2.7) and are what a client reports.
    // wrong-relay is local to this repo — a client cannot hit it.
    this.code = code // invalid-format | unsupported-version | checksum-failed | wrong-relay
  }
}

export function mintSeed () {
  return crypto.randomBytes(32)
}

function checksum (body) {
  return crypto.hash(body).subarray(0, SUM_BYTES)
}

export function encodeTicket (relayPublicKey, memberSeed) {
  if (relayPublicKey.byteLength !== 32) throw new TicketError('invalid-format', 'relay key must be 32 bytes')
  if (memberSeed.byteLength !== 32) throw new TicketError('invalid-format', 'member seed must be 32 bytes')
  const body = b4a.concat([b4a.from([TICKET_VERSION]), relayPublicKey, memberSeed])
  return SCHEME + z32.encode(b4a.concat([body, checksum(body)]))
}

// Accepts the canonical form and a bare payload, since a paste loses the prefix
// as often as it keeps it. Case- and whitespace-tolerant: z-base-32 is lowercase,
// and a chat client that title-cases the first letter must not cost a member
// their invite.
//
// `expectRelayPublicKey` is optional and off by default — the client has exactly
// one relay and nothing to compare against. The operator is the one who ends up
// holding two, and a ticket minted by the other relay is otherwise
// indistinguishable from a good one until a member silently fails to connect.
export function decodeTicket (input, { expectRelayPublicKey = null } = {}) {
  const raw = String(input == null ? '' : input).trim().toLowerCase()
  const payload = raw.startsWith(SCHEME) ? raw.slice(SCHEME.length) : raw

  // Before z32.decode, and not redundant with it: a 110-char payload decodes
  // cleanly to the same 69 bytes and would pass every check after this one.
  if (payload.length !== PAYLOAD_CHARS) {
    throw new TicketError('invalid-format', `expected ${PAYLOAD_CHARS} characters, got ${payload.length}`)
  }

  let bytes
  try {
    bytes = z32.decode(payload)
  } catch {
    throw new TicketError('invalid-format', 'not z-base-32')
  }
  if (bytes.byteLength !== TICKET_BYTES) {
    throw new TicketError('invalid-format', `expected ${TICKET_BYTES} bytes, got ${bytes.byteLength}`)
  }

  const version = bytes[0]
  if (version !== TICKET_VERSION) {
    throw new TicketError('unsupported-version', `ticket version ${version} is not supported`)
  }

  const body = bytes.subarray(0, BODY_BYTES)
  if (!b4a.equals(bytes.subarray(BODY_BYTES), checksum(body))) {
    throw new TicketError('checksum-failed', 'the ticket is incomplete or altered')
  }

  const relayPublicKey = b4a.from(bytes.subarray(1, 33))
  // A well-formed ticket for somebody else's relay. Its own code, because "wrong
  // relay" and "corrupt paste" have opposite fixes.
  if (expectRelayPublicKey && !b4a.equals(relayPublicKey, expectRelayPublicKey)) {
    throw new TicketError('wrong-relay', 'this invite was minted by a different relay')
  }

  return {
    version,
    relayPublicKey,
    memberSeed: b4a.from(bytes.subarray(33, 65))
  }
}

// The member's public key — what the firewall matches, and the only part of a
// ticket that is safe to log, list or display.
export function memberPublicKey (memberSeed) {
  return crypto.keyPair(memberSeed).publicKey
}

export function memberPublicKeyZ32 (memberSeed) {
  return idEnc.normalize(idEnc.encode(memberPublicKey(memberSeed)))
}

// A relay key, not a ticket: 52-char z32, 64-char hex, or pear://. Lets one paste
// field serve both inputs — the lengths cannot collide.
export function looksLikeTicket (input) {
  const raw = String(input == null ? '' : input).trim().toLowerCase()
  const payload = raw.startsWith(SCHEME) ? raw.slice(SCHEME.length) : raw
  return payload.length === PAYLOAD_CHARS
}
