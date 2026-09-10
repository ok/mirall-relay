#!/usr/bin/env node
// CLI entry: parse -> start -> serve -> shut down cleanly on a signal.
import { helpOptions, loadConfig } from '../src/config.js'
import { startRelay, stopRelay, VERSION } from '../src/index.js'
import { keygenCommand } from './keygen.js'
import { inviteCommand } from './invite.js'

const USAGE = `mirall-relay ${VERSION}

  A blind relay for Mirall. Bridges end-to-end-encrypted connections between two
  peers that cannot hole-punch to each other. Sees ciphertext only.

USAGE
  mirall-relay [options]            start the relay
  mirall-relay keygen [--out FILE]  generate an identity (seed + public key)
  mirall-relay invite <command>     manage membership (see below)
  mirall-relay --help

OPTIONS  (every flag has a MIRALL_RELAY_* environment equivalent)
${helpOptions()}

INVITE
  mirall-relay invite create <label>   mint an invite and print the ticket
  mirall-relay invite list             labels, keys, created, revoked
  mirall-relay invite show <label>     reprint an existing ticket
  mirall-relay invite revoke <label>   revoke; a running relay drops them in ~5s
`

const argv = process.argv.slice(2)

if (argv[0] === 'keygen') {
  keygenCommand(argv.slice(1))
  process.exit(0)
}

if (argv[0] === 'invite') {
  inviteCommand(argv.slice(1))
  process.exit(0)
}

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE)
  process.exit(0)
}

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(VERSION + '\n')
  process.exit(0)
}

let cfg
try {
  cfg = loadConfig(argv)
} catch (err) {
  process.stderr.write(`configuration error: ${err.message}\n\n`)
  process.stderr.write('Run with --help for the full option list.\n')
  process.exit(78) // EX_CONFIG
}

let app
try {
  app = await startRelay(cfg)
} catch (err) {
  process.stderr.write(`failed to start: ${err.stack || err.message}\n`)
  process.exit(1)
}

app.logger.info({
  version: VERSION,
  publicKey: app.relay.publicKeyZ32,
  admin: `http://${cfg.adminHost}:${cfg.adminPort}`,
  // Name the page in the startup log so operators know where to copy the key.
  ...(cfg.adminUi ? { statusPage: `http://${cfg.adminHost}:${cfg.adminPort}/` } : {})
}, 'mirall-relay started')

// Graceful shutdown: stop metering, close the blind-relay sessions, close the
// DHT server, destroy the node. A second signal gives up and exits immediately
// so a wedged shutdown can still be killed with two Ctrl-C.
let shuttingDown = false
async function shutdown (signal) {
  if (shuttingDown) {
    app.logger.warn({ signal }, 'second signal — exiting immediately')
    process.exit(130)
  }
  shuttingDown = true
  app.logger.info({ signal }, 'shutting down')
  const timer = setTimeout(() => {
    app.logger.error('shutdown timed out — exiting')
    process.exit(1)
  }, 15000)
  timer.unref()
  try {
    await stopRelay(app)
  } finally {
    clearTimeout(timer)
    process.exit(0)
  }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.on('unhandledRejection', (err) => {
  app.logger.error({ err: err?.stack || String(err) }, 'unhandled rejection')
})
