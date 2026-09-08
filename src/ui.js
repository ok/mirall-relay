// Keeps the numbers on the status page current. Everything else — the verdict
// prose, the symmetric-NAT note, the remediation list — is rendered by the server,
// so a change of reachability state asks for the page again instead of rebuilding
// that here. The page is correct without this file; it is only stale.
//
// The three decisions worth getting right are exported as pure functions so the
// repo's own test runner can reach them; only start() touches the DOM.
import { formatField } from './format.js'

const LIVE_MS = 5000
const BACKOFF_MS = 30000
const FAILURES_BEFORE_BACKOFF = 3
// A fetch whose connection is open but never answered has no default timeout in
// any browser. Without this the await never settles: schedule() is never reached,
// `failures` never increments, and the loop dies while the page keeps presenting
// minutes-old counters as live — the exact lie the .stale styling exists to stop.
const REQUEST_TIMEOUT_MS = 10000

export function readField (source, path) {
  return path.split('.').reduce((value, part) => (value == null ? undefined : value[part]), source)
}

// Everything in the reachability card that is NOT a data-field: the verdict prose,
// the symmetric-NAT note, the remediation list, the observed address, the local
// socket. All server-rendered, none of them constant — dht-rpc's NAT sampler
// starts empty and learns the host and port minutes into a run, so a page left
// open would otherwise never show the symmetric-NAT warning at all.
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

export function shouldReload (status, dataset) {
  return reachabilitySignature(status.reachability) !== dataset.reachability
}

export function applyFields (root, status) {
  for (const node of root.querySelectorAll('[data-field]')) {
    const value = readField(status, node.dataset.field)
    if (value === undefined) continue
    const text = formatField(value, node.dataset.format)
    if (node.textContent !== text) node.textContent = text
  }
}

function selectKey () {
  const node = document.getElementById('public-key')
  if (!node) return
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
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
    let resetTimer = null
    copyButton.addEventListener('click', async () => {
      clearTimeout(resetTimer)
      let copied = false
      try {
        // The Clipboard API is absent on plain HTTP to a non-localhost host,
        // which is exactly how a platform proxy serves this page. Selecting the
        // key is the normal path there, not an exotic fallback.
        await navigator.clipboard.writeText(copyButton.dataset.key)
        copied = true
      } catch {
        selectKey()
      }
      copyButton.textContent = copied ? 'Copied' : 'Selected — press ⌘C / Ctrl+C'
      resetTimer = setTimeout(() => { copyButton.textContent = 'Copy key' }, 2500)
    })
  }

  schedule()
}

if (typeof document !== 'undefined') start()
