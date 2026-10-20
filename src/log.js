// Logger with secret redaction (spec: sync-cli "Exit codes and logging").

const AUTH_RE = /(authorization\s*[:=]\s*)("?)[^\s",}]+(?:\s+[^\s",}]+)?/gi

/**
 * All output goes to stderr except `out()` (command results, dry-run plans) which
 * goes to stdout. Every line passes through `redact`.
 */
export function createLogger({ verbose = false, secrets = [], stdout, stderr } = {}) {
  const known = new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))
  const outStream = stdout ?? process.stdout
  const errStream = stderr ?? process.stderr

  const redact = (text) => {
    let s = String(text)
    for (const secret of known) s = s.split(secret).join('***')
    return s.replace(AUTH_RE, '$1$2***')
  }
  const line = (stream, prefix, msg) => stream.write(`${prefix}${redact(msg)}\n`)

  return {
    redact,
    addSecret(secret) {
      if (typeof secret === 'string' && secret.length >= 4) known.add(secret)
    },
    out: (msg) => line(outStream, '', msg),
    info: (msg) => line(errStream, '', msg),
    warn: (msg) => line(errStream, 'warning: ', msg),
    error: (msg) => line(errStream, 'error: ', msg),
    debug: (msg) => {
      if (verbose) line(errStream, 'debug: ', msg)
    },
    request(method, url, headers = {}) {
      if (!verbose) return
      const shown = Object.entries(headers)
        .map(([k, v]) => `${k}: ${k.toLowerCase() === 'authorization' ? '***' : v}`)
        .join(', ')
      line(errStream, 'debug: ', `${method} ${url}${shown ? ` [${shown}]` : ''}`)
    },
  }
}
