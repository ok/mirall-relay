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

// The blind-relay mark, the same artwork the StartOS package ships as its icon.
// A relative href on purpose: both pages sit behind platform proxies under
// prefixes they cannot know, and each serves its own copy (icon.png beside the
// status page, admin/icon.png beside the members page) so MIRALL_RELAY_ADMIN_UI=false
// does not take the members page's icon away with the status page's routes.
export const FAVICON_LINK = '<link rel="icon" type="image/png" href="icon.png">'
