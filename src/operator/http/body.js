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
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('body is not JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}
