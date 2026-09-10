import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readJson } from '../../src/operator/http/body.js'

function requestFrom (body) {
  return Readable.from(body === null ? [] : [Buffer.from(body)])
}

test('readJson parses a JSON body', async () => {
  assert.deepEqual(await readJson(requestFrom('{"label":"ben"}')), { label: 'ben' })
})

test('readJson treats an empty body as an empty object', async () => {
  assert.deepEqual(await readJson(requestFrom(null)), {})
})

test('readJson rejects malformed JSON as a bad request', async () => {
  await assert.rejects(readJson(requestFrom('not json')), {
    status: 400,
    code: 'invalid-json',
    message: 'request body must be valid JSON'
  })
})

test('readJson rejects bodies over the configured limit', async () => {
  await assert.rejects(readJson(requestFrom('xxxxx'), { limit: 4 }), {
    status: 413,
    code: 'body-too-large',
    message: 'request body too large'
  })
})
