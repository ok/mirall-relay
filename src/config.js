// Configuration: defaults <- environment <- CLI flags, validated once and frozen.
//
// Every knob is settable by env (MIRALL_RELAY_*) so a container needs no arguments,
// and by an equivalent long flag so a shell run needs no exports. Validation is
// strict and fails at boot: a relay that silently starts with a nonsense cap is
// worse than one that refuses to start.
import idEnc from 'hypercore-id-encoding'

export const ENV_PREFIX = 'MIRALL_RELAY_'

// flag name -> [env suffix, parser]. The flag is the kebab-case of the env suffix.
const SPEC = {
  // identity / networking
  seed: ['SEED', asSeedHex],
  'seed-file': ['SEED_FILE', asString],
  'seed-secret-file': ['SEED_SECRET_FILE', asString],
  bootstrap: ['BOOTSTRAP', asList],
  host: ['HOST', asString],
  port: ['PORT', asInt],
  ephemeral: ['EPHEMERAL', asBool],
  'assume-reachable': ['ASSUME_REACHABLE', asBool],
  // admin http
  'admin-host': ['ADMIN_HOST', asString],
  'admin-port': ['ADMIN_PORT', asInt],
  'admin-ui': ['ADMIN_UI', asBool],
  'admin-allowed-hosts': ['ADMIN_ALLOWED_HOSTS', asList],
  'admin-write': ['ADMIN_WRITE', asBool],
  'admin-token': ['ADMIN_TOKEN', asString],
  'admin-token-file': ['ADMIN_TOKEN_FILE', asString],
  // caps
  'max-sessions-per-key': ['MAX_SESSIONS_PER_KEY', asInt],
  'max-active-links': ['MAX_ACTIVE_LINKS', asInt],
  'max-link-bytes': ['MAX_LINK_BYTES', asBytes],
  'max-link-rate': ['MAX_LINK_RATE', asBytes],
  'max-link-ms': ['MAX_LINK_MS', asInt],
  'max-pending': ['MAX_PENDING', asInt],
  'session-rate': ['SESSION_RATE', asInt],
  'over-rate-grace-ms': ['OVER_RATE_GRACE_MS', asInt],
  'meter-ms': ['METER_MS', asInt],
  // access control
  access: ['ACCESS', asAccessMode],
  'roster-file': ['ROSTER_FILE', asString],
  allowlist: ['ALLOWLIST', asList],
  banlist: ['BANLIST', asList],
  // labels / ops
  region: ['REGION', asString],
  operator: ['OPERATOR', asString],
  'log-level': ['LOG_LEVEL', asString]
}

export const DEFAULTS = Object.freeze({
  seed: null, // 64-hex; overrides everything below when set
  // A mounted secret (Docker/Compose/Kubernetes) holding a 64-hex seed. Preferred
  // over MIRALL_RELAY_SEED because env vars leak into `docker inspect`, process
  // listings and crash reports; a file does not. Read in-process rather than by an
  // entrypoint shell script, so the runtime image needs no shell.
  seedSecretFile: '/run/secrets/relay_seed',
  seedFile: './.keys/seed',
  bootstrap: null, // null -> hyperdht's mainline bootstrap
  host: '0.0.0.0',
  port: 49737, // pinned by default so firewall/NAT rules are stable
  ephemeral: false, // a relay is a long-lived public node, not a transient client
  assumeReachable: false, // true -> tell hyperdht we are directly reachable (skip probing)

  adminHost: '127.0.0.1', // never expose the admin surface publicly
  adminPort: 9200,
  adminUi: true, // the browser status page; false leaves only the JSON endpoints
  // Extra Host header values accepted when the admin server is bound to loopback.
  // See src/operator/http/host-guard.js — the guard is inert on any other bind.
  adminAllowedHosts: null,
  adminWrite: true, // false removes /admin/* entirely
  adminToken: null, // prefer the file: env vars leak into `docker inspect`
  adminTokenFile: './.keys/admin-token',

  // Per DEVICE, not per user or per plane. The connection a peer makes TO the
  // relay uses its DHT node's defaultKeyPair (hyperdht/lib/connect.js:47,793 —
  // relayConnection passes no keyPair), and a Mirall client's two swarms share one
  // DHT node. So relaying to N peers costs 2xN sessions against a single key.
  // 5 (the Hiverelay-derived value) allowed only two relayed peers; 64 allows ~32
  // while capping one key at ~3% of maxActiveLinks.
  maxSessionsPerKey: 64,
  maxActiveLinks: 2000,
  maxLinkBytes: 512 * 1024 * 1024,
  maxLinkRate: 4 * 1024 * 1024,
  maxLinkMs: 60 * 60 * 1000,
  maxPending: 10000,
  sessionRate: 120, // new sessions per remote key per minute
  overRateGraceMs: 5000, // sustained-over-rate window before tearing a link
  meterMs: 1000,

  // 'open'   — anyone may connect; BANLIST and the caps do the work
  // 'invite' — only roster members and ALLOWLIST entries may connect
  //
  // Explicit on purpose. Inferring "private" from a non-empty list means
  // revoking the last member silently reopens the relay to the internet, which
  // is the one mistake this feature must not make possible.
  access: 'open',
  rosterFile: './.keys/members.json',
  allowlist: null, // in open mode: null -> open relay; a list -> only these keys
  banlist: null,

  region: 'unknown',
  operator: 'unknown',
  logLevel: 'info'
})

// --- parsers -------------------------------------------------------------

function asString (v) {
  return String(v)
}

function asInt (v) {
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`expected an integer, got ${JSON.stringify(v)}`)
  return n
}

function asAccessMode (v) {
  const s = String(v).trim().toLowerCase()
  if (s !== 'open' && s !== 'invite') throw new Error(`expected open or invite, got ${JSON.stringify(v)}`)
  return s
}

function asBool (v) {
  const s = String(v).toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === '') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  throw new Error(`expected a boolean, got ${JSON.stringify(v)}`)
}

const UNITS = { b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3 }

// "512MB" / "4MiB" / "1073741824" -> bytes. Binary units throughout (KiB == KB);
// a relay operator sizing a NIC thinks in powers of two, and mixing the two
// conventions in a cap is a footgun.
export function asBytes (v) {
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/)
  if (!m) throw new Error(`expected a byte size, got ${JSON.stringify(v)}`)
  const unit = m[2].toLowerCase() || 'b'
  if (!(unit in UNITS)) throw new Error(`unknown byte unit ${JSON.stringify(m[2])}`)
  return Math.round(Number(m[1]) * UNITS[unit])
}

// Comma- or whitespace-separated. Empty string -> null (an explicitly empty
// allowlist would lock everyone out, which is never what an operator means).
export function asList (v) {
  const parts = String(v).split(/[,\s]+/).filter(Boolean)
  return parts.length ? parts : null
}

function asSeedHex (v) {
  const s = String(v).trim()
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('seed must be 64 hex characters')
  return s.toLowerCase()
}

// z-base-32 or hex -> throws unless it decodes to a 32-byte key.
export function decodeKeyOrThrow (value) {
  let key
  try {
    key = idEnc.decode(String(value).trim())
  } catch {
    throw new Error(`not a valid key: ${JSON.stringify(value)}`)
  }
  if (key.byteLength !== 32) throw new Error(`key must be 32 bytes, got ${key.byteLength}`)
  return key
}

// "host:port" -> { host, port } for hyperdht's bootstrap list.
export function parseBootstrapEntry (entry) {
  const idx = entry.lastIndexOf(':')
  if (idx <= 0) throw new Error(`bootstrap entry must be host:port, got ${JSON.stringify(entry)}`)
  const host = entry.slice(0, idx)
  const port = Number(entry.slice(idx + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`bootstrap entry has an invalid port: ${JSON.stringify(entry)}`)
  }
  return { host, port }
}

// --- assembly ------------------------------------------------------------

function camel (flag) {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

// Minimal long-flag parser: --flag value | --flag=value | --flag (boolean true).
// Deliberately dependency-free — the CLI surface is a handful of options and a
// network-exposed service earns its small dependency tree.
export function parseArgv (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(arg)}`)
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (!(flag in SPEC)) throw new Error(`unknown flag --${flag}`)
    let raw
    if (eq !== -1) raw = arg.slice(eq + 1)
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) raw = argv[++i]
    else raw = '' // bare flag -> boolean true via asBool
    out[flag] = raw
  }
  return out
}

export function loadConfig (argv = [], env = process.env) {
  const cfg = { ...DEFAULTS }
  const flags = parseArgv(argv)

  for (const [flag, [suffix, parse]] of Object.entries(SPEC)) {
    const key = camel(flag)
    // precedence: flag > env > default
    const raw = flag in flags ? flags[flag] : env[ENV_PREFIX + suffix]
    if (raw === undefined || raw === '') {
      // An unset env var and an absent flag both mean "keep the default".
      if (!(flag in flags)) continue
      // A bare `--flag` arrives as '' and means true — but only for booleans;
      // for anything else it is a missing value, not a default.
      if (parse !== asBool) throw new Error(`--${flag} requires a value`)
    }
    try {
      cfg[key] = parse(raw)
    } catch (err) {
      throw new Error(`${ENV_PREFIX + suffix} / --${flag}: ${err.message}`)
    }
  }

  validate(cfg)
  return Object.freeze(cfg)
}

export function validate (c) {
  if (!Number.isInteger(c.port) || c.port < 0 || c.port > 65535) throw new Error('port out of range')
  // 0 is legitimate on both ports: it means "let the OS pick", which parallel
  // test runs and ephemeral deployments both rely on.
  if (!Number.isInteger(c.adminPort) || c.adminPort < 0 || c.adminPort > 65535) throw new Error('adminPort out of range')
  if (c.maxSessionsPerKey < 1) throw new Error('maxSessionsPerKey must be >= 1')
  if (c.maxActiveLinks < 1) throw new Error('maxActiveLinks must be >= 1')
  if (c.maxLinkBytes < 1) throw new Error('maxLinkBytes must be >= 1')
  if (c.maxLinkRate < 1) throw new Error('maxLinkRate must be >= 1')
  if (c.maxLinkMs < 1000) throw new Error('maxLinkMs must be >= 1000')
  if (c.maxPending < 1) throw new Error('maxPending must be >= 1')
  if (c.sessionRate < 1) throw new Error('sessionRate must be >= 1')
  if (c.overRateGraceMs < 0) throw new Error('overRateGraceMs must be >= 0')
  if (c.meterMs < 10) throw new Error('meterMs must be >= 10')
  if (c.access !== 'open' && c.access !== 'invite') throw new Error('access must be open or invite')
  if (!c.seed && !c.seedFile && !c.seedSecretFile) throw new Error('one of seed, seedSecretFile or seedFile is required')
  if (c.allowlist) for (const k of c.allowlist) decodeKeyOrThrow(k)
  if (c.banlist) for (const k of c.banlist) decodeKeyOrThrow(k)
  if (c.bootstrap) for (const e of c.bootstrap) parseBootstrapEntry(e)
  return c
}

// hyperdht wants [{ host, port }]; null means "use the mainline bootstrap".
export function bootstrapNodes (cfg) {
  return cfg.bootstrap ? cfg.bootstrap.map(parseBootstrapEntry) : null
}
