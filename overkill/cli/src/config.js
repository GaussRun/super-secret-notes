// Local state: $OVERKILL_HOME (default ~/.overkill-notes) holds config.json, a copy of
// vault.age, MEGA session files and a ciphertext staging area. Everything is 0600 / 0700.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as c from './crypto.js'
import { createBackend } from './backends/index.js'
import { Overkill } from './store.js'
import { logger } from './log.js'
import { SecretStore, migrateConfig, migrateSessions, migrateLocators } from './vaultsecrets.js'
import { DEFAULT_ROOT } from './defaults-core.js'

export { DEFAULT_ROOT }

export function homeDir (opt) {
  return path.resolve(opt ?? process.env.OVERKILL_HOME ?? path.join(os.homedir(), '.overkill-notes'))
}

export const files = (home) => ({
  config: path.join(home, 'config.json'),
  vault: path.join(home, 'vault.age'),
  // the last index this machine saw, encrypted like on the backends; `status` reads it offline
  indexCache: path.join(home, 'index-cache.ovk')
})

export const indexCache = (home) => ({
  write: (blob) => writePrivate(files(home).indexCache, blob),
  read: () => readFile(files(home).indexCache).then((b) => new Uint8Array(b), () => null)
})

export const INDEX_SYNC_MODES = ['always', 'manual', 'never']
const syncFile = (home) => path.join(home, 'index-sync.json')
export async function lastSynced (home) {
  return readFile(syncFile(home), 'utf8').then((t) => JSON.parse(t).last_synced, () => null)
}
export async function markSynced (home) {
  await writePrivate(syncFile(home), JSON.stringify({ last_synced: new Date().toISOString() }, null, 2))
}

export async function readConfig (home) {
  let text
  try {
    text = await readFile(files(home).config, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no vault here (${home}). Run \`super-secret-notes init\` first.`)
    throw err
  }
  const cfg = JSON.parse(text)
  if (cfg.v !== 1 || !Array.isArray(cfg.backends)) throw new Error('config.json has an unexpected shape')
  return cfg
}

export async function writePrivate (file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, data, { mode: 0o600 })
}

/** Adapters for a config. They share one secret store (secrets.ovk), locked until unlockSecrets(). */
export function makeBackends (cfg, home) {
  const ctx = { root: cfg.root ?? DEFAULT_ROOT, home, secrets: new SecretStore(home) }
  const backends = cfg.backends.map((b) => createBackend(b, ctx))
  backends.secrets = ctx.secrets
  return backends
}

/**
 * Open secrets.ovk with the vault keys, and move any plaintext credentials (config.json) and
 * session files (sessions/) into it. Returns what moved, for one line of output.
 */
export async function unlockSecrets ({ cfg, home, backends, keys, writeConfig = true }) {
  const store = backends.secrets
  await store.unlock(keys)
  const creds = migrateConfig(cfg, store)
  const sessions = home ? await migrateSessions(home, store) : 0
  const locators = home ? await migrateLocators(home, store) : 0
  if (creds || sessions || locators) {
    await store.save()
    if (creds && writeConfig) await writePrivate(files(home).config, JSON.stringify(cfg, null, 2) + '\n')
  }
  if (sessions) logger.warn(`moved ${sessions} plaintext session file(s) into secrets.ovk; the old files in ${path.join(home, 'sessions')} now hold only a stub and can be deleted`)
  if (locators) logger.warn(`moved ${locators} plaintext locator file(s) (paste keys, delete tokens) into secrets.ovk; the old files in ${path.join(home, 'locators')} now hold only a stub and can be deleted`)
  if (creds && writeConfig) logger.info(`moved ${creds} credential(s) from config.json into secrets.ovk`)
  return { creds, sessions, locators }
}

/** Local vault.age, or the first copy any backend has (new device). */
export async function loadVaultBytes (home, backends) {
  try {
    return new Uint8Array(await readFile(files(home).vault))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  for (const b of backends) {
    try {
      const bytes = await b.get(c.paths.vault)
      if (bytes) {
        logger.info(`no local vault.age, fetched it from ${b.name}`)
        await writePrivate(files(home).vault, bytes)
        return bytes
      }
    } catch (err) {
      logger.warn(`${b.name}: could not fetch vault.age (${err.message})`)
    }
  }
  throw new Error('vault.age not found locally or on any backend')
}

/** Open the vault and return a ready Overkill store. */
export async function open (home, getPassphrase) {
  const cfg = await readConfig(home)
  const backends = makeBackends(cfg, home)
  const vaultBytes = await loadVaultBytes(home, backends)
  const passphrase = await getPassphrase()
  const vault = await c.decryptVault(vaultBytes, passphrase)
  const keys = await c.unlockKeys(vault)
  await unlockSecrets({ cfg, home, backends, keys })
  return { cfg, vault, passphrase, vaultBytes, store: new Overkill({ backends, keys, vaultBytes, indexCache: indexCache(home), indexSync: cfg.index_sync ?? 'always' }) }
}
