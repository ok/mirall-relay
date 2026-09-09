// `mirall-relay invite` — mint, list, reprint and revoke memberships.
//
// A separate process against the same data volume as the running relay, because
// the image is distroless and the only way in is
// `docker exec … /nodejs/bin/node bin/mirall-relay.js invite …`. The roster file
// is the source of truth for both writers; a running relay watches it and picks
// up a revocation within about five seconds.
//
// Output is deliberately plain so it survives `docker logs` and a copy-paste
// into a chat window.
import { loadConfig } from '../src/config.js'
import fs from 'node:fs'
import { seedSource, resolveSeed, keyPairFromSeed } from '../src/keys.js'
import { openRoster } from '../src/roster.js'

const USAGE = `mirall-relay invite <command>

  create <label>   mint an invite and print the ticket
  list             labels, keys, created, revoked
  show <label>     reprint an existing ticket
  revoke <label>   revoke; a running relay drops them within ~5s

Every option the relay takes works here too, so MIRALL_RELAY_ROSTER_FILE and
--roster-file both point this at the same roster the relay is reading.
`

// The relay's own identity, read but NEVER created. A keygen-less `invite
// create` against an empty data directory must fail loudly rather than mint a
// ticket for an identity that will not exist.
function relayPublicKey (cfg) {
  const { from, path: file } = seedSource(cfg)
  // Checked BEFORE resolveSeed, which would generate one here — and a seed
  // minted as a side effect of asking for a ticket is an identity nobody chose.
  if (from === 'none' || (from === 'file' && !fs.existsSync(file))) {
    process.stderr.write('refusing to mint an invite for an identity that does not exist yet.\n')
    process.stderr.write(`no seed at ${file || '(none configured)'} — start the relay once, or run \`mirall-relay keygen\`, then retry.\n`)
    process.exit(78) // EX_CONFIG
  }
  return keyPairFromSeed(resolveSeed(cfg).seed).publicKey
}

function line (label, value) {
  return `${label.padEnd(8)} ${value}\n`
}

// Separate the label from the relay flags around it, understanding all three
// forms src/config.js's parseArgv takes: --flag value, --flag=value and a bare
// --flag. Filtering on the '--' prefix alone dropped the VALUE of the spaced
// form, so `invite list --roster-file /data/m.json` died claiming the flag
// needed one — and `invite create --roster-file /data/m.json ben` silently took
// the path as the label.
function split (argv) {
  const flags = []
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    flags.push(arg)
    const spaced = !arg.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
    if (spaced) flags.push(argv[++i])
  }
  return { flags, positional }
}

export function inviteCommand (argv = []) {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return
  }

  const { flags, positional } = split(rest)

  let cfg
  try {
    cfg = loadConfig(flags)
  } catch (err) {
    // Same shape as the server's: a config error names the variable and exits 78.
    process.stderr.write(`configuration error: ${err.message}\n`)
    process.exit(78) // EX_CONFIG
  }

  // openRoster is inside the try because it is the most likely thing to fail
  // here: a hand-mangled or half-written members.json throws RosterError, and
  // the operator most likely to hit it deserves one line rather than a stack.
  let roster = null
  try {
    roster = openRoster(cfg)
    switch (command) {
      case 'create': return create(cfg, roster, positional[0])
      case 'list': return list(roster)
      case 'show': return show(cfg, roster, positional[0])
      case 'revoke': return revoke(roster, positional[0])
      default:
        process.stderr.write(`unknown invite command ${JSON.stringify(command)}\n\n${USAGE}`)
        process.exit(64) // EX_USAGE
    }
  } catch (err) {
    // A duplicate label, an unknown one, a malformed roster or an unwritable
    // volume are all operator-facing conditions, not crashes.
    if (!err.code) throw err
    process.stderr.write(`${err.message}\n`)
    process.exit(65) // EX_DATAERR
  } finally {
    roster?.close()
  }
}

function requireLabel (label) {
  if (label) return label
  process.stderr.write('a label is required — the operator\'s own handle for the person, e.g. `ben`.\n')
  process.exit(64)
}

function create (cfg, roster, label) {
  const publicKey = relayPublicKey(cfg)
  const member = roster.add(requireLabel(label))
  process.stdout.write(
    '\n' +
    line('member', member.label) +
    line('key', member.publicKey) +
    line('invite', roster.ticketFor(member.label, publicKey)) +
    `\nSend the invite line to ${member.label}. It is a secret: anyone holding it is ${member.label}.\n\n`
  )
}

function show (cfg, roster, label) {
  const publicKey = relayPublicKey(cfg)
  const member = roster.get(requireLabel(label))
  process.stdout.write(
    '\n' +
    line('member', member.label) +
    line('key', member.publicKey) +
    line('invite', roster.ticketFor(member.label, publicKey)) +
    (member.revoked ? `\nREVOKED ${member.revoked} — this invite no longer admits anyone.\n\n` : '\n')
  )
}

function list (roster) {
  const members = roster.listPublic()
  if (!members.length) {
    process.stdout.write(`no members yet in ${roster.file}\nmint one with \`mirall-relay invite create <label>\`\n`)
    return
  }
  const width = Math.max(6, ...members.map((m) => m.label.length))
  process.stdout.write(`${'label'.padEnd(width)}  ${'key'.padEnd(52)}  created                   state\n`)
  for (const m of members) {
    process.stdout.write(
      `${m.label.padEnd(width)}  ${m.publicKey.padEnd(52)}  ${m.created}  ${m.revoked ? `revoked ${m.revoked}` : 'active'}\n`
    )
  }
  process.stdout.write(`\n${roster.active} active of ${roster.total} in ${roster.file}\n`)
}

function revoke (roster, label) {
  const member = roster.revoke(requireLabel(label))
  process.stdout.write(
    `\nrevoked ${member.label} (${member.publicKey}) at ${member.revoked}\n` +
    (member.keyHex
      ? 'A running relay drops their live sessions within about five seconds.\n\n'
      : 'They were already revoked; nothing changed.\n\n')
  )
}
