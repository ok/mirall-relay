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
import { attachCopy } from './copy-button.js'

const TOKEN_KEY = 'mirall-relay.admin-token'

const el = (id) => document.getElementById(id)
let token = ''

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

// One message element, above the cards. It used to sit at the BOTTOM of <main>,
// so on a relay with thirty members a duplicate-label error rendered hundreds of
// pixels below the fold and the click looked ignored.
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
  show('minted', false)
  // CLEARED, not merely hidden. Hiding left the invite ticket and every member's
  // name sitting in the DOM after "forget token" — readable from devtools, a
  // find-in-page or any later script. The affordance says forget, so it forgets.
  el('minted-ticket').textContent = ''
  el('minted-label').textContent = ''
  el('member-list').textContent = ''
  el('roster-summary').textContent = ''
  el('relay-key').textContent = 'not unlocked'
  setPill('Locked', 'idle')
  say(message || '', 'bad')
}

function setPill (text, tone) {
  const pill = el('mode-pill')
  pill.textContent = text
  pill.className = 'pill ' + tone
}

// The access block mirrors what the anonymous page shows, so an operator who
// cannot connect a member sees the same three numbers in both places.
function renderSummary (data) {
  const access = data.access || {}
  const members = access.members || { active: 0, total: 0 }

  el('relay-key').textContent = (data.relay && data.relay.publicKey) || 'no identity yet'

  if (access.mode === 'invite') {
    setPill(members.active === 1 ? '1 member' : members.active + ' members', members.active ? 'good' : 'warn')
  } else {
    setPill(access.mode === 'allowlist' ? 'Allowlist' : 'Open relay', 'idle')
  }

  // Minting into a relay that is not in invite mode is the one thing an operator
  // can do here that quietly achieves nothing, so it is said out loud.
  const warning = el('mode-warning')
  if (access.mode === 'invite') {
    warning.hidden = true
  } else {
    warning.hidden = false
    warning.textContent =
      'This relay is in ' + (access.mode || 'open') + ' mode, so invites are recorded but do not gate anything yet. ' +
      'Set MIRALL_RELAY_ACCESS=invite and restart to gate on the roster. ' +
      'Any MIRALL_RELAY_ALLOWLIST keys stay admitted alongside it — the admitted set is the union of the two.'
  }

  const refused = access.refusedLastHour || 0
  el('roster-summary').textContent =
    members.active + ' of ' + members.total + ' active. ' +
    refused + (refused === 1 ? ' connection attempt' : ' connection attempts') + ' refused in the last hour — ' +
    'a small number is normal, including peers handed this relay’s key by a member’s own Mirall.'
}

function memberRow (member) {
  const row = document.createElement('div')
  row.className = 'member' + (member.revoked ? ' revoked' : '')

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
    reveal.className = 'ghost'
    reveal.textContent = 'Show invite'
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
  for (const member of members) list.append(memberRow(member))
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

function showTicket (label, ticket) {
  el('minted-label').textContent = label
  el('minted-ticket').textContent = ticket
  show('minted', true)
  el('minted').scrollIntoView({ block: 'nearest' })
}

async function revealTicket (label) {
  try {
    // One member's route, not the bulk ?reveal=1: that attaches a live bearer
    // credential for every active member, so showing one person's invite would
    // pull the whole roster's secrets into this tab to discard all but one.
    const member = await api('invites/' + encodeURIComponent(label) + '?reveal=1')
    if (member.ticket) showTicket(member.label, member.ticket)
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
    el('minted-ticket').textContent = ''
    show('minted', false)
    await load()
    ok(result.sessionsClosed
      ? 'Revoked ' + label + ' and closed ' + result.sessionsClosed + ' live connection(s).'
      : 'Revoked ' + label + '.')
  } catch (err) {
    if (!err.handled) fail(err.message)
  }
}

function start () {
  el('unlock-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    token = el('token-input').value.trim()
    if (!token) return
    el('token-input').value = ''
    try {
      await load()
      writeToken(token)
    } catch (err) {
      // Only a 401 explains itself. A 503 while the relay has no identity yet, a
      // 403 from the Host guard, or a dropped connection used to land here and be
      // discarded — the field cleared, nothing appeared, and the operator had no
      // idea whether the token was wrong or the relay was.
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
      const member = await api('invites', { method: 'POST', body: JSON.stringify({ label }) })
      input.value = ''
      await load()
      showTicket(member.label, member.ticket)
    } catch (err) {
      if (!err.handled) fail(err.message)
    } finally {
      button.disabled = false
    }
  })

  attachCopy(el('copy-ticket'), () => el('minted-ticket'), { idle: 'Copy invite' })

  el('dismiss-ticket').addEventListener('click', () => {
    // The panel is dismissed because the operator is done with the secret in it.
    el('minted-ticket').textContent = ''
    show('minted', false)
  })

  el('lock').addEventListener('click', (event) => {
    event.preventDefault()
    lock('')
  })

  token = readToken()
  if (token) load().catch(() => { /* lock() has already reported it */ })
}

if (typeof document !== 'undefined') start()
