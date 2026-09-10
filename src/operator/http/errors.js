import { json } from './responses.js'

const ROSTER_CODE_STATUS = Object.freeze({
  duplicate: 409,
  'not-found': 404,
  malformed: 500
})

export class HttpError extends Error {
  constructor (status, code, message, options = {}) {
    const opts = options || {}
    super(message, Object.hasOwn(opts, 'cause') ? { cause: opts.cause } : undefined)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.expose = opts.expose ?? status < 500
  }
}

export function badRequest (code, message, options) {
  return new HttpError(400, code, message, options)
}

export function translateAdminError (err) {
  if (err instanceof HttpError) return err

  if (err instanceof URIError) {
    return badRequest('bad-path', 'request path is not valid percent-encoding', { cause: err })
  }

  const code = err?.code
  if (code && Object.hasOwn(ROSTER_CODE_STATUS, code)) {
    const status = ROSTER_CODE_STATUS[code]
    return new HttpError(status, code, err.message, { cause: err, expose: status < 500 })
  }

  if (code) {
    return badRequest(code, err.message, { cause: err })
  }

  return new HttpError(500, 'internal error', 'internal error', { cause: err, expose: false })
}

export function sendAdminError (res, err, { logger, path } = {}) {
  const httpErr = translateAdminError(err)
  if (httpErr.status >= 500) {
    logger?.warn({ err: httpErr.cause?.message || httpErr.message, path }, 'admin write failed')
  }
  return json(res, httpErr.status, {
    error: httpErr.code,
    message: httpErr.expose ? httpErr.message : 'internal error'
  })
}
