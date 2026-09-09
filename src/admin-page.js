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
import { etagFor, readAssets } from './admin-ui.js'

// Independent of ui.css on purpose: MIRALL_RELAY_ADMIN_UI=false turns the
// anonymous page off, and it must not take the only way to mint an invite with it.
const ASSETS = {
  '/admin/style.css': ['admin-page.css', 'text/css; charset=utf-8'],
  '/admin/app.js': ['admin-page.client.js', 'text/javascript; charset=utf-8'],
  // The same file the status page serves at /copy-button.js. Served here too
  // rather than shared by URL, because /copy-button.js is a ui path and
  // MIRALL_RELAY_ADMIN_UI=false takes it away.
  '/admin/copy-button.js': ['copy-button.js', 'text/javascript; charset=utf-8']
}

export const PAGE_PATH = '/admin/'

let cache = null

// Read on first use, not at import — same reason as admin-ui.js: a packaging step
// that ships only src/*.js must degrade to a 404 on one route, not stop the relay.
export function managePaths () {
  if (cache) return cache
  cache = readAssets(ASSETS)
  const html = renderManagePage()
  cache.set(PAGE_PATH, { body: Buffer.from(html), type: 'text/html; charset=utf-8', etag: etagFor(html) })
  return cache
}

// Fully static. Nothing here is interpolated, so there is no escaping to get
// wrong on the server; the client builds every dynamic node with textContent.
export function renderManagePage () {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>mirall-relay members</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="masthead">
  <div>
    <h1>Members</h1>
    <p class="sub">mirall-relay &middot; <span id="relay-key">not unlocked</span></p>
  </div>
  <p class="pill idle" id="mode-pill">Locked</p>
</header>

<main>
  <!-- Above the cards, not below them: an error from the mint form used to render
       under a thirty-member roster, hundreds of pixels off-screen. -->
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

  <section class="card" id="minted" hidden>
    <h2>New invite</h2>
    <p class="verdict">Send this line to <strong id="minted-label"></strong>, the way you would send a password.</p>
    <code class="key" id="minted-ticket"></code>
    <div class="key-actions">
      <button type="button" id="copy-ticket">Copy invite</button>
      <button type="button" class="ghost" id="dismiss-ticket">Done</button>
    </div>
    <p class="note warn">Anyone holding this line <em>is</em> that member. One per person, not one per device — every device they install Mirall on shares it. If it leaks, revoke and re-issue.</p>
  </section>

  <section class="card" id="manage" hidden>
    <h2>Invite someone</h2>
    <form id="mint-form" class="stack">
      <label class="field">
        <span>Label</span>
        <input type="text" id="label-input" autocomplete="off" spellcheck="false" placeholder="ben" maxlength="64">
      </label>
      <button type="submit" id="mint-button">Create invite</button>
    </form>
    <p class="hint">Your own handle for the person: letters, digits, dot, dash or underscore. It is never shown on the public status page.</p>
    <p class="note warn" id="mode-warning" hidden></p>
  </section>

  <section class="card" id="roster" hidden>
    <h2>Roster</h2>
    <div id="member-list"></div>
    <p class="hint" id="roster-summary"></p>
  </section>

</main>

<footer>
  <a href="../">status page</a>
  <a href="#" id="lock">forget token</a>
</footer>

<script type="module" src="app.js"></script>
</body>
</html>
`
}
