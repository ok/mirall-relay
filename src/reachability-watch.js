// Reports reachability transitions, so the log says when a relay stops being
// directly reachable and when it recovers.
//
// Event-driven: the caller runs check() on dht-rpc's 'nat-update' and on each
// re-probe result, never on a poll. No hold-down: the log reports what hyperdht
// is advertising now, and anything that alerts owns its own tolerance. The one
// timer is for an address that never settles: 'unknown' is normal for minutes
// after an IP change, and worth a warning only when it lasts.
const UNKNOWN_WARN_MS = 10 * 60_000

export function watchReachability ({
  read,
  onChange,
  unknownWarnMs = UNKNOWN_WARN_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let last = null
  let timer = null
  let stopped = false

  function disarm () {
    if (timer) clearTimer(timer)
    timer = null
  }

  function check () {
    if (stopped) return
    const next = read()
    if (next === last) return
    const prev = last
    last = next
    disarm()
    if (next === 'unknown') {
      timer = setTimer(() => {
        timer = null
        if (!stopped && last === 'unknown') onChange('unknown', 'unknown-long')
      }, unknownWarnMs)
      timer.unref?.()
    }
    onChange(prev, next)
  }

  return {
    check,
    stop () {
      stopped = true
      disarm()
    }
  }
}
