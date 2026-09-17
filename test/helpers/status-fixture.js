// The status snapshot the page renders from. Shared so a test about both operator
// pages does not carry a second, drifting copy of it.
export const KEY = 'yb3dq6h9c1x8kwmp4z7ejr5tn9adg2hf6bcxsq8vw3ymp4z7ejab'

export function statusFixture (overrides = {}) {
  const base = {
    service: 'mirall-relay',
    version: '0.1.0',
    ready: true,
    startedAt: new Date().toISOString(),
    uptimeSeconds: 11520,
    labels: { region: 'eu-fsn1', operator: 'example' },
    identity: { publicKey: KEY, seedFrom: 'file', seedPath: '/data/seed', seedCreated: false },
    reachability: {
      state: 'reachable',
      firewalled: false,
      probed: true,
      port: 49737,
      bindHost: '0.0.0.0',
      publicHost: '203.0.113.9',
      publicPort: 49737,
      portRandomized: false,
      bootstrapped: true,
      ephemeral: false,
      ephemeralConfigured: false,
      inRoutingTable: true,
      dhtNodes: 128,
      bound: { host: '0.0.0.0', port: 49737, family: 4 }
    },
    traffic: {
      bytesRelayed: 1536 * 1024 * 1024,
      linksActive: 2,
      linksOpened: 41,
      linksTornByCap: {},
      linksTornByCapTotal: 0,
      sessionsAccepted: 19,
      sessionsRejected: {},
      sessionsRejectedTotal: 0,
      pairings: { requested: 20, matched: 20, cancelled: 0, pending: 0, active: 1 },
      sessions: { accepted: 19, active: 2 }
    },
    caps: {
      maxSessionsPerKey: 64,
      maxActiveLinks: 2000,
      maxLinkBytes: 512 * 1024 * 1024,
      maxLinkRateBytesPerSecond: 4 * 1024 * 1024,
      maxLinkDurationMs: 3600000
    },
    access: { mode: 'open', allowlisted: null, banned: 0, members: null, refusedLastHour: 0, managed: true },
    privacy: 'This relay bridges end-to-end-encrypted streams.'
  }
  return {
    ...base,
    ...overrides,
    reachability: { ...base.reachability, ...(overrides.reachability || {}) },
    identity: { ...base.identity, ...(overrides.identity || {}) }
  }
}
