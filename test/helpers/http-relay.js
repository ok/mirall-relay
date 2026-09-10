// One startup path and one set of request shapes for the operator HTTP surface,
// shared by every integration test that drives the admin port.
import fs from 'node:fs'
import http from 'node:http'
import { createTestnet, startTestRelay } from './make-relay.js'

// Start a relay with its admin server listening, and register teardown before
// returning so a failing assertion cannot leak a testnet.
export async function withHttpRelay (t, overrides = {}, opts = {}) {
  const testnet = await createTestnet(4)
  const relay = await startTestRelay(testnet, overrides, { admin: true, ...opts })
  t.after(async () => { await relay.stop(); await testnet.destroy() })
  return httpRelay(relay, testnet)
}

// The same view over a relay a test started itself, for the few that own their
// own shutdown ordering.
export function httpRelay (relay, testnet) {
  const { port } = relay.admin.server.address()
  return {
    ...relay,
    testnet,
    port,
    base: `http://127.0.0.1:${port}`,
    adminToken: readAdminToken(relay)
  }
}

function readAdminToken (relay) {
  if (!relay.auth) return null
  if (relay.cfg.adminToken) return String(relay.cfg.adminToken).trim()
  return fs.readFileSync(relay.cfg.adminTokenFile, 'utf8').trim()
}

export function urlOf (relay, path) {
  return relay.base + path
}

export async function request (url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', ...opts })
  const body = await res.text()
  return { res, statusCode: res.status, headers: Object.fromEntries(res.headers), body }
}

export async function jsonRequest (url, opts = {}) {
  const body = opts.body === undefined || typeof opts.body === 'string'
    ? opts.body
    : JSON.stringify(opts.body)
  const out = await request(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...opts.headers },
    body
  })
  return { ...out, json: out.body ? JSON.parse(out.body) : null }
}

export function bearer (token) {
  return { authorization: `Bearer ${token}` }
}

export function adminHeaders (token, extra = {}) {
  return { ...bearer(token), ...extra }
}

// Host is a forbidden header for fetch(), which sends the real one instead of
// failing, so every Host-guard assertion has to go out over node:http.
export function rawHttpRequest ({ port, path = '/', host, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: host === undefined ? { ...headers } : { host, ...headers }
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
