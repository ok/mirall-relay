// Re-runs dht-rpc's reachability probe while the node is firewalled.
//
// WHY IT EXISTS: dht-rpc probes once at bootstrap, and its periodic re-check is
// skipped while the observed public host is unchanged ("do not recheck the same
// network"). The probe needs 3 of 5 remote nodes to ping back within a timeout,
// so one unlucky round — common in the first seconds after a restart — left a
// correctly forwarded relay firewalled until the next restart, hours later.
//
// _updateNetworkState is dht-rpc internals: the same call its own tick makes,
// minus the same-host guard. Everything about it is optional, so a dht-rpc that
// drops it costs the self-heal and nothing else.
const INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 15 * 60_000

export function startReprobe (dht, {
  onResult = null,
  onUnsupported = null,
  intervalMs = INTERVAL_MS,
  maxIntervalMs = MAX_INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let timer = null
  let stopped = false
  let wait = intervalMs

  function schedule () {
    if (stopped || !dht.firewalled) return
    timer = setTimer(probe, wait)
    timer.unref?.()
    wait = Math.min(wait * 2, maxIntervalMs)
  }

  async function probe () {
    timer = null
    try {
      await dht._updateNetworkState()
    } catch { /* a failed probe is just another firewalled result */ }
    if (stopped) return
    onResult?.(!!dht.firewalled)
    schedule()
  }

  if (typeof dht._updateNetworkState !== 'function') {
    if (dht.firewalled) onUnsupported?.()
  } else {
    schedule()
  }

  return {
    stop () {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
    }
  }
}
