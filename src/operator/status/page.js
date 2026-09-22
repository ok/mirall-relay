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
import { assetPath, readAssets } from '../assets.js'
import { encodeQr, qrSvg } from '../../qr.js'
import { formatBytes, formatCount, formatField, formatMs, formatRate } from '../format.js'
import { accessSignature, reachabilitySignature } from './refresh.client.js'
import { modePill, modeWord, reachabilityPill } from '../access-copy.js'
import { escapeHtml, FAVICON_LINK, plain } from '../html.js'

export { etagFor } from '../assets.js'

const ASSETS = {
  '/ui.css': [assetPath('status', 'status.css'), 'text/css; charset=utf-8'],
  '/ui.js': [assetPath('status', 'refresh.client.js'), 'text/javascript; charset=utf-8'],
  '/format.js': [assetPath('format.js'), 'text/javascript; charset=utf-8'],
  '/copy-button.js': [assetPath('copy-button.js'), 'text/javascript; charset=utf-8'],
  '/icon.png': [assetPath('icon.png'), 'image/png']
}

// Every path the browser surface owns — the set the Host guard covers, and the
// set MIRALL_RELAY_ADMIN_UI=false turns off.
export const uiPaths = new Set(['/', '/status.json', '/qr.svg', ...Object.keys(ASSETS)])

// Read on first use, not at import. Optional browser assets must not become a
// hard boot dependency for the CLI or relay process.
let assetCache = null
export function loadAssets () {
  if (!assetCache) {
    assetCache = readAssets(ASSETS)
  }
  return assetCache
}

export { escapeHtml }

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

const SENTENCES = {
  reachable: 'Peers on the open internet can connect to this relay directly.',
  assumed: 'MIRALL_RELAY_ASSUME_REACHABLE is set, so reachability was asserted rather than measured. Confirm it from another machine before publishing the key.',
  firewalled: 'HyperDHT probed this node from the outside and could not reach it. Clients cannot use this relay until the UDP port is open.',
  'port-unstable': 'Peers can reach this relay, but something between it and the internet rewrites its outbound UDP port, so the DHT cannot advertise a stable address. Peers cannot connect to it directly, and most cannot hole-punch to it either.',
  starting: 'Still bootstrapping onto the DHT.',
  stopped: 'The relay is shutting down. In-flight relayed connections are dropping.',
  unknown: 'The DHT has not settled on this relay’s public address yet. That is normal for a few minutes after startup or a network change; until it settles, peers cannot connect directly.'
}

export function verdict (reachability) {
  const pill = reachabilityPill(reachability)
  return { label: pill.text, tone: pill.tone, sentence: SENTENCES[pill.key] }
}

function notes (reachability) {
  const out = []
  const bound = reachability.bound
  if (reachability.portRandomized) {
    out.push('The DHT sees this relay on a different external port for each destination, as behind a symmetric NAT, so there is no single address to give peers.')
  } else if (reachability.state === 'port-unstable' && reachability.publicPort && bound && reachability.publicPort !== bound.port) {
    out.push(
      `Peers see this relay on port ${reachability.publicPort}, but it listens on port ${bound.port}. ` +
      'Something between the relay and the internet rewrites its outbound port.'
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

const CONFIRM_STEP = 'Confirm from a <em>different</em> machine: <code>node scripts/probe.js --relay &lt;public-key&gt;</code>'

function remediation (reachability, listenPort) {
  const port = escapeHtml(listenPort)
  if (reachability.state === 'port-unstable') {
    return [
      `If a NAT, VPN or tunnel sits between this host and the internet, it must keep the source port of UDP ${port} unchanged. If it cannot, run the relay where it has a public IP, or forward on a NAT that preserves ports.`,
      `After a network or container change, stale connection-tracking state on the host can keep rewriting the port. Restart the relay; if this persists for more than a few minutes, run <code>conntrack -D -p udp --orig-port-src ${escapeHtml(reachability.bound ? reachability.bound.port : reachability.port)}</code> on the host (for a container, <code>conntrack -D -p udp -s &lt;container IP&gt;</code>).`,
      'On Docker use <code>network_mode: host</code>. Publishing the port with <code>-p …/udp</code> puts Docker’s NAT in the outbound path.',
      CONFIRM_STEP
    ]
  }
  if (reachability.state !== 'firewalled') return []
  return [
    `Open and forward <strong>UDP ${escapeHtml(listenPort)}</strong> to this host, in both directions. UDP, not TCP.`,
    'Check the host firewall, and on a cloud host the security group.',
    'On Docker prefer <code>network_mode: host</code>; a published port can have its external mapping rewritten by the userland proxy.',
    'If your ISP puts you behind CGNAT there is no port to forward at all. A relay then needs a rented public address tunnelled back to this host; check whether your ISP will sell you a public IPv4.',
    CONFIRM_STEP
  ]
}

function field (path, format, value) {
  return `<span data-field="${escapeHtml(path)}" data-format="${escapeHtml(format)}">${escapeHtml(formatField(value, format))}</span>`
}

function rows (entries) {
  return entries.map(([label, value]) => `<div class="row"><dt>${label}</dt><dd>${value}</dd></div>`).join('')
}

// The four answers someone revisiting their own relay actually came for: is it
// being used, what is it costing, who may use it, and how long has it been up.
// Everything here is already in the snapshot, and each value keeps its data-field
// so refresh.client.js patches it in place like any other number.
function tiles (status, access) {
  const out = [
    ['traffic.linksActive', 'count', status.traffic.linksActive, 'live links'],
    // bytesRelayed is a process counter and resets on restart, so it is never
    // labelled as a lifetime total — this number is somebody's egress bill.
    ['traffic.bytesRelayed', 'bytes', status.traffic.bytesRelayed, 'relayed this run']
  ]

  // On an open relay a member count is meaningless: nothing gates on it.
  out.push(access.mode === 'invite' && access.members
    ? ['access.members.active', 'count', access.members.active, 'members']
    : ['traffic.sessionsAccepted', 'count', status.traffic.sessionsAccepted, 'sessions accepted'])

  out.push(['uptimeSeconds', 'duration', status.uptimeSeconds, 'uptime'])

  return out.map(([path, format, value, label]) =>
    `<div class="tile"><dt class="tile-label">${label}</dt><dd class="tile-value">${field(path, format, value)}</dd></div>`
  ).join('')
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

function privateHint (access) {
  if (access.mode !== 'open') return ''
  return '<p class="hint">To make this relay private, switch its access to Private (<code>MIRALL_RELAY_ACCESS=invite</code>). Members can be added before or after.</p>'
}

function manageSentence (access) {
  const cli = 'Or run <code>mirall-relay invite create &lt;label&gt;</code>.'
  return access.managed === false
    ? 'Add a member with <code>mirall-relay invite create &lt;label&gt;</code>, then send them the invite line. The members page is off (<code>MIRALL_RELAY_ADMIN_WRITE=false</code>).'
    : `Add and revoke members on the <a href="admin/">members page</a>. ${cli}`
}

// The members page exists only under MIRALL_RELAY_ADMIN_WRITE, so the link is
// left out rather than offered as a 404.
function pageNav (access) {
  const members = access.managed === false ? '' : '<a href="admin/">Members</a>'
  return `<nav class="pages" aria-label="Pages"><a href="./" aria-current="page">Status</a>${members}</nav>`
}

function accessRows (access) {
  const out = [['Mode', `${escapeHtml(modeWord(access))} <span class="muted">(${escapeHtml(access.mode)})</span>`]]
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

// On a private relay the key alone gets a client refused, and a refusal looks
// like an offline relay, so the card must not encourage handing out the key.
function identitySection (access, key, seedWarning, seedLine) {
  const shareable = access.mode === 'open'
  const keyBlock = key
    ? `
      <div class="key-block">
        <code class="key" id="public-key">${escapeHtml(key)}</code>
        <div class="key-actions">
          <button type="button" id="copy-key" data-key="${escapeHtml(key)}">Copy key</button>
          ${shareable ? '<a href="qr.svg" download="mirall-relay-key.svg">Download QR</a>' : ''}
        </div>
      </div>
      ${shareable ? `<figure class="qr">${publicKeyQr(key)}<figcaption>Scan to read the key</figcaption></figure>` : ''}`
    : '<p class="muted">No identity yet — the relay has not finished starting.</p>'

  return `<section class="card identity">
    <h2>${access.mode === 'invite' ? 'Invite people' : 'Relay public key'}</h2>
    ${identityLead(access)}
    <div class="identity-grid">${keyBlock}</div>
    ${identityHint(access)}
    ${seedWarning}
    <p class="muted">${seedLine}</p>
  </section>`
}

function identityLead (access) {
  if (access.mode !== 'invite') return ''
  // An empty roster already gets this sentence, loudly, in the access card.
  const manage = access.members && access.members.active > 0 ? `<p class="hint">${manageSentence(access)}</p>` : ''
  return `<p class="verdict">This relay is private. The key alone will not get anyone in — each person needs their own invite.</p>${manage}`
}

function identityHint (access) {
  if (access.mode === 'invite') {
    return '<p class="hint">This key identifies the relay. It is safe to publish, and is not enough to connect.</p>'
  }
  if (access.mode === 'allowlist') {
    return '<p class="hint">Only the static <code>MIRALL_RELAY_ALLOWLIST</code> keys can connect. Anyone else who pastes this key into Mirall is refused.</p>'
  }
  return '<p class="hint">Paste this into Mirall under <strong>Settings → Network → Add a relay</strong>. It is the only thing a client needs — there is no host, port, token or account.</p>'
}

// The headline names the mode only. The member count has its own tile, so it is
// repeated here just for the one case that changes what the relay does.
function heroMode (access, mode) {
  return mode.tone === 'warn' ? mode.text : `${modeWord(access)} relay`
}

export function renderPage (status) {
  const { identity, reachability, traffic, caps, access, labels } = status
  const key = identity.publicKey
  const current = verdict(reachability)
  const mode = modePill(access)
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
  // A NAT that rewrites the port consistently shows the rewritten port instead,
  // which is the truth, under the note that explains it.
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
<title>Mirall Relay</title>
${FAVICON_LINK}
<link rel="stylesheet" href="ui.css">
</head>
<body data-reachability="${escapeHtml(reachabilitySignature(reachability))}" data-access="${escapeHtml(accessSignature(access))}">
<header class="masthead">
  <div>
    <h1>Mirall Relay</h1>
    ${pageNav(access)}
  </div>
  <div class="pills">
    <p class="pill ${current.tone}" id="verdict-pill" data-tone="${current.tone}">${escapeHtml(current.label)}</p>
    <p class="pill ${mode.tone}" id="mode-pill">${escapeHtml(mode.text)}</p>
  </div>
</header>

<main>
  <section class="card hero ${current.tone}">
    <h2 class="visually-hidden">Summary</h2>
    <div class="hero-head">
      <p class="hero-verdict" id="verdict-sentence-label">${escapeHtml(current.label)}</p>
      <p class="hero-mode ${mode.tone}">${escapeHtml(heroMode(access, mode))}</p>
    </div>
    <p class="hero-sentence" id="verdict-sentence">${escapeHtml(current.sentence)}</p>
    <dl class="tiles">${tiles(status, access)}</dl>
  </section>

  ${identitySection(access, key, seedWarning, seedLine)}

  <section class="card reachability">
    <h2>Reachability</h2>
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
    ${privateHint(access)}
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
  <div class="footer-links">
    <a href="status.json">status.json</a>
    <a href="readyz">readyz</a>
    <a href="metrics">metrics</a>
    <a href=".well-known/mirall-relay.json">capability doc</a>
  </div>
  <p class="footer-meta">${plain(labels.region, 'no region')} · ${plain(labels.operator, 'no operator')} · v${plain(status.version)}</p>
</footer>

<script type="module" src="ui.js"></script>
</body>
</html>
`
}
