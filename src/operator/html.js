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
