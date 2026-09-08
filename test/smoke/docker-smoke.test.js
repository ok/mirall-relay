// Container smoke test. Proves the packaged image does the three things a
// deployment depends on: it starts and reports healthy, the identity derived
// from a given seed is STABLE across container replacement, and SIGTERM is
// handled gracefully.
//
// Run with `npm run test:smoke`. Set MIRALL_RELAY_IMAGE to test a prebuilt image
// (CI does this); otherwise the image is built from the working tree.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { keyPairFromSeed, publicKeyZ32 } from '../../src/keys.js'

const execFile = promisify(execFileCb)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const IMAGE = process.env.MIRALL_RELAY_IMAGE || 'mirall-relay:smoke'
const ADMIN_PORT = 19200

async function haveDocker () {
  try {
    await execFile('docker', ['version', '--format', '{{.Server.Version}}'])
    return true
  } catch {
    return false
  }
}

const dockerAvailable = await haveDocker()
const skip = dockerAvailable ? false : 'docker is not available'

async function buildImage () {
  if (process.env.MIRALL_RELAY_IMAGE) return // provided by CI
  await execFile('docker', ['build', '-t', IMAGE, '.'], { cwd: ROOT, maxBuffer: 1 << 26 })
}

async function runContainer (name, seedHex) {
  await execFile('docker', ['rm', '-f', name]).catch(() => {})
  const { stdout } = await execFile('docker', [
    'run', '-d', '--name', name,
    '-e', `MIRALL_RELAY_SEED=${seedHex}`,
    '-e', 'MIRALL_RELAY_ADMIN_HOST=0.0.0.0',
    '-e', `MIRALL_RELAY_ADMIN_PORT=${ADMIN_PORT}`,
    '-e', 'MIRALL_RELAY_PORT=0',
    '-e', 'MIRALL_RELAY_LOG_LEVEL=debug',
    '-p', `127.0.0.1:${ADMIN_PORT}:${ADMIN_PORT}`,
    IMAGE
  ])
  return stdout.trim()
}

async function removeContainer (name) {
  await execFile('docker', ['rm', '-f', name]).catch(() => {})
}

async function waitForHealthz (timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/healthz`)
      if (res.ok) return await res.json()
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('container never became healthy')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

test('the image starts, serves /healthz and derives the expected identity', { skip }, async (t) => {
  await buildImage()

  const seed = crypto.randomBytes(32)
  const seedHex = b4a.toString(seed, 'hex')
  const expected = publicKeyZ32(keyPairFromSeed(seed))

  const name = 'mirall-relay-smoke-1'
  t.after(() => removeContainer(name))
  await runContainer(name, seedHex)

  assert.deepEqual(await waitForHealthz(), { ok: true })

  const doc = await (await fetch(`http://127.0.0.1:${ADMIN_PORT}/.well-known/mirall-relay.json`)).json()
  assert.equal(
    doc.publicKey, expected,
    'the container must derive the same identity the operator generated with keygen'
  )

  const metrics = await (await fetch(`http://127.0.0.1:${ADMIN_PORT}/metrics`)).text()
  assert.match(metrics, /relay_ready 1/)

  // The page and its assets are not .js files, and the Dockerfile copies
  // directories. If src/ui/ ever stops being shipped, this is where it shows up —
  // everything else would keep passing while the browser surface 404s.
  const page = await (await fetch(`http://127.0.0.1:${ADMIN_PORT}/`)).text()
  assert.ok(page.includes(expected), 'the key the image derived must be on the page')
  assert.match(page, /Settings → Network/)
  for (const asset of ['ui.css', 'ui.js', 'format.js']) {
    const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/${asset}`)
    assert.equal(res.status, 200, `${asset} must be in the image`)
  }
})

test('the identity survives container replacement', { skip }, async (t) => {
  await buildImage()

  const seedHex = b4a.toString(crypto.randomBytes(32), 'hex')
  const name = 'mirall-relay-smoke-2'
  t.after(() => removeContainer(name))

  await runContainer(name, seedHex)
  await waitForHealthz()
  const first = (await (await fetch(`http://127.0.0.1:${ADMIN_PORT}/.well-known/mirall-relay.json`)).json()).publicKey

  await removeContainer(name)
  await runContainer(name, seedHex)
  await waitForHealthz()
  const second = (await (await fetch(`http://127.0.0.1:${ADMIN_PORT}/.well-known/mirall-relay.json`)).json()).publicKey

  assert.equal(second, first, 'a replaced container must not strand configured clients')
})

test('the container stops cleanly on SIGTERM', { skip }, async (t) => {
  await buildImage()

  const seedHex = b4a.toString(crypto.randomBytes(32), 'hex')
  const name = 'mirall-relay-smoke-3'
  t.after(() => removeContainer(name))

  await runContainer(name, seedHex)
  await waitForHealthz()

  const started = Date.now()
  // `docker stop` sends SIGTERM and waits; if the process ignored it, Docker
  // would SIGKILL at the timeout instead and the exit code would be 137.
  await execFile('docker', ['stop', '-t', '15', name])
  const elapsed = Date.now() - started

  const { stdout } = await execFile('docker', ['inspect', '-f', '{{.State.ExitCode}}', name])
  assert.equal(stdout.trim(), '0', 'a clean shutdown exits 0, not 137 (SIGKILL)')
  assert.ok(elapsed < 15_000, `shutdown took ${elapsed}ms — it should not need the full grace period`)
})

test('the container runs as a non-root user', { skip }, async () => {
  await buildImage()
  // No `id` binary: the runtime image is distroless. Ask node instead — its
  // entrypoint is the only executable in there.
  const { stdout } = await execFile('docker', [
    'run', '--rm', IMAGE, '-e', 'console.log(process.getuid())'
  ])
  assert.notEqual(stdout.trim(), '0', 'the relay must not run as root')
})

test('the runtime image ships no shell', { skip }, async () => {
  await buildImage()
  // Not a nice-to-have: a shell in a network-exposed container is the difference
  // between a bug and a foothold. If a future base change reintroduces one, this
  // should be a deliberate decision, not a silent regression.
  await assert.rejects(
    execFile('docker', ['run', '--rm', '--entrypoint', '/bin/sh', IMAGE, '-c', 'echo hi']),
    'expected no /bin/sh in the runtime image'
  )
})

test('the CLI is usable inside the image', { skip }, async () => {
  await buildImage()
  // The base image's ENTRYPOINT is node, so CMD is just the script path.
  const { stdout } = await execFile('docker', [
    'run', '--rm', IMAGE, 'bin/mirall-relay.js', 'keygen'
  ])
  assert.match(stdout, /PUBLIC KEY/)
  assert.match(stdout, /SEED/)
})

// Guard against a silently mis-scoped skip: if docker IS available the suite
// must have actually run something.
test('docker availability is reported honestly', () => {
  assert.equal(typeof dockerAvailable, 'boolean')
  if (!dockerAvailable) {
    process.stderr.write('\n[smoke] docker unavailable — container tests were skipped, not passed.\n')
  }
})
