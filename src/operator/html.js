// Server-side escaping, shared by both operator pages. One implementation on
// purpose: region and operator labels are operator-supplied and reach the
// anonymous status page and the unauthenticated members shell alike, so a second
// copy is a second thing to get wrong.
export function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

export function plain (value, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : escapeHtml(value)
}

// The Mirall "M" and its orange square, from docs/media/logo-*.svg, on a dark tile
// so it reads on light and dark tab strips alike. Inlined as a data: URI rather
// than served: both pages live under different prefixes behind platform proxies,
// MIRALL_RELAY_ADMIN_UI=false removes the status page's routes, and the CSP
// already allows data: images.
const FAVICON_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
  "<rect width='64' height='64' rx='14' fill='#15181b'/>" +
  "<path fill='#fff' transform='translate(37.04 48.4) scale(.175)' d='M0,-196.22L-62.292,-111.171L-126.424,-196.22L-165.931,-196.22L-165.931,0L-125.107,0L-125.107,-129.2L-65.846,-50.043L-60.578,-50.043L-1.317,-126.442L-1.317,0L39.507,0L39.507,-196.22L0,-196.22Z'/>" +
  "<rect x='48' y='41.4' width='7' height='7' fill='#fb9c43'/>" +
  '</svg>'

export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`
