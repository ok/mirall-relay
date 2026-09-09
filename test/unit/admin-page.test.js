// The management page's shell. It is static, so what matters is that it carries
// no data, loads nothing external, and can actually be served.
import test from 'node:test'
import assert from 'node:assert/strict'
import { managePaths, PAGE_PATH, renderManagePage } from '../../src/admin-page.js'

test('the shell is static and carries no member data', () => {
  const html = renderManagePage()
  // Everything dynamic arrives over an authenticated fetch and is written with
  // textContent by the client. Nothing about a member can be in this file.
  assert.ok(!/seedHex|mirall:\/\/relay\/[a-z0-9]/.test(html), 'no ticket or seed value')
  assert.ok(!/[0-9a-f]{52,}/i.test(html), 'no key- or seed-length run')
  assert.equal(renderManagePage(), html, 'and it is the same bytes every time')
})

test('the page loads no external resource, so default-src none holds', () => {
  const html = renderManagePage()
  assert.ok(!/https?:\/\//.test(html), 'no absolute URL at all')
  assert.ok(!html.includes('<script>'), 'no inline script')
  assert.ok(!html.includes('<style'), 'no inline style')
  assert.ok(!/\sstyle="/.test(html), 'no style attributes')
  assert.ok(!/\son[a-z]+="/.test(html), 'no inline event handlers — the CSP forbids them')
})

test('its asset URLs are document-relative, so a proxy prefix works', () => {
  const html = renderManagePage()
  // The page is served at /admin/, so `style.css` resolves under the prefix a
  // platform proxy mounts it at — the same rule the status page follows.
  assert.match(html, /href="style\.css"/)
  assert.match(html, /src="app\.js"/)
  assert.match(html, /href="\.\.\/"/, 'and the way back to the status page')
})

test('every route the page needs is served', () => {
  const assets = managePaths()
  for (const path of [PAGE_PATH, '/admin/style.css', '/admin/app.js']) {
    const asset = assets.get(path)
    assert.ok(asset, `${path} must be served`)
    assert.ok(asset.body.length > 0)
    assert.match(asset.etag, /^"[A-Za-z0-9_-]{27}"$/)
  }
  assert.match(assets.get(PAGE_PATH).type, /text\/html/)
  assert.match(assets.get('/admin/style.css').type, /text\/css/)
  assert.match(assets.get('/admin/app.js').type, /javascript/)
})

test('the client script never uses innerHTML', async () => {
  // Labels are people's names, supplied by the operator. The page builds every
  // dynamic node with textContent so there is no escaping to get wrong; the CSP
  // is the second line of defence, not the first.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../src/admin-page.client.js', import.meta.url), 'utf8')
  assert.ok(!/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write\(/.test(source))
})

test('the token is kept for the tab only, never on disk', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../src/admin-page.client.js', import.meta.url), 'utf8')
  assert.match(source, /sessionStorage/)
  assert.ok(!/localStorage\s*\./.test(source), 'closing the tab must forget it')
  // A cookie would ride along on every request to this origin and turn a write
  // surface into a CSRF target; the header is sent explicitly instead.
  assert.ok(!/document\.cookie/.test(source))
})
