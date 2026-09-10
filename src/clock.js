// A monotonic millisecond clock, injectable so cap/rate tests can advance time
// without sleeping. Never use Date.now() for cap enforcement — a clock step
// (NTP, VM migration) would otherwise tear down every live link at once.
import { performance } from 'node:perf_hooks'

export function monotonicMs () {
  return performance.now()
}
