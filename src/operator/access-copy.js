// How both operator pages name the access mode and the reachability verdict. The
// status page renders these on the server and the members page in the browser,
// so they live in one place.
function count (n, one, many) {
  return n === 1 ? `1 ${one}` : `${n} ${many}`
}

const REACHABILITY = {
  reachable: { text: 'Reachable', tone: 'good' },
  assumed: { text: 'Assumed reachable', tone: 'warn' },
  firewalled: { text: 'Not reachable', tone: 'bad' },
  'port-unstable': { text: 'Port unstable', tone: 'bad' },
  starting: { text: 'Starting', tone: 'idle' },
  stopped: { text: 'Stopped', tone: 'idle' },
  unknown: { text: 'Unknown', tone: 'idle' }
}

export function reachabilityPill (reachability) {
  const { state, probed } = reachability || {}
  // Asserted is never shown as measured: ASSUME_REACHABLE forces the verdict.
  const key = state === 'reachable' && probed === false ? 'assumed' : (REACHABILITY[state] ? state : 'unknown')
  return { key, ...REACHABILITY[key] }
}

export function modeWord (access) {
  const mode = access && access.mode
  if (mode === 'invite') return 'Private'
  if (mode === 'allowlist') return 'Restricted'
  return 'Public'
}

export function modePill (access) {
  const a = access || {}
  if (a.mode === 'invite') {
    const active = a.members ? a.members.active : 0
    return active === 0
      ? { text: 'Private relay · no members', tone: 'warn' }
      : { text: `Private relay · ${count(active, 'member', 'members')}`, tone: 'good' }
  }
  if (a.mode === 'allowlist') {
    return { text: `Restricted · ${count(a.allowlisted || 0, 'static key', 'static keys')}`, tone: 'idle' }
  }
  return { text: 'Public relay', tone: 'idle' }
}

// null in invite mode, where the roster is what gates the relay.
export function rosterNotice (access) {
  const mode = access && access.mode
  if (mode === 'invite') return null
  const how = 'To switch, set access to Private in the relay’s settings (MIRALL_RELAY_ACCESS=invite) and restart.'
  if (mode === 'allowlist') {
    // A roster member is refused here: the firewall admits roster keys only in invite mode.
    return 'This relay admits only its static MIRALL_RELAY_ALLOWLIST keys, so invites created here do not connect yet. ' +
      'Once the relay is private, members and static keys are both admitted. ' + how
  }
  return 'This relay is public, so anyone with its key can connect. ' +
    'Invites you create here already work, and become the only way in once the relay is private. ' + how
}
