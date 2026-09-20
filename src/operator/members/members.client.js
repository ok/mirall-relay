// The management page's browser half. Shipped to the browser, not run by Node.
//
// THE TOKEN LIVES IN sessionStorage, for this tab only. Not localStorage, so
// closing the tab forgets it; not a cookie, because a cookie would be attached to
// every request the browser makes to this origin and turn a write surface into a
// CSRF target. Every call sends it as an Authorization header explicitly.
//
// EVERY DYNAMIC NODE IS BUILT WITH textContent. The roster is operator-supplied
// text — labels are people's names — and this page has no innerHTML anywhere, so
// there is no escaping to get wrong. The CSP (default-src 'none') is the second
// line, not the first.
import { copyText, selectNode } from './copy-button.js'
import { modePill, reachabilityPill, rosterNotice } from './access-copy.js'

const TOKEN_KEY = 'mirall-relay.admin-token'
const COPY_IDLE = 'Copy invite'
const COPY_RESET_MS = 2500

const el = (id) => document.getElementById(id)
let token = ''

// At most one member's invite on screen at a time. Held here rather than in the
// DOM because renderMembers rebuilds the whole list on every load().
let revealed = null

function readToken () {
  // Private browsing and blocked-storage modes throw on access rather than
  // returning null, and an exception here would stop the page loading at all.
  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

function writeToken (value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch { /* the page still works, it just forgets on reload */ }
}

function show (id, visible) {
  el(id).hidden = !visible
}

// One message element, above the cards, so form failures stay visible even when
// the roster is long.
function say (message, tone) {
  const node = el('message')
  node.textContent = message || ''
  node.className = 'note ' + (tone || 'bad')
  node.hidden = !message
  if (message) node.scrollIntoView({ block: 'nearest' })
}

const fail = (message) => say(message, 'bad')
const ok = (message) => say(message, 'good')

// Paths are document-relative, so the page works under a proxy prefix the same
// way the status page does — /relay/admin/ reaches /relay/admin/invites.
async function api (path, options = {}) {
  const res = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: {
      authorization: 'Bearer ' + token,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    }
  })

  if (res.status === 401) {
    lock('That token was not accepted.')
    // Marked, so the callers below do not overwrite the sentence above with the
    // word "unauthorized".
    throw Object.assign(new Error('unauthorized'), { handled: true })
  }

  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.message || body.error || 'request failed (' + res.status + ')')
  return body
}

function lock (message) {
  token = ''
  writeToken('')
  show('unlock', true)
  show('manage', false)
  show('roster', false)
  show('mode-notice', false)
  revealed = null
  // Cleared, not merely hidden: forgetting the token must also remove protected
  // labels and tickets from the DOM.
  el('member-list').textContent = ''
  el('roster-summary').textContent = ''
  showPublicMode()
  say(message || '', 'bad')
}

function setPill (text, tone, id = 'mode-pill') {
  const pill = el(id)
  pill.textContent = text
  pill.className = 'pill ' + tone
}

// The anonymous snapshot already says which mode the relay is in and whether it
// is reachable, so the header matches the status page before any token is given.
let publicAccess = null

function showPublicMode () {
  if (!publicAccess) return setPill('Locked', 'idle')
  const pill = modePill(publicAccess)
  setPill(pill.text, pill.tone)
}

// The access block mirrors what the anonymous page shows, so an operator who
// cannot connect a member sees the same three numbers in both places.
function renderSummary (data) {
  const access = data.access || {}
  const members = access.members || { active: 0, total: 0 }

  const pill = modePill(access)
  setPill(pill.text, pill.tone)

  // Minting into a relay that does not gate on the roster quietly excludes
  // nobody, so it is said out loud.
  const notice = rosterNotice(access)
  el('mode-notice').textContent = notice || ''
  show('mode-notice', notice !== null)

  const refused = access.refusedLastHour || 0
  el('roster-summary').textContent =
    members.active + ' of ' + members.total + ' active. ' +
    refused + (refused === 1 ? ' connection attempt' : ' connection attempts') + ' refused in the last hour — ' +
    'a small number is normal, including peers handed this relay’s key by a member’s own Mirall.'
}

async function loadPublicStatus () {
  try {
    const res = await fetch('../status.json', { headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!res.ok) return
    const status = await res.json()
    const reach = reachabilityPill(status.reachability)
    setPill(reach.text, reach.tone, 'reach-pill')
    show('reach-pill', true)
    publicAccess = status.access || null
    if (!token) showPublicMode()
  } catch { /* the snapshot is off or unreachable; the page works without it */ }
}

function revealBlock (label, ticket) {
  const block = document.createElement('div')
  block.className = 'member-reveal'

  const key = document.createElement('code')
  key.className = 'key'
  key.textContent = ticket

  const actions = document.createElement('div')
  actions.className = 'key-actions'
  const done = document.createElement('button')
  done.type = 'button'
  done.className = 'ghost'
  done.textContent = 'Done'
  done.addEventListener('click', dismissReveal)
  actions.append(done)

  const warn = document.createElement('p')
  warn.className = 'note warn'
  warn.textContent = 'Send this to ' + label + ' the way you would send a password. Anyone holding it is that member.'

  block.append(key, actions, warn)
  return { block, key }
}

function dismissReveal () {
  revealed = null
  for (const block of el('member-list').querySelectorAll('.member-reveal')) {
    const key = block.querySelector('.key')
    if (key) key.textContent = ''
    block.remove()
  }
}

// Walked rather than selected: a label is operator-supplied text and has no
// business being spliced into a selector.
function rowFor (label) {
  for (const row of el('member-list').children) {
    if (row.dataset && row.dataset.label === label) return row
  }
  return null
}

// A copy that worked needs no UI: the invite goes to the clipboard and the button
// says so. The ticket is put on screen only where the Clipboard API is missing —
// every plain-HTTP, non-localhost host, which is how a platform proxy serves this
// page — because selecting text requires text to select.
async function deliverTicket (label, ticket) {
  dismissReveal()
  const row = rowFor(label)
  if (!row) return

  const copied = await copyText(ticket, () => {
    revealed = { label, ticket }
    const { block, key } = revealBlock(label, ticket)
    row.append(block)
    block.scrollIntoView({ block: 'nearest' })
    return key
  })

  if (copied) say('', 'bad')
  else say('This browser has no clipboard on a plain-HTTP address. The invite is selected below — press ⌘C / Ctrl+C.', 'warn')

  const button = row.querySelector('.copy-invite')
  if (!button) return
  button.textContent = copied ? 'Copied' : 'Selected — press ⌘C / Ctrl+C'
  setTimeout(() => { button.textContent = COPY_IDLE }, COPY_RESET_MS)
}

function memberRow (member) {
  const row = document.createElement('div')
  row.className = 'member' + (member.revoked ? ' revoked' : '')
  row.dataset.label = member.label

  const who = document.createElement('div')
  who.className = 'member-who'

  const label = document.createElement('div')
  label.className = 'member-label'
  label.textContent = member.label

  const meta = document.createElement('div')
  meta.className = 'member-meta'
  meta.textContent = member.revoked
    ? 'revoked ' + member.revoked.slice(0, 10) + ' · ' + member.publicKey
    : member.publicKey + ' · ' + member.sessions + (member.sessions === 1 ? ' session' : ' sessions')

  who.append(label, meta)

  const actions = document.createElement('div')
  actions.className = 'member-actions'

  if (!member.revoked) {
    const reveal = document.createElement('button')
    reveal.type = 'button'
    reveal.className = 'ghost copy-invite'
    reveal.textContent = COPY_IDLE
    reveal.addEventListener('click', () => revealTicket(member.label))

    const revoke = document.createElement('button')
    revoke.type = 'button'
    revoke.className = 'danger'
    revoke.textContent = 'Revoke'
    revoke.addEventListener('click', () => revokeMember(member.label))

    actions.append(reveal, revoke)
  }

  row.append(who, actions)
  return row
}

// Revoked members are kept — the roster is the record of who was ever invited —
// but they are not what the operator came here to read, so they collapse. <details>
// rather than a toggle of our own: it works before app.js has wired anything and
// carries its own keyboard and screen-reader behaviour.
function revokedGroup (members) {
  const group = document.createElement('details')
  group.className = 'revoked-group'

  const summary = document.createElement('summary')
  summary.textContent = members.length === 1 ? '1 revoked member' : members.length + ' revoked members'
  group.append(summary)

  for (const member of members) group.append(memberRow(member))
  return group
}

function renderMembers (members) {
  const list = el('member-list')
  list.textContent = ''
  if (!members.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'Nobody yet. Create the first invite above.'
    list.append(empty)
    return
  }

  const active = members.filter((member) => !member.revoked)
  const revoked = members.filter((member) => member.revoked)

  if (active.length) {
    for (const member of active) list.append(memberRow(member))
  } else {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'No active members. Create an invite above.'
    list.append(empty)
  }

  if (revoked.length) list.append(revokedGroup(revoked))

  // The rebuild above destroyed the reveal, so put it back rather than making an
  // operator mid-copy click again.
  if (!revealed) return
  const row = rowFor(revealed.label)
  if (!row) {
    revealed = null
    return
  }
  const { block, key } = revealBlock(revealed.label, revealed.ticket)
  row.append(block)
  // It is only ever on screen because the clipboard was unavailable, so it is
  // only useful selected.
  selectNode(key)
}

async function load () {
  const data = await api('invites')
  renderSummary(data)
  renderMembers(data.members)
  show('unlock', false)
  show('manage', true)
  show('roster', true)
  say('', 'bad')
}

async function revealTicket (label) {
  try {
    // One member's route, not the bulk ?reveal=1: that attaches a live bearer
    // credential for every active member, so showing one person's invite would
    // pull the whole roster's secrets into this tab to discard all but one.
    const member = await api('invites/' + encodeURIComponent(label) + '?reveal=1')
    if (member.ticket) await deliverTicket(member.label, member.ticket)
    else fail('No invite to show for ' + label + '.')
  } catch (err) {
    if (!err.handled) fail(err.message)
  }
}

async function revokeMember (label) {
  // A revocation drops the member's live sessions, so it is not a soft toggle.
  if (!window.confirm('Revoke ' + label + '?\n\nTheir invite stops working immediately and any connection they have open is closed.')) return
  try {
    const result = await api('invites/' + encodeURIComponent(label), { method: 'DELETE' })
    dismissReveal()
    await load()
    ok(result.sessionsClosed
      ? 'Revoked ' + label + ' and closed ' + result.sessionsClosed + ' live connection(s).'
      : 'Revoked ' + label + '.')
  } catch (err) {
    if (!err.handled) fail(err.message)
  }
}

function start () {
  loadPublicStatus()

  el('unlock-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    token = el('token-input').value.trim()
    if (!token) return
    el('token-input').value = ''
    try {
      await load()
      writeToken(token)
    } catch (err) {
      // Only a 401 explains itself. Other failures must stay visible so an
      // operator can distinguish a bad token from a relay or Host-guard problem.
      if (!err.handled) {
        token = ''
        fail(err.message)
      }
    }
  })

  el('mint-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const input = el('label-input')
    const label = input.value.trim()
    if (!label) return

    const button = el('mint-button')
    button.disabled = true
    try {
      // The POST already carries the ticket; re-fetching it with ?reveal=1 would
      // put the same live credential on the wire twice.
      const member = await api('invites', { method: 'POST', body: JSON.stringify({ label }) })
      input.value = ''
      await load()
      await deliverTicket(member.label, member.ticket)
    } catch (err) {
      if (!err.handled) fail(err.message)
    } finally {
      button.disabled = false
    }
  })

  el('lock').addEventListener('click', (event) => {
    event.preventDefault()
    lock('')
  })

  token = readToken()
  if (token) load().catch(() => { /* lock() has already reported it */ })
}

if (typeof document !== 'undefined') start()
