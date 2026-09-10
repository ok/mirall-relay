import test from 'node:test'
import assert from 'node:assert/strict'
import { HttpError, badRequest, sendAdminError, translateAdminError } from '../../src/operator/http/errors.js'

class CodedError extends Error {
  constructor (code, message) {
    super(message)
    this.code = code
  }
}

function captureJson () {
  let status = null
  let body = ''
  return {
    res: {
      writeHead (value) {
        status = value
      },
      end (value) {
        body = value
      }
    },
    read () {
      return { status, body: JSON.parse(body) }
    }
  }
}

test('HttpError carries status code and public error code', () => {
  const err = new HttpError(413, 'body-too-large', 'request body too large')
  assert.equal(err.status, 413)
  assert.equal(err.code, 'body-too-large')
  assert.equal(err.expose, true)
})

test('badRequest creates a 400 HttpError', () => {
  const cause = new Error('parser detail')
  const err = badRequest('invalid-json', 'request body must be valid JSON', { cause })
  assert.equal(err.status, 400)
  assert.equal(err.code, 'invalid-json')
  assert.equal(err.cause, cause)
})

test('translateAdminError preserves explicit HttpError instances', () => {
  const err = new HttpError(429, 'rate-limited', 'slow down')
  assert.equal(translateAdminError(err), err)
})

test('translateAdminError maps malformed path escapes to a bad request', () => {
  const cause = new URIError('URI malformed')
  const err = translateAdminError(cause)
  assert.equal(err.status, 400)
  assert.equal(err.code, 'bad-path')
  assert.equal(err.cause, cause)
})

test('translateAdminError maps roster codes in one place', () => {
  assert.equal(translateAdminError(new CodedError('duplicate', 'exists')).status, 409)
  assert.equal(translateAdminError(new CodedError('not-found', 'missing')).status, 404)

  const malformed = translateAdminError(new CodedError('malformed', 'bad roster bytes'))
  assert.equal(malformed.status, 500)
  assert.equal(malformed.code, 'malformed')
  assert.equal(malformed.expose, false)
})

test('translateAdminError treats other coded errors as bad requests', () => {
  const err = translateAdminError(new CodedError('bad-label', 'bad label'))
  assert.equal(err.status, 400)
  assert.equal(err.code, 'bad-label')
  assert.equal(err.message, 'bad label')
})

test('translateAdminError hides uncoded server faults', () => {
  const cause = new Error('database details')
  const err = translateAdminError(cause)
  assert.equal(err.status, 500)
  assert.equal(err.code, 'internal error')
  assert.equal(err.message, 'internal error')
  assert.equal(err.expose, false)
  assert.equal(err.cause, cause)
})

test('sendAdminError logs server causes without exposing them', () => {
  const messages = []
  const { res, read } = captureJson()
  sendAdminError(res, new Error('private stack detail'), {
    path: '/admin/invites',
    logger: { warn: (obj) => messages.push(obj.err) }
  })

  assert.deepEqual(read(), {
    status: 500,
    body: { error: 'internal error', message: 'internal error' }
  })
  assert.deepEqual(messages, ['private stack detail'])
})
