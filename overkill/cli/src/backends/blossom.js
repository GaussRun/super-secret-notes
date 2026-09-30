// Blossom blob servers (BUD-01 get, BUD-02 upload/delete, BUD-06 preflight). EXPERIMENTAL.
// Blobs are addressed by their sha256, so this backend is locator-addressed like PrivateBin:
// it keeps a map path -> blob URL, note locators travel in the encrypted index and the
// index locator goes in the recovery kit. Uploads are authorized with kind 24242 events
// signed by the vault's Nostr key (crypto.deriveNostrSecret), so no account and no extra
// secret. Third layer: AES-256-GCM under K_blossom = HKDF(master, "overkill v1 blossom"),
// blob = "OVKB" || nonce(12) || ciphertext. See docs/NOSTR.md.
import { finalizeEvent } from 'nostr-tools/pure'
import { toBase64, concat, sha256Hex, randomBytes, paths } from '../crypto.js'
import { logger } from '../log.js'
import { locatorState } from '../vaultsecrets.js'

export const info = {
  title: 'Blossom server (experimental)',
  blurb: 'Nostr blob servers: files addressed by their sha256, uploads signed with a key derived from your vault. No account. Free tiers can prune old blobs, so run `super-secret-notes check` and `repair`.',
  signup: 'https://github.com/hzrd149/blossom'
}

// verified 2026-09-29 by scripts/probe-blossom.js (upload, read-back, delete, CORS); results in
// docs/NOSTR.md. The first DEFAULT_COUNT are what `init` offers.
// Most big Blossom servers are media-only and refuse application/octet-stream (primal,
// blossom.band, nostr.build, 24242.io, azzamo, nostrcheck); these accept any bytes.
export const SERVERS = [
  'https://nostr.download',
  'https://blossom.ditto.pub',
  'https://cdn.hzrd149.com',
  'https://blossom.yakihonne.com',
  'https://files.sovbit.host',
  'https://blossom.nmail.li',
  'https://blossom.jumble.social'
]
export const DEFAULT_COUNT = 3
// Blossom servers promise no retention either (free tiers prune), so like Nostr copies a blob
// counts as expiring this long after this machine uploaded it, and `refresh` (default 90 days)
// republishes it once it is older than 30 days. Our policy, not the server's promise.
export const ASSUMED_RETENTION_DAYS = 120

const MAGIC = new TextEncoder().encode('OVKB')
const AAD = new TextEncoder().encode('overkill v1 blossom')
const subtle = globalThis.crypto.subtle
const hostOf = (url) => new URL(url).host
const nameFor = (url) => 'blossom-' + hostOf(url).replace(/^(blossom|cdn|files|media)\./, '').split('.')[0]

export async function prompt (ask) {
  const url = await ask(`  Server URL (verified ones: ${SERVERS.join(', ')}): `)
  return { url: url.trim().replace(/\/+$/, '') }
}

/** init: the default servers, or a hand-picked list. Each server becomes its own backend. */
export async function promptMany (ask, askYesNo) {
  const urls = await askYesNo(`  Use the ${DEFAULT_COUNT} default servers (${SERVERS.slice(0, DEFAULT_COUNT).join(', ')})?`, true)
    ? SERVERS.slice(0, DEFAULT_COUNT)
    : (await ask(`  Server URLs, comma separated (verified ones: ${SERVERS.join(', ')}): `)).split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean)
  return urls.map((url) => ({ name: nameFor(url), type: 'blossom', url }))
}

// every server is run by someone else, so each one is its own operator
export const operator = (cfg) => `Blossom ${hostOf(cfg.url)}`

export async function sealBlob (key, blob) {
  const nonce = randomBytes(12)
  return concat(MAGIC, nonce, new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, key, blob)))
}

export async function openBlob (key, sealed) {
  if (sealed.length < 32 || !MAGIC.every((b, i) => sealed[i] === b)) throw new Error('not an OVKB blob')
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(4, 16), additionalData: AAD }, key, sealed.subarray(16)))
}

/** BUD-02 authorization header: a kind 24242 event, valid for 5 minutes, for one verb and blob. */
export function authHeader (secret, verb, sha256, server) {
  const now = Math.floor(Date.now() / 1000)
  const tags = [['t', verb], ['expiration', String(now + 300)]]
  if (sha256) tags.push(['x', sha256])
  if (server) tags.push(['server', hostOf(server)])
  const ev = finalizeEvent({ kind: 24242, created_at: now, tags, content: `overkill ${verb}` }, secret)
  return 'Nostr ' + toBase64(new TextEncoder().encode(JSON.stringify(ev)))
}

const corrupt = (message) => Object.assign(new Error(message), { corrupt: true })
const shaOf = (url) => /([0-9a-f]{64})(?:\.[a-z0-9]+)?$/.exec(new URL(url).pathname)?.[1]

// server-chosen addresses: holds notes and vault.age, never the index (docs/OVERKILL.md)
export const addressing = 'locator'

export function create (cfg, ctx, { fetchImpl = globalThis.fetch } = {}) {
  const base = cfg.url.replace(/\/+$/, '')
  // kept in secrets.ovk, like the paste locators
  const local = locatorState(ctx, cfg.name)
  let secret = null
  let key = null
  let state = null // path -> { url, at } (at: when this machine uploaded it; unknown for learned locators)
  const retentionDays = cfg.assumeRetentionDays ?? ASSUMED_RETENTION_DAYS
  let loadedLocked = false

  async function load () {
    if (state && !(loadedLocked && local.unlocked())) return state
    loadedLocked = !local.unlocked()
    state = (await local.read('paths')) ?? {}
    // locators from a kit or bootstrap record ("locators": {"vault.age": url}) until they move into secrets.ovk
    for (const [p, url] of Object.entries(cfg.locators ?? {})) state[p] ??= { url }
    return state
  }
  async function save () {
    await local.write({ paths: state })
  }
  const reason = (res) => res.headers.get('x-reason') ?? `HTTP ${res.status}`

  async function remove (sha) {
    const res = await fetchImpl(`${base}/${sha}`, { method: 'DELETE', headers: { Authorization: authHeader(secret, 'delete', sha, base) } })
    if (!res.ok && res.status !== 404) logger.debug(`${cfg.name}: could not delete old blob ${sha}: ${reason(res)}`)
  }

  return {
    name: cfg.name,
    type: 'blossom',
    where: base,
    addressing: 'locator',
    unlock (keys) {
      secret = keys.nostrSecret
      key = keys.blossomKey
    },
    async put (rel, bytes) {
      if (!secret) throw new Error('vault is locked, no Nostr key yet')
      const s = await load()
      const sealed = await sealBlob(key, bytes)
      const sha = await sha256Hex(sealed)
      const res = await fetchImpl(`${base}/upload`, {
        method: 'PUT',
        headers: { Authorization: authHeader(secret, 'upload', sha, base), 'Content-Type': 'application/octet-stream', 'X-SHA-256': sha },
        body: sealed
      })
      if (!res.ok) throw new Error(`${base} refused the upload: ${reason(res)}`)
      const desc = await res.json().catch(() => ({}))
      if (desc.sha256 && desc.sha256 !== sha) throw new Error(`${base} stored sha256 ${desc.sha256}, expected ${sha}`)
      const old = s[rel]
      s[rel] = { url: `${base}/${sha}`, at: new Date().toISOString() }
      await save()
      // be a good guest: drop the version we just replaced, unless another path still uses it
      const oldSha = old && shaOf(old.url)
      if (oldSha && oldSha !== sha && !Object.values(s).some((v) => shaOf(v.url) === oldSha)) await remove(oldSha).catch(() => {})
    },
    async get (rel) {
      const loc = (await load())[rel]
      if (!loc || !key) return null
      const sha = shaOf(loc.url)
      const res = await fetchImpl(`${base}/${sha}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`${base}: ${reason(res)}`)
      const body = new Uint8Array(await res.arrayBuffer())
      if (await sha256Hex(body) !== sha) throw corrupt(`${base} served bytes whose sha256 is not ${sha}`)
      try {
        return await openBlob(key, body)
      } catch (err) {
        throw corrupt(`Blossom layer failed: ${err.message}`)
      }
    },
    async exists (rel) {
      return Boolean((await load())[rel])
    },
    async list (dir) {
      const prefix = dir ? `${dir}/` : ''
      return Object.keys(await load()).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length))
    },
    /** No retention promised: expiring ASSUMED_RETENTION_DAYS after this machine uploaded it; null if unknown. */
    expiresAt (rel) {
      const at = state?.[rel]?.at
      return at ? new Date(Date.parse(at) + retentionDays * 86_400_000) : null
    },
    /** The expiry above is our assumption, not the server's (see ASSUMED_RETENTION_DAYS). */
    assumedRetention: true,
    /** Forget a path here and delete its blob (used to move the index off locator backends). */
    async dropPath (rel) {
      const s = await load()
      if (!s[rel]) return false
      if (secret) await remove(new URL(s[rel].url).pathname.split('/').pop().replace(/\..*$/, ''))
      delete s[rel]
      await save()
      return true
    },
    /** path -> blob URL, for the index and the recovery kit */
    async getLocators () {
      return Object.fromEntries(Object.entries(await load()).map(([p, v]) => [p, v.url]))
    },
    /** Adopt locators from the merged index. index.ovk is never in there. */
    async learnLocators (map = {}) {
      const s = await load()
      let changed = false
      for (const [p, url] of Object.entries(map)) {
        if (p === paths.index || s[p]?.url === url) continue
        s[p] = { url }
        changed = true
      }
      if (changed) await save()
    },
    async close () {}
  }
}
