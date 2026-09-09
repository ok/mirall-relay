# mirall-relay

A **blind relay** for [Mirall](https://mirall.app). It connects two peers that
cannot reach each other directly — office Wi-Fi, mobile hotspots, symmetric NAT,
UDP-filtered networks — without ever being able to read what they send.

Anyone can run one. Start it, open `http://localhost:9200` for the public key and
whether the world can actually reach you, then paste that key into Mirall under
**Settings → Network**.

---

## What "blind" means here

The relay bridges two encrypted streams. The peers run their own Noise handshake
**over** the relayed connection, so the relay holds no session key and there is no
API through which it could produce plaintext.

The relay **cannot** see:

- who the peers are (their Mirall identities)
- which spaces they share
- file names, folder structure, or file contents

The relay **can** see, unavoidably, what any middlebox sees:

- the IP addresses of both peers, and that they are talking to each other
- when they talk, and how many bytes cross

If that metadata matters to you, run your own relay rather than using someone
else's. That is the point of this repository being public.

---

## Quick start (Docker)

```sh
# 1. Generate an identity. The PUBLIC KEY is what users paste into Mirall.
#    The SEED is secret: back it up, and never let it change.
docker run --rm ghcr.io/ok/mirall-relay:latest bin/mirall-relay.js keygen

# 2. Run it. The named volume is what keeps the identity stable.
docker compose up -d

# 3. Open the status page. It has the public key, a QR of it, whether you are
#    actually reachable, and the relayed-bytes counter.
open http://localhost:9200

# …or, on a headless host, ask the same questions over curl:
curl -s localhost:9200/readyz
# {"ready": true, "firewalled": false, "publicKey": "…"}
```

`"firewalled": true` — **Not reachable** on the page — means clients cannot reach
you. Open UDP 49737 and try again. A firewalled relay starts, logs an error,
returns 503 on `/readyz`, and serves nothing.

### Running it locally (Docker Desktop) — smoke test only

```sh
docker build -t mirall-relay:local .
docker volume create mirall-relay-data

docker run -d --name mirall-relay \
  -p 49737:49737/udp \
  -p 127.0.0.1:9200:9200/tcp \
  -v mirall-relay-data:/data \
  mirall-relay:local

open http://localhost:9200
```

On a laptop this will report **`"firewalled": true`** and `/readyz` will return
**503**, and that is correct: your machine is behind NAT, and on macOS/Windows
Docker Desktop adds a Linux VM in between. The container is healthy and every
endpoint works, but **it is not a usable relay** — no peer can hole-punch to it.
Use this to check the image, the endpoints and that the seed persists; use a host
with a public IP for anything real.

`network_mode: host` in `docker-compose.yml` is a **Linux** setting. On Docker
Desktop it does not attach to your machine's network, so comment it out and use
the `ports:` block instead.

> **Not a bug:** while firewalled, the `address` in the startup log shows a random
> high port rather than your configured one. HyperDHT reports its ephemeral client
> socket in that state. The `port` field in the same log line is the one to open
> in your firewall.

## Quick start (Node, no Docker)

```sh
npm ci --omit=dev
npm run keygen                  # prints the public key + seed
MIRALL_RELAY_SEED_FILE=./.keys/seed npm start
```

A `deploy/mirall-relay.service` systemd unit and a documented
`deploy/mirall-relay.env.example` are included.

---

## Requirements

- **Node.js 22+**
- **A public IP with unfiltered inbound/outbound UDP.** HyperDHT hole-punches to
  the relay itself; behind a NAT that it cannot traverse, the relay is useless.
- **Bandwidth.** Every relayed byte enters and leaves this host. Bandwidth, not
  CPU, is the cost of running a relay — pick a host that bills egress kindly.

---

## The image

The runtime stage is **distroless** — glibc, so the Holepunch native addons load
(Alpine/musl would mean building libsodium and libudx from source), but with no
shell, no package manager and no userland. It runs as uid `65532`, and the
prebuilt addons for the twelve architectures you are not building for are pruned
away, which is most of the difference between a ~280 MB image and a ~165 MB one.

The trade-off is deliberate: `docker exec <container> sh` does not exist. Debug
from outside with `docker logs`, the `/metrics` endpoint, and `scripts/probe.js`.

To run the CLI, override the command — the entrypoint is already node:

```sh
docker run --rm mirall-relay:local bin/mirall-relay.js keygen
docker run --rm mirall-relay:local bin/mirall-relay.js --help
```

---

## Configuration

Every option is available as an environment variable (`MIRALL_RELAY_*`) and as a
CLI flag. Run `mirall-relay --help` for the full list; the essentials:

| Env | Default | Notes |
|---|---|---|
| `MIRALL_RELAY_SEED_FILE` | `./.keys/seed` | Identity. Generated on first run, then **never change it**. |
| `MIRALL_RELAY_SEED` | — | 64-hex seed; overrides everything. Prefer a secret file. |
| `MIRALL_RELAY_SEED_SECRET_FILE` | `/run/secrets/relay_seed` | Mounted secret holding the seed. Read in-process; wins over `SEED_FILE`. |
| `MIRALL_RELAY_PORT` | `49737` | UDP port. Pin it so firewall rules stay stable. |
| `MIRALL_RELAY_ASSUME_REACHABLE` | `false` | Skip reachability probing. Only set it when you *know* the host is public. |
| `MIRALL_RELAY_ADMIN_HOST` | `127.0.0.1` | Admin/metrics/status-page bind. **Never expose publicly.** |
| `MIRALL_RELAY_ADMIN_UI` | `true` | The browser status page. `false` leaves only the JSON endpoints. |
| `MIRALL_RELAY_ADMIN_ALLOWED_HOSTS` | — | Extra `Host` values to accept. Only consulted on a loopback bind — see below. |
| `MIRALL_RELAY_ADMIN_WRITE` | `true` | The token-gated `/admin/*` surface. `false` removes it; the CLI still works. |
| `MIRALL_RELAY_ADMIN_TOKEN_FILE` | `./.keys/admin-token` | Bearer token for `/admin/*`. Minted on first boot and logged **once**. |
| `MIRALL_RELAY_ACCESS` | `open` | `open` or `invite`. `invite` admits only roster members. |
| `MIRALL_RELAY_ROSTER_FILE` | `./.keys/members.json` | The member roster. **As secret as the seed** — back it up with it. |
| `MIRALL_RELAY_ALLOWLIST` | — | Static keys admitted, unioned with the roster. |
| `MIRALL_RELAY_BANLIST` | — | These keys are refused, whatever the access mode. |
| `MIRALL_RELAY_MAX_SESSIONS_PER_KEY` | `64` | Sessions per peer **key**. See the note below. |
| `MIRALL_RELAY_MAX_ACTIVE_LINKS` | `2000` | Global bridged-stream ceiling (~1000 relayed connections). |
| `MIRALL_RELAY_MAX_LINK_RATE` | `4MiB` | Per link, **per direction**. |
| `MIRALL_RELAY_MAX_LINK_BYTES` | `512MB` | Per link, **per direction**. |
| `MIRALL_RELAY_REGION` / `_OPERATOR` | `unknown` | Labels shown in metrics and the capability doc. |

### Access control

A relay is in one of two modes, set explicitly with `MIRALL_RELAY_ACCESS`:

| Mode | Who may connect |
|---|---|
| `open` (default) | Anyone holding the public key. `BANLIST` and the caps are your only limits. |
| `invite` | Only people you have minted an invite for, plus any static `ALLOWLIST` keys. |

The mode is explicit on purpose. Emptiness used to mean "open", which under a
roster you can edit is a hazard: revoking your last member would silently reopen
the relay to the internet. In `invite` mode an **empty roster admits nobody**, and
the status page says so in those words.

#### Running a private relay

```sh
mirall-relay invite create ben
# member   ben
# key      mrgq43jtgdacci91sdt9fxogdzc7wxtcu71mqi45sgf6e61p3rxy
# invite   mirall://relay/ygqac38xcbqmffk19weyomkrzhny5qbt5oag7iqzbwscj4b88h…
```

Send the `invite` line to Ben; he pastes it into Mirall in place of a relay key.
It is a **bearer credential** — anyone holding it is Ben — so send it the way you
would send a password, and one per person rather than one per device.

```sh
mirall-relay invite list             # labels, keys, created, revoked
mirall-relay invite show ben         # reprint the ticket; he lost the message
mirall-relay invite revoke ben       # takes effect within ~5s, live sessions too
```

Inside the container the image is distroless, so run the CLI through the node
entrypoint directly:

```sh
docker exec mirall-relay /nodejs/bin/node bin/mirall-relay.js invite create ben
```

The same operations are available over HTTP at `/admin/*` for platforms with no
shell — see [Operator endpoints](#operator-endpoints).

**`members.json` is as sensitive as the seed.** It holds every member's seed, so
it is written `0600` and belongs in the same backup: losing it locks out every
member, and leaking it hands over every membership.

#### The lists

`ALLOWLIST` and `BANLIST` are comma- or space-separated z-base-32 or hex public
keys, validated at startup — a typo refuses to boot rather than silently locking
everyone out later. Both are enforced during the Noise handshake, so a refused
peer never reaches a session, a pairing, or a byte of bridged traffic. Refusals
are counted in `relay_sessions_rejected_total{reason=…}` and shown on the status
page as *refused in the last hour*.

`ALLOWLIST` is the static, config-managed half of the same admission set: the
effective set is the union of it and the roster. On its own, with `ACCESS` left
at `open`, it keeps its original meaning and makes the relay private to that
list. Setting `MIRALL_RELAY_ALLOWLIST=` (empty) means *unset*, not "allow
nobody" — that is what `ACCESS=invite` is for.

Two things to know before relying on any of it:

- **Both peers of a relayed connection must be admitted.** Each end dials the
  relay independently, so enrolling only one of them locks the pair out entirely.
  A private relay only helps its members reach *each other*.
- **A refused peer cannot tell why.** The rejection happens during the handshake,
  which is indistinguishable from the relay being offline. That is deliberate —
  a polite refusal would hand an unauthenticated attacker a handshake per
  attempt — so the diagnosis is operator-side: the refusal counter on the status
  page. A small non-zero count there is normal, not an attack: a member's own
  Mirall can offer this relay's key to their peers, who are then refused having
  never been given an invite.

For ad-hoc abuse handling on an open relay, prefer `BANLIST`; the meter also bans
a key automatically after repeated byte/rate cap violations.

### `MAX_SESSIONS_PER_KEY` counts members, not devices

Every relayed connection opens one session with the relay, and the key presented
is the peer's **DHT node key**. On an open relay a Mirall client regenerates that
key on every app start, so it identifies a running app. With an invite it is
derived from the ticket instead, which makes it stable — and shared across every
device that person installs Mirall on. Both of Mirall's planes share one DHT
node, so relaying to N peers costs `2 × N` sessions against that single key.

The default of `64` therefore allows roughly **32 relayed peers** per member,
across all of their devices, while capping any one key at about 3% of
`MAX_ACTIVE_LINKS`. For the case this is built for it is not close: a five-person
club means four peers each, eight sessions, so there is ~8× headroom before extra
devices. Lower it only if you are deliberately rationing a constrained relay.

Its second job in `invite` mode is anti-sharing: a ticket forwarded to twenty
people shows up as one key parked at the ceiling — visible, bounded, and harmless
to everybody else. The real enforcement is revocation.

### Caps are per direction

A relayed connection is two bridged streams, and each one only accounts the bytes
*entering* it. So `MAX_LINK_BYTES=512MB` allows up to 512 MB each way. This falls
out of how UDX's native forwarding works (see `src/meter.js`) and is documented
rather than silently halved.

---

## Operator endpoints

Bound to `127.0.0.1:9200` by default.

| Path | Purpose |
|---|---|
| `/` | **Status page.** Public key with copy and QR, the reachability verdict in plain language, live counters. |
| `/status.json` | Everything the page shows, as data. |
| `/qr.svg` | The public key as a scannable square, to save or print. |
| `/healthz` | Process is up. |
| `/readyz` | Listening, bootstrapped, and **not** firewalled. 503 otherwise. `probed` says whether that verdict was measured. |
| `/metrics` | Prometheus. See `deploy/prometheus-scrape.example.yml` for the alerts worth having. |
| `/.well-known/mirall-relay.json` | Public key, region, operator, caps. |

### The status page

Everything a relay operator needs and every mistake they can make, on one screen:
the key to publish, whether peers can actually reach you, where the seed is being
read from, and how many bytes you have paid for. It is server-rendered, so it works
with JavaScript disabled and `curl -s localhost:9200/ | grep` still finds the key;
with JavaScript it refreshes the counters every five seconds.

The page is **read-only and unauthenticated**, like the rest of the admin port. It
carries nothing secret — the seed is never rendered, only the path it is read from.
There is deliberately no "test reachability" button: that would let an
unauthenticated port be made to do work. Use `scripts/probe.js` from another
machine instead.

**Host checking.** A page on the internet can point its own hostname at
`127.0.0.1` and read this port out of your browser (DNS rebinding). The request
still carries the name the browser resolved, so:

- When the admin server is **bound to loopback**, a `Host` that is neither a
  loopback name nor an IP literal is refused with 403.
- On **any other bind** the check is off by default, because a platform proxy
  (Umbrel, StartOS) legitimately sets its own `Host` and the process cannot tell
  from its bind address whether the port is private.
- Setting `MIRALL_RELAY_ADMIN_ALLOWED_HOSTS` **turns the check on regardless of
  bind**, and adds those names to it. This is how a container deployment opts in —
  `docker run -p 127.0.0.1:9200:…` binds `0.0.0.0` inside the container, so the
  default cannot protect it.

The check covers only the browser surface (`/`, `/status.json`, `/qr.svg` and the
page assets). `/healthz`, `/readyz`, `/metrics` and the capability doc keep their
previous contract, because deployments address them by hostname — a Prometheus
target, an `/etc/hosts` alias — and 403ing those on upgrade would take monitoring
down while looking like a network fault. If `/metrics` being readable matters to
you, put authentication in front of the port.

**Behind a path-prefix proxy**, mount the page at a path with a trailing slash
(`/relay/`, not `/relay`). Every URL on the page is document-relative so that a
prefix works at all, and a browser resolves `ui.css` under `/relay` as `/ui.css`.

---

## Verifying a deployment

```sh
node scripts/probe.js --relay <your-public-key>
# {"ok": true, "bridged": true, "bytes": 262144, "throughputMbps": 149.8}
```

Two throwaway nodes pair through the relay exactly the way a real peer pair does,
push a payload across, and measure it. Exit `0` means the relay bridged real
traffic; exit `1` means it did not.

The probe pairs through the relay *directly* rather than using `relayThrough`,
because both of its peers run on one host: they would hole-punch to each other and
hyperdht would abandon the relayed path, producing a green result that proves
nothing about the relay.

---

## Using it from Mirall

Mirall reaches a relay purely by its public key — there is no host, port, token or
account. Paste the key into **Settings → Network → Add a relay**, and use **Test**
to confirm reachability.

Relaying only engages when a direct connection cannot be made, so configuring a
relay costs nothing on networks that work.

**Configure it on both peers when you can.** One side is enough for a connection
to succeed, but the recovery path is asymmetric: if the peer *without* a relay is
the one behind the restrictive network, the connection only recovers after the
other side's direct attempt times out.

---

## Development

```sh
npm ci
npm run lint
npm test              # unit + integration (integration spins up a local DHT testnet)
npm run test:smoke    # builds and runs the Docker image
```

The integration suite runs a real relay against a real (local) HyperDHT and proves
the load-bearing behaviours: relayed connections work, byte counters advance on
natively-bridged streams, every cap tears real bridges down, and admission control
holds.

---

## Security

- The seed is the only secret and the only durable state. Losing it strands every
  client configured with the derived public key. Back it up offline.
- The admin port exposes internals; keep it on loopback or a private network. That
  includes the status page, which is unauthenticated. It shows the seed's *path*,
  never the seed.
- The status page states whether the identity was **read** from that path or
  **generated on this start**. A relay that generated one is one restart away from
  a different public key unless the path is persistent storage.

See [SECURITY.md](SECURITY.md) for what to report, what is already known and
documented, and how to reach us privately.

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE).
