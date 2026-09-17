// The two operator stylesheets are separate files on purpose — MIRALL_RELAY_ADMIN_UI=false
// takes /ui.css away, and the members page must not lose its styling with it. The
// cost of that is a duplicated palette, and this is the guard that keeps the copy
// honest so the two surfaces keep reading as one product.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderManagePage } from '../../src/operator/members/page.js'
import { renderPage } from '../../src/operator/status/page.js'
import { statusFixture } from '../helpers/status-fixture.js'

const read = (name) =>
  readFileSync(new URL(`../../src/operator/${name}`, import.meta.url), 'utf8')

// Every :root and prefers-color-scheme block, normalized for indentation only.
function tokenBlocks (css) {
  const blocks = css.match(/:root\s*\{[^}]*\}/g) || []
  return blocks.map((block) => block.replace(/\s+/g, ' ').trim())
}

test('both operator stylesheets define the same design tokens', () => {
  const status = tokenBlocks(read('status/status.css'))
  const members = tokenBlocks(read('members/members.css'))

  assert.ok(status.length >= 2, 'a light palette and a dark one')
  assert.deepEqual(members, status)
})

test('both pages wear the same masthead and footer', () => {
  const members = renderManagePage({ region: 'local', operator: 'oliver', version: '9.9.9' })
  const status = renderPage(statusFixture({ labels: { region: 'local', operator: 'oliver' }, version: '9.9.9' }))

  for (const html of [members, status]) {
    // One title, one nav, and the version down in the footer rather than a
    // sub-line only one of the two pages had.
    assert.match(html, /<h1>mirall-relay<\/h1>/)
    assert.match(html, /<nav class="pages" aria-label="Pages">/)
    assert.match(html, /<div class="footer-links">/)
    assert.match(html, /<p class="footer-meta">/)
    assert.ok(!html.includes('class="sub"'), 'the status line lives in the footer now')
  }

  assert.match(members, /local · oliver · v9\.9\.9/)
  assert.match(status, /local · oliver · v9\.9\.9/)
})

test('the members shell links nothing that MIRALL_RELAY_ADMIN_UI=false turns off', () => {
  const off = renderManagePage({ statusPage: false })
  // /, /status.json and the status assets go away with the flag; /readyz,
  // /metrics and the capability doc do not.
  assert.ok(!off.includes('href="../"'), 'no Status nav link')
  assert.ok(!off.includes('status.json'), 'and no status.json link')
  assert.match(off, /href="\.\.\/readyz"/)
  assert.match(off, /href="\.\.\/metrics"/)
})

test('the dark palette is a media override, not a second source of truth', () => {
  for (const name of ['status/status.css', 'members/members.css']) {
    const css = read(name)
    assert.match(css, /@media \(prefers-color-scheme: dark\)/, name)
    // Every colour has to be defined in the bare :root block, or the light theme
    // is whatever the browser last inherited.
    const base = css.slice(css.indexOf(':root'), css.indexOf('@media'))
    for (const token of ['--ground', '--card', '--ink', '--rule', '--good', '--warn', '--bad', '--idle']) {
      assert.match(base, new RegExp(`${token}:`), `${token} in ${name}`)
    }
  }
})
