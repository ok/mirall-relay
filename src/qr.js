// A QR encoder, because the public key is the product.
//
// SCOPE, deliberately narrow: byte mode, error correction level M, versions 1-9.
// That spans 14-180 bytes; a z-base-32 public key is 52 and lands on version 4.
// Level M alone is a nine-row block table instead of a thirty-six-row one, and
// every row is a chance to mistype a number that only fails on one payload size.
//
// WHY NOT A DEPENDENCY: `qrcode` brings dijkstrajs, pngjs and yargs into a
// process that relays other people's traffic. src/config.js makes the same call
// about an argv parser for the same reason.
//
// Everything here is ISO/IEC 18004: the GF(256) primitive polynomial 0x11D, the
// BCH(15,5) format code with its 0x5412 mask, the BCH(18,6) version code, and
// the four mask penalty rules.
//
// MASK SELECTION IS A HEURISTIC, NOT A CORRECTNESS PROPERTY. All eight masks
// produce a valid, decodable symbol; the penalty score only picks the one likely
// to scan best. Reference encoders legitimately disagree at the borders (see the
// rule-3 note in penalty()), so a change here that moves a fixture's `mask` while
// every payload still decodes is a judgement call, not a regression — and a change
// that alters the MODULES for a fixed mask is a real bug. test/unit/qr.test.js
// pins both, and says which is which.

// [ecCodewordsPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]
const BLOCKS = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37]
]

// Row/column centres of the alignment patterns. Version 1 has none.
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]
]

const MAX_VERSION = BLOCKS.length
const ECC_M = 0b00 // the two format-info bits for error correction level M

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0
]

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x <<= 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]

function mul (a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

function generatorPoly (degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= mul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

function errorCorrection (data, count) {
  const gen = generatorPoly(count)
  const rem = new Array(count).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.shift()
    rem.push(0)
    if (factor !== 0) {
      for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor)
    }
  }
  return rem
}

function totalDataCodewords (version) {
  const [, g1, d1, g2, d2] = BLOCKS[version - 1]
  return g1 * d1 + g2 * d2
}

// 4 mode bits + 8 character-count bits + 8 per byte must fit the data capacity.
export function byteCapacity (version) {
  return totalDataCodewords(version) - 2
}

function pickVersion (length) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (length <= byteCapacity(v)) return v
  }
  throw new Error(
    `${length} bytes does not fit a version ${MAX_VERSION} QR at error correction level M (max ${byteCapacity(MAX_VERSION)})`
  )
}

function dataCodewords (bytes, version) {
  const capacity = totalDataCodewords(version)
  const bits = []
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }

  push(0b0100, 4) // byte mode
  push(bytes.length, 8) // versions 1-9 use an 8-bit count in byte mode
  for (const byte of bytes) push(byte, 8)

  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const words = []
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))
  }

  const pad = [0xec, 0x11]
  for (let i = 0; words.length < capacity; i++) words.push(pad[i % 2])
  return words
}

// Split into blocks, error-correct each, then interleave: data codeword i of every
// block in order, then EC codeword i of every block in order.
function interleave (words, version) {
  const [ecPerBlock, g1, d1, g2, d2] = BLOCKS[version - 1]
  const blocks = []
  let offset = 0
  for (const [count, size] of [[g1, d1], [g2, d2]]) {
    for (let i = 0; i < count; i++) {
      const data = words.slice(offset, offset + size)
      offset += size
      blocks.push({ data, ec: errorCorrection(data, ecPerBlock) })
    }
  }

  const out = []
  const longest = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of blocks) out.push(block.ec[i])
  }
  return out
}

// Long division by `generator` in GF(2). Each step shifts one bit in and cancels
// the generator's leading term when it appears, so `rem` never exceeds `degree`
// bits and no lookup table of magic strings is needed.
function bchRemainder (value, generator, degree) {
  let rem = value
  for (let i = 0; i < degree; i++) {
    rem = (rem << 1) ^ ((rem >>> (degree - 1)) * generator)
  }
  return rem
}

function formatBits (mask) {
  const data = (ECC_M << 3) | mask
  return ((data << 10) | bchRemainder(data, 0b10100110111, 10)) ^ 0b101010000010010
}

function versionBits (version) {
  return (version << 12) | bchRemainder(version, 0b1111100100101, 12)
}

class Grid {
  constructor (version) {
    this.version = version
    this.size = version * 4 + 17
    this.modules = new Uint8Array(this.size * this.size)
    this.fixed = new Uint8Array(this.size * this.size)
  }

  at (row, col) {
    return this.modules[row * this.size + col]
  }

  set (row, col, dark) {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) return
    this.modules[row * this.size + col] = dark ? 1 : 0
    this.fixed[row * this.size + col] = 1
  }

  reserve (row, col) {
    this.fixed[row * this.size + col] = 1
  }

  isFree (row, col) {
    return this.fixed[row * this.size + col] === 0
  }
}

function placeFinders (grid) {
  for (const [row, col] of [[0, 0], [0, grid.size - 7], [grid.size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const ring = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          ((r === 0 || r === 6 || c === 0 || c === 6) || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
        grid.set(row + r, col + c, ring)
      }
    }
  }
}

function placeAlignment (grid) {
  const centres = ALIGNMENT[grid.version - 1]
  if (centres.length === 0) return
  const last = centres[centres.length - 1]
  for (const row of centres) {
    for (const col of centres) {
      const overlapsFinder = (row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6)
      if (overlapsFinder) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          grid.set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
        }
      }
    }
  }
}

function placeTiming (grid) {
  for (let i = 8; i < grid.size - 8; i++) {
    grid.set(6, i, i % 2 === 0)
    grid.set(i, 6, i % 2 === 0)
  }
}

function reserveFormat (grid) {
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      grid.reserve(i, 8)
      grid.reserve(8, i)
    }
  }
  for (let i = 0; i < 8; i++) {
    grid.reserve(8, grid.size - 1 - i)
    grid.reserve(grid.size - 1 - i, 8)
  }
  // The dark module. Always set, never part of the format code.
  grid.set(grid.size - 8, 8, true)
}

function placeVersion (grid) {
  if (grid.version < 7) return
  const bits = versionBits(grid.version)
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1
    grid.set(Math.floor(i / 3), (i % 3) + grid.size - 11, dark)
    grid.set((i % 3) + grid.size - 11, Math.floor(i / 3), dark)
  }
}

function placeFormat (grid, mask) {
  const bits = formatBits(mask)
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1
    if (i < 6) grid.set(i, 8, dark)
    else if (i < 8) grid.set(i + 1, 8, dark)
    else grid.set(grid.size - 15 + i, 8, dark)

    if (i < 8) grid.set(8, grid.size - 1 - i, dark)
    else if (i < 9) grid.set(8, 15 - i, dark)
    else grid.set(8, 14 - i, dark)
  }
}

// The two-column serpentine from the bottom right, skipping the vertical timing
// column. Running out of codewords mid-placement leaves 0s, which is exactly what
// the standard's remainder-bits table describes — so there is no such table here.
function placeData (grid, codewords, mask) {
  const maskFn = MASKS[mask]
  let bit = 0
  let up = true

  for (let col = grid.size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let step = 0; step < grid.size; step++) {
      const row = up ? grid.size - 1 - step : step
      for (const c of [col, col - 1]) {
        if (!grid.isFree(row, c)) continue
        const byte = codewords[bit >> 3]
        let dark = byte !== undefined && ((byte >> (7 - (bit & 7))) & 1) === 1
        if (maskFn(row, c)) dark = !dark
        grid.modules[row * grid.size + c] = dark ? 1 : 0
        bit++
      }
    }
    up = !up
  }
}

function penalty (grid) {
  const { size } = grid
  let score = 0

  const line = (get) => {
    let run = 1
    let previous = get(0)
    for (let i = 1; i < size; i++) {
      const value = get(i)
      if (value === previous) {
        run++
      } else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
        previous = value
      }
    }
    if (run >= 5) score += 3 + (run - 5)
  }

  for (let i = 0; i < size; i++) {
    line((j) => grid.at(i, j))
    line((j) => grid.at(j, i))
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const first = grid.at(r, c)
      if (first === grid.at(r, c + 1) && first === grid.at(r + 1, c) && first === grid.at(r + 1, c + 1)) {
        score += 3
      }
    }
  }

  // Rule 3 requires the four light modules to be INSIDE the symbol, matching
  // node-qrcode's 11-bit window (its `col >= 10` guard). Nayuki instead counts the
  // quiet zone as the light area and so penalises finder-like runs against the
  // border; the standard's "light area 4 modules wide" does not settle which is
  // meant. Both emit valid symbols — see the note on mask selection in the header.
  const FINDER = [1, 0, 1, 1, 1, 0, 1]
  const matches = (get, at) => {
    for (let i = 0; i < 7; i++) if (get(at + i) !== FINDER[i]) return false
    const before = () => {
      for (let i = 1; i <= 4; i++) if (at - i < 0 || get(at - i) !== 0) return false
      return true
    }
    const after = () => {
      for (let i = 0; i < 4; i++) if (at + 7 + i >= size || get(at + 7 + i) !== 0) return false
      return true
    }
    return before() || after()
  }

  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 7; j++) {
      if (matches((k) => grid.at(i, k), j)) score += 40
      if (matches((k) => grid.at(k, i), j)) score += 40
    }
  }

  let dark = 0
  for (const module of grid.modules) dark += module
  const percent = (dark * 100) / grid.modules.length
  score += Math.floor(Math.abs(percent - 50) / 5) * 10

  return score
}

export function encodeQr (text, opts = {}) {
  const bytes = new TextEncoder().encode(String(text))
  const version = pickVersion(bytes.length)
  const codewords = interleave(dataCodewords(bytes, version), version)
  const candidates = opts.mask === undefined ? MASKS.map((_, i) => i) : [opts.mask]

  let best = null
  for (const mask of candidates) {
    const grid = new Grid(version)
    placeFinders(grid)
    placeAlignment(grid)
    placeTiming(grid)
    reserveFormat(grid)
    placeVersion(grid)
    placeData(grid, codewords, mask)
    placeFormat(grid, mask)

    const score = penalty(grid)
    if (best === null || score < best.score) best = { grid, score, mask }
  }

  return { version, mask: best.mask, size: best.grid.size, modules: best.grid.modules }
}

// One <path> of unit subpaths. Dark modules only, so the background is whatever
// the page is — which is what makes `color: currentColor` follow the theme.
export function qrSvg ({ size, modules }, opts = {}) {
  const {
    quietZone = 4,
    color = 'currentColor',
    background = null,
    standalone = false,
    title = null
  } = opts

  const side = size + quietZone * 2
  const parts = []
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules[row * size + col]) parts.push(`M${col + quietZone} ${row + quietZone}h1v1h-1z`)
    }
  }

  const attrs = [
    'xmlns="http://www.w3.org/2000/svg"',
    `viewBox="0 0 ${side} ${side}"`,
    'shape-rendering="crispEdges"',
    standalone ? `width="${side * 8}" height="${side * 8}"` : 'role="img"'
  ].filter(Boolean).join(' ')

  return (standalone ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '') +
    `<svg ${attrs}>` +
    (title ? `<title>${escapeXml(title)}</title>` : '') +
    (background ? `<rect width="${side}" height="${side}" fill="${background}"/>` : '') +
    `<path fill="${color}" d="${parts.join('')}"/>` +
    '</svg>'
}

function escapeXml (value) {
  return String(value).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]))
}
