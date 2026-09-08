// Display formatting. Shared by the server render and the browser refresh, so a
// wrong rule here shows up twice.
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes, formatRate, formatCount, formatDuration, formatMs, formatField } from '../../src/format.js'

test('formatBytes uses binary units, matching the units the caps are written in', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1 KiB')
  assert.equal(formatBytes(1536), '1.5 KiB')
  // The two defaults an operator will recognise from their own env file.
  assert.equal(formatBytes(512 * 1024 ** 2), '512 MiB')
  assert.equal(formatBytes(4 * 1024 ** 2), '4 MiB')
  assert.equal(formatBytes(1.4 * 1024 ** 3), '1.4 GiB')
  assert.equal(formatBytes(1024 ** 5), '1 PiB')
})

test('formatBytes carries into the next unit when rounding reaches 1024', () => {
  // Rounding happens after the unit is picked, so 1048575 scales to 1023.999… KiB
  // and rounds to 1024 — which printed "1024 KiB". relay_bytes_relayed_total is a
  // monotonically increasing counter refreshed every 5s, so it crosses every one
  // of these windows, on the number the page captions "your egress bill".
  assert.equal(formatBytes(1024 ** 2 - 1), '1 MiB')
  assert.equal(formatBytes(1024 ** 3 - 1), '1 GiB')
  assert.equal(formatBytes(1024 ** 4 - 1), '1 TiB')
  assert.equal(formatBytes(1024 ** 5 - 1), '1 PiB')
  // The top unit has nowhere to carry to and must not lose the value.
  assert.match(formatBytes(1024 ** 6), /PiB$/)
})

test('formatField is the one data-format vocabulary both sides use', () => {
  assert.equal(formatField(1536, 'bytes'), '1.5 KiB')
  assert.equal(formatField(true, 'bool'), 'yes')
  assert.equal(formatField(11520, 'duration'), '3h 12m')
  assert.equal(formatField('x', 'nope'), 'x', 'an unknown format falls back to the raw value')
})

test('formatBytes refuses to invent a number it does not have', () => {
  assert.equal(formatBytes(null), '0 B')
  assert.equal(formatBytes(undefined), '—')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes('nope'), '—')
})

test('formatRate is a byte size per second', () => {
  assert.equal(formatRate(4 * 1024 ** 2), '4 MiB/s')
  assert.equal(formatRate(0), '0 B/s')
})

test('formatCount groups thousands the same way in every locale', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1000), '1,000')
  assert.equal(formatCount(1234567), '1,234,567')
  assert.equal(formatCount(undefined), '—')
})

test('formatDuration shows the two largest non-zero units', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(45), '45s')
  assert.equal(formatDuration(60), '1m')
  assert.equal(formatDuration(75), '1m 15s')
  assert.equal(formatDuration(3600), '1h')
  assert.equal(formatDuration(11520), '3h 12m')
  assert.equal(formatDuration(86400), '1d')
  assert.equal(formatDuration(90061), '1d 1h')
  assert.equal(formatDuration(-5), '0s')
})

test('formatMs converts before formatting, so maxLinkMs reads as an hour', () => {
  assert.equal(formatMs(3600000), '1h')
  assert.equal(formatMs(5000), '5s')
})
