// The storage-independent part of secrets.ovk (see vaultsecrets.js): the encrypted store itself,
// the locators kept in it, and the config migration. No node:* imports, so the web client uses
// it as is and only brings its own persistence (IndexedDB instead of a file).
import * as c from './crypto.js'

export const SECRETS_ID = 'secrets'
// config fields that hold credentials when they are plain strings
export const SECRET_FIELDS = ['email', 'password', 'user', 'apiKey', 'api_key', 'token', 'privateKey', 'mnemonic', 'secret']

/**
 * secrets.ovk in memory. `io` persists the encrypted bytes: { read(): Promise<Uint8Array|null>,
 * write(bytes) }; without one nothing is persisted.
 * @typedef {{read(): Promise<Uint8Array|null>, write(bytes: Uint8Array): Promise<void>}} SecretIo
 */
export class SecretStoreCore {
  /** @param {SecretIo|null} [io] */
  constructor (io = null) {
    this.io = io
    this.data = null
    this.keys = null
  }

  get unlocked () { return Boolean(this.data) }

  async unlock (keys) {
    this.keys = keys
    const blob = this.io ? await this.io.read() : null
    this.data = blob
      ? JSON.parse(new TextDecoder().decode(await c.decryptBlob(keys, SECRETS_ID, blob)))
      : { v: 1, creds: {}, sessions: {} }
    this.data.locators ??= {}
    return this
  }

  /** Replace everything with an already encrypted secrets.ovk (from a bootstrap record). */
  async adopt (keys, blob) {
    this.keys = keys
    this.data = JSON.parse(new TextDecoder().decode(await c.decryptBlob(keys, SECRETS_ID, blob)))
    this.data.locators ??= {}
    await this.save()
  }

  locked (what) {
    return new Error(`${what}: stored in secrets.ovk, which opens only once the vault is unlocked`)
  }

  cred (backend, field) {
    if (!this.data) throw this.locked(`${backend} ${field}`)
    const v = this.data.creds[backend]?.[field]
    if (v === undefined) throw new Error(`${backend} ${field}: not in secrets.ovk`)
    return v
  }

  setCred (backend, field, value) {
    (this.data.creds[backend] ??= {})[field] = value
  }

  session (key) {
    return this.data?.sessions[key] ?? null
  }

  async setSession (key, value) {
    if (!this.data) throw this.locked(`session ${key}`)
    this.data.sessions[key] = value
    await this.save()
  }

  async bytes () {
    return c.encryptBlob(this.keys, SECRETS_ID, JSON.stringify(this.data))
  }

  /**
   * Parallel uploads (several PrivateBin and Blossom backends) save at the same moment. Two
   * concurrent writes to one file can interleave into a blob that no longer decrypts, so saves
   * run one at a time, each encrypting the data as it is when its turn comes.
   */
  save () {
    if (!this.io || !this.data) return Promise.resolve()
    const write = async () => this.io.write(await this.bytes())
    this.saving = (this.saving ?? Promise.resolve()).then(write, write)
    return this.saving
  }

  get empty () {
    return !this.data || (!Object.keys(this.data.creds).length && !Object.keys(this.data.sessions).length)
  }
}

/** Locator state of one paste-like backend inside an unlocked-or-not store (see locatorState). */
export function storeLocatorState (store, name) {
  return {
    unlocked: () => store.unlocked,
    async read (key) {
      if (!store.unlocked) return null
      const v = store.data.locators[name]?.[key]
      return v ? JSON.parse(JSON.stringify(v)) : null
    },
    async write (patch) {
      if (!store.unlocked) throw store.locked(`${name} locators`)
      store.data.locators[name] = { ...store.data.locators[name], ...JSON.parse(JSON.stringify(patch)) }
      await store.save()
    }
  }
}

/** Plain-string credentials in a config move into the store; the config keeps references. */
export function migrateConfig (cfg, store) {
  let moved = 0
  for (const b of cfg.backends ?? []) {
    for (const field of SECRET_FIELDS) {
      if (typeof b[field] === 'string') {
        store.setCred(b.name, field, b[field])
        b[field] = { stored: true }
        moved++
      }
    }
    // locators from a kit or a bootstrap record: paste URLs carry the paste key
    if (b.locators && typeof b.locators === 'object') {
      const st = (store.data.locators[b.name] ??= {})
      st.paths ??= {}
      for (const [p, url] of Object.entries(b.locators)) st.paths[p] ??= { url }
      delete b.locators
      moved++
    }
  }
  return moved
}
