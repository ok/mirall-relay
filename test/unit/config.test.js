import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadConfig, validate, parseArgv, asBytes, asList,
  decodeKeyOrThrow, parseBootstrapEntry, bootstrapNodes, DEFAULTS
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
