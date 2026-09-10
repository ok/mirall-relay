// The one long-option parser for every CLI in this repo: `--flag value`,
// `--flag=value` and a bare `--flag`.
//
// Deliberately dependency-free and deliberately small — it understands this
// repo's CLI shape, not the whole POSIX surface. Every entry point parses
// through it so a label, a spaced flag value and an unknown flag mean the same
// thing in `mirall-relay`, `invite`, `keygen` and the probe.
//
// A spec entry is { value, parse, aliases, default }:
//   value: false  a bare boolean flag; `--flag=x` is an error.
//   value: true   takes a value; bare is an error unless `bareBooleanValue` is set.
//   parse         applied to the value; throws are the caller's error message.
//   aliases       extra names for the same flag, e.g. ['-h'] for --help.
//   default       used when the flag is absent.

export function camel (flag) {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

function resolveName (token, spec) {
  const name = token.replace(/^-+/, '')
  if (name in spec) return name
  for (const [flag, entry] of Object.entries(spec)) {
    if (entry.aliases?.includes(token) || entry.aliases?.includes(name)) return flag
  }
  return null
}

export function parseLongOptions (argv, spec, opts = {}) {
  const { allowPositionals = false, bareBooleanValue } = opts
  const flags = {}
  const positionals = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '-' || !arg.startsWith('-')) {
      if (!allowPositionals) throw new Error(`unexpected argument ${JSON.stringify(arg)}`)
      positionals.push(arg)
      continue
    }

    const eq = arg.indexOf('=')
    const token = eq === -1 ? arg : arg.slice(0, eq)
    const name = resolveName(token, spec)
    if (!name) throw new Error(`unknown flag ${token}`)
    const entry = spec[name]

    if (entry.value === false) {
      if (eq !== -1) throw new Error(`${token} does not take a value`)
      flags[name] = true
      continue
    }

    let value
    if (eq !== -1) value = arg.slice(eq + 1)
    // A following token that is itself a long flag is never this flag's value.
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i]
    else if (bareBooleanValue !== undefined) value = bareBooleanValue
    else throw new Error(`${token} requires a value`)

    flags[name] = entry.parse ? entry.parse(value) : value
  }

  for (const [name, entry] of Object.entries(spec)) {
    if (entry.default !== undefined && !(name in flags)) flags[name] = entry.default
  }

  return { flags, positionals }
}
