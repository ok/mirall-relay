import idEnc from 'hypercore-id-encoding'
import { accessBlock } from '../../status.js'
import { readJson } from './body.js'
import { hexOfKey } from './keys.js'
import { json, notFound } from './responses.js'

export function createAdminRoutes ({ cfg, relay, firewall, roster, meter, logger }) {
  return async function adminRoute (req, res, path) {
    const [, , resource, ...rest] = path.split('/')
    const reveal = /[?&]reveal=1(&|$)/.test(req.url || '')

    try {
      const id = rest.length ? decodeURIComponent(rest.join('/')) : null

      if (resource === 'invites' && req.method !== 'DELETE' && !relay.publicKey) {
        return json(res, 503, { error: 'no identity yet' })
      }

      if (resource === 'invites' && req.method === 'POST' && !id) {
        return await createInvite({ req, res, roster, relay, logger })
      }

      if (resource === 'invites' && req.method === 'GET' && !id) {
        return listInvites({ res, cfg, firewall, roster, meter, relay, reveal })
      }

      if (resource === 'invites' && req.method === 'GET' && id) {
        return showInvite({ res, roster, meter, relay, id, reveal })
      }

      if (resource === 'invites' && req.method === 'DELETE' && id) {
        return revokeInvite({ res, roster, relay, logger, id })
      }

      if (resource === 'bans' && req.method === 'POST' && !id) {
        return await createBan({ req, res, firewall, relay })
      }

      if (resource === 'bans' && req.method === 'DELETE' && id) {
        return deleteBan({ res, firewall, id })
      }

      return notFound(res)
    } catch (err) {
      // Malformed roster data is a server fault; malformed request data is a
      // client fault. Keep that distinction centralized at the HTTP boundary.
      const BY_CODE = { duplicate: 409, 'not-found': 404, malformed: 500 }
      const status = err.status || BY_CODE[err.code] || (err.code ? 400 : 500)
      if (status >= 500) logger?.warn({ err: err.message, path }, 'admin write failed')
      return json(res, status, { error: err.code || 'internal error', message: err.message })
    }
  }
}

async function createInvite ({ req, res, roster, relay, logger }) {
  const { label } = await readJson(req)
  const member = roster.add(label)
  logger?.info({ label: member.label }, 'invite minted')
  return json(res, 201, {
    label: member.label,
    publicKey: member.publicKey,
    created: member.created,
    ticket: roster.ticketFor(member.label, relay.publicKey)
  })
}

function listInvites ({ res, cfg, firewall, roster, meter, relay, reveal }) {
  // /admin/invites is the token-protected roster view. Tickets are included only
  // when explicitly requested and only for active members.
  const members = roster.listPublic().map((m) => ({
    ...m,
    sessions: meter.sessionCount(hexOfKey(m.publicKey)),
    ...(reveal && !m.revoked ? { ticket: roster.ticketFor(m.label, relay.publicKey) } : {})
  }))
  return json(res, 200, {
    relay: { publicKey: relay.publicKeyZ32 },
    access: accessBlock(cfg, firewall, roster),
    members
  })
}

function showInvite ({ res, roster, meter, relay, id, reveal }) {
  const member = roster.get(id)
  return json(res, 200, {
    label: member.label,
    publicKey: member.publicKey,
    created: member.created,
    revoked: member.revoked,
    sessions: meter.sessionCount(hexOfKey(member.publicKey)),
    ...(reveal && !member.revoked ? { ticket: roster.ticketFor(member.label, relay.publicKey) } : {})
  })
}

function revokeInvite ({ res, roster, relay, logger, id }) {
  const revoked = roster.revoke(id)
  const closed = revoked.keyHex ? relay.destroySessionsFor(revoked.keyHex) : 0
  logger?.warn({ label: revoked.label, sessions: closed }, 'invite revoked')
  return json(res, 200, { label: revoked.label, revoked: revoked.revoked, sessionsClosed: closed })
}

async function createBan ({ req, res, firewall, relay }) {
  const { key, ttlMs } = await readJson(req)
  const keyHex = hexOfKey(key)
  const ttl = banTtl(ttlMs)
  firewall.ban(keyHex, ttl)
  const closed = relay.destroySessionsFor(keyHex)
  return json(res, 200, {
    key: idEnc.normalize(String(key).trim()),
    permanent: ttl === null,
    ttlMs: ttl,
    sessionsClosed: closed
  })
}

function deleteBan ({ res, firewall, id }) {
  const keyHex = hexOfKey(id)
  return json(res, 200, { key: idEnc.normalize(id), wasBanned: firewall.unban(keyHex) })
}

function banTtl (value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error('ttlMs must be a positive number of milliseconds'), { status: 400 })
  }
  return value
}
