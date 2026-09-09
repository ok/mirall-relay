// The browser surface.
//
// The relay's entire user-facing product is a 52-character public key, and until
// this page existed the only way to get it was `docker logs | head -1`. So the
// page is server-rendered: the key, the reachability verdict and the counters are
// in the markup, and `ui.js` only refreshes the numbers that move. With
// JavaScript off, or with `ui.js` broken, the page is stale but still correct and
// still hands over the key.
//
// Nothing here is a secret. The seed is never rendered — only where it is being
// read from, which is the fact that catches a container running without a volume
// before the identity is lost rather than after.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { encodeQr, qrSvg } from './qr.js'
import { formatBytes, formatCount, formatField, formatMs, formatRate } from './format.js'
import { accessSignature, reachabilitySignature } from './ui.js'

// Served verbatim to the browser. They live in src/ alongside everything else
// rather than in a src/ui/ of their own: format.js and ui.js are SOURCE that the
// server imports, and a packaging step that copies `src/*.js` must not be able to
// separate them from the modules that import them. Only the stylesheet is a pure
// asset, and its absence 404s one route instead of stopping the relay.
const ASSET_TYPES = {
  'ui.css': 'text/css; charset=utf-8',
  'ui.js': 'text/javascript; charset=utf-8',
  'format.js': 'text/javascript; charset=utf-8'
}

// Every path the browser surface owns — the set the Host guard covers, and the
// set MIRALL_RELAY_ADMIN_UI=false turns off.
export const uiPaths = new Set(['/', '/status.json', '/qr.svg', ...Object.keys(ASSET_TYPES).map((f) => '/' + f)])

export function etagFor (body) {
  return `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`
}

// Read on first use, not at import. Reading at module load made src/ui/*.css a
// hard boot dependency of the whole CLI: any packaging that shipped only src/*.js
// turned "the status page 404s" into "the relay will not start and you cannot run
// the key ceremony", with an error naming a stylesheet.
let assetCache = null
export function loadAssets () {
  if (assetCache) return assetCache
  assetCache = new Map()
  for (const [file, type] of Object.entries(ASSET_TYPES)) {
    try {
      const body = fs.readFileSync(new URL(`./${file}`, import.meta.url))
      assetCache.set('/' + file, { body, type, etag: etagFor(body) })
    } catch { /* missing asset: that route 404s, the relay still runs */ }
  }
  return assetCache
}

export function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

// The identity never changes while the process runs, so neither do its squares.
// Both renderings are memoised: the inline one is ~7 KB of path data rebuilt on
// every page load otherwise, which is most of the cost of rendering the page.
let squares = null
function squaresFor (publicKey) {
  if (squares && squares.key === publicKey) return squares
  const matrix = encodeQr(publicKey)
  const common = { quietZone: 4, color: '#000000', background: '#ffffff', title: `Relay public key ${publicKey}` }
  squares = {
    key: publicKey,
    // Black on white regardless of the page theme. A light-on-dark QR is legal
    // and most scanners cope, but the whole point of this square is that it works
    // on the first try from someone else's phone.
    inline: qrSvg(matrix, common),
    standalone: qrSvg(matrix, { ...common, standalone: true })
  }
  return squares
}

export function publicKeyQr (publicKey) {
  return squaresFor(publicKey).inline
}

// The same square as a file to save, print or hand to someone.
export function standaloneQr (publicKey) {
  return squaresFor(publicKey).standalone
}

const VERDICTS = {
  reachable: {
    label: 'Reachable',
    tone: 'good',
    sentence: 'Peers on the open internet can hole-punch to this relay.'
  },
  assumed: {
    label: 'Assumed reachable',
    tone: 'warn',
    sentence: 'MIRALL_RELAY_ASSUME_REACHABLE is set, so reachability was asserted rather than measured. Confirm it from another machine before publishing the key.'
  },
  firewalled: {
    label: 'Not reachable',
    tone: 'bad',
    sentence: 'HyperDHT probed this node from the outside and could not reach it. Clients cannot use this relay until the UDP port is open.'
  },
  starting: {
    label: 'Starting',
    tone: 'idle',
    sentence: 'Still bootstrapping onto the DHT.'
  },
  stopped: {
    label: 'Stopped',
    tone: 'idle',
    sentence: 'The relay is shutting down. In-flight relayed connections are dropping.'
  },
  unknown: {
    label: 'Unknown',
    tone: 'idle',
    sentence: 'The DHT node has not reported a reachability verdict yet.'
  }
}

export function verdict (reachability) {
  const { state, probed } = reachability
  if (state === 'reachable' && probed === false) return VERDICTS.assumed
  return VERDICTS[state] || VERDICTS.unknown
}

function notes (reachability) {
  const out = []
  if (reachability.portRandomized) {
    out.push(
      'This host is behind a NAT that assigns a different external port per destination (symmetric NAT). ' +
      'A relay needs a stable external UDP port, so hole-punching to it will fail even when the reachability check above passes.'
    )
  }
  // Only when the OPERATOR asked for it. hyperdht keeps a firewalled node
  // ephemeral on its own, and telling someone to unset a variable they never set
  // sends them looking for a mistake they did not make.
  if (reachability.ephemeralConfigured) {
    out.push(
      'MIRALL_RELAY_EPHEMERAL is set, so this node does not join the DHT routing table. A public relay should not be ephemeral.'
    )
  }
  return out
}

function remediation (reachability, listenPort) {
  if (reachability.state !== 'firewalled') return []
  return [
    `Open and forward <strong>UDP ${escapeHtml(listenPort)}</strong> to this host, in both directions. UDP, not TCP.`,
    'Check the host firewall, and on a cloud host the security group.',
    'On Docker prefer <code>network_mode: host</code>; a published port can have its external mapping rewritten by the userland proxy.',
    'If your ISP puts you behind CGNAT there is no port to forward at all. A relay then needs a rented public address tunnelled back to this host; check whether your ISP will sell you a public IPv4.',
    'Confirm from a <em>different</em> machine: <code>node scripts/probe.js --relay &lt;public-key&gt;</code>'
  ]
}

function field (path, format, value) {
  return `<span data-field="${escapeHtml(path)}" data-format="${escapeHtml(format)}">${escapeHtml(formatField(value, format))}</span>`
}

function rows (entries) {
  return entries.map(([label, value]) => `<div class="row"><dt>${label}</dt><dd>${value}</dd></div>`).join('')
}

function plain (value, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : escapeHtml(value)
}

// Three modes, in plain language, because the page is where an operator finds
// out why nobody is connecting.
function accessSentence (access) {
  const members = access.members ? access.members.active : 0
  if (access.mode === 'invite') {
    return members === 0
      ? 'No members yet — this relay is refusing everyone.'
      : `${formatCount(members)} ${members === 1 ? 'member' : 'members'} may connect. Everyone else is refused.`
  }
  if (access.mode === 'allowlist') {
    return `${formatCount(access.allowlisted)} ${access.allowlisted === 1 ? 'key' : 'keys'} may connect. Everyone else is refused.`
  }
  return "Anyone with this relay's key can connect. Bans and the caps are your only limits."
}

// The loud case. An invite-mode relay with an empty roster is working exactly as
// configured and is indistinguishable from a broken one, so it gets the fix.
function accessWarning (access) {
  if (access.mode !== 'invite') return ''
  if (access.members && access.members.active > 0) return ''
  // The verdict sentence directly above already says nobody can connect; this
  // note's whole job is the way out of it.
  return `<p class="note warn">${manageSentence(access)}</p>`
}

// Shown whether or not the roster is empty. It used to appear ONLY in the loud
// case above, which meant the page told you how to add the first member and then
// never mentioned it again — the second invite had no route on screen at all.
function manageHint (access) {
  if (access.mode !== 'invite') return ''
  if (!access.members || access.members.active === 0) return '' // already said, loudly
  return `<p class="hint">${manageSentence(access)}</p>`
}

function manageSentence (access) {
  const cli = 'Or run <code>mirall-relay invite create &lt;label&gt;</code>.'
  return access.managed === false
    ? 'Add a member with <code>mirall-relay invite create &lt;label&gt;</code>, then send them the invite line. The admin page is off (<code>MIRALL_RELAY_ADMIN_WRITE=false</code>).'
    : `Add and revoke members on the <a href="admin/">admin page</a>. ${cli}`
}

function accessRows (access) {
  const out = [['Mode', escapeHtml(access.mode)]]
  const members = access.members ? access.members.active : null
  if (access.members) {
    out.push(['Members', field('access.members.active', 'count', members)])
    const revoked = access.members.total - access.members.active
    if (revoked > 0) out.push(['Revoked members', escapeHtml(formatCount(revoked))])
  }
  // Only when it says something the row above did not: the admitted set is the
  // union of the roster and ALLOWLIST, so an equal number means no static keys.
  if (access.allowlisted !== null && access.allowlisted !== undefined && access.allowlisted !== members) {
    out.push(['Keys admitted', field('access.allowlisted', 'count', access.allowlisted)])
  }
  out.push(['Banned keys', field('access.banned', 'count', access.banned)])
  out.push(['Connection attempts refused, last hour', field('access.refusedLastHour', 'count', access.refusedLastHour || 0)])
  return out
}

export function renderPage (status) {
  const { identity, reachability, traffic, caps, access, labels } = status
  const key = identity.publicKey
  const current = verdict(reachability)
  const bound = reachability.bound
  // While firewalled, dht-rpc's socket getter returns the ephemeral CLIENT socket
  // (dht-rpc/index.js:139), so the observed port is a temporary probing port and
  // not the one to forward. The README carries a "Not a bug" note about exactly
  // this confusion in the startup log; do not reproduce it on the page.
  const probing = reachability.state === 'firewalled'
  // NEVER fall back to the configured port here. A null observed port with a live
  // observed host means dht-rpc's NAT sampler saw the port move — i.e. symmetric
  // NAT — so the configured number is precisely the one the NAT is not using, and
  // printing it reads as confirmation directly above the note saying otherwise.
  const showPort = !probing && reachability.publicPort
  const publicAddress = reachability.publicHost
    ? (showPort ? `${reachability.publicHost}:${reachability.publicPort}` : reachability.publicHost)
    : null
  const localSocket = bound
    ? `${bound.host}:${bound.port}${probing ? ' (temporary probe socket)' : ''}`
    : null
  // --port 0 is documented as "let the OS pick", so there is no configured number
  // to forward and telling the operator to open UDP 0 sends them nowhere.
  const listenPort = reachability.port === 0
    ? (bound ? `${bound.port} (ephemeral — pin it with MIRALL_RELAY_PORT)` : 'ephemeral')
    : String(reachability.port)

  const identityCard = key
    ? `
      <div class="key-block">
        <code class="key" id="public-key">${escapeHtml(key)}</code>
        <div class="key-actions">
          <button type="button" id="copy-key" data-key="${escapeHtml(key)}">Copy key</button>
          <a href="qr.svg" download="mirall-relay-key.svg">Download QR</a>
        </div>
      </div>
      <figure class="qr">${publicKeyQr(key)}<figcaption>Scan to read the key</figcaption></figure>`
    : '<p class="muted">No identity yet — the relay has not finished starting.</p>'

  const seedLine = identity.seedPath
    ? `Identity seed: <code>${escapeHtml(identity.seedPath)}</code>${identity.seedFrom === 'secret-file' ? ' (mounted secret)' : ''}. Back it up — losing it strands every client configured with this key.`
    : identity.seedFrom === 'env'
      ? 'Identity seed supplied through the environment. Keep the backup wherever that value is stored — losing it strands every client configured with this key.'
      : 'No seed configured.'

  // The whole reason OPERATIONS.md sends people to this line. "Where would it
  // look" reads identically whether the seed was found or invented; only this
  // says which happened, and it is the difference between a healthy relay and one
  // that is a single container replacement away from stranding every client.
  const seedWarning = identity.seedCreated
    ? `<p class="note warn">This identity was <strong>generated on this start</strong>, not read from an existing seed. If <code>${escapeHtml(identity.seedPath || 'the seed path')}</code> is not persistent storage, the key above changes the next time this process is replaced and every client you gave it to is stranded.</p>`
    : ''

  const noteList = notes(reachability)
  const steps = remediation(reachability, listenPort)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>mirall-relay</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="ui.css">
</head>
<body data-reachability="${escapeHtml(reachabilitySignature(reachability))}" data-access="${escapeHtml(accessSignature(access))}">
<header class="masthead">
  <div>
    <h1>mirall-relay</h1>
    <p class="sub">${plain(labels.region, 'no region')} · ${plain(labels.operator, 'no operator')} · v${plain(status.version)}</p>
  </div>
  <p class="pill ${current.tone}" id="verdict-pill" data-tone="${current.tone}">${escapeHtml(current.label)}</p>
</header>

<main>
  <section class="card identity">
    <h2>Relay public key</h2>
    <div class="identity-grid">${identityCard}</div>
    <p class="hint">Paste this into Mirall under <strong>Settings → Network → Add a relay</strong>. It is the only thing a client needs — there is no host, port, token or account.</p>
    ${seedWarning}
    <p class="muted">${seedLine}</p>
  </section>

  <section class="card reachability">
    <h2>Reachability</h2>
    <p class="verdict" id="verdict-sentence">${escapeHtml(current.sentence)}</p>
    ${noteList.map((note) => `<p class="note warn">${escapeHtml(note)}</p>`).join('')}
    ${steps.length ? `<ol class="steps">${steps.map((step) => `<li>${step}</li>`).join('')}</ol>` : ''}
    <dl class="facts">
      ${rows([
        ['UDP port', escapeHtml(listenPort)],
        ['Bind address', plain(reachability.bindHost)],
        ['Seen from outside as', plain(publicAddress)],
        ['Local socket', plain(localSocket)],
        ['DHT bootstrapped', field('reachability.bootstrapped', 'bool', reachability.bootstrapped)],
        ['In the DHT routing table', field('reachability.inRoutingTable', 'bool', reachability.inRoutingTable)],
        ['DHT nodes known', field('reachability.dhtNodes', 'count', reachability.dhtNodes)]
      ])}
    </dl>
  </section>

  <div class="columns">
    <section class="card">
      <h2>Traffic</h2>
      <dl class="facts">
        ${rows([
          ['Relayed', field('traffic.bytesRelayed', 'bytes', traffic.bytesRelayed)],
          ['Active links', field('traffic.linksActive', 'count', traffic.linksActive)],
          ['Links opened', field('traffic.linksOpened', 'count', traffic.linksOpened)],
          ['Pairings matched', field('traffic.pairings.matched', 'count', traffic.pairings ? traffic.pairings.matched : 0)],
          ['Sessions accepted', field('traffic.sessionsAccepted', 'count', traffic.sessionsAccepted)],
          ['Sessions refused', field('traffic.sessionsRejectedTotal', 'count', traffic.sessionsRejectedTotal)],
          ['Links torn by a cap', field('traffic.linksTornByCapTotal', 'count', traffic.linksTornByCapTotal)],
          ['Uptime', field('uptimeSeconds', 'duration', status.uptimeSeconds)]
        ])}
      </dl>
      <p class="hint">Every relayed byte enters and leaves this host once. This counter is your egress bill.</p>
    </section>

    <section class="card">
      <h2>Limits</h2>
      <dl class="facts">
        ${rows([
          ['Sessions per peer key', escapeHtml(formatCount(caps.maxSessionsPerKey))],
          ['Active links', escapeHtml(formatCount(caps.maxActiveLinks))],
          ['Bytes per link, per direction', escapeHtml(formatBytes(caps.maxLinkBytes))],
          ['Rate per link, per direction', escapeHtml(formatRate(caps.maxLinkRateBytesPerSecond))],
          ['Maximum link duration', escapeHtml(formatMs(caps.maxLinkDurationMs))]
        ])}
      </dl>
      <p class="hint">Byte and rate caps apply per direction: a relayed connection is two bridged streams and each counts only what enters it.</p>
    </section>
  </div>

  <section class="card access">
    <h2>Who may connect</h2>
    <p class="verdict">${escapeHtml(accessSentence(access))}</p>
    ${accessWarning(access)}
    ${manageHint(access)}
    <dl class="facts">
      ${rows(accessRows(access))}
    </dl>
    <p class="hint">A refused peer cannot tell a closed door from an offline relay — its handshake simply fails. This counter is the only place that difference is visible, so a friend who cannot connect shows up here. A small number is normal on an invite relay and is not a signal: a member's own Mirall can hand this relay's key to their peers, who are then refused having never been given an invite.</p>
  </section>

  <section class="card privacy">
    <h2>What this relay can and cannot see</h2>
    <p>${escapeHtml(status.privacy)}</p>
    <p class="muted">It does see, unavoidably, what any middlebox sees: the IP addresses of both peers, that they are talking to each other, when, and how many bytes cross.</p>
  </section>
</main>

<footer>
  <a href="status.json">status.json</a>
  <a href="readyz">readyz</a>
  <a href="metrics">metrics</a>
  <a href=".well-known/mirall-relay.json">capability doc</a>
</footer>

<script type="module" src="ui.js"></script>
</body>
</html>
`
}
