// A monotonic millisecond clock, injectable so cap/rate tests can advance time
// without sleeping. Never use Date.now() for cap enforcement — a clock step
// (NTP, VM migration) would otherwise tear down every live link at once.
import { performance } from 'node:perf_hooks'

export function monotonicMs () {
  return performance.now()
}

export function fakeClock (start = 0) {
  let t = start
  const now = () => t
  now.advance = (ms) => { t += ms; return t }
  now.set = (ms) => { t = ms; return t }
  return now
}
