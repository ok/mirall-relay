// Structured JSON logging to stdout — the format journald and Docker both want,
// and the only format worth grepping on a box relaying other people's traffic.
//
// NEVER log: the seed, pairing tokens, or any stream payload. Remote PUBLIC keys
// are fine (they are not secret and they are the only handle an operator has on
// an abusive peer), as are counts, caps and timings.
import pino from 'pino'

export function makeLogger (cfg, opts = {}) {
  return pino({
    level: cfg.logLevel,
    base: { region: cfg.region, operator: cfg.operator },
    redact: {
      paths: ['seed', 'token', '*.seed', '*.token'],
      censor: '[redacted]'
    },
    ...opts
  })
}

// A logger that swallows everything — used by tests and by the probe script.
export function nullLogger () {
  return pino({ level: 'silent' })
}
