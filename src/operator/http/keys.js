import b4a from 'b4a'
import { decodeKeyOrThrow } from '../../config.js'

export function hexOfKey (value) {
  try {
    return b4a.toString(decodeKeyOrThrow(value), 'hex')
  } catch (err) {
    throw Object.assign(err, { status: 400 })
  }
}
