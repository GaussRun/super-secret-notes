// `super-secret-notes status`: what the health ledger says, without touching the network.
import { HEALTH_KEYS } from './crypto.js'

export const STALE_CHECK_DAYS = 30
const DAY = 86_400_000

/**
 * @param {object} index merged index with its `health` ledger
 * @param {string[]} backends configured backend names, in order
 * @param {Date} [now]
 * @param {{ indexOn?: string[] }} [o] backends expected to hold an index copy (default: all)
 * @returns {{ backends: {backend: string, copies: number, healthy: number, errors: number, unverified: number, oldestOk: string|null, nextExpiry: string|null}[], warnings: string[] }}
 */
export function ledgerStatus (index, backends, now = new Date(), { indexOn = backends } = {}) {
  const health = index.health ?? {}
  const notes = Object.keys(index.notes ?? {}).sort()
  const warnings = []
  const rows = backends.map((name) => {
    const keys = [HEALTH_KEYS.vault, ...(indexOn.includes(name) ? [HEALTH_KEYS.index] : []), ...notes]
    let healthy = 0
    let errors = 0
    let unverified = 0
    let oldestOk = null
    let nextExpiry = null
    for (const key of keys) {
      const e = health[key]?.[name]
      if (!e) { unverified++; continue }
      if (e.status === 'ok') healthy++
      if (e.status === 'error') errors++
      if (e.last_ok && (!oldestOk || e.last_ok < oldestOk)) oldestOk = e.last_ok
      if (e.expires && (!nextExpiry || e.expires < nextExpiry)) nextExpiry = e.expires
      const checked = Date.parse(e.last_checked)
      if (now - checked > STALE_CHECK_DAYS * DAY) {
        warnings.push(`STALE CHECK: ${key} on ${name} last verified ${Math.floor((now - checked) / DAY)} days ago`)
      }
    }
    if (unverified) warnings.push(`STALE CHECK: ${unverified} of ${keys.length} copies on ${name} never verified`)
    const seen = keys.length - unverified
    if (errors >= 2 || (seen >= 2 && errors === seen)) warnings.push(`FLAKY: ${name} failed to answer for ${errors} of ${seen} copies`)
    return { backend: name, copies: keys.length, healthy, errors, unverified, oldestOk, nextExpiry }
  })
  for (const key of Object.keys(index.notes ?? {}).sort()) {
    const since = Date.parse(index.notes[key].updated ?? '') || 0
    const other = backends.filter((b) => health[key]?.[b]?.status === 'diverged' && Date.parse(health[key][b].last_checked) >= since)
    if (other.length) warnings.push(`DIVERGED: ${key} on ${other.join(', ')} is a version the index does not know (maybe newer); \`get "${key}" --from ${other[0]}\` reads it`)
    const ok = backends.filter((b) => health[key]?.[b]?.status === 'ok').length
    if (ok < 2) warnings.push(`AT RISK: ${key} has ${ok} known-healthy ${ok === 1 ? 'copy' : 'copies'}`)
  }
  return { backends: rows, warnings }
}

/**
 * What kind of retention a host promises, for the Retention column. `expires`: the earliest
 * expiry the ledger has for that backend (ISO) or null. For Nostr and Blossom that date is our
 * assumption (ASSUMED_RETENTION_DAYS after publishing), not the host's promise.
 */
export function retention (type, expires) {
  const date = expires ? String(expires).slice(0, 10) : null
  switch (type) {
    case 'privatebin': return date ? `expires ${date} (host-confirmed)` : 'never (host-confirmed)'
    case 'cryptpad': return 'while the account is active (instance policy)'
    case 'nostr':
    case 'blossom': return date ? `none promised; republish by ${date}` : 'none promised'
    case 'mega':
    case 'proton-cli':
    case 'filen':
    case 'fileverse':
    case 'rclone': return 'while the account exists'
    case 'local': return 'while the folder exists'
    default: return 'unknown'
  }
}

export function ago (iso, now = new Date()) {
  if (!iso) return 'never'
  const ms = now - Date.parse(iso)
  if (ms < 3_600_000) return `${Math.max(0, Math.round(ms / 60_000))} min ago`
  if (ms < DAY) return `${Math.round(ms / 3_600_000)} h ago`
  return `${Math.round(ms / DAY)} days ago`
}
