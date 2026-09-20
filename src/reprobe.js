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
// Front-loaded: a port that is open answers within seconds, so the first retries
// come quickly and only a port that really is closed settles into the last wait.
const SCHEDULE_MS = [10_000, 20_000, 30_000, 60_000, 120_000, 300_000]

export function startReprobe (dht, {
  onResult = null,
  onUnsupported = null,
  scheduleMs = SCHEDULE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let timer = null
  let stopped = false
  let attempt = 0

  function schedule () {
    if (stopped || !dht.firewalled) return
    timer = setTimer(probe, scheduleMs[Math.min(attempt++, scheduleMs.length - 1)])
    timer.unref?.()
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
