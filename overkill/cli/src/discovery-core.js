// The storage-independent half of discovery.js: what goes into the bootstrap record, when it is
// due again, and turning a fetched record back into a config. Shared with the web client.
import { sha256Hex, deriveCryptpadCredentials, paths, toBase64, fromBase64 } from './crypto.js'
import { SECRET_FIELDS } from './vaultsecrets-core.js'
import { identity } from './backends/nostr.js'
import { DEFAULT_ROOT } from './defaults-core.js'

export const REPUBLISH_DAYS = 30 // relays promise no retention; refresh keeps it young

/**
 * Backends that need no secret beyond the vault itself travel in the record (locator-addressed
 * ones with their vault.age locator); others (MEGA,
 * Proton, ... with their own logins) are only named, so the user knows to add them back.
 * `travelsWithSecrets(type)`: whether a login backend of that type may travel with secrets.ovk.
 * @param {any} cfg
 * @param {any} backends
 * @param {any} keys
 * @param {{travelsWithSecrets?: (type: string) => boolean}} [o]
 */
export async function bootstrapRecord (cfg, backends, keys, { travelsWithSecrets = () => false } = {}) {
  const portable = []
  const others = []
  const cryptpad = []
  const store = backends.secrets
  // a login backend travels when all its credentials sit in secrets.ovk (which travels too)
  const stored = (b) => SECRET_FIELDS.every((f) => b[f] === undefined || b[f]?.stored === true) && SECRET_FIELDS.some((f) => b[f]?.stored)
  let needSecrets = false
  for (const b of cfg.backends) {
    if (b.type === 'privatebin' || b.type === 'blossom') {
      const adapter = backends.find((x) => x.name === b.name)
      const vaultUrl = adapter?.getLocators ? (await adapter.getLocators())[paths.vault] : null
      portable.push({ name: b.name, type: b.type, url: b.url, ...(vaultUrl ? { locators: { [paths.vault]: vaultUrl } } : {}) })
    } else if (b.type === 'cryptpad' && b.derived) {
      portable.push({ name: b.name, type: b.type, origin: b.origin, derived: true })
      cryptpad.push({ instance: b.origin, username: (await deriveCryptpadCredentials(keys.master, new URL(b.origin).host)).username })
    } else if (b.type === 'fileverse' && b.derived) {
      // the account is derived from the master, so the recovered vault can use it again
      portable.push({ name: b.name, type: b.type, derived: true })
    } else if (b.type === 'nostr') {
      portable.push({ name: b.name, type: b.type, url: b.url })
    } else if (travelsWithSecrets(b.type) && b.derived) {
      portable.push({ ...b }) // its login comes from the master, like derived CryptPad
    } else if (travelsWithSecrets(b.type) && stored(b) && store?.unlocked) {
      portable.push({ ...b })
      needSecrets = true
    } else {
      others.push({ name: b.name, type: b.type })
    }
  }
  return {
    v: 1, name: cfg.name, root: cfg.root ?? DEFAULT_ROOT, index_sync: cfg.index_sync ?? 'always', main_npub: identity(keys.nostrSecret).npub, backends: portable, others, cryptpad,
    // secrets.ovk as is: already encrypted with the vault keys (credentials and sessions)
    ...(needSecrets ? { secrets: toBase64(await store.bytes()) } : {})
  }
}

/** What a publish stamp compares: the record and the exact vault.age bytes. */
export async function recordHash (record, vaultBytes) {
  return sha256Hex(JSON.stringify(record) + (await sha256Hex(vaultBytes)))
}

/** Publish again when the record changed or the last publish ({ sha256, at }) is older than REPUBLISH_DAYS. */
export function publishDue (last, hash, now = Date.now()) {
  const young = last && now - Date.parse(last.at) < REPUBLISH_DAYS * 86_400_000
  return !(last?.sha256 === hash && young)
}

/** A fetched bootstrap (bootstrap.fetchBootstrap) -> { vaultBytes, cfg, others, from, npub, secretsBlob }. */
export function configFromBootstrap ({ vaultAge, bootstrap: rec, from, npub }, name) {
  if (!Array.isArray(rec?.backends) || !rec.backends.length) {
    const others = (rec?.others ?? []).map((b) => `${b.name} (${b.type})`).join(', ')
    throw new Error(`found the vault on ${from}, but none of its backends works without its own login${others ? ` (${others})` : ''}; recover with the kit and init --from instead`)
  }
  const cfg = { v: 1, name: rec.name ?? name, root: rec.root ?? DEFAULT_ROOT, ...(rec.index_sync && rec.index_sync !== 'always' ? { index_sync: rec.index_sync } : {}), backends: rec.backends }
  return { vaultBytes: vaultAge, cfg, others: rec.others ?? [], from, npub, secretsBlob: rec.secrets ? fromBase64(rec.secrets) : null }
}
