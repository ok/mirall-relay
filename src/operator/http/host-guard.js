import net from 'node:net'

// A page on the internet can point its own hostname at 127.0.0.1 and read this
// port out of the operator's browser. Validating Host is the standard answer, but
// a fixed allowlist would break every reverse proxy. So the check runs only where
// it cannot break anything: a loopback bind, where nothing but loopback reaches us
// directly and a rebinding request necessarily carries the DNS name the browser
// resolved. An IP literal is always fine.
export function normalizeHost (value) {
  let name = String(value).trim()
  if (name.startsWith('[')) {
    const end = name.indexOf(']')
    name = end === -1 ? name.slice(1) : name.slice(1, end)
  } else if ((name.match(/:/g) || []).length === 1) {
    name = name.slice(0, name.lastIndexOf(':'))
  }
  return name.replace(/\.$/, '').toLowerCase()
}

export function isLoopback (value) {
  const name = normalizeHost(value)
  if (name === 'localhost' || name === '::1') return true
  if (name.startsWith('::ffff:')) return isLoopback(name.slice(7))
  return net.isIPv4(name) && name.startsWith('127.')
}

export function guardsHost (cfg) {
  return isLoopback(cfg.adminHost) || !!cfg.adminAllowedHosts
}

export function hostAllowed (cfg, host) {
  if (!guardsHost(cfg)) return true
  if (host === undefined || host === null) return true
  const name = normalizeHost(host)
  if (!name) return false
  if (isLoopback(name) || net.isIP(name) !== 0) return true
  return !!cfg.adminAllowedHosts && cfg.adminAllowedHosts.some((allowed) => normalizeHost(allowed) === name)
}
