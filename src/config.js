// Configuration: defaults <- environment <- CLI flags, validated once and frozen.
//
// Every knob is settable by env (MIRALL_RELAY_*) so a container needs no arguments,
// and by an equivalent long flag so a shell run needs no exports. Validation is
// strict and fails at boot: a relay that silently starts with a nonsense cap is
// worse than one that refuses to start.
//
// OPTIONS below is the single source of option truth: the parser, the defaults,
// the flag spec, the `--help` table and the docs drift guard are all derived from
// it, so an option cannot exist in one of those and be missing from another.
import idEnc from 'hypercore-id-encoding'
import { parseLongOptions } from './cli-args.js'

export const ENV_PREFIX = 'MIRALL_RELAY_'

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

// --- the option table ----------------------------------------------------

// flag         long CLI name, without the leading `--`. Kebab-case of env.
// env          suffix after MIRALL_RELAY_.
// key          camelCase config key.
// category     help grouping; consecutive options in a category print together.
// parse        the parser above; also decides whether a bare flag means true.
// default      runtime default, before env and flags.
// value        help placeholder, or null for a bare boolean flag.
// help         one short line for `--help`.
// helpDefault  what `--help` shows in brackets, when the raw default would not
//              read as what an operator typed; null hides the bracket entirely.
// envExample   the value deploy/mirall-relay.env.example sets, or null when the
//              template must leave it commented out.
// sensitive    a secret: the env template must never carry a usable value.
// docsRequired the README must name it — the options reached for under pressure.
function option (o) {
  return Object.freeze(o)
}

export const OPTIONS = Object.freeze([
  option({
    flag: 'seed',
    env: 'SEED',
    key: 'seed',
    category: 'identity',
    parse: asSeedHex,
    default: null,
    value: 'HEX',
    help: '64-hex identity seed (overrides --seed-file)',
    envExample: null,
    sensitive: true,
    docsRequired: true
  }),
  option({
    flag: 'seed-file',
    env: 'SEED_FILE',
    key: 'seedFile',
    category: 'identity',
    parse: asString,
    default: './.keys/seed',
    value: 'PATH',
    help: 'seed file, generated on first run',
    envExample: '/var/lib/mirall-relay/seed',
    docsRequired: true
  }),
  // A mounted secret (Docker/Compose/Kubernetes) holding a 64-hex seed. Preferred
  // over MIRALL_RELAY_SEED because env vars leak into `docker inspect`, process
  // listings and crash reports; a file does not. Read in-process rather than by an
  // entrypoint shell script, so the runtime image needs no shell.
  option({
    flag: 'seed-secret-file',
    env: 'SEED_SECRET_FILE',
    key: 'seedSecretFile',
    category: 'identity',
    parse: asString,
    default: '/run/secrets/relay_seed',
    value: 'PATH',
    help: 'mounted secret, read before --seed-file',
    envExample: null
  }),
  option({
    flag: 'bootstrap',
    env: 'BOOTSTRAP',
    key: 'bootstrap',
    category: 'identity',
    parse: asList,
    default: null, // null -> hyperdht's mainline bootstrap
    value: 'host:port,...',
    help: 'DHT bootstrap override',
    helpDefault: 'mainline',
    envExample: null
  }),
  option({
    flag: 'host',
    env: 'HOST',
    key: 'host',
    category: 'identity',
    parse: asString,
    default: '0.0.0.0',
    value: 'ADDR',
    help: 'UDP bind address',
    envExample: '0.0.0.0'
  }),
  option({
    flag: 'port',
    env: 'PORT',
    key: 'port',
    category: 'identity',
    parse: asInt,
    default: 49737, // pinned by default so firewall/NAT rules are stable
    value: 'N',
    help: 'UDP port, 0 = ephemeral',
    envExample: '49737',
    docsRequired: true
  }),
  option({
    flag: 'ephemeral',
    env: 'EPHEMERAL',
    key: 'ephemeral',
    category: 'identity',
    parse: asBool,
    default: false, // a relay is a long-lived public node, not a transient client
    value: null,
    help: 'do not join the DHT routing table',
    envExample: null
  }),
  option({
    flag: 'assume-reachable',
    env: 'ASSUME_REACHABLE',
    key: 'assumeReachable',
    category: 'identity',
    parse: asBool,
    default: false, // true -> tell hyperdht we are directly reachable (skip probing)
    value: null,
    help: 'skip firewall probing (public IP)',
    envExample: null,
    docsRequired: true
  }),

  option({
    flag: 'admin-host',
    env: 'ADMIN_HOST',
    key: 'adminHost',
    category: 'admin',
    parse: asString,
    default: '127.0.0.1', // never expose the admin surface publicly
    value: 'ADDR',
    help: 'admin HTTP bind',
    envExample: '127.0.0.1',
    docsRequired: true
  }),
  option({
    flag: 'admin-port',
    env: 'ADMIN_PORT',
    key: 'adminPort',
    category: 'admin',
    parse: asInt,
    default: 9200,
    value: 'N',
    help: 'admin HTTP port',
    envExample: '9200'
  }),
  option({
    flag: 'admin-ui',
    env: 'ADMIN_UI',
    key: 'adminUi',
    category: 'admin',
    parse: asBool,
    default: true, // the browser status page; false leaves only the JSON endpoints
    value: 'BOOL',
    help: 'serve the browser status page',
    envExample: 'true'
  }),
  // Extra Host header values accepted when the admin server is bound to loopback.
  // See src/operator/http/host-guard.js — the guard is inert on any other bind.
  option({
    flag: 'admin-allowed-hosts',
    env: 'ADMIN_ALLOWED_HOSTS',
    key: 'adminAllowedHosts',
    category: 'admin',
    parse: asList,
    default: null,
    value: 'H,..',
    help: 'extra Host values accepted when the admin server is bound to loopback',
    helpDefault: 'none',
    envExample: null
  }),
  option({
    flag: 'admin-write',
    env: 'ADMIN_WRITE',
    key: 'adminWrite',
    category: 'admin',
    parse: asBool,
    default: true, // false removes /admin/* entirely
    value: 'BOOL',
    help: 'serve the token-gated /admin/* write surface; false removes it entirely',
    envExample: 'true'
  }),
  option({
    flag: 'admin-token',
    env: 'ADMIN_TOKEN',
    key: 'adminToken',
    category: 'admin',
    parse: asString,
    default: null, // prefer the file: env vars leak into `docker inspect`
    value: 'TOKEN',
    help: 'bearer token for /admin/*; prefer the file, env vars leak into inspect',
    helpDefault: 'none',
    envExample: null,
    sensitive: true
  }),
  option({
    flag: 'admin-token-file',
    env: 'ADMIN_TOKEN_FILE',
    key: 'adminTokenFile',
    category: 'admin',
    parse: asString,
    default: './.keys/admin-token',
    value: 'PATH',
    help: 'token file, generated and logged on first boot',
    envExample: '/var/lib/mirall-relay/admin-token'
  }),

  // Per DEVICE, not per user or per plane. The connection a peer makes TO the
  // relay uses its DHT node's defaultKeyPair (hyperdht/lib/connect.js:47,793 —
  // relayConnection passes no keyPair), and a Mirall client's two swarms share one
  // DHT node. So relaying to N peers costs 2xN sessions against a single key.
  // 5 (the Hiverelay-derived value) allowed only two relayed peers; 64 allows ~32
  // while capping one key at ~3% of maxActiveLinks.
  option({
    flag: 'max-sessions-per-key',
    env: 'MAX_SESSIONS_PER_KEY',
    key: 'maxSessionsPerKey',
    category: 'caps',
    parse: asInt,
    default: 64,
    value: 'N',
    help: 'sessions per peer DEVICE key',
    envExample: '64',
    docsRequired: true
  }),
  option({
    flag: 'max-active-links',
    env: 'MAX_ACTIVE_LINKS',
    key: 'maxActiveLinks',
    category: 'caps',
    parse: asInt,
    default: 2000,
    value: 'N',
    help: 'global bridged-stream ceiling',
    envExample: '2000',
    docsRequired: true
  }),
  option({
    flag: 'max-link-bytes',
    env: 'MAX_LINK_BYTES',
    key: 'maxLinkBytes',
    category: 'caps',
    parse: asBytes,
    default: 512 * 1024 * 1024,
    value: 'SIZE',
    help: 'bytes per link, per direction',
    helpDefault: '512MB',
    envExample: '512MB',
    docsRequired: true
  }),
  option({
    flag: 'max-link-rate',
    env: 'MAX_LINK_RATE',
    key: 'maxLinkRate',
    category: 'caps',
    parse: asBytes,
    default: 4 * 1024 * 1024,
    value: 'SIZE',
    help: 'bytes/sec per link, per direction',
    helpDefault: '4MiB',
    envExample: '4MiB',
    docsRequired: true
  }),
  option({
    flag: 'max-link-ms',
    env: 'MAX_LINK_MS',
    key: 'maxLinkMs',
    category: 'caps',
    parse: asInt,
    default: 60 * 60 * 1000,
    value: 'N',
    help: 'max link lifetime',
    envExample: '3600000'
  }),
  option({
    flag: 'max-pending',
    env: 'MAX_PENDING',
    key: 'maxPending',
    category: 'caps',
    parse: asInt,
    default: 10000,
    value: 'N',
    help: 'half-open pairing ceiling',
    envExample: '10000'
  }),
  option({
    flag: 'session-rate',
    env: 'SESSION_RATE',
    key: 'sessionRate',
    category: 'caps',
    parse: asInt,
    default: 120, // new sessions per remote key per minute
    value: 'N',
    help: 'new sessions per key per minute',
    envExample: '120'
  }),
  option({
    flag: 'over-rate-grace-ms',
    env: 'OVER_RATE_GRACE_MS',
    key: 'overRateGraceMs',
    category: 'caps',
    parse: asInt,
    default: 5000, // sustained-over-rate window before tearing a link
    value: 'N',
    help: 'sustained-overrun window before a link is torn for exceeding its rate',
    envExample: '5000'
  }),
  option({
    flag: 'meter-ms',
    env: 'METER_MS',
    key: 'meterMs',
    category: 'caps',
    parse: asInt,
    default: 1000,
    value: 'N',
    help: 'cap sampling interval',
    envExample: '1000'
  }),

  // 'open'   — anyone may connect; the banlist and the caps do the work
  // 'invite' — only roster members and the allowlist may connect
  //
  // Explicit on purpose. Inferring "private" from a non-empty list means
  // revoking the last member silently reopens the relay to the internet, which
  // is the one mistake this feature must not make possible.
  option({
    flag: 'access',
    env: 'ACCESS',
    key: 'access',
    category: 'access',
    parse: asAccessMode,
    default: 'open',
    value: 'MODE',
    help: 'open | invite. invite admits only roster members and --allowlist keys',
    envExample: 'open',
    docsRequired: true
  }),
  option({
    flag: 'roster-file',
    env: 'ROSTER_FILE',
    key: 'rosterFile',
    category: 'access',
    parse: asString,
    default: './.keys/members.json',
    value: 'PATH',
    help: 'members.json; as secret as the seed',
    envExample: '/var/lib/mirall-relay/members.json'
  }),
  option({
    flag: 'allowlist',
    env: 'ALLOWLIST',
    key: 'allowlist',
    category: 'access',
    parse: asList,
    default: null, // in open mode: null -> open relay; a list -> only these keys
    value: 'KEY,...',
    help: 'static keys admitted, unioned with the roster',
    envExample: null,
    docsRequired: true
  }),
  option({
    flag: 'banlist',
    env: 'BANLIST',
    key: 'banlist',
    category: 'access',
    parse: asList,
    default: null,
    value: 'KEY,...',
    help: 'keys refused at connect time',
    envExample: null,
    docsRequired: true
  }),

  option({
    flag: 'region',
    env: 'REGION',
    key: 'region',
    category: 'labels',
    parse: asString,
    default: 'unknown',
    value: 'NAME',
    help: 'label for metrics and /.well-known',
    envExample: 'eu-fsn1'
  }),
  option({
    flag: 'operator',
    env: 'OPERATOR',
    key: 'operator',
    category: 'labels',
    parse: asString,
    default: 'unknown',
    value: 'NAME',
    help: 'label for metrics and /.well-known',
    envExample: 'example'
  }),
  option({
    flag: 'log-level',
    env: 'LOG_LEVEL',
    key: 'logLevel',
    category: 'labels',
    parse: asString,
    default: 'info',
    value: 'LEVEL',
    help: 'trace|debug|info|warn|error|fatal',
    envExample: 'info'
  })
])

// A flag, an env suffix or a config key claimed twice would let one option
// silently shadow another; the metadata unit test runs this.
export function validateOptionsMetadata (options = OPTIONS) {
  const seen = { flag: new Set(), env: new Set(), key: new Set() }
  for (const o of options) {
    for (const field of ['flag', 'env', 'key']) {
      if (seen[field].has(o[field])) throw new Error(`duplicate ${field} ${o[field]}`)
      seen[field].add(o[field])
    }
  }
  return options
}

export const DEFAULTS = Object.freeze(Object.fromEntries(OPTIONS.map((o) => [o.key, o.default])))

// --- help ----------------------------------------------------------------

const HELP_INDENT = '  '
const HELP_COLUMN = 29
const HELP_WIDTH = 78

function wrap (text, width) {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

function helpLine (o) {
  const flag = `--${o.flag}${o.value ? ' ' + o.value : ''}`
  const shown = o.helpDefault !== undefined ? o.helpDefault : (o.default === null ? null : String(o.default))
  const [first, ...rest] = wrap(shown === null ? o.help : `${o.help} [${shown}]`, HELP_WIDTH - HELP_COLUMN)
  const head = HELP_INDENT + flag.padEnd(HELP_COLUMN - HELP_INDENT.length) + first
  return [head, ...rest.map((l) => ' '.repeat(HELP_COLUMN) + l)].join('\n')
}

// The `--help` option table, rendered from the metadata so a new option cannot
// reach an operator's terminal undocumented. Categories print as blank-line
// separated blocks, in table order.
export function helpOptions (options = OPTIONS) {
  const blocks = []
  for (const o of options) {
    const last = blocks.at(-1)
    if (last?.category === o.category) last.lines.push(helpLine(o))
    else blocks.push({ category: o.category, lines: [helpLine(o)] })
  }
  return blocks.map((b) => b.lines.join('\n')).join('\n\n')
}

// --- assembly ------------------------------------------------------------

// The relay's flags as a cli-args spec. Every option carries a value; a bare
// `--flag` arrives as '' so asBool can read it as true and every other parser
// can reject it as a missing value.
export const CONFIG_FLAG_SPEC = Object.freeze(
  Object.fromEntries(OPTIONS.map((o) => [o.flag, { value: true }]))
)

export function parseArgv (argv) {
  return parseLongOptions(argv, CONFIG_FLAG_SPEC, { bareBooleanValue: '' }).flags
}

export function loadConfig (argv = [], env = process.env) {
  return configFromFlags(parseArgv(argv), env)
}

// Flags already parsed — `invite` shares this entry point because its labels are
// positional, so it cannot hand the whole argv to parseArgv.
export function configFromFlags (flags, env = process.env) {
  const cfg = { ...DEFAULTS }

  for (const o of OPTIONS) {
    // precedence: flag > env > default
    const raw = o.flag in flags ? flags[o.flag] : env[ENV_PREFIX + o.env]
    if (raw === undefined || raw === '') {
      // An unset env var and an absent flag both mean "keep the default".
      if (!(o.flag in flags)) continue
      // A bare `--flag` arrives as '' and means true — but only for booleans;
      // for anything else it is a missing value, not a default.
      if (o.parse !== asBool) throw new Error(`--${o.flag} requires a value`)
    }
    try {
      cfg[o.key] = o.parse(raw)
    } catch (err) {
      throw new Error(`${ENV_PREFIX + o.env} / --${o.flag}: ${err.message}`)
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
