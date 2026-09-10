// The rendered page. Every assertion here is about something an operator has to
// be able to read off the screen without a terminal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAssets, uiPaths, escapeHtml, renderPage, publicKeyQr, standaloneQr, verdict } from '../../src/operator/status/page.js'

const KEY = 'yb3dq6h9c1x8kwmp4z7ejr5tn9adg2hf6bcxsq8vw3ymp4z7ejab'

function status (overrides = {}) {
  const base = {
    service: 'mirall-relay',
    version: '0.1.0',
    ready: true,
    startedAt: new Date().toISOString(),
    uptimeSeconds: 11520,
    labels: { region: 'eu-fsn1', operator: 'example' },
    identity: { publicKey: KEY, seedFrom: 'file', seedPath: '/data/seed', seedCreated: false },
    reachability: {
      state: 'reachable',
      firewalled: false,
      probed: true,
      port: 49737,
      bindHost: '0.0.0.0',
      publicHost: '203.0.113.9',
      publicPort: 49737,
      portRandomized: false,
      bootstrapped: true,
      ephemeral: false,
      ephemeralConfigured: false,
      inRoutingTable: true,
      dhtNodes: 128,
      bound: { host: '0.0.0.0', port: 49737, family: 4 }
    },
    traffic: {
      bytesRelayed: 1536 * 1024 * 1024,
      linksActive: 2,
      linksOpened: 41,
      linksTornByCap: {},
      linksTornByCapTotal: 0,
      sessionsAccepted: 19,
      sessionsRejected: {},
      sessionsRejectedTotal: 0,
      pairings: { requested: 20, matched: 20, cancelled: 0, pending: 0, active: 1 },
      sessions: { accepted: 19, active: 2 }
    },
    caps: {
      maxSessionsPerKey: 64,
      maxActiveLinks: 2000,
      maxLinkBytes: 512 * 1024 * 1024,
      maxLinkRateBytesPerSecond: 4 * 1024 * 1024,
      maxLinkDurationMs: 3600000
    },
    access: { mode: 'open', allowlisted: null, banned: 0, members: null, refusedLastHour: 0, managed: true },
    privacy: 'This relay bridges end-to-end-encrypted streams.'
  }
  return {
    ...base,
    ...overrides,
    reachability: { ...base.reachability, ...(overrides.reachability || {}) },
    identity: { ...base.identity, ...(overrides.identity || {}) }
  }
}

test('the public key is in the markup, so the page works with JavaScript off', () => {
  const html = renderPage(status())
  assert.ok(html.includes(KEY), 'the key must be readable from view-source and from curl')
  assert.match(html, /Settings → Network/, 'and the page must say what to do with it')
  assert.match(html, /id="copy-key"/)
})

test('the counters are in the markup too, not fetched in', () => {
  const html = renderPage(status())
  assert.match(html, />1\.5 GiB</, 'relayed bytes, formatted')
  assert.match(html, />3h 12m</, 'uptime, formatted')
  assert.match(html, />512 MiB</, 'the byte cap in the units it was configured in')
  assert.match(html, />4 MiB\/s</)
})

test('the seed path is shown and the seed itself never is', () => {
  const html = renderPage(status())
  assert.match(html, /Identity seed: <code>\/data\/seed<\/code>/)
  assert.match(html, /Back it up/)

  const fromEnv = renderPage(status({ identity: { seedFrom: 'env', seedPath: null } }))
  assert.match(fromEnv, /supplied through the environment/)
  assert.ok(!fromEnv.includes('<code>null</code>'))
})

test('each reachability state gets its own verdict', () => {
  const cases = [
    [{ state: 'reachable', probed: true }, 'good', /can hole-punch/],
    [{ state: 'reachable', probed: false }, 'warn', /asserted rather than measured/],
    [{ state: 'firewalled', probed: true }, 'bad', /could not reach it/],
    [{ state: 'starting', probed: true }, 'idle', /bootstrapping/],
    [{ state: 'stopped', probed: true }, 'idle', /shutting down/],
    [{ state: 'unknown', probed: true }, 'idle', /has not reported/]
  ]
  for (const [reachability, tone, sentence] of cases) {
    assert.equal(verdict(reachability).tone, tone, `tone for ${reachability.state}`)
    const html = renderPage(status({ reachability }))
    assert.match(html, new RegExp(`class="pill ${tone}"`))
    assert.match(html, sentence)
    assert.match(html, new RegExp(`data-reachability="${reachability.state}\\|`))
  }
})

test('the remediation list appears only when the relay is actually unreachable', () => {
  assert.ok(!renderPage(status()).includes('class="steps"'))

  const html = renderPage(status({ reachability: { state: 'firewalled', firewalled: true } }))
  assert.match(html, /class="steps"/)
  assert.match(html, /UDP 49737<\/strong>/, 'name the port they have to forward')
  assert.match(html, /scripts\/probe\.js/, 'and how to confirm the fix from outside')
  assert.match(html, /CGNAT/, 'including the case where there is no port to forward')
})

test('the symmetric-NAT note stands on its own, not on the firewall verdict', () => {
  // A symmetric NAT reports firewalled: false and is still useless, so this note
  // has to survive a green verdict.
  const green = renderPage(status({ reachability: { portRandomized: true } }))
  assert.match(green, /symmetric NAT/)
  assert.match(green, /class="pill good"/)

  const red = renderPage(status({ reachability: { state: 'firewalled', portRandomized: true } }))
  assert.match(red, /symmetric NAT/)
})

test('the ephemeral note blames the operator only when the operator did it', () => {
  // hyperdht's adaptive mode keeps a FIREWALLED node ephemeral no matter what the
  // config says. Telling someone to unset a variable they never set sends them
  // hunting for a mistake they did not make — which is what this page exists to
  // prevent, not to cause.
  const consequence = renderPage(status({
    reachability: { state: 'firewalled', ephemeral: true, inRoutingTable: false, ephemeralConfigured: false }
  }))
  assert.ok(!consequence.includes('MIRALL_RELAY_EPHEMERAL'), 'not their doing, not their note')
  assert.match(consequence, /In the DHT routing table<\/dt><dd><span[^>]*>no</, 'but the fact is still shown')

  const configured = renderPage(status({
    reachability: { ephemeral: true, inRoutingTable: false, ephemeralConfigured: true }
  }))
  assert.match(configured, /MIRALL_RELAY_EPHEMERAL is set/)
})

test('operator-supplied labels cannot break out of the markup', () => {
  // region and operator arrive from the environment and are already treated as
  // arbitrary text by Prometheus. They reach the page the same way.
  const hostile = '</style><script>alert(1)</script>'
  const html = renderPage(status({ labels: { region: hostile, operator: '"><img src=x onerror=1>' } }))
  assert.ok(!html.includes('<script>'), 'no injected script element')
  assert.ok(!html.includes('<img'), 'no injected image element')
  assert.match(html, /&lt;script&gt;/, 'the label is still shown, as text')
  assert.match(html, /&quot;&gt;&lt;img/)
})

test('a hostile seed path is escaped as well', () => {
  const html = renderPage(status({ identity: { seedPath: '/data/<img src=x onerror=1>' } }))
  assert.ok(!html.includes('<img'))
})

test('escapeHtml covers the five characters that matter', () => {
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;')
  assert.equal(escapeHtml(42), '42')
})

test('a relay with no identity yet still renders a page', () => {
  const html = renderPage(status({ identity: { publicKey: null, seedFrom: 'none', seedPath: null }, reachability: { state: 'starting' } }))
  assert.match(html, /has not finished starting/)
  assert.ok(!html.includes('id="copy-key"'))
})

test('the QR is inline SVG, so the page needs no image request to show the key', () => {
  const html = renderPage(status())
  assert.match(html, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.ok(html.includes(publicKeyQr(KEY)))
})

test('the QR is black on white in both themes, because scanners are not themed', () => {
  const svg = publicKeyQr(KEY)
  assert.match(svg, /fill="#ffffff"/)
  assert.match(svg, /fill="#000000"/)
  assert.ok(!svg.includes('currentColor'))
})

test('the standalone QR is a file you can save', () => {
  const svg = standaloneQr(KEY)
  assert.match(svg, /^<\?xml/)
  assert.match(svg, /width="\d+" height="\d+"/)
})

test('every asset loads and carries a stable ETag', () => {
  const assets = loadAssets()
  for (const path of ['/ui.css', '/ui.js', '/format.js', '/copy-button.js']) {
    const asset = assets.get(path)
    assert.ok(asset, `${path} must be served`)
    assert.ok(asset.body.length > 0)
    assert.match(asset.etag, /^"[A-Za-z0-9_-]{27}"$/)
  }
  assert.notEqual(assets.get('/ui.js').etag, assets.get('/format.js').etag)
  for (const path of assets.keys()) assert.ok(uiPaths.has(path), `${path} must be covered by the Host guard`)
})

test('the page loads no external resource, so default-src none holds', () => {
  const html = renderPage(status())
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'the only absolute URL allowed is the SVG namespace')
  assert.ok(!html.includes('<script>'), 'no inline script')
  assert.ok(!html.includes('<style'), 'no inline style')
  assert.ok(!/\sstyle="/.test(html), 'no style attributes either')
})

test('the QR is encoded once per identity, not once per request', () => {
  const first = publicKeyQr(KEY)
  assert.equal(publicKeyQr(KEY), first)
  const other = 'z'.repeat(52)
  assert.notEqual(publicKeyQr(other), first, 'a different key still gets its own square')
  assert.equal(publicKeyQr(KEY), first, 'and switching back does not return the wrong one')
})

test('a firewalled relay is never told its probe port is its public port', () => {
  // dht-rpc reports the ephemeral CLIENT socket while firewalled, so the observed
  // port is random. The README carries a "Not a bug" note about this confusion in
  // the startup log; the page must not recreate it.
  const html = renderPage(status({
    reachability: { state: 'firewalled', firewalled: true, publicPort: 54949, bound: { host: '0.0.0.0', port: 54949, family: 4 } }
  }))
  assert.match(html, /Seen from outside as<\/dt><dd>203\.0\.113\.9</, 'host only')
  assert.ok(!html.includes('203.0.113.9:54949'))
  assert.match(html, /temporary probe socket/)
})

test('a symmetric NAT is never shown the configured port as if it were observed', () => {
  // dht-rpc sets randomized when the sampler sees a stable host and a MOVING port,
  // so dht.port is 0 and publicPort arrives null while state stays 'reachable'.
  // Falling back to cfg.port prints the one number the NAT is definitely not
  // using, directly above the note saying the port is not stable.
  const html = renderPage(status({
    reachability: { publicPort: null, portRandomized: true }
  }))
  assert.match(html, /Seen from outside as<\/dt><dd>203\.0\.113\.9</)
  assert.ok(!html.includes('203.0.113.9:49737'), 'the configured port is not an observation')
  assert.match(html, /symmetric NAT/)
})

test('a reachable relay shows the full observed address', () => {
  const html = renderPage(status())
  assert.match(html, /203\.0\.113\.9:49737/)
  assert.ok(!html.includes('temporary probe socket'))
})

test('the local socket row uses the key udx actually returns', () => {
  // udx's socket.address() is { host, family, port }, not Node's { address, ... }.
  const html = renderPage(status())
  assert.match(html, /Local socket<\/dt><dd>0\.0\.0\.0:49737</)
  assert.ok(!html.includes('undefined:'))
})

test('--port 0 does not produce "forward UDP 0"', () => {
  // bin/mirall-relay.js documents --port 0 as "let the OS pick", and config.js
  // validates it, so the page has to cope: port 0 is not a number to forward.
  const html = renderPage(status({
    reachability: { state: 'firewalled', firewalled: true, port: 0, bound: { host: '0.0.0.0', port: 54949, family: 4 } }
  }))
  assert.ok(!/UDP <strong>0<\/strong>/.test(html))
  assert.ok(!/UDP port<\/dt><dd>0</.test(html))
  assert.match(html, /ephemeral — pin it with MIRALL_RELAY_PORT/)
})

test('a freshly minted identity is called out as such', () => {
  // The whole reason OPERATIONS.md sends operators to the seed line: "where would
  // it look" reads identically whether the seed was found or invented.
  const persisted = renderPage(status())
  assert.ok(!persisted.includes('generated on this start'))

  const minted = renderPage(status({ identity: { seedCreated: true } }))
  assert.match(minted, /generated on this start/)
  assert.match(minted, /not persistent storage/)
  assert.match(minted, /class="note warn"/)
})

test('the remediation list does not point at documentation that does not exist', () => {
  const html = renderPage(status({ reachability: { state: 'firewalled', firewalled: true } }))
  assert.match(html, /CGNAT/, 'the case still has to be covered')
  assert.ok(!html.includes('StartTunnel'), 'but not by a pointer to a section nobody wrote')
  assert.ok(!/see the .* in the README/.test(html))
})

test('the page always answers "how do I add a member", not only when empty', () => {
  // The invite-management route must stay visible after the first member exists.
  const empty = renderPage(status({ access: { mode: 'invite', members: { active: 0, total: 0 }, allowlisted: 0, banned: 0, managed: true } }))
  assert.match(empty, /href="admin\/"/, 'the empty case points at the admin page')
  assert.match(empty, /invite create/, 'and at the CLI')

  const populated = renderPage(status({ access: { mode: 'invite', members: { active: 3, total: 3 }, allowlisted: 3, banned: 0, managed: true } }))
  assert.match(populated, /href="admin\/"/, 'and so does a relay that already has members')
  assert.match(populated, /invite create/)
})

test('the page does not offer an admin link that is turned off', () => {
  const off = renderPage(status({ access: { mode: 'invite', members: { active: 1, total: 1 }, allowlisted: 1, banned: 0, managed: false } }))
  assert.ok(!off.includes('href="admin/"'), 'MIRALL_RELAY_ADMIN_WRITE=false means there is no page to link to')
  assert.match(off, /invite create/, 'but the CLI still works and is still named')
  assert.match(off, /MIRALL_RELAY_ADMIN_WRITE/, 'and the page says why the link is missing')
})

test('an open relay is not told to manage members it does not gate', () => {
  const open = renderPage(status())
  assert.ok(!open.includes('href="admin/"'))
  assert.ok(!open.includes('invite create'))
})
