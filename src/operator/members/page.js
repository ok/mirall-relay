// The authenticated management page: the browser half of /admin/*.
//
// WHY IT EXISTS: minting an invite was CLI-only, and the operators this relay is
// aimed at run it on StartOS or Umbrel where there is no shell at all. They could
// read a member COUNT off the anonymous page and had no way to add a member.
//
// WHY IT IS A SEPARATE PAGE. The anonymous status page is unauthenticated by
// design and must stay that way — it shows numbers, never names or secrets. This
// one shows labels and tickets, so it lives behind the bearer token, under the
// same /admin/ prefix the Host guard and MIRALL_RELAY_ADMIN_WRITE already cover.
//
// THE SHELL ITSELF CARRIES NO DATA. It is static markup with empty slots: every
// label, key and ticket arrives over an authenticated fetch, and the shell is what
// ASKS for the token in the first place. That is why these three files are served
// without one — a <link> and a <script src> cannot send an Authorization header,
// so requiring it here would mean no page could ever load to collect it.
import { assetPath, etagFor, readAssets } from '../assets.js'
import { FAVICON_LINK, plain } from '../html.js'

// Independent of ui.css on purpose: MIRALL_RELAY_ADMIN_UI=false turns the
// anonymous page off, and it must not take the only way to mint an invite with it.
const ASSETS = {
  '/admin/style.css': [assetPath('members', 'members.css'), 'text/css; charset=utf-8'],
  '/admin/app.js': [assetPath('members', 'members.client.js'), 'text/javascript; charset=utf-8'],
  // The same file the status page serves at /copy-button.js. Served here too
  // rather than shared by URL, because /copy-button.js is a ui path and
  // MIRALL_RELAY_ADMIN_UI=false takes it away.
  '/admin/copy-button.js': [assetPath('copy-button.js'), 'text/javascript; charset=utf-8'],
  // Shared with the status page's server render, so both pages name the mode alike.
  '/admin/access-copy.js': [assetPath('access-copy.js'), 'text/javascript; charset=utf-8'],
  '/admin/icon.png': [assetPath('icon.png'), 'image/png']
}

export const PAGE_PATH = '/admin/'

let cache = null

// Read on first use, not at import — same reason as the status page: a packaging step
// that ships only src/*.js must degrade to a 404 on one route, not stop the relay.
export function managePaths (site = {}) {
  if (cache) return cache
  cache = readAssets(ASSETS)
  const html = renderManagePage(site)
  cache.set(PAGE_PATH, { body: Buffer.from(html), type: 'text/html; charset=utf-8', etag: etagFor(html) })
  return cache
}

// `site` carries only what the anonymous status page already publishes — region,
// operator, version — so the two footers can match. Nothing about a member is in
// here: those are the values this page is served without a token to protect.
// Everything else is static, and the client builds every dynamic node with
// textContent.
export function renderManagePage ({ region = null, operator = null, version = null, statusPage = true } = {}) {
  // /, /status.json and the status assets go away under MIRALL_RELAY_ADMIN_UI=false;
  // /readyz, /metrics and the capability doc survive it. Do not link what is off.
  const statusLink = statusPage ? '<a href="../">Status</a>' : ''
  const statusJson = statusPage ? '<a href="../status.json">status.json</a>' : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>Mirall Relay members</title>
${FAVICON_LINK}
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="masthead">
  <div>
    <h1>Mirall Relay</h1>
    <nav class="pages" aria-label="Pages">
      ${statusLink}
      <a href="./" aria-current="page">Members</a>
    </nav>
  </div>
  <div class="pills">
    <p class="pill idle" id="reach-pill" hidden></p>
    <p class="pill idle" id="mode-pill">Locked</p>
  </div>
</header>

<main>
  <!-- Above the cards so mint-form errors stay visible with a long roster. -->
  <p class="note bad" id="message" hidden></p>

  <section class="card" id="unlock">
    <h2>Admin token</h2>
    <p class="verdict">Managing members needs the relay's admin token.</p>
    <form id="unlock-form" class="stack">
      <label class="field">
        <span>Token</span>
        <input type="password" id="token-input" autocomplete="off" spellcheck="false" placeholder="52 characters">
      </label>
      <button type="submit">Unlock</button>
    </form>
    <p class="hint">It was written to <code>MIRALL_RELAY_ADMIN_TOKEN_FILE</code> (<code>/data/admin-token</code> in the container) and printed <strong>once</strong> to the log on the boot that created it, as <code>"adminToken"</code>. It is kept for this browser tab only and is never stored on disk here.</p>
  </section>

  <section class="card" id="manage" hidden>
    <h2>Invite someone</h2>
    <p class="hint" id="mode-notice" hidden></p>
    <form id="mint-form" class="stack">
      <label class="field">
        <span>Label</span>
        <input type="text" id="label-input" autocomplete="off" spellcheck="false" placeholder="ben" maxlength="64">
      </label>
      <button type="submit" id="mint-button">Create invite</button>
    </form>
    <p class="hint">Your own handle for the person: letters, digits, dot, dash or underscore. It is never shown on the public status page.</p>
    <p class="hint">Anyone holding an invite <em>is</em> that member. One per person, not one per device — every device they install Mirall on shares it. If it leaks, revoke and re-issue.</p>
  </section>

  <section class="card" id="roster" hidden>
    <h2>Member list</h2>
    <div id="member-list"></div>
    <p class="hint" id="roster-summary"></p>
  </section>

</main>

<footer>
  <div class="footer-links">
    ${statusJson}
    <a href="../readyz">readyz</a>
    <a href="../metrics">metrics</a>
    <a href="../.well-known/mirall-relay.json">capability doc</a>
  </div>
  <p class="footer-meta">${plain(region, 'no region')} · ${plain(operator, 'no operator')} · v${plain(version)} · <a href="#" id="lock">forget token</a></p>
</footer>

<script type="module" src="app.js"></script>
</body>
</html>
`
}
