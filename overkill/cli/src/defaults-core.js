// Pure parts of the defaults (defaults.js adds the host cache): backend names for zero-signup
// hosts, the default root folder and the vault name rule. Shared with the web client.
export const DEFAULT_ROOT = 'overkill'

const host = (url) => new URL(url).host

// short backend names: the host without its usual prefix, e.g. pb-envs, cp-private, nostr-mom
const PREFIX = {
  privatebin: ['pb-', /^(www|paste|pb|bin)\./],
  cryptpad: ['cp-', /^(cryptpad|crypt|pad)\./],
  nostr: ['nostr-', /^(relay|nostr)\./],
  blossom: ['blossom-', /^(blossom|cdn|files|media)\./]
}

/**
 * Backend config for a zero-signup host. `taken` holds names already in use; a clash (two
 * "paste.<x>" hosts found in directories) gets a number. The new name is added to `taken`.
 */
export function backendConfig (type, url, taken = new Set()) {
  const [prefix, strip] = PREFIX[type]
  const base = prefix + host(url).replace(strip, '').split('.')[0]
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
  taken.add(name)
  // CryptPad accounts are derived from the vault and registered on first use
  return type === 'cryptpad' ? { name, type, origin: url, derived: true } : { name, type, url }
}

/** Rough registrable domain ("paste.example.co.uk" -> "example.co.uk"): one operator, one pick. */
export function site (url) {
  const u = new URL(url)
  if (/^[\d.]+$/.test(u.hostname)) return u.host // an IP address (tests): one per port
  const labels = u.hostname.split('.')
  const n = labels.length >= 3 && labels.at(-1).length === 2 && labels.at(-2).length <= 3 ? 3 : 2
  return labels.slice(-n).join('.')
}

/** Vault names salt the recovery key, so keep them simple and unambiguous. */
export function validVaultName (name) {
  return typeof name === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}$/u.test(name.normalize('NFC'))
}
