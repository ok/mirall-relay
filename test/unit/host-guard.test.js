// The DNS-rebinding guard, as a table. The integration suite proves it is wired
// into the server; this proves the rule itself, including the cases that would
// break a real deployment if it were stricter.
import test from 'node:test'
import assert from 'node:assert/strict'
import { hostAllowed, guardsHost } from '../../src/admin-http.js'

const loopback = { adminHost: '127.0.0.1', adminAllowedHosts: null }

test('a loopback bind accepts loopback and IP-literal Hosts', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:9200', 'localhost', 'localhost:9200', '[::1]:9200', '[::1]', '0.0.0.0:9200', '192.168.1.5:9200']) {
    assert.equal(hostAllowed(loopback, host), true, host)
  }
})

test('a loopback bind refuses a DNS name it was not told about', () => {
  // Which is the whole attack: the browser resolved evil.example to 127.0.0.1 and
  // still sends the name it looked up.
  for (const host of ['evil.example', 'evil.example:9200', 'rebind.attacker.test']) {
    assert.equal(hostAllowed(loopback, host), false, host)
  }
})

test('named hosts are accepted once the operator names them', () => {
  const cfg = { adminHost: '127.0.0.1', adminAllowedHosts: ['relay.internal'] }
  assert.equal(hostAllowed(cfg, 'relay.internal'), true)
  assert.equal(hostAllowed(cfg, 'relay.internal:9200'), true)
  assert.equal(hostAllowed(cfg, 'other.internal'), false)
})

test('any other bind turns the guard off entirely', () => {
  // Umbrel, StartOS and our own Dockerfile all bind 0.0.0.0 behind a proxy that
  // sets its own Host. Guarding there would break every container deployment and
  // buy nothing: the port is directly reachable anyway.
  for (const adminHost of ['0.0.0.0', '::', '10.0.0.4']) {
    assert.equal(hostAllowed({ adminHost, adminAllowedHosts: null }, 'anything.example'), true, adminHost)
  }
})

test('an empty Host is refused, unlike an absent one', () => {
  // Node answers a MISSING Host on HTTP/1.1 with 400 itself, so the only way a
  // blank string reaches us is a client that chose to send `Host:` with nothing
  // after it. Treating that as "no Host header" made the guard allow-on-blank.
  assert.equal(hostAllowed(loopback, undefined), true, 'HTTP/1.0 genuinely sends none')
  assert.equal(hostAllowed(loopback, ''), false)
  assert.equal(hostAllowed(loopback, '   '), false)
})

test('Host matching is case- and trailing-dot-insensitive', () => {
  // A browser lowercases the authority and a resolver may append the root dot;
  // neither should turn into a 403 the operator cannot explain.
  for (const host of ['LOCALHOST', 'LocalHost:9200', 'localhost.', 'localhost.:9200']) {
    assert.equal(hostAllowed(loopback, host), true, host)
  }
  const named = { adminHost: '127.0.0.1', adminAllowedHosts: ['Relay.Internal'] }
  assert.equal(hostAllowed(named, 'relay.internal'), true, 'config case must not matter')
  assert.equal(hostAllowed(named, 'RELAY.INTERNAL.'), true)
})

test('the whole 127.0.0.0/8 range counts as a loopback bind', () => {
  // 127.0.0.2 is a common multi-tenant pattern; treating it as non-loopback took
  // the guard from enforcing to inert with no visible difference.
  for (const adminHost of ['127.0.0.1', '127.0.0.2', '127.1.2.3', '::1', 'localhost']) {
    assert.equal(guardsHost({ adminHost, adminAllowedHosts: null }), true, adminHost)
    assert.equal(hostAllowed({ adminHost, adminAllowedHosts: null }, 'evil.example'), false, adminHost)
  }
})

test('naming hosts turns the guard on even where the bind would not', () => {
  // The Dockerfile binds 0.0.0.0 and the README publishes it to host loopback, so
  // the bind alone cannot tell us the port is private. Naming a host is the
  // operator saying it is.
  const cfg = { adminHost: '0.0.0.0', adminAllowedHosts: ['relay.internal'] }
  assert.equal(guardsHost(cfg), true)
  assert.equal(hostAllowed(cfg, 'relay.internal'), true)
  assert.equal(hostAllowed(cfg, 'evil.example'), false)
})

test('an unbracketed IPv6 Host is not mangled into a different host', () => {
  assert.equal(hostAllowed(loopback, '::1'), true)
  assert.equal(hostAllowed(loopback, '[::1]'), true)
  assert.equal(hostAllowed(loopback, '[::ffff:127.0.0.1]:9200'), true)
})
