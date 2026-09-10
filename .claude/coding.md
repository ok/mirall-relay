# Coding Discipline

> Any future code changes, reviews, or automated agent runs in this repository must read this file first and follow it. If a change conflicts with a rule here, either follow the rule or update the rule deliberately in the same change - never silently ignore it.

This file is the binding style and architecture guide for `mirall-relay`. Check new code against it before considering work complete. Keep the relay small, explicit, secure by default, and easy to reason about from the composition root outward.

## Naming Conventions

- Use JavaScript ESM with explicit `.js` import specifiers.
- Use kebab-case for CLI flags and route-oriented names: `admin-token-file`, `/admin/invites`, `max-link-bytes`.
- Use camelCase for JavaScript variables, functions, object fields, and config keys: `adminTokenFile`, `maxLinkBytes`, `publicKeyZ32`.
- Use PascalCase only for classes and error classes: `RelayNode`, `RosterError`.
- Use `makeX` for factories that return stateful service objects: `makeAdminServer`, `makeFirewall`, `makeMeter`, `makeLogger`.
- Use `createX` for route builders or test fixtures that return a callable object: `createPublicRoutes`, `createAdminRoutes`, `createTestnet`.
- Use `loadX` for reading durable or process configuration: `loadConfig`, `loadOrCreateToken`, `loadAssets`.
- Use `openX` for durable resources that must be closed: `openRoster`.
- Use `XOrThrow` for boundary decoders that validate and throw: `decodeKeyOrThrow`.
- Keep key vocabulary precise:
  - `publicKeyZ32` means the operator-facing z-base-32 relay key.
  - `keyHex` means a decoded 32-byte key encoded as lowercase hex for internal maps.
  - `seed`, `seedHex`, and roster member seeds are secrets. Never call them keys in user-facing text.
- Keep operator-surface vocabulary precise:
  - `status` is the anonymous read-only browser page and JSON payload.
  - `members` is the token-gated management page under `/admin/`.
  - `adminWrite` controls `/admin/*` write/data endpoints, not the anonymous status page.
- Do not introduce vague synonyms such as `dashboard`, `panel`, `user`, or `client` when the domain term is `status page`, `members page`, `member`, `peer`, or `operator`.
- If editing declarations or typed helper files, use precise unions and object shapes. Do not add `any` or `unknown`.

## File And Module Organization

- Start from `src/index.js`. It is the composition root and the only place that should wire the full object graph.
- Organize code by relay domain and security boundary, not by historical file type.
- Keep compatibility facades thin. `src/admin-http.js`, `src/admin-ui.js`, `src/admin-page.js`, and `src/format.js` exist so older imports keep working; do not add new behavior there.
- Put HTTP boundary code under `src/operator/http/`:
  - `server.js` owns HTTP lifecycle and dispatch.
  - `host-guard.js` owns Host normalization and rebinding defense.
  - `responses.js` owns headers, JSON, cache, and method responses.
  - `body.js` owns request body parsing.
  - `keys.js` owns HTTP-safe key normalization.
  - `public-routes.js` owns anonymous read routes.
  - `admin-routes.js` owns token-protected admin data/write routes.
- Put status page code under `src/operator/status/`: server render, browser refresher, and status CSS stay together.
- Put members page code under `src/operator/members/`: static shell, browser client, and members CSS stay together.
- Put shared operator browser helpers in `src/operator/`: `assets.js`, `format.js`, and `copy-button.js`.
- Preserve public route URLs unless the change explicitly migrates an operator contract. Files may move; `/ui.css`, `/ui.js`, `/format.js`, `/copy-button.js`, `/admin/style.css`, `/admin/app.js`, and `/admin/copy-button.js` must remain covered by tests when used.
- Keep feature files cohesive. A file over about 250 lines deserves a split check; a file over about 400 lines needs a deliberate reason such as a static HTML template or a table-driven config surface.
- Do not create one-line wrapper files unless they are compatibility facades, browser URL facades, or feature-local import facades needed to preserve served routes.
- Do not read static assets at module import time. Read on first use through `src/operator/assets.js` so missing optional assets degrade to route 404s instead of preventing relay boot.

## Function And Class Design

- Keep functions single-purpose. A function that parses, authorizes, mutates state, and writes the response should be split at the boundary between those jobs.
- Prefer flat route dispatch and small route handlers over a monolithic HTTP function. See `src/operator/http/server.js`, `public-routes.js`, and `admin-routes.js`.
- Keep pure helpers near the domain they serve unless they are reused by both status and members pages.
- Use dependency injection for services that need config, metrics, logging, clocks, or live state. See `createRelay(cfg, opts)` in `src/index.js`.
- Use closure-owned state for small factories (`makeFirewall`, `makeMeter`) and class-owned state for lifecycle-heavy resources (`RelayNode`).
- Keep timers owned and stoppable. Any module that starts an interval, watcher, server, DHT node, or roster watch must expose a close/stop path and tests must clean it up.
- Avoid parameter lists longer than four positional values. Pass a named object when a function needs several collaborators or optional values, as in `createInvite({ req, res, roster, relay, logger })`.
- Decode and validate at boundaries. Convert z-base-32 or user-provided keys to `keyHex` before putting them in maps, metrics, bans, or session indexes.
- Centralize duplicated logic after the second use. Shared asset loading belongs in `src/operator/assets.js`; formatting belongs in `src/operator/format.js`; copy behavior belongs in `src/operator/copy-button.js`.
- Prefer explicit error translation at the boundary. Domain errors may carry `code` or `status`; HTTP modules turn them into status codes and JSON bodies.
- Do not silently recover from malformed durable state by replacing it with defaults. A malformed seed, token, or roster is a fault to report or a previous-good state to keep, not a reason to re-key or empty membership.

## Commenting Standard

- Comments explain why a rule exists, what invariant must be preserved, or what public contract a caller depends on.
- Do not comment what the next line already says.
- Do not leave anecdotal comments, dated notes, personal notes, debugging stories, or implementation archaeology.
- Do not leave commented-out code.
- Do not leave vague `TODO`, `FIXME`, `HACK`, or `XXX` markers. Put planned work in an issue or plan file.
- Do not add JSDoc for internal helpers whose signature is already clear from local use.
- Keep comments when they protect security, protocol, durability, operator behavior, or surprising platform behavior.
- Rewrite historical comments into current invariants.
- In tests, comment the invariant that makes an assertion non-obvious. Do not write "regression" as the reason; state the behavior that must hold.
- Treat comments embedded in rendered HTML as part of the served asset. Keep them short, present-tense, and operator-contract focused.
- Keep user-facing text distinct from source comments. Do not rewrite text that operators see unless the task intentionally changes the product wording.

Bad:

```js
// It was written twice and the copy immediately drifted, losing the
// clearTimeout guard that stops a second click's feedback being wiped.
```

Good:

```js
// Copy feedback is centralized so repeated clicks share the same timeout guard.
```

Bad:

```js
// This used to render the token into the shell and leaked it through view-source.
```

Good:

```js
// The unauthenticated shell must not contain member data or bearer credentials.
```

Bad:

```js
// Regression: nothing an existing operator configured changes behaviour.
```

Good:

```js
// Existing open-mode deployments keep their admission behavior.
```

## Anti-Patterns To Avoid

- God module: Do not put lifecycle, Host validation, headers, body parsing, public routes, admin routes, and asset loading in one admin HTTP file. Split by boundary under `src/operator/http/`.
- File-type organization: Do not scatter one feature across root-level `admin-ui.js`, `ui.js`, `ui.css`, and helper files. Co-locate status code under `src/operator/status/` and members code under `src/operator/members/`.
- Shotgun route surgery: Do not change a route URL in one asset map without updating route sets, integration tests, smoke/package expectations, and browser imports.
- Primitive key confusion: Do not pass raw strings through the core. Normalize at the edge and use `keyHex` internally.
- Secret leakage: Do not render, log, metric, or fixture seed material, admin tokens, roster member seeds, invite tickets, or member labels on anonymous surfaces.
- Silent re-keying: Do not generate a fresh identity as a fallback for malformed configured state. Stable relay identity is load-bearing.
- Static shell data leak: Do not embed member data, tickets, roster counts, or bearer credentials in the unauthenticated `/admin/` shell.
- Import-time asset dependency: Do not make CSS or browser JS a hard startup dependency for the relay process.
- Duplicate browser helpers: Do not reimplement formatting, clipboard copy, or asset ETag logic inside page-specific clients.
- Bug-history comments: Do not preserve the story of a past bug in source comments. Preserve the rule that prevents it.
- Assertion labels as comments: Do not add test comments that merely restate `assert.equal(...)`. Name the contract only when the assertion alone is not enough.
- Rendered-comment drift: Do not hide old implementation history inside HTML comments returned by `renderManagePage()` or `renderPage()`.
- Speculative abstraction: Do not introduce a framework, router library, bundler, or generic response abstraction unless the current change has concrete repeated code that it removes.
- Overloaded booleans: Do not infer access mode from whether a list is empty. Keep explicit config like `access: 'open' | 'invite'`.
- Unbounded live state: Do not create maps, timers, pending pairings, sessions, or refusal counters without a cap, expiry, or close path.

## Established Good Patterns

- Composition root: Build the full service from config in `src/index.js`, and have CLI and integration tests use the same wiring.
- Config table: Add options through the `OPTIONS` metadata table in `src/config.js`, filling in every field including `envExample` and `docsRequired`. `DEFAULTS`, the cli-args flag spec, the `--help` table and the docs drift guard are all derived from it, so an option added there cannot go missing from one of them. Every option is both a flag and a `MIRALL_RELAY_*` env var.
- CLI parsing: Parse every command line through `parseLongOptions` in `src/cli-args.js`. Do not hand-roll a second argv loop; `mirall-relay`, `invite`, `keygen`, and the probe must agree on `--flag value`, `--flag=value`, bare flags, positionals, and unknown-flag errors.
- Strict boot validation: Reject invalid config early. Do not coerce nonsense values into a running relay.
- Stable identity: Resolve the seed through `src/keys.js` and derive the HyperDHT identity once. Never log the seed.
- Relay lifecycle: Keep HyperDHT, blind-relay, session indexing, and teardown ownership inside `RelayNode` in `src/relay.js`.
- Firewall before session budget: Apply bans and membership before rate accounting so rejected unauthenticated peers do not consume admitted peers' budgets. See `src/firewall.js`.
- Meter polling: Enforce link caps from UDX `bytesReceived` sampling, not JS `data` events. See `src/meter.js`.
- Public projection: Build anonymous status data through `src/status.js`; keep labels, tickets, tokens, and seed material out of the status payload.
- HTTP responses: Use `src/operator/http/responses.js` for CSP, no-sniff headers, JSON, cache, 404, and 405 responses.
- Host guard: Use `src/operator/http/host-guard.js` for browser-facing paths; keep the conditional loopback/reverse-proxy rule centralized.
- Admin error translation: Keep malformed roster data as a server fault and malformed request data as a client fault in `src/operator/http/admin-routes.js`.
- Admin auth split: Serve the static `/admin/` shell and its static assets without bearer auth, but require bearer auth before returning names, tickets, bans, or roster data.
- Roster views: Keep `/admin/invites` as the token-protected roster view. Include tickets only when explicitly requested and only for active members.
- Asset maps: Use `src/operator/assets.js` and explicit route-to-file maps so package contents, cache headers, and served URLs stay visible.
- No-JavaScript status page: `src/operator/status/page.js` must render a complete status page without browser JavaScript; `refresh.client.js` only refreshes moving fields.
- DOM safety: Browser clients that render operator-provided labels must use `textContent` and DOM node creation, not `innerHTML`.
- Roster durability: `src/roster.js` treats the file as the source of truth, writes atomically, watches for external CLI edits, and keeps the previous membership on malformed reloads.
- Tests by layer: Unit tests live in `test/unit/*.test.js`, integration tests in `test/integration/*.test.js`, and Docker boot checks in `test/smoke/*.test.js`.
- Test helpers: Start relays through `test/helpers/make-relay.js` so tests exercise production wiring.

## Definition Of Done

- Read this file, `AGENTS.md`, and `.claude/testing.md` before changing code.
- Place new code in the folder that owns its domain and security boundary.
- Keep compatibility facades thin and behavior-free.
- Preserve route URLs, response statuses, headers, ETags, and auth boundaries unless the change explicitly updates the operator contract.
- Validate input at the boundary and use precise internal shapes after validation.
- Do not duplicate formatting, copy behavior, asset loading, key normalization, response writing, or route authorization logic.
- Review every added or changed comment against the commenting standard.
- For comment-only changes, verify the diff contains no executable branch, route, assertion, public string, status, header, or import change unless the task explicitly asked for one.
- Ensure no anonymous surface exposes secrets, tickets, member labels, or bearer credentials.
- Ensure every timer, watcher, socket, server, DHT node, roster handle, or interval has a close/stop path.
- Add or update tests at the layer the change touches:
  - Pure logic: unit tests.
  - `/admin/*`, status page, routes, headers, assets: unit plus integration tests.
  - Relay behavior, caps, membership enforcement, revocation, bans: integration tests.
  - Docker packaging or package contents: smoke tests.
  - Config options: config tests plus README, env example, and help text.
- Run `npm run lint` and the required test scripts from `.claude/testing.md`. Report skipped checks with the reason.
- Run `git diff --check` for comment/docs-only cleanups. Runtime tests may be skipped only when `.claude/testing.md` says the change has no runtime surface.
- Do not call work complete with an unreviewed dirty diff, unrelated edits, or unstated verification gaps.

## Maintenance

Update `.claude/coding.md` in the same change whenever a cleanup, review, bug fix, or architecture decision changes these conventions. Do not let this file drift behind the code.
