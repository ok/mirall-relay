// The rendered page. Every assertion here is about something an operator has to
// be able to read off the screen without a terminal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAssets, uiPaths, escapeHtml, renderPage, publicKeyQr, standaloneQr, verdict } from '../../src/operator/status/page.js'

import { statusFixture as status, KEY } from '../helpers/status-fixture.js'

test('the public key is in the markup, so the page works with JavaScript off', () => {
  const html = renderPage(status())
  assert.ok(html.includes(KEY), 'the key must be readable from view-source and from curl')
  assert.match(html, /Settings → Network/, 'and the page must say what to do with it')
  assert.match(html, /id="copy-key"/)
})

test('the page leads with a summary, not with setup', () => {
  const html = renderPage(status())
  const hero = html.indexOf('class="card hero')
  assert.ok(hero !== -1, 'there is a hero card')
  assert.ok(hero < html.indexOf('class="card identity"'), 'and it comes before the key card')

  // The verdict is the headline: a relay that is not reachable is doing nothing.
  assert.match(html, /class="card hero good"/)
  assert.match(html, /<p class="hero-verdict"[^>]*>Reachable<\/p>/)

  // Every tile is a live field, so the refresher patches it like any other number.
  for (const path of ['traffic.linksActive', 'traffic.bytesRelayed', 'uptimeSeconds']) {
    assert.match(html, new RegExp(`class="tile-value"><span data-field="${path.replace('.', '\\.')}"`))
  }
})

test('the headline counts what the relay actually gates on', () => {
  // An open relay gates on nothing, so a member count there would be a number
  // that means nothing; it gets throughput instead.
  const open = renderPage(status())
  assert.match(open, /<dt class="tile-label">sessions accepted<\/dt>/)
  assert.ok(!open.includes('>members<'))

  const invite = renderPage(status({ access: { mode: 'invite', members: { active: 2, total: 3 }, allowlisted: 0, banned: 0, refusedLastHour: 0, managed: true } }))
  assert.match(invite, /<dt class="tile-label">members<\/dt>/)
  assert.match(invite, /data-field="access\.members\.active"[^>]*>2</)
})

test('the relayed total never claims to be a lifetime figure', () => {
  // It is a process counter and resets on restart, and it is somebody's egress
  // bill — overstating it is the worst way to be wrong on this page.
  const html = renderPage(status())
  assert.match(html, /<dt class="tile-label">relayed this run<\/dt>/)
})

test('the verdict is stated once, not in every card', () => {
  const html = renderPage(status({ reachability: { state: 'firewalled', firewalled: true } }))
  assert.equal(html.split('could not reach it').length - 1, 1, 'the sentence appears once')
  // The reachability card keeps the detail an operator acts on.
  assert.match(html, /class="steps"/)
  assert.match(html, /DHT nodes known/)
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
  // The nav offers the members page on every relay that has one; what an open
  // relay must not get is the advice to go there and add a member, because on an
  // open relay an invite gates nothing.
  const body = renderPage(status()).split('<main>')[1]
  assert.ok(!body.includes('href="admin/"'))
  assert.ok(!body.includes('invite create'))
})

test('the masthead carries the same two-page nav the members page does', () => {
  const html = renderPage(status())
  assert.match(html, /<nav class="pages"/)
  assert.match(html, /aria-current="page">Status</)
  assert.match(html, /<a href="admin\/">Members<\/a>/)

  // Nothing about the nav may depend on JavaScript: the whole page has to be
  // complete on first render.
  assert.ok(!html.includes('<script>'), 'no inline script')
  const off = renderPage(status({ access: { mode: 'open', allowlisted: null, banned: 0, members: null, refusedLastHour: 0, managed: false } }))
  assert.ok(!off.includes('>Members<'), 'and it is not offered when there is no members page')
})

const INVITE = (active, managed = true) => ({ mode: 'invite', members: { active, total: active }, allowlisted: active, banned: 0, refusedLastHour: 0, managed })
const ALLOWLIST = { mode: 'allowlist', allowlisted: 2, banned: 0, members: null, refusedLastHour: 0, managed: true }

test('the hero names the mode, in every mode', () => {
  assert.match(renderPage(status()), /id="mode-pill">Public relay</)
  assert.match(renderPage(status({ access: INVITE(2) })), /class="pill good" id="mode-pill">Private relay · 2 members</)
  assert.match(renderPage(status({ access: INVITE(0) })), /class="pill warn" id="mode-pill">Private relay · no members</)
  assert.match(renderPage(status({ access: ALLOWLIST })), /id="mode-pill">Restricted · 2 static keys</)
})

test('a private relay never says the key is all a client needs', () => {
  // On a private relay a key-only client is refused, and a refusal looks exactly
  // like an offline relay.
  const html = renderPage(status({ access: INVITE(2) }))
  assert.ok(!html.includes('the only thing a client needs'))
  assert.match(html, /<h2>Invite people<\/h2>/)
  assert.match(html, /key alone will not get anyone in/)
})

test('a private relay offers no QR of a key that cannot connect anyone', () => {
  const html = renderPage(status({ access: INVITE(2) }))
  assert.ok(!html.includes('<figure class="qr">'))
  assert.ok(!html.includes('href="qr.svg"'))
  assert.ok(html.includes(KEY), 'the key still identifies the relay')
  assert.match(html, /id="copy-key"/)
})

test('a public relay keeps the key card exactly as it was', () => {
  const html = renderPage(status())
  assert.match(html, /<h2>Relay public key<\/h2>/)
  assert.match(html, /<figure class="qr">/)
  assert.match(html, /href="qr\.svg"/)
  assert.match(html, /the only thing a client needs/)
})

test('an allowlist relay says who the key works for, and drops the QR', () => {
  const html = renderPage(status({ access: ALLOWLIST }))
  assert.match(html, /MIRALL_RELAY_ALLOWLIST/)
  assert.ok(!html.includes('the only thing a client needs'))
  assert.ok(!html.includes('<figure class="qr">'))
})

test('the add-members route is stated once on a private relay', () => {
  const html = renderPage(status({ access: INVITE(3) }))
  assert.equal(html.split('members page</a>').length - 1, 1)
})

test('an empty private relay is loud in the access card and still offers the way out', () => {
  const html = renderPage(status({ access: INVITE(0) }))
  assert.match(html, /refusing everyone/)
  assert.match(html, /href="admin\/"/)
})

test('a private relay with the members page off points at the CLI in the key card', () => {
  const html = renderPage(status({ access: INVITE(1, false) }))
  const card = html.slice(html.indexOf('class="card identity"'), html.indexOf('class="card reachability"'))
  assert.match(card, /invite create/)
  assert.ok(!card.includes('href="admin/"'))
})

test('a public relay is told how to go private, with no precondition', () => {
  const body = renderPage(status()).split('<main>')[1]
  assert.match(body, /MIRALL_RELAY_ACCESS=invite/)
  assert.match(body, /before or after/)
})

test('the mode row carries the operator word beside the config value', () => {
  assert.match(renderPage(status()), /Public <span class="muted">\(open\)<\/span>/)
  assert.match(renderPage(status({ access: INVITE(1) })), /Private <span class="muted">\(invite\)<\/span>/)
})
