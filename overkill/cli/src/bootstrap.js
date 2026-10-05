// Recovery with vault name + passphrase only (docs/OVERKILL.md, "Defaults: zero-signup first").
// The discovery key (scrypt of passphrase and vault name, crypto.deriveDiscoverySecret) is a
// Nostr key of its own. Under it, every default relay holds two NIP-78 events, NIP-44 to self:
// vault.age and a small bootstrap record (index locators on PrivateBin, CryptPad usernames,
// the main npub). Whoever knows name + passphrase finds both; the passphrase then opens vault.age.
import { getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { deriveDiscoverySecret, deriveDiscoveryTags, encryptIndex, toBytes } from './crypto.js'
import * as nostr from './backends/nostr.js'
import { logger } from './log.js'

// d tags before format history 17: "<DISCOVERY_ROOT>/<path>", the same for every vault. Still
// read (old records recover), never written.
export const DISCOVERY_ROOT = 'overkill-discovery'
// The fixed, well-known relays for the recovery record: every vault publishes there (besides its
// own randomly drawn relays) and recovery by name asks them, so a vault's own draw never matters
// for finding it. Changing this list strands records: only ever add. The first four are the
// originals; the rest are long-retention relays from docs/NOSTR.md ("best 10").
export const DISCOVERY_RELAYS = ['wss://nos.lol', 'wss://nostr.mom', 'wss://purplerelay.com', 'wss://nostr.oxtr.dev',
  'wss://nostr.data.haus', 'wss://relay.nostr.wirednet.jp', 'wss://nostr-01.yakihonne.com', 'wss://relay.illuminodes.com']
export const DEFAULT_RELAYS = DISCOVERY_RELAYS
const VAULT = 'vault.age'
const BOOTSTRAP = 'bootstrap.json'
const INDEX = 'index.ovk' // a copy of the encrypted index (format history 18)
// the index copy goes out at most this often while a vault stays open, and once more on close
export const INDEX_COPY_INTERVAL_MS = 5 * 60_000

/** The discovery identity. Takes about a second (scrypt N=2^18); pass `secret` on to skip it later. */
export async function discoveryIdentity (passphrase, vaultName) {
  const secret = await deriveDiscoverySecret(passphrase, vaultName)
  const pubkey = getPublicKey(secret)
  return { secret, pubkey, npub: npubEncode(pubkey) }
}

// `tags`: the vault's own d tags (deriveDiscoveryTags), or null for the old fixed ones
function adapters (secret, relays, opts, tags) {
  return relays.map((url) => {
    const b = nostr.create({ name: url, type: 'nostr', url, root: DISCOVERY_ROOT }, { root: DISCOVERY_ROOT, home: null }, { ...opts, ...(tags ? { dTags: tags } : {}) })
    b.unlock({ nostrSecret: secret })
    return b
  })
}

/**
 * Publish vault.age and the bootstrap record (a JSON-able object, suggested shape in
 * docs/NOSTR.md) to every relay. Never throws for one relay; returns
 * [{ relay, ok, error }] and throws only if no relay took both.
 * @param {string} passphrase
 * @param {string} vaultName
 * @param {Uint8Array} vaultAgeBytes
 * @param {object|string} bootstrapJson
 * @param {{relays?: string[], secret?: Uint8Array, pause?: number, WebSocketImpl?: any}} [options] `secret`: the
 *   discovery key when it is already derived (skips the scrypt); the rest goes to the relay adapters
 */
export async function publishBootstrap (passphrase, vaultName, vaultAgeBytes, bootstrapJson, { relays = DEFAULT_RELAYS, secret, ...opts } = {}) {
  secret ??= (await discoveryIdentity(passphrase, vaultName)).secret
  const record = toBytes(typeof bootstrapJson === 'string' ? bootstrapJson : JSON.stringify(bootstrapJson))
  JSON.parse(new TextDecoder().decode(record)) // must be JSON, whichever form it came in
  const bs = adapters(secret, relays, opts, await deriveDiscoveryTags(secret))
  try {
    const results = await Promise.all(bs.map(async (b) => {
      try {
        await b.put(VAULT, toBytes(vaultAgeBytes))
        await b.put(BOOTSTRAP, record)
        return { relay: b.where, ok: true }
      } catch (err) {
        logger.warn(`bootstrap: ${b.where}: ${err.message}`)
        return { relay: b.where, ok: false, error: err.message }
      }
    }))
    if (!results.some((r) => r.ok)) throw new Error(`bootstrap not stored on any relay (${results.map((r) => `${r.relay}: ${r.error}`).join('; ')})`)
    return results
  } finally {
    await Promise.all(bs.map((b) => b.close()))
  }
}

// the newest complete record on each relay: [{ relay, vaultAge, bootstrap, at } | { relay, error }]
async function readRecords (secret, relays, opts, tags) {
  const bs = adapters(secret, relays, opts, tags)
  try {
    return await Promise.all(bs.map(async (b) => {
      try {
        const record = await b.get(BOOTSTRAP)
        const vaultAge = record && await b.get(VAULT)
        if (!record || !vaultAge) return { relay: b.where, error: 'nothing there' }
        // the index copy is a bonus: a relay without one (or an old record) still counts
        const indexBlob = tags ? await b.get(INDEX).catch(() => null) : null
        return { relay: b.where, vaultAge, bootstrap: JSON.parse(new TextDecoder().decode(record)), at: b.publishedAt(BOOTSTRAP), indexBlob }
      } catch (err) {
        return { relay: b.where, error: err.message }
      }
    }))
  } finally {
    await Promise.all(bs.map((b) => b.close()))
  }
}

/**
 * Find vault.age and the bootstrap record from name + passphrase. Asks every relay under the
 * vault's own d tags and keeps the newest bootstrap; with none there, the old fixed tags. A
 * record found only under those is published again under the new tags (the old events stay).
 * -> { vaultAge: Uint8Array, bootstrap: object, from: relay URL, npub, legacy: boolean,
 *   indexBlobs: Uint8Array[] (the index copies found, still encrypted with the vault keys) }
 * @param {string} passphrase
 * @param {string} vaultName
 * @param {{relays?: string[], secret?: Uint8Array, pause?: number, WebSocketImpl?: any}} [options] as for publishBootstrap
 */
export async function fetchBootstrap (passphrase, vaultName, { relays = DEFAULT_RELAYS, secret, ...opts } = {}) {
  secret ??= (await discoveryIdentity(passphrase, vaultName)).secret
  let found = await readRecords(secret, relays, opts, await deriveDiscoveryTags(secret))
  let legacy = false
  if (!found.some((f) => f.vaultAge)) {
    const old = await readRecords(secret, relays, opts, null)
    if (old.some((f) => f.vaultAge)) {
      found = old
      legacy = true
    }
  }
  const good = found.filter((f) => f.vaultAge).sort((x, y) => y.at - x.at)
  if (!good.length) throw new Error(`no bootstrap for this vault name and passphrase on any relay (${found.map((f) => `${f.relay}: ${f.error}`).join('; ')})`)
  if (legacy) {
    await publishBootstrap(passphrase, vaultName, good[0].vaultAge, good[0].bootstrap, { relays, secret, ...opts })
      .then((r) => logger.info(`recovery record moved to this vault's own tags on ${r.filter((x) => x.ok).length}/${r.length} relays (the old copies stay)`))
      .catch((err) => logger.warn(`recovery record found under the old shared tags, republishing under the new ones failed: ${err.message}`))
  }
  const indexBlobs = found.map((f) => f.indexBlob).filter(Boolean)
  return { vaultAge: good[0].vaultAge, bootstrap: good[0].bootstrap, from: good[0].relay, npub: npubEncode(getPublicKey(secret)), legacy, indexBlobs }
}

/**
 * Keeps the index copy next to the recovery record current, for Overkill's `indexMirror`: every
 * index write is offered. One that changes the notes or their locators goes out at once (that is
 * what another device needs to find a note); other changes (the health ledger) at most every
 * `minIntervalMs`, the newest of them otherwise on `flush` (close). Never throws.
 * @param {{keys: any, secret: () => Promise<Uint8Array>, relays: string[], minIntervalMs?: number, pause?: number, WebSocketImpl?: any}} o
 *   `secret`: called once, when the first copy goes out (the scrypt is not paid before that)
 */
export function indexMirror ({ keys, secret, relays, minIntervalMs = INDEX_COPY_INTERVAL_MS, ...opts }) {
  let pending = null
  let last = 0
  let sentShape = null
  let running = Promise.resolve()
  let bs = null // kept between copies: replacements of one d tag must get rising created_at
  let key = null
  const shape = (index) => JSON.stringify([index.notes, index.locators ?? {}])
  const send = () => {
    const index = pending
    pending = null
    last = Date.now()
    sentShape = shape(index)
    running = running.then(async () => {
      key ??= secret()
      const k = await key
      bs ??= adapters(k, relays, opts, await deriveDiscoveryTags(k))
      const blob = await encryptIndex(keys, index)
      const res = await Promise.all(bs.map((b) => b.put(INDEX, blob).then(() => ({ relay: b.where, ok: true }), (err) => ({ relay: b.where, ok: false, error: err.message }))))
      const ok = res.filter((r) => r.ok).length
      if (ok) logger.debug(`index copy next to the recovery record: on ${ok}/${res.length} relays`)
      else logger.warn(`index copy next to the recovery record not stored (${res.map((r) => `${r.relay}: ${r.error}`).join('; ')})`)
    }).catch((err) => logger.warn(`index copy next to the recovery record: ${err.message}`))
    return running
  }
  return {
    offer (index) {
      pending = index
      if (shape(index) !== sentShape || Date.now() - last >= minIntervalMs) return send()
    },
    async flush () {
      if (pending) send()
      await running
      const open = bs
      bs = null
      await Promise.all((open ?? []).map((b) => b.close()))
    }
  }
}

/**
 * When each relay last got this vault's record (under its own tags): [{ relay, at: Date|null, error? }].
 * `at` null with no error = the relay answered and has none.
 * @param {Uint8Array} secret the discovery key
 * @param {string[]} relays
 * @param {{pause?: number, WebSocketImpl?: any}} [opts]
 */
export async function auditBootstrap (secret, relays, opts = {}) {
  const found = await readRecords(secret, relays, opts, await deriveDiscoveryTags(secret))
  return found.map((f) => ({ relay: f.relay, at: f.at ?? null, ...(f.error && f.error !== 'nothing there' ? { error: f.error } : {}) }))
}
