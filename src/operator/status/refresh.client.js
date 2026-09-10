// Keeps the numbers on the status page current. Everything else — the verdict
// prose, the symmetric-NAT note, the remediation list — is rendered by the server,
// so a change of reachability state asks for the page again instead of rebuilding
// that here. The page is correct without this file; it is only stale.
//
// The three decisions worth getting right are exported as pure functions so the
// repo's own test runner can reach them; only start() touches the DOM.
import { formatField } from './format.js'
import { attachCopy } from './copy-button.js'

const LIVE_MS = 5000
const BACKOFF_MS = 30000
const FAILURES_BEFORE_BACKOFF = 3
// A fetch whose connection is open but never answered has no default timeout in
// any browser. Bound each request so the refresh loop can mark stale counters
// stale instead of presenting them as live indefinitely.
const REQUEST_TIMEOUT_MS = 10000

export function readField (source, path) {
  return path.split('.').reduce((value, part) => (value == null ? undefined : value[part]), source)
}

// Everything in the reachability card that is NOT a data-field: the verdict prose,
// the symmetric-NAT note, the remediation list, the observed address, the local
// socket. All server-rendered, none of them constant: dht-rpc's NAT sampler
// starts empty and learns the host and port minutes into a run.
//
// The server stamps this into data-reachability and the browser compares; one
// definition, so the two cannot disagree about what counts as a change.
export function reachabilitySignature (reachability) {
  return [
    reachability.state,
    reachability.probed,
    reachability.portRandomized,
    reachability.ephemeralConfigured,
    reachability.publicHost,
    reachability.publicPort,
    reachability.port,
    reachability.bound && reachability.bound.port
  ].join('|')
}

// The access card has the same problem the reachability card does: the verdict
// sentence, the "refusing everyone" warning and the conditional rows are all
// server-rendered with no data-field, so applyFields cannot touch them. Reload
// when they change instead of patching counters under stale prose.
export function accessSignature (access) {
  if (!access) return ''
  return [
    access.mode,
    access.members && access.members.active,
    access.members && access.members.total,
    access.allowlisted
  ].join('|')
}

export function shouldReload (status, dataset) {
  if (reachabilitySignature(status.reachability) !== dataset.reachability) return true
  // Only when the page actually stamped one: a dataset from an older render has
  // no access signature, and reloading on that would be a loop.
  return dataset.access !== undefined && accessSignature(status.access) !== dataset.access
}

export function applyFields (root, status) {
  for (const node of root.querySelectorAll('[data-field]')) {
    const value = readField(status, node.dataset.field)
    if (value === undefined) continue
    const text = formatField(value, node.dataset.format)
    if (node.textContent !== text) node.textContent = text
  }
}

function start () {
  let failures = 0
  let timer = null

  function schedule () {
    clearTimeout(timer)
    if (document.hidden) return
    timer = setTimeout(refresh, failures >= FAILURES_BEFORE_BACKOFF ? BACKOFF_MS : LIVE_MS)
  }

  async function refresh () {
    try {
      const res = await fetch('status.json', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(String(res.status))
      const status = await res.json()
      failures = 0
      document.body.classList.remove('stale')

      if (shouldReload(status, document.body.dataset)) {
        location.reload()
        return
      }
      applyFields(document, status)
    } catch {
      failures++
      if (failures >= FAILURES_BEFORE_BACKOFF) document.body.classList.add('stale')
    }
    schedule()
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer)
    else refresh()
  })

  const copyButton = document.getElementById('copy-key')
  if (copyButton) {
    attachCopy(copyButton, () => document.getElementById('public-key'), { idle: 'Copy key' })
  }

  schedule()
}

if (typeof document !== 'undefined') start()
