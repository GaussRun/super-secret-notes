// Resolves credentials from config without ever logging them.
// A secret spec is either a literal string, { env: "NAME" }, { envFile: "/path/.env", key: "NAME" },
// or { stored: true } (in secrets.ovk, see vaultsecrets.js; `store` and the field name are needed then).
// envFile values are read literally (no shell or dotenv interpolation), so passwords with
// shell metacharacters work.
import { readFileSync } from 'node:fs'

export function resolveSecret (spec, what, store = null, backend = null, field = null) {
  if (typeof spec === 'string') return spec
  if (spec?.stored) {
    if (!store) throw new Error(`${what}: stored in secrets.ovk, but no secret store here`)
    return store.cred(backend, field)
  }
  if (spec?.env) {
    const v = process.env[spec.env]
    if (!v) throw new Error(`${what}: environment variable ${spec.env} is not set`)
    return v
  }
  if (spec?.envFile && spec?.key) {
    for (const line of readFileSync(spec.envFile, 'utf8').split('\n')) {
      if (line.startsWith(spec.key + '=')) return line.slice(spec.key.length + 1).replace(/\r$/, '')
    }
    throw new Error(`${what}: key ${spec.key} not found in ${spec.envFile}`)
  }
  throw new Error(`${what}: missing or unsupported secret spec`)
}
