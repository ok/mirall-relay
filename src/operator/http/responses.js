export const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

export const BASE_HEADERS = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin'
})

export function send (res, status, body, type, extra = {}) {
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    ...extra
  })
  res.end(body)
}

export function json (res, status, body, extra = {}) {
  send(res, status, JSON.stringify(body, null, 2), 'application/json; charset=utf-8', { 'cache-control': 'no-store', ...extra })
}

export function notFound (res) {
  return json(res, 404, { error: 'not found' })
}

export function methodNotAllowed (res) {
  return json(res, 405, { error: 'method not allowed' })
}

export function cached (req, res, body, type, etag) {
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...BASE_HEADERS, etag })
    return res.end()
  }
  return send(res, 200, body, type, { etag, 'cache-control': 'no-cache' })
}
