#!/usr/bin/env node
// CLI entry: parse -> start -> serve -> shut down cleanly on a signal.
import { loadConfig } from '../src/config.js'
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
  --seed HEX                 64-hex identity seed (overrides --seed-file)
  --seed-file PATH           seed file, generated on first run   [./.keys/seed]
  --seed-secret-file PATH    mounted secret, read before --seed-file
                             [/run/secrets/relay_seed]
  --bootstrap host:port,...  DHT bootstrap override              [mainline]
  --host ADDR                UDP bind address                    [0.0.0.0]
  --port N                   UDP port, 0 = ephemeral             [49737]
  --ephemeral                do not join the DHT routing table   [false]
  --assume-reachable         skip firewall probing (public IP)   [false]

  --admin-host ADDR          admin HTTP bind                     [127.0.0.1]
  --admin-port N             admin HTTP port                     [9200]
  --admin-ui BOOL            serve the browser status page       [true]
  --admin-allowed-hosts H,.. extra Host values accepted when the
                             admin server is bound to loopback   [none]
  --admin-write BOOL         serve the token-gated /admin/* write
                             surface; false removes it entirely  [true]
  --admin-token TOKEN        bearer token for /admin/*; prefer the
                             file, env vars leak into inspect    [none]
  --admin-token-file PATH    token file, generated and logged on
                             first boot              [./.keys/admin-token]

  --max-sessions-per-key N   sessions per peer DEVICE key        [64]
  --max-active-links N       global bridged-stream ceiling       [2000]
  --max-link-bytes SIZE      bytes per link, per direction       [512MB]
  --max-link-rate SIZE       bytes/sec per link, per direction   [4MiB]
  --max-link-ms N            max link lifetime                   [3600000]
  --max-pending N            half-open pairing ceiling           [10000]
  --session-rate N           new sessions per key per minute     [120]
  --over-rate-grace-ms N     sustained-overrun window before a
                             link is torn for exceeding its rate  [5000]
  --meter-ms N               cap sampling interval               [1000]

  --access MODE              open | invite. invite admits only roster
                             members and --allowlist keys        [open]
  --roster-file PATH         members.json; as secret as the seed
                                                     [./.keys/members.json]
  --allowlist KEY,...        static keys admitted, unioned with the roster
  --banlist KEY,...          keys refused at connect time
  --region NAME              label for metrics and /.well-known  [unknown]
  --operator NAME            label for metrics and /.well-known  [unknown]
  --log-level LEVEL          trace|debug|info|warn|error|fatal   [info]

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
  // The key used to be available only from this line. It is now on a page, and
  // saying so here is what makes anyone look.
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
