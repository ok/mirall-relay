import http from 'node:http'
import { managePaths } from '../../admin-page.js'
import { uiPaths } from '../../admin-ui.js'
import { createAdminRoutes } from './admin-routes.js'
import { createPublicRoutes } from './public-routes.js'
import { hostAllowed } from './host-guard.js'
import { BASE_HEADERS, cached, json, methodNotAllowed, notFound } from './responses.js'

export function makeAdminServer (cfg, deps) {
  const { auth, logger } = deps
  const adminRoute = createAdminRoutes({ cfg, ...deps })
  const publicRoute = createPublicRoutes({ cfg, ...deps })

  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0]
    const isAdmin = path === '/admin' || path.startsWith('/admin/')
    const guardedBrowserPath = uiPaths.has(path) || isAdmin

    if (guardedBrowserPath && !hostAllowed(cfg, req.headers.host)) {
      return forbiddenHost(res, req, path, logger)
    }

    if (isAdmin) return dispatchAdmin(req, res, path, { cfg, auth, logger, adminRoute })
    return dispatchPublic(req, res, path, { logger, publicRoute })
  })

  return lifecycle(server, cfg, logger)
}

function forbiddenHost (res, req, path, logger) {
  logger?.warn(
    { host: req.headers.host, path },
    'refused a request whose Host is neither loopback nor in MIRALL_RELAY_ADMIN_ALLOWED_HOSTS'
  )
  return json(res, 403, {
    error: 'host not allowed',
    hint: 'add this Host to MIRALL_RELAY_ADMIN_ALLOWED_HOSTS if it is a proxy you run'
  })
}

function dispatchAdmin (req, res, path, { cfg, auth, logger, adminRoute }) {
  if (!cfg.adminWrite || !auth) return notFound(res)

  if (path === '/admin') {
    res.writeHead(308, { ...BASE_HEADERS, location: 'admin/', 'content-length': 0 })
    return res.end()
  }

  const page = managePaths().get(path)
  if (page) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
    return cached(req, res, page.body, page.type, page.etag)
  }

  if (!auth.check(req.headers.authorization)) {
    res.setHeader('www-authenticate', 'Bearer realm="mirall-relay"')
    return json(res, 401, { error: 'unauthorized' })
  }

  return adminRoute(req, res, path).catch((err) => {
    logger?.warn({ err: err.message, path }, 'admin request failed')
    if (!res.headersSent) json(res, 500, { error: 'internal error' })
  })
}

async function dispatchPublic (req, res, path, { logger, publicRoute }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)

  try {
    return await publicRoute(req, res, path)
  } catch (err) {
    logger?.warn({ err: err.message, path }, 'admin request failed')
    return json(res, 500, { error: 'internal error' })
  }
}

function lifecycle (server, cfg, logger) {
  server.on('error', (err) => logger?.error({ err: err.message }, 'admin server error'))

  return {
    server,
    listen () {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.adminPort, cfg.adminHost, () => {
          server.removeListener('error', reject)
          logger?.info({ host: cfg.adminHost, port: cfg.adminPort, ui: cfg.adminUi !== false }, 'admin http listening')
          resolve(server.address())
        })
      })
    },
    close () {
      return new Promise((resolve) => server.close(resolve))
    }
  }
}
