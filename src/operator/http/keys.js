import b4a from 'b4a'
import { decodeKeyOrThrow } from '../../config.js'
import { badRequest } from './errors.js'

export function hexOfKey (value) {
  try {
    return b4a.toString(decodeKeyOrThrow(value), 'hex')
  } catch (err) {
    throw badRequest('invalid-key', err.message, { cause: err })
  }
}
