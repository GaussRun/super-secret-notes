// Overkill Notes format v1 crypto (see docs/OVERKILL.md).
// Only WebCrypto (globalThis.crypto.subtle), age-encryption and @noble/hashes (scrypt, which
// WebCrypto lacks) are used here, and no
// node:* imports, so this module can be shared with the browser client as-is.
import * as age from 'age-encryption'
import { scryptAsync } from '@noble/hashes/scrypt.js'

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

export const MAGIC = enc.encode('OVK1')
export const NONCE_LEN = 12
export const INDEX_ID = 'index'
export const DEFAULT_SCRYPT_LOG_N = 18

/** Thrown when a copy fails to decrypt or verify. `layer` says which check failed. */
export class CorruptBlobError extends Error {
  constructor (layer, message, options) {
    super(message, options)
    this.name = 'CorruptBlobError'
    this.layer = layer // 'header' | 'aes' | 'age' | 'sha256' | 'json'
  }
}

export class WrongPassphraseError extends Error {
  constructor (options) {
    super('wrong passphrase (or vault.age is damaged)', options)
    this.name = 'WrongPassphraseError'
  }
}

export function toBytes (data) {
  if (typeof data === 'string') return enc.encode(data)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new TypeError('expected string, Uint8Array or ArrayBuffer')
}

export function concat (...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

export function toHex (bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex (hex) {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('bad hex')
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))
}

export function toBase64 (bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromBase64 (b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

export async function sha256Hex (data) {
  return toHex(new Uint8Array(await subtle.digest('SHA-256', toBytes(data))))
}

export function randomBytes (n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

async function hkdf (master, info, bytes = 32) {
  const ikm = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) },
    ikm,
    bytes * 8
  )
  return new Uint8Array(bits)
}

const base64url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Login for the account a vault owns on one CryptPad instance, derived so nothing extra is stored:
 * b = HKDF-SHA256(master, info = "overkill v1 cryptpad:" + lowercase host, 32 bytes),
 * username = "ovk-" + hex(b[0..8]), password = base64url(b[8..32]) without padding.
 */
export async function deriveCryptpadCredentials (master, host) {
  const b = await hkdf(master, `overkill v1 cryptpad:${host.toLowerCase()}`)
  return { username: `ovk-${toHex(b.subarray(0, 8))}`, password: base64url(b.subarray(8)) }
}

// order of the secp256k1 group; a Nostr secret key must be in [1, n-1]
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const bigHex = (bytes) => BigInt('0x' + toHex(bytes))
/** A 32-byte string is a usable secp256k1 secret key iff it is in [1, n-1]. */
export const nostrScalarOk = (k) => { const x = bigHex(k); return x > 0n && x < SECP256K1_N }

/**
 * K_nostr = HKDF(master, info "overkill v1 nostr"). If that is not a valid secp256k1 scalar
 * (probability about 2^-128), retry with info "overkill v1 nostr 1", then "overkill v1 nostr 2", and so on.
 */
export async function deriveNostrSecret (master) {
  for (let i = 0; ; i++) {
    const k = await hkdf(master, i ? `overkill v1 nostr ${i}` : 'overkill v1 nostr')
    if (nostrScalarOk(k)) return k
  }
}

/** HKDF(master, info) as a secp256k1 secret: on an invalid scalar retry with "<info> 1", "<info> 2", ... */
async function deriveScalar (master, info) {
  for (let i = 0; ; i++) {
    const k = await hkdf(master, i ? `${info} ${i}` : info)
    if (nostrScalarOk(k)) return k
  }
}

/**
 * Fileverse (opt-in backend): the whole account comes from the master, so any machine with the
 * vault re-derives it and nothing needs caching.
 * - wallet     = HKDF(master, "overkill v1 fileverse"): the EVM key that signs the Privy SIWE login.
 *   Invalid-scalar rule as for K_nostr: retry "overkill v1 fileverse 1", "overkill v1 fileverse 2", ...
 * - ownerAgent = HKDF(master, "overkill v1 fileverse owner agent"), same rule: owner key of the Safe
 *   that owns the Developer Space portal.
 * - ownerUcan  = HKDF(master, "overkill v1 fileverse owner ucan"): ed25519 seed of the portal owner DID.
 * - portalSeed = HKDF(master, "overkill v1 fileverse portal seed", 48 bytes): the portal's EC key seed.
 * - apiKeySeed = HKDF(master, "overkill v1 fileverse api key", 24 bytes): the API key is its
 *   unpadded base64url (32 characters), the format the official app generates at random.
 */
export async function deriveFileverseSecrets (master) {
  return {
    wallet: await deriveScalar(master, 'overkill v1 fileverse'),
    ownerAgent: await deriveScalar(master, 'overkill v1 fileverse owner agent'),
    ownerUcan: await hkdf(master, 'overkill v1 fileverse owner ucan'),
    portalSeed: await hkdf(master, 'overkill v1 fileverse portal seed', 48),
    apiKeySeed: await hkdf(master, 'overkill v1 fileverse api key', 24)
  }
}

export const DISCOVERY_SCRYPT = { N: 2 ** 18, r: 8, p: 1, dkLen: 32 }

/**
 * Discovery key: a Nostr secret from the passphrase and vault name alone, so vault.age and the
 * bootstrap record can be found with nothing else (docs/OVERKILL.md, "Recovery with vault name +
 * passphrase only"). scrypt(passphrase, salt "overkill v1 discovery:" || NFC(vault name),
 * N=2^18, r=8, p=1, 32 bytes). Same invalid-scalar rule as K_nostr: retry with salt
 * "overkill v1 discovery 1:" || name, then "overkill v1 discovery 2:" || name, and so on.
 * The passphrase is used as UTF-8 exactly as typed (as age does).
 */
export async function deriveDiscoverySecret (passphrase, vaultName) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('passphrase must be a non-empty string')
  const name = normalizeName(vaultName)
  for (let i = 0; ; i++) {
    const salt = `overkill v1 discovery${i ? ` ${i}` : ''}:${name}`
    const k = await scryptAsync(enc.encode(passphrase), enc.encode(salt), DISCOVERY_SCRYPT)
    if (nostrScalarOk(k)) return k
  }
}

/**
 * The d tags of a vault's recovery record (format history 17): per vault and random-looking, so
 * no relay query by a well-known tag lists every vault. HKDF-SHA256(ikm = discovery secret,
 * salt = empty, info = "overkill v1 discovery tag:" || path, 32 bytes), lowercase hex. `index.ovk`
 * is the copy of the index that travels with the record (format history 18).
 * @param {Uint8Array} discoverySecret from deriveDiscoverySecret
 * @returns {Promise<{'vault.age': string, 'bootstrap.json': string, 'index.ovk': string}>}
 */
export async function deriveDiscoveryTags (discoverySecret) {
  const tag = async (p) => toHex(await hkdf(discoverySecret, `overkill v1 discovery tag:${p}`))
  return { 'vault.age': await tag('vault.age'), 'bootstrap.json': await tag('bootstrap.json'), 'index.ovk': await tag('index.ovk') }
}

/** Raw derived key bytes. Exposed for known-answer tests. */
export async function deriveRawKeys (master) {
  if (!(master instanceof Uint8Array) || master.length !== 32) throw new Error('master must be 32 bytes')
  return {
    aes: await hkdf(master, 'overkill v1 aes'),
    name: await hkdf(master, 'overkill v1 name'),
    nostr: await deriveNostrSecret(master),
    blossom: await hkdf(master, 'overkill v1 blossom')
  }
}

/**
 * Unlocked key material: everything needed to read and write blobs.
 * @param {{age_identity: string, master: string}} vault parsed vault JSON
 */
export async function unlockKeys (vault) {
  const master = fromBase64(vault.master)
  const raw = await deriveRawKeys(master)
  return {
    master, // for per-service derivations (deriveCryptpadCredentials)
    ageIdentity: vault.age_identity,
    ageRecipient: await age.identityToRecipient(vault.age_identity),
    aesKey: await subtle.importKey('raw', raw.aes, 'AES-GCM', false, ['encrypt', 'decrypt']),
    nameKey: await subtle.importKey('raw', raw.name, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    nostrSecret: raw.nostr, // secp256k1 secret for the Nostr backend (signing and NIP-44 to self)
    blossomKey: await subtle.importKey('raw', raw.blossom, 'AES-GCM', false, ['encrypt', 'decrypt']) // third layer on Blossom servers
  }
}

/** Note names are Unicode NFC-normalized everywhere (HMAC input and index key). */
export function normalizeName (name) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('note name must be a non-empty string')
  return name.normalize('NFC')
}

/** blob_id of a note: lowercase hex HMAC-SHA256(K_name, UTF-8 of NFC(name)), all 64 chars. */
export async function blobIdForName (keys, name) {
  return toHex(new Uint8Array(await subtle.sign('HMAC', keys.nameKey, enc.encode(normalizeName(name)))))
}

function aad (blobId) {
  return concat(MAGIC, enc.encode(blobId))
}

/** Layer 2 only: "OVK1" || nonce || AES-256-GCM(K_aes, nonce, inner, AAD). Exposed for vectors. */
export async function aesSeal (keys, blobId, inner, nonce = randomBytes(NONCE_LEN)) {
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(blobId) }, keys.aesKey, inner)
  return concat(MAGIC, nonce, new Uint8Array(ct))
}

export async function aesOpen (keys, blobId, blob) {
  blob = toBytes(blob)
  if (blob.length < MAGIC.length + NONCE_LEN + 16 || !MAGIC.every((b, i) => blob[i] === b)) {
    throw new CorruptBlobError('header', 'not an OVK1 blob')
  }
  const nonce = blob.subarray(4, 4 + NONCE_LEN)
  try {
    const inner = await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(blobId) },
      keys.aesKey,
      blob.subarray(4 + NONCE_LEN)
    )
    return new Uint8Array(inner)
  } catch (err) {
    throw new CorruptBlobError('aes', 'AES-GCM tag check failed (tampered, corrupted, or wrong blob id)', { cause: err })
  }
}

/** Full two-layer encryption of a note or the index. */
export async function encryptBlob (keys, blobId, plaintext) {
  const e = new age.Encrypter()
  e.addRecipient(keys.ageRecipient)
  const inner = await e.encrypt(toBytes(plaintext))
  return aesSeal(keys, blobId, inner)
}

export async function decryptBlob (keys, blobId, blob) {
  const inner = await aesOpen(keys, blobId, blob)
  const d = new age.Decrypter()
  d.addIdentity(keys.ageIdentity)
  try {
    return await d.decrypt(inner)
  } catch (err) {
    throw new CorruptBlobError('age', `age layer failed: ${err.message}`, { cause: err })
  }
}

// ---- vault ----

export async function createVault () {
  return {
    v: 1,
    age_identity: await age.generateX25519Identity(),
    master: toBase64(randomBytes(32)),
    created: new Date().toISOString()
  }
}

export async function encryptVault (vault, passphrase, { logN = DEFAULT_SCRYPT_LOG_N } = {}) {
  const e = new age.Encrypter()
  e.setPassphrase(passphrase)
  e.setScryptWorkFactor(logN)
  return e.encrypt(JSON.stringify(vault))
}

const ARMOR = '-----BEGIN AGE ENCRYPTED FILE-----'

/** vault.age is written binary; armored input is accepted too. */
export async function decryptVault (bytes, passphrase) {
  bytes = toBytes(bytes)
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart()
  if (head.startsWith(ARMOR)) bytes = age.armor.decode(new TextDecoder().decode(bytes))
  const d = new age.Decrypter()
  d.addPassphrase(passphrase)
  let text
  try {
    text = await d.decrypt(bytes, 'text')
  } catch (err) {
    throw new WrongPassphraseError({ cause: err })
  }
  const vault = JSON.parse(text)
  if (vault.v !== 1 || !vault.age_identity?.startsWith('AGE-SECRET-KEY-1') || fromBase64(vault.master).length !== 32) {
    throw new Error('vault.age decrypted but has an unexpected shape')
  }
  return vault
}

// ---- index ----

export function emptyIndex () {
  return { v: 1, notes: {} }
}

/**
 * Union of names; per name the newest `updated` wins (a tie goes to the index with the newer
 * `written`). Optional `locators` ({backend: {path: locator}}): for a note path the locator comes
 * from the index whose entry for that note won; for any other path from the newest `written`
 * index that has one.
 */
export function mergeIndexes (...indexes) {
  const t = (iso) => (iso ? Date.parse(iso) : 0)
  // oldest write first, so later (newer) indexes win ties below
  const list = indexes.filter(Boolean).sort((a, b) => t(a.written) - t(b.written))
  const out = emptyIndex()
  const winner = new Map() // note path -> index that supplied the winning entry
  for (const idx of list) {
    for (const [name, entry] of Object.entries(idx.notes ?? {})) {
      const cur = out.notes[name]
      if (!cur || t(entry.updated) >= t(cur.updated)) {
        out.notes[name] = entry
        winner.set(paths.note(entry.id), idx)
      }
    }
  }
  const locators = {}
  for (const idx of list) {
    for (const [backend, map] of Object.entries(idx.locators ?? {})) {
      locators[backend] ??= {}
      for (const [p, loc] of Object.entries(map)) {
        const w = winner.get(p)
        if (!w || w === idx) locators[backend][p] = loc
      }
    }
  }
  // a winning index without a locator for that path must not erase another index's locator
  for (const idx of [...list].reverse()) {
    for (const [backend, map] of Object.entries(idx.locators ?? {})) {
      for (const [p, loc] of Object.entries(map)) locators[backend][p] ??= loc
    }
  }
  if (Object.keys(locators).length) out.locators = locators
  // pastes (id -> {path, token, at}) the vault owns on paste-like backends: a union by id;
  // a paste deleted meanwhile just fails to delete again and drops out
  const pastes = {}
  for (const idx of list) {
    for (const [backend, map] of Object.entries(idx.pastes ?? {})) Object.assign(pastes[backend] ??= {}, map)
  }
  if (Object.keys(pastes).length) out.pastes = pastes
  const health = mergeHealth(list.map((idx) => idx.health))
  if (Object.keys(health).length) out.health = health
  const newest = list.at(-1)?.written
  if (newest) out.written = newest
  return out
}

const maxIso = (a, b) => (!a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a)

/**
 * Health ledger merge ({key: {backend: {last_ok, last_checked, status, expires}}}, key = note name,
 * "_vault" or "_index"): per key and backend, the entry with the newest `last_checked` wins
 * (a tie goes to the later input); `last_ok` is the newest seen in any input.
 */
export function mergeHealth (ledgers) {
  const out = {}
  for (const ledger of ledgers) {
    for (const [key, byBackend] of Object.entries(ledger ?? {})) {
      for (const [backend, e] of Object.entries(byBackend)) {
        out[key] ??= {}
        const cur = out[key][backend]
        const lastOk = maxIso(cur?.last_ok, e.last_ok)
        const next = !cur || Date.parse(e.last_checked) >= Date.parse(cur.last_checked) ? { ...e } : cur
        if (lastOk) next.last_ok = lastOk
        out[key][backend] = next
      }
    }
  }
  return out
}

export const HEALTH_KEYS = { vault: '_vault', index: '_index' }

export async function encryptIndex (keys, index) {
  return encryptBlob(keys, INDEX_ID, JSON.stringify(index))
}

export async function decryptIndex (keys, blob) {
  const bytes = await decryptBlob(keys, INDEX_ID, blob)
  let idx
  try {
    idx = JSON.parse(dec.decode(bytes))
  } catch (err) {
    throw new CorruptBlobError('json', 'index decrypted but is not valid JSON', { cause: err })
  }
  if (idx.v !== 1 || typeof idx.notes !== 'object' || (idx.locators !== undefined && typeof idx.locators !== 'object')) throw new CorruptBlobError('json', 'index has an unexpected shape')
  return idx
}

export const paths = {
  vault: 'vault.age',
  index: 'index.ovk',
  note: (blobId) => `notes/${blobId}.ovk`
}
