// A deterministic stand-in for `monotonicMs`, so cap/rate tests can step time
// forward without sleeping. Test-only on purpose: production never fakes time.
export function fakeClock (start = 0) {
  let t = start
  const now = () => t
  now.advance = (ms) => { t += ms; return t }
  now.set = (ms) => { t = ms; return t }
  return now
}
