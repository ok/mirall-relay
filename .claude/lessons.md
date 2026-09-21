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

**dht-rpc probes reachability once, and never again while the public host is unchanged.**
Its periodic re-check is guarded by `_lastHost === _nat.host` ("do not recheck the same
network"), and the probe needs 3 of 5 ping-backs, so one unlucky round at startup left a
correctly forwarded relay firewalled for hours. The tell: firewalled from the first seconds
of a run, settings untouched, and a plain restart fixes it. `src/reprobe.js` re-runs
`_updateNetworkState()` while firewalled; re-check that hook on any hyperdht bump.

**`firewalled: false` and `randomized: false` together still do not mean directly
reachable.** hyperdht offers clients a direct connection only when `dht.remoteAddress()`
is non-null, and that is null for an unknown host, a randomized port, *or* a consistent
public port that differs from the bound one — the last is what a NAT rewriting only
relay-initiated flows produces, and the sampler can settle on it without ever reporting
randomized. The tell: every client fails with `HOLEPUNCH_*` while the relay is on the
DHT and not firewalled. Judge reachability by `remoteAddress()` (`networkInfo().publicAddress`),
and reproduce it in tests with `dht._natAdd()` rather than a stub.

**On Docker Desktop, `firewalled: true` and a 503 from the probe are the expected
result.** The VM's NAT means the relay is genuinely not publicly reachable, so a local
Docker run smoke-tests boot and serve — never reachability. Don't debug it as a failure.

**`server.close()` waits forever on a socket that connected and never sent a request.**
Node's idle-connection sweep only covers sockets that have finished a request, and browsers
and platform proxies open silent speculative ones constantly. The tell is a shutdown that
always takes exactly the timeout and exits 1, but only on a box someone has a page open on.
Call `server.closeAllConnections()` right after `server.close()`.

## Operator experience

**Do not put a precondition in front of a state the relay already handles safely — label
the state instead.** A private relay with an empty roster refuses everyone; that is
fail-closed, correct, and also what revoking the last member produces, so it has to be
presentable anyway. The tell is a guard whose error message explains a consequence the
status page could simply show. Let the setting save, and say "nobody can connect yet" on the
status page and in the platform's health check.
