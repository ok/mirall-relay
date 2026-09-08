# Operations runbook

Everything you need to run `mirall-relay` in production and to fix it when it
misbehaves. Read §1 before the first deploy; the rest is reference.

---

## 1. Key ceremony (once per relay, forever)

The relay's identity is an ed25519 keypair derived from a 32-byte seed. Clients
configure the **public key**. The **seed** is the only secret and the only durable
state in the entire service.

```sh
mirall-relay keygen --out /var/lib/mirall-relay/seed
```

1. Store the seed in your secret manager **and** keep an offline backup.
2. Record the public key. This is what you publish and what users paste.
3. Verify the file is `0600` and owned by the service user.
4. Open the status page (`http://localhost:9200`) and check the **Identity seed**
   line. It names the file the running process read, and — the part that matters —
   says in red when the identity was *generated on this start* rather than found.
   A path inside a container with no volume mounted at it looks perfectly healthy
   right up to the moment the container is replaced; this is the one place that
   distinguishes the two before it costs you the key.

**Losing the seed is unrecoverable.** Every client configured with the derived
public key will silently fail to reach you, exactly like losing an OTA signing
key. There is no rotation grace period built into the protocol — see §7.

Never let the seed change by accident. The two ways that happens:

- running the container without a mounted `/data` volume
- an empty `MIRALL_RELAY_SEED_FILE` path on a fresh host

Both mint a new identity on boot and look completely healthy.

---

## 2. Host sizing

The relay is **bandwidth-bound, not CPU-bound**. It forwards packets in UDX's
native path; the JS process barely participates.

- A small VPS (1–2 vCPU, 1–2 GB RAM) is plenty of compute.
- **Egress is the entire cost.** Every relayed byte enters (usually free) and
  leaves (usually billed) once, so the monthly bill tracks ≈ 1× the relayed
  volume.
- Pick a host that bills egress generously. Providers that include tens of TB, or
  a dedicated line with unmetered traffic, are an order of magnitude cheaper than
  hyperscaler egress for this workload.
- Do not co-locate a relay with latency-sensitive or bandwidth-hungry services.
  A relayed transfer will happily saturate the NIC up to your configured caps.

Requirements that are not negotiable:

- a public IP
- inbound and outbound UDP unfiltered on `MIRALL_RELAY_PORT`
- a stable external port mapping (see §3)

---

## 3. Networking and reachability

HyperDHT hole-punches **to the relay itself**, so the relay must be directly
reachable. Verify after every deploy — the status page states the verdict and, when
it is bad, the steps:

```sh
open http://localhost:9200          # or, headless:
curl -s localhost:9200/readyz
# {"ready":true,"firewalled":false,"publicKey":"…"}
```

`firewalled: true` → clients cannot reach you. Check, in order: the host firewall,
the cloud security group, and whether the UDP port is actually forwarded.

Two states the page separates that `/readyz` does not:

- **Assumed reachable.** `MIRALL_RELAY_ASSUME_REACHABLE` makes `firewalled` read
  `false` whether or not anything was measured. The page says so in words;
  `/readyz` reports it as `probed: false` and `/metrics` as
  `relay_reachability_probed 0`. Anything consuming only `firewalled` — a
  platform health check, an uptime probe — is reporting a fact nobody
  established.
- **Symmetric NAT.** A NAT that assigns a different external port per destination
  reports `firewalled: false` and is still unusable as a relay. The page raises it
  from `dht.randomized`; nothing else does.

**Docker networking.** `network_mode: host` is the reliable choice. Publishing
UDP with `-p 49737:49737/udp` works on many hosts but Docker's userland proxy and
conntrack can rewrite the external mapping in ways that degrade hole-punch success
and are miserable to diagnose. If you must publish rather than share the host
network, verify with `scripts/probe.js` from a *different* machine, not just
`/readyz`.

**`MIRALL_RELAY_ASSUME_REACHABLE`** skips hyperdht's own probing. Set it only when
you know the host is public — setting it while actually firewalled produces a
relay that confidently advertises itself and then fails every connection.

---

## 4. Verifying a deployment

```sh
# from any machine
node scripts/probe.js --relay <public-key>
```

| Exit | Meaning |
|---|---|
| `0` | The relay bridged real traffic. Output includes bytes and measured throughput. |
| `1` | It did not. The `error` field says which step failed — connect, pair, or carry. |

Run it from a *different* machine as well as from the host. A relay can look
perfect on `/readyz` and still be unreachable from the outside if the UDP port is
filtered upstream.

Then confirm the counters moved:

```sh
curl -s localhost:9200/metrics | grep -E 'relay_(sessions|pairings|bytes|links)'
```

---

## 5. Monitoring

Scrape `/metrics` (see `deploy/prometheus-scrape.example.yml`). The alerts that
actually matter:

| Signal | Why it matters |
|---|---|
| `relay_dht_firewalled == 1` | You are advertising a key nobody can reach. |
| `relay_reachability_probed == 0` | Reachability was asserted, not measured — so the row above is forced to 0 and can never fire. |
| `relay_ready == 0` | Not listening or not bootstrapped. |
| `relay_links_active` near `maxActiveLinks` | About to start refusing connections. |
| `rate(relay_bytes_relayed_total[1h])` | Your bill. Project it monthly against your egress budget. |
| `relay_sessions_rejected_total{reason=...}` | `banned` / `not-allowlisted` is normal; a spike in `pending-pairings` or `session-rate` is abuse or misconfiguration. |
| `relay_links_torn_by_cap_total{cap="rate"}` | Caps are biting legitimate transfers — either abuse, or your caps are too tight. |

Logs are JSON on stdout (journald/Docker friendly). Remote **public keys** are
logged, because they are the only handle you have on an abusive peer. Seeds,
tokens and payloads never are.

---

## 6. Incident response

### A peer is abusing the relay

1. Find the key in the logs — cap teardowns log `key`.
2. Add it to `MIRALL_RELAY_BANLIST` and restart, or flip to allowlist mode with
   `MIRALL_RELAY_ALLOWLIST` for a members-only relay.
3. The meter also bans automatically after repeated byte/rate violations from the
   same key (duration teardowns never ban — a slow honest transfer is not abuse).

The blast radius is bounded by design: token-pairing means a client can only ever
burn **its own** relayed bandwidth. It cannot make the relay dial a third party,
which is precisely why this relay does not implement forwarding.

### Egress is running away

Lower `MIRALL_RELAY_MAX_LINK_RATE` and `MIRALL_RELAY_MAX_ACTIVE_LINKS` and
restart. Both take effect for new links immediately.

### The relay is up but nothing connects

In order: the status page's reachability verdict (or `/readyz` → `firewalled`); UDP
reachability from outside; whether the published public key matches the one on the
page (a lost seed is the usual cause — check the **Identity seed** line);
`scripts/probe.js` from another machine.

### Restart

Shutdown is graceful on SIGTERM: the meter stops, blind-relay sessions close, the
DHT server closes, the node is destroyed. In-flight relayed connections drop —
clients re-establish, falling back to a direct path if one exists. Restarting a
relay is disruptive but not damaging.

---

## 7. Rotating the identity

There is no protocol-level rotation. Do it by overlap:

1. Stand up a **second** relay with a new identity.
2. Publish both keys; clients accept a list and pick one per connection.
3. Wait until you are confident clients have the new key.
4. Retire the old one.

Never hard-cut: the moment the old key stops answering, every client that only has
the old key loses its relay.

---

## 8. Upgrades and version lockstep

The relay must stay wire-compatible with the HyperDHT version Mirall ships.
`hyperdht` is pinned to an exact version in `package.json` for this reason — a
caret range would float it into a version the clients cannot talk to, and the
symptom is "connections mysteriously stopped working", not a build failure.

When Mirall bumps hyperdht, bump it here in the same change and re-run the
integration suite.

---

## 9. Backup

Back up exactly one thing: the seed.

```sh
# the whole of your durable state
cp /var/lib/mirall-relay/seed <offline-backup>
```

Everything else — sessions, links, meter samples, metrics — is in-memory and
disposable by design.
