// The full backup file (docs/OVERKILL.md, "Backup file"): one JSON document holding vault.age, the
// index and every note blob, each exactly in our two-layer encrypted form, base64. Nothing in it is
// plaintext except the format header and the vault name; opening it needs the passphrase. With it,
// a vault comes back with no host reachable at all. Shared with the web client.
import * as c from './crypto.js'

export const BACKUP_FORMAT = 'super-secret-notes-backup'
// blob id of the encrypted vault config inside a backup (which hosts to copy back to)
export const BACKUP_CONFIG_ID = 'backup-config'

/**
 * The backup of an open vault, as text. Notes are read through the store (from the first healthy
 * copy) and encrypted again under their own blob ids; copies that differ from the index are not in it.
 * @param {{ store: any, cfg: any, keys: any, vaultBytes: Uint8Array, now?: () => Date }} o
 */
export async function makeBackup ({ store, cfg, keys, vaultBytes, now = () => new Date() }) {
  const index = await store.mergedIndex()
  const files = { [c.paths.vault]: c.toBase64(vaultBytes) }
  for (const [name, entry] of Object.entries(index.notes)) {
    const { bytes } = await store.get(name)
    files[c.paths.note(entry.id)] = c.toBase64(await c.encryptBlob(keys, entry.id, bytes))
  }
  files[c.paths.index] = c.toBase64(await c.encryptIndex(keys, index))
  const config = await c.encryptBlob(keys, BACKUP_CONFIG_ID, new TextEncoder().encode(JSON.stringify(cfg)))
  return JSON.stringify({
    format: BACKUP_FORMAT,
    v: 1,
    created: now().toISOString(),
    vault_name: cfg.name ?? null,
    root: cfg.root ?? null,
    config: c.toBase64(config),
    notes: Object.keys(index.notes).length,
    files
  }, null, 1) + '\n'
}

/** The container, checked, with its files as bytes. Throws on anything that is not a backup. */
export function parseBackup (text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('this is not a Super Secret Notes backup file (not JSON)')
  }
  if (doc?.format !== BACKUP_FORMAT) throw new Error('this is not a Super Secret Notes backup file')
  if (doc.v !== 1) throw new Error(`backup format version ${doc.v} is newer than this version understands`)
  if (typeof doc.files?.[c.paths.vault] !== 'string' || typeof doc.files?.[c.paths.index] !== 'string') throw new Error('the backup file is incomplete (no vault.age or index)')
  const files = {}
  for (const [rel, b64] of Object.entries(doc.files)) {
    if (rel !== c.paths.vault && rel !== c.paths.index && !/^notes\/[0-9a-f]{64}\.ovk$/.test(rel)) throw new Error(`unexpected entry in the backup: ${rel}`)
    files[rel] = c.fromBase64(String(b64))
  }
  return { created: doc.created, vaultName: doc.vault_name, config: doc.config ? c.fromBase64(doc.config) : null, files }
}

/**
 * Open a backup with the passphrase: the vault, its keys, its config and index, every note checked
 * (both layers, against the index's sha256). -> { vault, keys, vaultBytes, cfg, index, files }
 */
export async function openBackup (text, passphrase) {
  const b = parseBackup(text)
  const vaultBytes = b.files[c.paths.vault]
  const vault = await c.decryptVault(vaultBytes, passphrase)
  const keys = await c.unlockKeys(vault)
  const index = await c.decryptIndex(keys, b.files[c.paths.index])
  const cfg = b.config
    ? JSON.parse(new TextDecoder().decode(await c.decryptBlob(keys, BACKUP_CONFIG_ID, b.config)))
    : { v: 1, name: b.vaultName ?? undefined, backends: [] }
  for (const [name, entry] of Object.entries(index.notes)) {
    const blob = b.files[c.paths.note(entry.id)]
    if (!blob) throw new Error(`the backup has no copy of "${name}"`)
    const plain = await c.decryptBlob(keys, entry.id, blob)
    if (await c.sha256Hex(plain) !== entry.sha256) throw new Error(`the backup's copy of "${name}" does not match its index`)
  }
  return { vault, keys, vaultBytes, cfg, index, files: b.files }
}
