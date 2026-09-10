// `mirall-relay keygen` — the key ceremony.
//
// Prints a fresh seed and the public key derived from it. The SEED is the secret:
// store it in a secret manager and keep an offline backup. The PUBLIC KEY is what
// you hand to users so they can add this relay in Mirall's Settings > Network.
//
// Losing the seed means every client configured with the derived public key can
// no longer reach you, and there is no recovery — treat it like the OTA signing key.
import { parseLongOptions } from '../src/cli-args.js'
import { generateSeed, keyPairFromSeed, publicKeyZ32, writeSeed } from '../src/keys.js'
import b4a from 'b4a'

export function keygen ({ out = null } = {}) {
  const seed = generateSeed()
  const keyPair = keyPairFromSeed(seed)
  const seedHex = b4a.toString(seed, 'hex')
  const pub = publicKeyZ32(keyPair)
  if (out) writeSeed(out, seed)
  return { seedHex, publicKey: pub, seedFile: out }
}

// --seed-file is the relay's own name for the path; --out is the ceremony's.
const KEYGEN_SPEC = {
  out: { value: true },
  'seed-file': { value: true }
}

export function keygenCommand (argv = []) {
  const { flags } = parseLongOptions(argv, KEYGEN_SPEC)
  const out = flags.out ?? flags['seed-file'] ?? null

  const { seedHex, publicKey, seedFile } = keygen({ out })

  process.stdout.write(
    '\n' +
    'mirall-relay identity\n' +
    '=====================\n\n' +
    'PUBLIC KEY  (share this — users paste it into Mirall > Settings > Network)\n' +
    `  ${publicKey}\n\n` +
    'SEED  (SECRET — store in a secret manager, back it up offline, never commit)\n' +
    `  ${seedHex}\n\n` +
    (seedFile
      ? `Written to ${seedFile} with mode 0600.\n\n`
      : 'Pass --out <path> to write the seed to a file, or set MIRALL_RELAY_SEED to this value.\n\n') +
    'Losing the seed permanently strands every client configured with the public key.\n\n'
  )

  return { publicKey, seedFile }
}
