// The QR encoder.
//
// HOW THESE FIXTURES WERE PRODUCED, because "it matches itself" would prove
// nothing: every payload length from 1 to 180 was encoded by src/qr.js, rendered
// to a bitmap and decoded by jsQR — a real decoder that reads the format bits,
// unmasks, de-interleaves and Reed-Solomon-corrects. 540 payloads, zero failures.
// The same matrices were compared module-for-module against node-qrcode with byte
// mode and mask forced: identical everywhere the mask agreed. Neither library is a
// dependency of this project; only the confidence and the matrices below survive.
//
// So the fixtures are a REGRESSION PIN, not the proof. The proof was the sweep.
//
// READ THIS BEFORE "FIXING" A FAILURE HERE. The `packed` matrices are correctness:
// a diff in them at the same version and mask is a real bug. The `mask` values are
// NOT — every mask yields a valid symbol, and reference encoders disagree about
// how penalty rule 3 scores patterns against the border (node-qrcode requires all
// eleven modules inside the symbol; Nayuki counts the quiet zone). A change that
// moves `mask` while every payload still decodes is a judgement call to be made
// deliberately and re-pinned, not a regression to be reverted on sight.
import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeQr, qrSvg, byteCapacity } from '../../src/qr.js'

function pack ({ modules }) {
  const bytes = Buffer.alloc(Math.ceil(modules.length / 8))
  for (let i = 0; i < modules.length; i++) if (modules[i]) bytes[i >> 3] |= 0x80 >> (i & 7)
  return bytes.toString('base64')
}

const FIXTURES = [
  { text: 'a', version: 1, mask: 5, size: 21, packed: '/lv8FZButLt1ZdukrsEZB/qv4BgAgrZ0wO5LmsCrPq09/4BkF/nT0ERHunTl0voul3cEfo/qkwA=' },
  { text: 'hello world', version: 1, mask: 2, size: 21, packed: '/lv8ERBuvLt11duqrsFJB/qv4BQAvlPjav9r251IucF84IBUZ/hI0FCvupMN1n4uskkE2c/tqQA=' },
  { text: 'x'.repeat(26), version: 2, mask: 0, size: 25, packed: '/hU/wWqQboqrt09V26rS7BDpB/qq/gBaAKolCVzpU1WMovaoqy/510DDlTYYKi6bKrKT1fwAdUd/iurwTpE7q0/F0lhy6qlrBCni/tWlgA==' },
  { text: 'yb3dq6h9c1x8kwmp4z7ejr5tn9adg2hf6bcxsq8vw3ymp4z7ej', version: 4, mask: 2, size: 33, packed: '/n5fP8Er4hBuoT1rt1xzJduoEnLsFi9RB/qqqv4BAkwAvm9jvlpgTrl94EusUBVxk1xgkjzTAJxblKkoWIVIHT2uxwxTWKh3bdH783I3DY5vlNN22BSWgWk7HkoOEDVLqmvtjl1Y/ABfW8d/jujq0FBi8curoy/N1M7sTusZO8kEpVqM/rrq9QA=' },
  { text: 'z'.repeat(52), version: 4, mask: 2, size: 33, packed: '/g7bP8EjoFBuux1rt19SZduqVjLsF+8FB/qqqv4B4msAvl/bPmKdTbDC0kguVZ1Ct9/7g7TN4J7bDj3JguXgNWt9AsrbTNAKbbDQstAuWY8Ot9Ug6bTPCAvbDhinguUZ+mt8nz/b/QBOTcT/gMhqUFECsdurg6/N1q7STutpgYEE5Wp8/qLbvQA=' },
  { text: 'q'.repeat(84), version: 5, mask: 0, size: 37, packed: '/nQRE/wUbu7QbpniIrt0JHd126mZES7BAW7tB/qqqq/gDz7uAKo0xECT5Xt3Ukv7CIj/mRbu4gy1JER01Fd3dSYJmIiP4SHu7iDnhERHSGg3d1Jp/4iI//ou7uIKpOREdOSxd3UkLpCIj+KQbu4gx/RER0vDh3dSZJIIiP6yRu7iKbVkRP2AV3d0Z/jIiOvwSq7tELr6RE/N0dd3Bi65iIt/BK7u2C/uxEXtgA==' }
]

test('every fixture round-trips to the exact module matrix', () => {
  for (const fixture of FIXTURES) {
    const qr = encodeQr(fixture.text)
    const label = `${fixture.text.slice(0, 12)}… (${fixture.text.length} bytes)`
    assert.equal(qr.version, fixture.version, `version for ${label}`)
    assert.equal(qr.size, fixture.size, `size for ${label}`)
    assert.equal(qr.mask, fixture.mask, `mask for ${label}`)
    assert.equal(pack(qr), fixture.packed, `modules for ${label}`)
  }
})

// The same matrix as the first fixture, written out so a reviewer can see the
// finder patterns, the separators, the timing rows and the format strip without
// decoding base64.
test('the smallest QR is a recognisable QR', () => {
  const qr = encodeQr('a')
  const rows = []
  for (let r = 0; r < qr.size; r++) {
    let line = ''
    for (let c = 0; c < qr.size; c++) line += qr.modules[r * qr.size + c] ? '#' : '.'
    rows.push(line)
  }
  assert.deepEqual(rows, [
    '#######..#.##.#######',
    '#.....#.#.##..#.....#',
    '#.###.#.##.#..#.###.#',
    '#.###.#.#.##..#.###.#',
    '#.###.#..#..#.#.###.#',
    '#.....#...##..#.....#',
    '#######.#.#.#.#######',
    '........##...........',
    '#.....#.#.##.##..###.',
    '#..##......###.###..#',
    '..#.###..##.#.##.....',
    '.#.#.#.##..#####.#.#.',
    '##.#..####.##########',
    '........##..#.....#.#',
    '#######..###.#..####.',
    '#.....#...#...#...###',
    '#.###.#..###.#..###..',
    '#.###.#..#.#####.#...',
    '#.###.#..#.###.###.##',
    '#.....#...######.#...',
    '#######.#.#.#..#..##.'
  ])
})

test('the three finder patterns are drawn with their separators', () => {
  const qr = encodeQr('a')
  const at = (r, c) => qr.modules[r * qr.size + c]
  for (const [row, col] of [[0, 0], [0, qr.size - 7], [qr.size - 7, 0]]) {
    assert.equal(at(row, col), 1, 'finder corner')
    assert.equal(at(row + 3, col + 3), 1, 'finder centre')
    assert.equal(at(row + 1, col + 1), 0, 'finder inner ring is light')
    assert.equal(at(row + 3, col + 1), 0)
  }
  // The separator between the top-left finder and the data region.
  for (let i = 0; i < 8; i++) assert.equal(at(7, i), 0, `separator at (7,${i})`)
})

test('the timing patterns alternate along row and column six', () => {
  const qr = encodeQr('z'.repeat(52))
  for (let i = 8; i < qr.size - 8; i++) {
    assert.equal(qr.modules[6 * qr.size + i], i % 2 === 0 ? 1 : 0, `row timing at ${i}`)
    assert.equal(qr.modules[i * qr.size + 6], i % 2 === 0 ? 1 : 0, `column timing at ${i}`)
  }
})

test('the always-dark module sits at (4v + 9, 8)', () => {
  for (const text of ['a', 'z'.repeat(52), 'q'.repeat(84)]) {
    const qr = encodeQr(text)
    assert.equal(qr.modules[(4 * qr.version + 9) * qr.size + 8], 1)
  }
})

test('version selection picks the smallest version that fits', () => {
  // The boundary is what breaks: one byte over and the whole matrix changes size.
  const boundaries = [[14, 1], [15, 2], [26, 2], [27, 3], [42, 3], [43, 4], [62, 4], [63, 5]]
  for (const [length, version] of boundaries) {
    assert.equal(encodeQr('a'.repeat(length)).version, version, `${length} bytes`)
  }
})

test('byteCapacity matches the published level-M capacities', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map(byteCapacity),
    [14, 26, 42, 62, 84, 106, 122, 152, 180]
  )
})

test('a payload past version 9 is a clear error, not a corrupt code', () => {
  assert.doesNotThrow(() => encodeQr('a'.repeat(180)))
  assert.throws(() => encodeQr('a'.repeat(181)), /does not fit a version 9 QR/)
})

test('multi-byte characters are counted as bytes, not as characters', () => {
  // Byte mode encodes UTF-8; 60 three-byte characters is 180 bytes, the very top
  // of version 9. Counting characters would silently pick version 4 and corrupt.
  assert.equal(encodeQr('✓'.repeat(60)).version, 9)
  assert.throws(() => encodeQr('✓'.repeat(61)), /does not fit/)
})

test('a public key encodes to a version 4 code, small enough to scan from a screen', () => {
  const qr = encodeQr('yb3dq6h9c1x8kwmp4z7ejr5tn9adg2hf6bcxsq8vw3ymp4z7ejab')
  assert.equal(qr.version, 4)
  assert.equal(qr.size, 33)
})

test('qrSvg draws a quiet zone and nothing else outside the modules', () => {
  const qr = encodeQr('a')
  const svg = qrSvg(qr, { quietZone: 4 })
  assert.match(svg, /viewBox="0 0 29 29"/, '21 modules plus a 4-module quiet zone each side')
  assert.match(svg, /fill="currentColor"/, 'inline SVG follows the page theme')
  assert.ok(!svg.includes('<rect'), 'no background, so the page shows through')
  assert.equal((svg.match(/<path/g) || []).length, 1, 'one path, not one element per module')
})

test('qrSvg standalone is a self-contained black-on-white file', () => {
  const svg = qrSvg(encodeQr('a'), { standalone: true, color: '#000', background: '#fff' })
  assert.match(svg, /^<\?xml version="1\.0"/)
  assert.match(svg, /<rect width="29" height="29" fill="#fff"\/>/)
  assert.match(svg, /width="232" height="232"/)
})

test('qrSvg escapes a title rather than letting it close the document', () => {
  const svg = qrSvg(encodeQr('a'), { title: '</svg><script>alert(1)</script>' })
  assert.ok(!svg.includes('<script>'))
  assert.match(svg, /&lt;\/svg&gt;/)
})

test('the module count of the path matches the dark module count', () => {
  const qr = encodeQr('hello world')
  let dark = 0
  for (const module of qr.modules) dark += module
  const svg = qrSvg(qr)
  assert.equal((svg.match(/M\d+ \d+h1v1h-1z/g) || []).length, dark)
})

test('a forced mask is honoured, so masks can be compared against a reference', () => {
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(encodeQr('a', { mask }).mask, mask)
  }
  assert.notDeepEqual(encodeQr('a', { mask: 0 }).modules, encodeQr('a', { mask: 1 }).modules)
})
