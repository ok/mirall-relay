// A stand-in for a UDX raw stream, exposing exactly the surface the meter reads.
//
// Deliberately only implements `bytesReceived` — mirroring the measured fact that
// `bytesTransmitted` stays 0 on a relayTo()-bridged stream. If the meter ever
// starts reading tx again, these fakes will make that visible instead of hiding
// it behind a plausible-looking number.
import { EventEmitter } from 'node:events'

export class FakeStream extends EventEmitter {
  constructor () {
    super()
    this.bytesReceived = 0
    this.bytesTransmitted = 0 // always 0 under relayTo — see src/meter.js
    this.destroyed = false
  }

  receive (n) {
    this.bytesReceived += n
    return this
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }
}

export function fakeStream () {
  return new FakeStream()
}

// A metrics double with the same shape as src/metrics.js but readable counters.
export function fakeMetrics () {
  const counters = new Map()
  const key = (name, labels) => name + (labels ? ':' + JSON.stringify(labels) : '')
  const counter = (name) => ({
    inc: (labelsOrValue = 1, maybeValue) => {
      const labels = typeof labelsOrValue === 'object' ? labelsOrValue : null
      const value = typeof labelsOrValue === 'object' ? (maybeValue ?? 1) : labelsOrValue
      const k = key(name, labels)
      counters.set(k, (counters.get(k) || 0) + value)
    }
  })
  const gauge = (name) => ({
    set: (labelsOrValue, maybeValue) => {
      const labels = typeof labelsOrValue === 'object' ? labelsOrValue : null
      const value = typeof labelsOrValue === 'object' ? maybeValue : labelsOrValue
      counters.set(key(name, labels), value)
    }
  })

  return {
    m: {
      sessionsAccepted: counter('sessionsAccepted'),
      sessionsRejected: counter('sessionsRejected'),
      linksActive: gauge('linksActive'),
      linksOpened: counter('linksOpened'),
      linksTornByCap: counter('linksTornByCap'),
      bytesRelayed: counter('bytesRelayed'),
      dhtFirewalled: gauge('dhtFirewalled'),
      ready: gauge('ready')
    },
    read (name, labels) { return counters.get(key(name, labels)) || 0 }
  }
}

export function fakeFirewall () {
  const banned = new Set()
  return {
    firewall: () => false,
    ban: (k) => banned.add(k),
    unban: (k) => banned.delete(k),
    isBanned: (k) => banned.has(k),
    gc () {},
    stop () {},
    _banned: banned
  }
}
