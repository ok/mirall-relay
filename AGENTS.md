# mirall-relay — working agreement

Baseline discipline for agentic work in this repo. Kept short on purpose: it is read
every session.

## Workflow

### 1. Plan before non-trivial work
- Enter plan mode for anything spanning 3+ steps or carrying an architectural decision.
- If something goes sideways, STOP and re-plan — don't keep pushing.
- Plans go to `~/Projects/Mirall/plans/plan-<name>.md` with checkable items. **Approving a
  plan is not approving the build** — get an explicit build signal before touching code.

### 2. Verification before done
- Never mark a task complete without proving it works. Run the suites the change touches
  (`.claude/testing.md`), read the output, and say what you ran.
- Report outcomes faithfully: a failure is stated with its output, a skipped step is named.

### 3. Autonomous bug fixing
- Given a bug report, a failing test, or a red CI job: fix it. Point at the log, find the
  root cause, resolve it. No hand-holding round-trips.

### 4. Self-improvement loop
- After any correction from the user, add the pattern to `.claude/lessons.md` in the style
  that file prescribes. Read it at session start.

## Core principles

- **Simplicity first** — make every change as simple as possible; impact minimal code.
- **No laziness** — find root causes. No temporary fixes. Senior-developer standards.
- **Minimal impact** — touch only what is necessary. Avoid introducing bugs.
- **No AI mentions** — never mention AI-assisted coding in commit messages, PR bodies, or
  code comments.

## Commit messages

Harmonized with `mirall-app` — keep every message brief.

- **Square-bracketed type prefix**: `[feat]`, `[fix]`, or `[chore]` (refactors, cleanup,
  deps, config — anything non-behavioural). Use another short standard type where clearer
  (`[docs]`, `[test]`, `[perf]`, `[ci]`, `[refactor]`). Square brackets, not parentheses —
  parentheses are reserved for scope in Conventional Commits.
- **Short imperative title**, ≤ ~60 chars: `[feat] Add invite membership`,
  `[fix] Unblock local Docker builds and clarify port logging`.
- **Brief body**: one blank line after the title, then a single paragraph wrapped at ~70
  chars carrying just the necessary context. No play-by-play narrative.
- No AI mentions (see Core principles).

## Branching

- **`main` is the only long-lived branch and is releasable.** There is no `staging` here —
  that is a deliberate divergence from `mirall-app`, not an oversight.
- Non-trivial work goes on a feature branch — `ok/<slug>` by convention — and reaches
  `main` through a PR with green CI (`.github/workflows/ci.yml`).
- Trivial edits (typo, comment, a `.claude/` doc) may go straight to `main`.
- **No worktrees.** The app's worktree discipline exists because parallel Electron agents
  collide on dev-server ports and native rebuilds; this repo has neither. Revisit if
  parallel work ever does collide.
- A `v*` tag triggers the multi-arch publish to ghcr.io. Tag only from `main`, and only on
  a commit whose CI is already green.

## Architecture snapshot

A standalone, self-hostable **blind relay**: it bridges two Mirall peers that cannot
hole-punch to each other, without ever holding a session key.

- **`src/index.js` — the composition root. Start here.** It builds the whole object graph
  from a config, so `bin/` and the integration tests wire the service identically.
- `src/relay.js` — the HyperDHT node on a stable seed-derived identity, plus the
  `blind-relay` server that bridges the peers' already-encrypted streams.
- `src/config.js` — the `SPEC` option table. Every option is both a flag and a
  `MIRALL_RELAY_*` env var, and adding one carries a documentation obligation
  (`.claude/testing.md` §3).
- `src/roster.js`, `src/ticket.js`, `src/admin-token.js` — invite membership: who may
  connect, the invite ticket codec, and the bearer token in front of the `/admin/*` write
  surface.
- `src/firewall.js`, `src/meter.js` — admission control and the byte/rate/duration/
  concurrency caps, enforced during the Noise handshake and on live bridges.
- `src/admin-http.js`, `src/operator/http/`, `src/operator/status/`,
  `src/operator/members/`, `src/operator/assets.js`, `src/operator/format.js`,
  `src/operator/copy-button.js`, `src/qr.js` — the operator surface on the admin port:
  Prometheus metrics, JSON endpoints, the anonymous status page, and the token-gated
  members page.

**The seed is the only secret and the only durable state** — with `members.json` alongside
it on an invite relay. Never log it, never commit it into a fixture, and never let a code
path silently re-key into a fresh identity.

**`hyperdht` is pinned to an exact version, deliberately.** It must stay wire-compatible
with the version Mirall ships; a caret range floats it into a version clients cannot talk
to, and the symptom is "connections mysteriously stopped working", not a build failure.
Bump it here in the same change that bumps it in `mirall-app`, and re-run the integration
suite. See `OPERATIONS.md` §8.

**Downstream packaging:** `ok/mirall-relay-startos` packages this service for StartOS. A
change to the config surface, the admin port, or the key ceremony has a counterpart there.

## Obligatory reading

- `README.md` — what the relay is, what "blind" means, the full configuration surface,
  operator endpoints, and how a user points Mirall at it. The **user-facing truth**.
- `OPERATIONS.md` — the operator runbook: key ceremony, sizing, reachability, monitoring,
  incident response, rotation, upgrades, backup. The **deployment truth**.
- `SECURITY.md` — the trust model, how to report, and what is known-and-documented rather
  than a vulnerability.
- `.claude/coding.md` — the code style, module boundaries, naming, commenting, and
  anti-pattern rules that keep relay cleanup from drifting back.
- `.claude/testing.md` — the test layers, the change-type → coverage matrix, the docs-drift
  obligation, the status-page bar, and how it is all gated.
- `.claude/lessons.md` — running log of non-obvious lessons from real debugging.
