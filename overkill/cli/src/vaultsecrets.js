// secrets.ovk: every stored credential and session, encrypted with the vault keys (the same
// two-layer blob format as notes, blob_id "secrets"). config.json only holds references
// ({"stored": true}), so the state directory is no honeypot. env:/envFile references stay
// supported as an explicit opt-out.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writePrivate } from './config.js'
import { SecretStoreCore, storeLocatorState, migrateConfig, SECRETS_ID, SECRET_FIELDS } from './vaultsecrets-core.js'

export { SecretStoreCore, storeLocatorState, migrateConfig, SECRETS_ID, SECRET_FIELDS }
export const STUB = { moved_to: 'secrets.ovk', note: 'this file held secrets in plaintext; they are now encrypted in secrets.ovk and this file can be deleted' }

/** secrets.ovk under the state directory (no file without a home). */
export class SecretStore extends SecretStoreCore {
  constructor (home) {
    const file = home ? path.join(home, 'secrets.ovk') : null
    super(file && {
      read: () => readFile(file).then((b) => new Uint8Array(b), () => null),
      write: (bytes) => writePrivate(file, bytes)
    })
    this.file = file
  }
}

/**
 * Where a paste-like backend keeps its locators (URLs with the paste keys) and delete tokens:
 * in secrets.ovk, readable only once the vault is unlocked. Without a store (a bare adapter,
 * as in some tests) it falls back to files under locators/.
 */
export function locatorState (ctx, name) {
  if (ctx.secrets) return storeLocatorState(ctx.secrets, name)
  const file = (key) => path.join(ctx.home ?? '', 'locators', key === 'paths' ? `${name}.json` : `${name}.${key}.json`)
  return {
    unlocked: () => true,
    read: (key) => readFile(file(key), 'utf8').then(JSON.parse, () => null),
    async write (patch) {
      for (const [key, v] of Object.entries(patch)) await writePrivate(file(key), JSON.stringify(v, null, 2))
    }
  }
}

/** Old plaintext locator files (locators/<backend>.json, .pastes.json) move into the store. */
export async function migrateLocators (home, store) {
  const dir = path.join(home, 'locators')
  let moved = 0
  for (const f of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'))) {
    const m = /^(.+?)(?:\.(pastes))?\.json$/.exec(f)
    if (!m || f.includes('.fileverse-')) continue // Fileverse maps hold file ids only
    const file = path.join(dir, f)
    const json = await readFile(file, 'utf8').then(JSON.parse, () => null)
    if (!json || json.moved_to) continue
    const [, name, kind] = m
    store.data.locators[name] = { ...store.data.locators[name], [kind ?? 'paths']: { ...json, ...store.data.locators[name]?.[kind ?? 'paths'] } }
    await writeFile(file, JSON.stringify(STUB, null, 2) + '\n', { mode: 0o600 })
    moved++
  }
  return moved
}

/** Old plaintext session files (sessions/*.json) move into the store; the files become stubs. */
export async function migrateSessions (home, store) {
  const dir = path.join(home, 'sessions')
  const names = await readdir(dir).catch(() => [])
  let moved = 0
  for (const f of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(dir, f)
    const json = await readFile(file, 'utf8').then(JSON.parse, () => null)
    if (!json || json.moved_to) continue
    store.data.sessions[f.replace(/\.json$/, '')] = json
    // no deletion here (the user deletes files): overwrite the content with a stub instead
    await writeFile(file, JSON.stringify(STUB, null, 2) + '\n', { mode: 0o600 })
    moved++
  }
  return moved
}
