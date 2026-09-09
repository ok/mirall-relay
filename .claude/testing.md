# Testing discipline

**The bar (Definition of Done):** a change to behaviour is not "done" until it is covered
by tests at the layer(s) it touches, those tests fail before the change and pass after, and
`npm run lint` + `npm test` are green. Bug fixes additionally carry a **red-first
regression test** at the layer the bug lived. Docs/comment-only changes have no runtime
surface — state `SKIP` and say why.

This is not "all layers for every change". Use the matrix in §2 to pick the layers a change
actually touches.

---

## 1. Test layers

| Layer | Lives in | Runner | What it covers |
|---|---|---|---|
| **Unit** | `test/unit/*.test.js` | `npm run test:unit` (`node --test`) | Pure logic, no sockets: the config `SPEC` table, key and ticket encoding, the QR encoder, formatters, meter accounting, the status projection, the admin-UI render, the host guard. |
| **Integration** | `test/integration/*.test.js` | `npm run test:integration` | A real relay against a real (local) HyperDHT testnet: relayed round-trips, byte counters on natively-bridged streams, every cap tearing a real bridge down, admission control, invite membership, the `/admin/*` surface. Timing-sensitive — CI allows 15 minutes. |
| **Smoke** | `test/smoke/*.test.js` | `npm run test:smoke` | The built Docker image actually boots and serves. Needs a local Docker daemon and a built image (`MIRALL_RELAY_IMAGE`). |

`npm test` runs unit + integration together.

**Tests drive the production wiring.** `test/helpers/make-relay.js` builds a relay through
`createRelay` — the same composition root `bin/` uses — so a test exercises the real object
graph rather than a hand-rolled subset of it. Anything a test starts, it closes in
teardown; a leaked DHT node or HTTP server wedges the rest of the suite, not just itself.

## 2. What coverage a change needs

| Change type | Required coverage |
|---|---|
| Pure logic — codec, formatter, validator, projection | **Unit** |
| A config option (new, or changed semantics) | **Unit** (`config.test.js`) + the docs obligation in §3 |
| Relay behaviour — bridging, caps, sessions | **Integration** (+ Unit for any extracted pure logic) |
| The `/admin/*` surface or the status page | **Unit** (render/projection) + **Integration** (served, over real HTTP) |
| Membership — roster, invites, tickets, revocation | **Unit** (codec/roster) + **Integration** (see below) |
| Packaging — Dockerfile, entrypoint, image contents | **Smoke** |
| Bug fix (any layer) | **Red-first regression test** at the bug's layer + the normal layer coverage |
| Docs / comments only | None — `SKIP`, say why |

**Admission and revocation are only proven at the integration layer.** A unit test that the
roster no longer lists a key proves the bookkeeping, not the enforcement — and enforcement
is the entire point, because revocation has to kill *live sessions and their bridged links*
(the reason being a stolen laptop). Assert the refused connection, or the torn-down
session, against a real relay.

## 3. The docs obligation (enforced by a test)

`test/unit/docs.test.js` is a drift guard, and it exists because `--over-rate-grace-ms`
shipped documented nowhere and nobody noticed until a manual read-through.

**A config option is not done until it appears in all three of:** `--help`
(`bin/mirall-relay.js`), `deploy/mirall-relay.env.example`, and `README.md`. The guard
parses the `SPEC` table out of `src/config.js` and fails on any option missing from them.
An option that exists but is documented nowhere is invisible — an operator cannot tune what
they cannot find.

**The same guard pins narrative docs, not just the option table.** It asserts that the
invite workflow is shown end to end (`mirall-relay invite create` in the README, `invite
revoke` in the runbook), that both access-control lists are *explained* rather than listed,
and that `members.json` appears beside the seed in the backup rules with what losing and
leaking it each cost. A feature that changes any of those has a prose obligation too, and
the test will say so.

## 4. The status page

Server-rendered HTML on the admin port, and the operator's primary surface on a headless
host. Same bar as anything else, plus three rules:

- **It must work without JavaScript.** `src/ui.js` refreshes numbers in place; the first
  render has to be complete and correct on its own.
- **Semantic HTML, real labels.** Headings in order, tabular data in a `<table>`, every
  control with an accessible name, and status carried by text rather than colour alone.
  There is no jsx-a11y/axe stack here — the bar is met by writing the markup correctly and
  reading it back.
- **Never render the seed.** The page shows the seed's *path*, and whether the identity was
  **read** from it or **generated on this start**. That distinction is load-bearing: a relay
  that generated one is one restart away from a different public key.

## 5. How it is gated

`.github/workflows/ci.yml`, on every PR and every push to `main`, runs three jobs that must
all be green to merge:

- **lint** — `npm run lint`
- **test** — `npm run test:unit`, then `npm run test:integration` (15-minute cap)
- **docker** — build the image, then `npm run test:smoke` against it

A `v*` tag additionally runs **publish** (multi-arch build to ghcr.io). That job does not
re-litigate quality, which is why a tag goes only on a commit whose CI is already green.
