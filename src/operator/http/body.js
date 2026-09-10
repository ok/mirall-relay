import { HttpError, badRequest } from './errors.js'

const MAX_BODY = 4096

export function readJson (req, { limit = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0
    let done = false
    const chunks = []
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        done = true
        req.pause()
        reject(new HttpError(413, 'body-too-large', 'request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(badRequest('invalid-json', 'request body must be valid JSON', { cause: err }))
      }
    })
    req.on('error', reject)
  })
}
