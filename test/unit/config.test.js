import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadConfig, validate, parseArgv, asBytes, asList,
  decodeKeyOrThrow, parseBootstrapEntry, bootstrapNodes, DEFAULTS,
  OPTIONS, CONFIG_FLAG_SPEC, validateOptionsMetadata, helpOptions
} from '../../src/config.js'

const VALID_KEY = 'a'.repeat(64) // 32 bytes as hex

test('defaults load with an empty environment', () => {
  const cfg = loadConfig([], {})
  assert.equal(cfg.port, DEFAULTS.port)
  assert.equal(cfg.adminHost, '127.0.0.1')
  // Pinned deliberately, not read from DEFAULTS: this value is the difference
  // between a client relaying to ~32 peers and to two, so a change to it should
  // have to be made twice. See the README note on per-device accounting.
  assert.equal(cfg.maxSessionsPerKey, 64)
  assert.equal(cfg.allowlist, null)
  assert.ok(Object.isFrozen(cfg))
})

test('precedence: flag beats env beats default', () => {
  const env = { MIRALL_RELAY_PORT: '5000', MIRALL_RELAY_REGION: 'from-env' }
  const cfg = loadConfig(['--port', '6000'], env)
  assert.equal(cfg.port, 6000, 'flag wins over env')
  assert.equal(cfg.region, 'from-env', 'env wins over default')
  assert.equal(cfg.adminPort, DEFAULTS.adminPort, 'default survives')
})

test('an empty env var is treated as unset, not as an empty value', () => {
  const cfg = loadConfig([], { MIRALL_RELAY_REGION: '' })
  assert.equal(cfg.region, DEFAULTS.region)
})

test('parseArgv handles --flag value, --flag=value and bare booleans', () => {
  assert.deepEqual(parseArgv(['--port', '1']), { port: '1' })
  assert.deepEqual(parseArgv(['--port=2']), { port: '2' })
  assert.deepEqual(parseArgv(['--ephemeral']), { ephemeral: '' })
  assert.throws(() => parseArgv(['--nope']), /unknown flag --nope/)
  assert.throws(() => parseArgv(['bare']), /unexpected argument/)
})

test('a bare non-boolean flag is an error, not a silent default', () => {
  assert.throws(() => loadConfig(['--region']), /--region requires a value/)
  assert.throws(() => loadConfig(['--admin-port']), /--admin-port requires a value/)
})

test('the relay config surface takes flags only, and only its own', () => {
  assert.throws(() => loadConfig(['--nope', '1']), /unknown flag --nope/)
  assert.throws(() => loadConfig(['ben']), /unexpected argument "ben"/)
})

test('bare --ephemeral and --assume-reachable parse as true', () => {
  const cfg = loadConfig(['--ephemeral', '--assume-reachable'], {})
  assert.equal(cfg.ephemeral, true)
  assert.equal(cfg.assumeReachable, true)
})

test('asBytes understands binary units', () => {
  assert.equal(asBytes('1024'), 1024)
  assert.equal(asBytes('512MB'), 512 * 1024 * 1024)
  assert.equal(asBytes('4MiB'), 4 * 1024 * 1024)
  assert.equal(asBytes('1 GB'), 1024 ** 3)
  assert.equal(asBytes('1.5k'), 1536)
  assert.throws(() => asBytes('lots'), /expected a byte size/)
  assert.throws(() => asBytes('10 parsecs'), /unknown byte unit/)
})

test('asList splits on commas and whitespace, empty means null', () => {
  assert.deepEqual(asList('a,b c'), ['a', 'b', 'c'])
  assert.equal(asList('  '), null, 'an empty list must not become a lockout allowlist')
})

test('a seed must be 64 hex characters', () => {
  assert.throws(() => loadConfig([], { MIRALL_RELAY_SEED: 'nope' }), /seed must be 64 hex/)
  assert.throws(() => loadConfig([], { MIRALL_RELAY_SEED: 'a'.repeat(63) }), /seed must be 64 hex/)
  const cfg = loadConfig([], { MIRALL_RELAY_SEED: 'A'.repeat(64) })
  assert.equal(cfg.seed, 'a'.repeat(64), 'normalised to lowercase')
})

test('decodeKeyOrThrow accepts hex and z-base-32, rejects the rest', () => {
  const key = decodeKeyOrThrow(VALID_KEY)
  assert.equal(key.byteLength, 32)
  assert.throws(() => decodeKeyOrThrow('not-a-key'), /not a valid key/)
  assert.throws(() => decodeKeyOrThrow('ab'), /not a valid key|32 bytes/)
})

test('an allowlist of bad keys fails at boot rather than at first connection', () => {
  assert.throws(
    () => loadConfig([], { MIRALL_RELAY_ALLOWLIST: 'garbage' }),
    /not a valid key/
  )
  const cfg = loadConfig([], { MIRALL_RELAY_ALLOWLIST: VALID_KEY })
  assert.deepEqual(cfg.allowlist, [VALID_KEY])
})

test('bootstrap entries are host:port and convert for hyperdht', () => {
  assert.deepEqual(parseBootstrapEntry('1.2.3.4:49737'), { host: '1.2.3.4', port: 49737 })
  assert.throws(() => parseBootstrapEntry('1.2.3.4'), /must be host:port/)
  assert.throws(() => parseBootstrapEntry('1.2.3.4:0'), /invalid port/)

  const cfg = loadConfig([], { MIRALL_RELAY_BOOTSTRAP: '1.2.3.4:1, 5.6.7.8:2' })
  assert.deepEqual(bootstrapNodes(cfg), [
    { host: '1.2.3.4', port: 1 },
    { host: '5.6.7.8', port: 2 }
  ])
  assert.equal(bootstrapNodes(loadConfig([], {})), null, 'no bootstrap means mainline')
})

test('validate rejects out-of-range and nonsensical caps', () => {
  const base = { ...DEFAULTS, seed: null, seedFile: './seed' }
  assert.throws(() => validate({ ...base, port: 70000 }), /port out of range/)
  assert.throws(() => validate({ ...base, adminPort: -1 }), /adminPort out of range/)
  assert.doesNotThrow(() => validate({ ...base, adminPort: 0 }), 'port 0 means "let the OS pick"')
  assert.throws(() => validate({ ...base, maxSessionsPerKey: 0 }), /maxSessionsPerKey/)
  assert.throws(() => validate({ ...base, maxActiveLinks: 0 }), /maxActiveLinks/)
  assert.throws(() => validate({ ...base, maxLinkBytes: 0 }), /maxLinkBytes/)
  assert.throws(() => validate({ ...base, maxLinkRate: 0 }), /maxLinkRate/)
  assert.throws(() => validate({ ...base, maxLinkMs: 10 }), /maxLinkMs/)
  assert.throws(() => validate({ ...base, meterMs: 1 }), /meterMs/)
  assert.throws(() => validate({ ...base, sessionRate: 0 }), /sessionRate/)
  assert.throws(
    () => validate({ ...base, seed: null, seedFile: null, seedSecretFile: null }),
    /seed, seedSecretFile or seedFile/
  )
  // Any one of the three is enough — the default secret path alone is valid.
  assert.doesNotThrow(() => validate({ ...base, seed: null, seedFile: null }))
  assert.doesNotThrow(() => validate({ ...base }))
})

test('an invalid value names the env var and the flag that set it', () => {
  assert.throws(
    () => loadConfig([], { MIRALL_RELAY_PORT: 'abc' }),
    /MIRALL_RELAY_PORT \/ --port: expected an integer/
  )
})

test('the browser status page is on by default and can be turned off', () => {
  assert.equal(loadConfig([], {}).adminUi, true)
  assert.equal(loadConfig([], { MIRALL_RELAY_ADMIN_UI: 'false' }).adminUi, false)
  assert.equal(loadConfig(['--admin-ui=false'], {}).adminUi, false)
  assert.equal(loadConfig(['--admin-ui'], {}).adminUi, true, 'a bare flag is still true')
})

test('extra admin hosts parse as a list and default to none', () => {
  assert.equal(loadConfig([], {}).adminAllowedHosts, null)
  assert.deepEqual(
    loadConfig([], { MIRALL_RELAY_ADMIN_ALLOWED_HOSTS: 'relay.internal, umbrel.local' }).adminAllowedHosts,
    ['relay.internal', 'umbrel.local']
  )
})

test('access accepts open and invite only', () => {
  assert.equal(loadConfig([], { MIRALL_RELAY_ACCESS: 'invite' }).access, 'invite')
  assert.equal(loadConfig([], { MIRALL_RELAY_ACCESS: '  INVITE  ' }).access, 'invite')
  assert.equal(loadConfig(['--access=invite'], {}).access, 'invite')
  assert.throws(
    () => loadConfig([], { MIRALL_RELAY_ACCESS: 'private' }),
    /MIRALL_RELAY_ACCESS \/ --access: expected open or invite/
  )
  assert.throws(() => validate({ ...DEFAULTS, access: 'allowlist' }), /access must be open or invite/)
})

test('access defaults to open', () => {
  // The whole point of making it explicit: nothing an existing operator has
  // configured changes behaviour.
  assert.equal(DEFAULTS.access, 'open')
  assert.equal(loadConfig([], {}).access, 'open')
})

test('a roster file does not imply invite mode', () => {
  // Emptiness is no longer how privacy is expressed, and neither is presence.
  const cfg = loadConfig([], { MIRALL_RELAY_ROSTER_FILE: '/tmp/members.json' })
  assert.equal(cfg.access, 'open')
  assert.equal(cfg.rosterFile, '/tmp/members.json')
})

test('the admin write surface is on by default with a file-backed token', () => {
  const cfg = loadConfig([], {})
  assert.equal(cfg.adminWrite, true)
  assert.equal(cfg.adminToken, null, 'the env token is an override, never a default')
  assert.equal(cfg.adminTokenFile, './.keys/admin-token')
  assert.equal(loadConfig([], { MIRALL_RELAY_ADMIN_WRITE: 'false' }).adminWrite, false)
  assert.equal(loadConfig(['--admin-write=false'], {}).adminWrite, false)
})

test('the new options are frozen with the rest', () => {
  const cfg = loadConfig([], { MIRALL_RELAY_ACCESS: 'invite' })
  assert.ok(Object.isFrozen(cfg), 'the roster and the ban set are the mutable state, not cfg')
})

test('every option carries the metadata the derived surfaces need', () => {
  assert.doesNotThrow(() => validateOptionsMetadata(OPTIONS))
  for (const o of OPTIONS) {
    assert.equal(typeof o.parse, 'function', `${o.flag} needs a parser`)
    assert.equal(typeof o.help, 'string', `${o.flag} needs a help line`)
    assert.equal(typeof o.category, 'string', `${o.flag} needs a category`)
    assert.ok('envExample' in o, `${o.flag} must say what the env template does with it`)
    assert.ok(Object.isFrozen(o))
  }
})

test('a flag, env suffix or key claimed twice is a hard error', () => {
  // Two options sharing any of the three would let one silently shadow the other.
  const dup = (field, value) => [OPTIONS[0], { ...OPTIONS[0], flag: 'x', env: 'X', key: 'x', [field]: value }]
  assert.throws(() => validateOptionsMetadata(dup('flag', 'seed')), /duplicate flag seed/)
  assert.throws(() => validateOptionsMetadata(dup('env', 'SEED')), /duplicate env SEED/)
  assert.throws(() => validateOptionsMetadata(dup('key', 'seed')), /duplicate key seed/)
})

test('the derived surfaces stay in step with the option table', () => {
  assert.equal(DEFAULTS.adminPort, 9200)
  assert.equal(DEFAULTS.seedFile, './.keys/seed')
  assert.deepEqual(Object.keys(DEFAULTS), OPTIONS.map((o) => o.key))
  assert.deepEqual(Object.keys(CONFIG_FLAG_SPEC), OPTIONS.map((o) => o.flag))
})

test('generated help lists every flag with its placeholder and default', () => {
  const help = helpOptions()
  assert.match(help, /^ {2}--seed-file PATH {11}seed file, generated on first run \[\.\/\.keys\/seed\]$/m)
  assert.match(help, /^ {2}--ephemeral {16}do not join the DHT routing table \[false\]$/m)
  for (const o of OPTIONS) assert.ok(help.includes(`--${o.flag}`), `${o.flag} is missing from --help`)
  for (const line of help.split('\n')) assert.ok(line.length <= 78, `help line too wide: ${line}`)
})
