// Display formatting, imported by BOTH sides: src/admin-ui.js renders the first
// paint in Node, and src/ui/ui.js re-renders the live numbers in the browser from
// the same module over the same origin. Two copies of these rules would drift, and
// the drift would show up as a counter that changes shape when it refreshes.
//
// Binary units throughout, matching src/config.js's asBytes(): an operator who
// wrote MAX_LINK_BYTES=512MB must read "512 MiB" back, not "536.9 MB".

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

export function formatBytes (bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${Math.round(value)} B`

  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024
    unit++
  }

  let rounded = Math.round(scaled * 10) / 10
  // Rounding happens after the unit is chosen, so a value just under a boundary
  // scales to 1023.999… and rounds to 1024 — which would print "1024 KiB" rather
  // than "1 MiB". Carry it.
  if (rounded >= 1024 && unit < UNITS.length - 1) {
    rounded = 1
    unit++
  }

  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${UNITS[unit]}`
}

export function formatRate (bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`
}

// Grouped by hand rather than with toLocaleString(): the same page must read the
// same way on a German laptop and in CI.
export function formatCount (count) {
  const value = Number(count)
  if (!Number.isFinite(value)) return '—'
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatDuration (seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const parts = [
    ['d', Math.floor(total / 86400)],
    ['h', Math.floor(total / 3600) % 24],
    ['m', Math.floor(total / 60) % 60],
    ['s', total % 60]
  ]

  const first = parts.findIndex(([, value]) => value > 0)
  if (first === -1) return '0s'

  const shown = parts.slice(first, first + 2).filter(([, value], i) => i === 0 || value > 0)
  return shown.map(([unit, value]) => `${value}${unit}`).join(' ')
}

export function formatMs (ms) {
  return formatDuration(Number(ms) / 1000)
}

export function formatBool (value) {
  return value ? 'yes' : 'no'
}

// The `data-format` vocabulary. Lives here rather than in each caller so the
// server's first paint and the browser's refresh cannot pick different functions
// for the same attribute — the drift this module exists to prevent.
const FORMATTERS = {
  bool: formatBool,
  bytes: formatBytes,
  count: formatCount,
  duration: formatDuration,
  ms: formatMs,
  rate: formatRate
}

export function formatField (value, format) {
  const formatter = FORMATTERS[format]
  return formatter ? formatter(value) : String(value)
}
