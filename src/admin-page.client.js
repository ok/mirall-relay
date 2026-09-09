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

function fail (message) {
  const node = el('error')
  node.textContent = message
  node.hidden = !message
}

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
    throw new Error('unauthorized')
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
  el('relay-key').textContent = 'not unlocked'
  setPill('Locked', 'idle')
  fail(message || '')
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
      'Set MIRALL_RELAY_ACCESS=invite and restart to admit only these members.'
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
  fail('')
}

function showTicket (label, ticket) {
  el('minted-label').textContent = label
  el('minted-ticket').textContent = ticket
  show('minted', true)
  el('minted').scrollIntoView({ block: 'nearest' })
}

async function revealTicket (label) {
  try {
    const data = await api('invites?reveal=1')
    const member = data.members.find((m) => m.label === label)
    if (member && member.ticket) showTicket(label, member.ticket)
    else fail('No invite to show for ' + label + '.')
  } catch (err) {
    fail(err.message)
  }
}

async function revokeMember (label) {
  // A revocation drops the member's live sessions, so it is not a soft toggle.
  if (!window.confirm('Revoke ' + label + '?\n\nTheir invite stops working immediately and any connection they have open is closed.')) return
  try {
    const result = await api('invites/' + encodeURIComponent(label), { method: 'DELETE' })
    show('minted', false)
    await load()
    if (result.sessionsClosed) fail('Revoked ' + label + ' and closed ' + result.sessionsClosed + ' live session(s).')
  } catch (err) {
    fail(err.message)
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
    } catch { /* api() has already locked and reported */ }
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
      showTicket(member.label, member.ticket)
      await load()
    } catch (err) {
      fail(err.message)
    } finally {
      button.disabled = false
    }
  })

  el('copy-ticket').addEventListener('click', async (event) => {
    const button = event.currentTarget
    const ticket = el('minted-ticket').textContent
    let copied = false
    try {
      // The Clipboard API is absent on plain HTTP to a non-localhost host, which
      // is exactly how a platform proxy serves this page. Selecting is the normal
      // path there, not an exotic fallback.
      await navigator.clipboard.writeText(ticket)
      copied = true
    } catch {
      const range = document.createRange()
      range.selectNodeContents(el('minted-ticket'))
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    }
    button.textContent = copied ? 'Copied' : 'Selected — press ⌘C / Ctrl+C'
    setTimeout(() => { button.textContent = 'Copy invite' }, 2500)
  })

  el('dismiss-ticket').addEventListener('click', () => show('minted', false))

  el('lock').addEventListener('click', (event) => {
    event.preventDefault()
    lock('')
  })

  token = readToken()
  if (token) load().catch(() => { /* lock() has already reported it */ })
}

if (typeof document !== 'undefined') start()
