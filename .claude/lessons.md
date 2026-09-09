# Lessons

Compact, actionable rules distilled from real debugging — gotchas, root causes, and the
fixes that actually worked. Grouped by theme; read at session start.

**Write every new lesson in this style.** A lesson is a short **bold imperative claim**
followed by 1–4 sentences carrying only what makes the rule usable: the mechanism (why it
bites), the diagnostic *tell* (the signal that points at it), and the concrete fix (the
specific API, formula, or sequence). No narrative — drop dates, "the user corrected me",
and play-by-plays. Put it under the matching `##` theme, adding one only if none fits, and
merge into a near-identical existing lesson rather than duplicating it.

**Durable discipline rules live in their discipline doc, not here.** Test layers, the
coverage matrix, and the docs obligation → `.claude/testing.md`. Architecture, the seed,
branching, and version lockstep → `CLAUDE.md` and `OPERATIONS.md`. This file is for
cross-cutting debugging *tactics* and system *gotchas* that belong to no single discipline.
If a new lesson is really a rule for one discipline, put it there and skip this file.

## Dependencies & packaging

**`hyperdht` is pinned exactly, and a caret range on it is a wire-compatibility bug.** The
relay must talk to the version Mirall ships; let it float and clients silently stop
connecting. The tell is the worst kind: "connections mysteriously stopped working", with a
green build and no error anywhere. Bump it in the same change as the client, then re-run
the integration suite.

**Alpine is not available for the runtime image — the native modules ship glibc-only
prebuilds.** musl would mean building libsodium and libudx from source. Distroless is the
win that was actually available (281 MB → 164 MB), at the cost of having no shell: that is
why the seed is read in-process via `MIRALL_RELAY_SEED_SECRET_FILE` rather than by an
entrypoint script, and why a malformed secret is a hard error instead of a silent re-key.

**A `# syntax=` directive costs a Docker Hub round-trip on every build for nothing** unless
the Dockerfile actually uses BuildKit-frontend features. Ours uses only classic
instructions, so dropping it unblocked local and offline builds.

## Networking & diagnostics

**A firewalled HyperDHT node reports its ephemeral client socket, not the configured
port.** The startup log therefore reads as though `--port` was ignored, which sends
debugging down the wrong path entirely. Log the *configured* UDP port explicitly at
startup, and read a port mismatch as "firewalled" before reading it as "misconfigured".

**On Docker Desktop, `firewalled: true` and a 503 from the probe are the expected
result.** The VM's NAT means the relay is genuinely not publicly reachable, so a local
Docker run smoke-tests boot and serve — never reachability. Don't debug it as a failure.
