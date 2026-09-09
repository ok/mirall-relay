# Security Policy

## Reporting a vulnerability

Please **do not report security vulnerabilities through public GitHub issues.**

Email **security@mirall.app** instead. Include as much of the following as you can:

- A description of the issue and its impact
- Steps to reproduce (a proof of concept helps a lot)
- The `mirall-relay` version or commit, and how it is deployed (Docker / systemd)

You will receive an acknowledgement, typically within a few days. Please give us
reasonable time to investigate and ship a fix before any public disclosure.

Anyone can run their own relay, so a fix here does not reach operators
automatically the way an app update does — expect coordinated disclosure to
include a window for operators to upgrade.

## What this service is trusted with

A relay bridges **end-to-end-encrypted** streams between two peers. It holds no
session key and exposes no API that could produce plaintext, so it cannot read
peer identities, space topics, file names or file contents.

Findings that break that property are the most serious thing you can report.
Also in scope:

- Anything that lets a client make the relay dial a target of its choosing
  (connection laundering / amplification). The token-pairing model is specifically
  chosen to make this impossible; a way around it is a real vulnerability.
- Bypassing admission control (`ACCESS` / `ALLOWLIST` / `BANLIST`), invite
  membership, or the byte, rate, duration and concurrency caps.
- Bypassing the `/admin/*` bearer token, or reaching any write through the
  anonymous status surface.
- Anything that exposes the seed, a member seed or ticket, a member label, the
  admin token, a pairing token, or relayed payload bytes — in logs, metrics, the
  admin HTTP surface, or an error path.
- Remote crash or unbounded resource growth from untrusted input.

## Known and documented, not vulnerabilities

These are properties of the design, stated plainly in the README so operators can
make an informed choice:

- **A relay operator sees peer IP addresses, connection timing and byte counts.**
  This is unavoidable for any middlebox. If that metadata matters to you, run your
  own relay.
- **There is currently no global session cap.** A peer that connects and never
  pairs consumes a session without creating a bridge. Per-key limits apply;
  globally it is bounded by memory. Allowlist mode closes this entirely. A global
  cap is planned.
- **The admin HTTP surface exposes internals.** It binds to `127.0.0.1` by
  default; exposing it publicly is a misconfiguration, not a vulnerability. The
  bearer token protects the `/admin/*` writes, not the port.
- **An invite ticket is a bearer credential.** Anyone the holder forwards it to
  becomes that member. There is no cryptographic fix while a person's devices
  share one member key; the controls are `MAX_SESSIONS_PER_KEY` and revocation.
- **A private relay is blind to content, not to who talks to whom.** An invite
  gives the operator a *stable* member identity, and therefore a persistent
  record of which member paired with which, and when. This is the price of
  membership and is stated in the client UI as well as here.
- **A refused peer cannot tell why.** The firewall rejects during the handshake,
  which is indistinguishable from the relay being offline. A "polite refusal"
  would hand an unauthenticated attacker a handshake per attempt, so the
  diagnosis is deliberately operator-side.

## Supported versions

The latest release on `main` is the supported version. There are no long-term
support branches.

## Operator responsibilities

- Keep the **seed** secret and backed up. It is the relay's identity and the only
  durable state; losing it strands every client configured with the derived key.
- Keep the admin port off the public internet.
- Keep `hyperdht` in lockstep with the version Mirall ships — see `OPERATIONS.md` §8.
