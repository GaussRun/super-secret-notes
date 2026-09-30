// PrivateBin instances (https://privatebin.info/directory/). Each paste gets its own
// AES-256-GCM layer with the key in the URL fragment, so this is a real third layer too.
// Paste IDs are chosen by the server, so this backend is locator-addressed: it keeps a
// map path -> paste URL (with #key). Note locators travel in the encrypted index
// ("locators"); the vault.age and index.ovk locators go in the recovery kit.
import { base58 } from '@scure/base'
import { toBase64, fromBase64, randomBytes, paths } from '../crypto.js'
import { logger } from '../log.js'
import { locatorState } from '../vaultsecrets.js'

export const info = {
  title: 'PrivateBin instance',
  blurb: 'Anonymous, volunteer-run pastebins with "never" expiry and their own AES layer. No account. Add three from different operators; instances do die now and then, `repair` re-uploads.',
  signup: 'https://privatebin.info/directory/'
}

// verified 2026-09-29 to offer `never` expiry (docs/OVERKILL.md, backend admission rule);
// the first three also honored it server side
export const INSTANCES = [
  'https://pb.envs.net',
  'https://paste.systemli.org',
  'https://extrait.facil.services',
  'https://bin.disroot.org',
  'https://paste.evolix.org',
  'https://cryptostorm.is/paste',
  'https://paste.d-ku.de',
  'https://0g.gg',
  'https://paste.unredacted.org',
  'https://bin.infra.mee6.cloud',
  'https://paste.coalserver.de'
]
export const DEFAULT_COUNT = 3

const nameFor = (url) => 'pb-' + new URL(url).hostname.replace(/^(www|paste|pb|bin)\./, '').split('.')[0]

export async function prompt (ask) {
  const url = await ask(`  Instance URL (verified ones: ${INSTANCES.join(', ')}): `)
  return { url: url.replace(/\/+$/, '') }
}

/** init: the default three, or a hand-picked list. Each instance becomes its own backend. */
export async function promptMany (ask, askYesNo) {
  const urls = await askYesNo(`  Use the ${DEFAULT_COUNT} default instances (${INSTANCES.slice(0, DEFAULT_COUNT).join(', ')})?`, true)
    ? INSTANCES.slice(0, DEFAULT_COUNT)
    : (await ask(`  Instance URLs, comma separated (verified ones: ${INSTANCES.join(', ')}): `)).split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean)
  return urls.map((url) => ({ name: nameFor(url), type: 'privatebin', url }))
}

// every instance is run by someone else, so each one is its own operator
export const operator = (cfg) => `PrivateBin ${new URL(cfg.url).host}`

// some instances sit behind Cloudflare's browser integrity check
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const ITERATIONS = 100000
const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()

async function pasteKey (key, salt) {
  const base = await subtle.importKey('raw', key, 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** PrivateBin format v2, no password, no compression. Our blob goes in as base64 text. */
export async function sealPaste (blob, key = randomBytes(32)) {
  const iv = randomBytes(16)
  const salt = randomBytes(8)
  const adata = [[toBase64(iv), toBase64(salt), ITERATIONS, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 0, 0]
  const pt = enc.encode(JSON.stringify({ paste: toBase64(blob) }))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(JSON.stringify(adata)), tagLength: 128 }, await pasteKey(key, salt), pt)
  return { key, body: { v: 2, adata, ct: toBase64(new Uint8Array(ct)), meta: { expire: 'never' } } }
}

export async function openPaste (paste, key) {
  const [[iv, salt, iter, keySize, tagSize, algo, mode, compression]] = paste.adata
  if (paste.v !== 2 || iter !== ITERATIONS || keySize !== 256 || tagSize !== 128 || algo !== 'aes' || mode !== 'gcm' || compression !== 'none') {
    throw new Error('unexpected PrivateBin paste parameters')
  }
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: enc.encode(JSON.stringify(paste.adata)), tagLength: 128 },
    await pasteKey(key, fromBase64(salt)),
    fromBase64(paste.ct)
  )
  return fromBase64(JSON.parse(new TextDecoder().decode(pt)).paste)
}

export function parseLocator (locator) {
  const u = new URL(locator)
  return { base: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, id: u.search.slice(1), key: base58.decode(u.hash.slice(1)) }
}

// server-chosen addresses: holds notes and vault.age, never the index (docs/OVERKILL.md)
export const addressing = 'locator'

/**
 * `browser`: send CORS simple requests (Content-Type text/plain, Accept application/json, no
 * X-Requested-With and no User-Agent). PrivateBin answers no preflight, but it detects a JSON
 * client by that Accept header and parses the body as JSON whatever its Content-Type.
 */
export function create (cfg, ctx, { browser = false } = {}) {
  const base = cfg.url.replace(/\/+$/, '')
  // kept in secrets.ovk: the URLs carry the paste keys, and the tokens allow deleting
  const local = locatorState(ctx, cfg.name)
  // path -> { url, deletetoken } for the pastes this machine reads and writes
  let state = null
  let loadedLocked = false
  // every live paste the vault created on this instance, by any machine: id -> { path, token, at }.
  // It travels in the encrypted index ("pastes"), so any machine can clean up after the others.
  let owned = null
  const expiry = new Map() // path -> Date, from the last read, when the instance reports one

  async function load () {
    // read before the vault was unlocked (vault.age on a new machine): read again now
    if (state && !(loadedLocked && local.unlocked())) return state
    loadedLocked = !local.unlocked()
    state = (await local.read('paths')) ?? {}
    // locators from a kit or bootstrap record ("locators": {"vault.age": url}) until they move into secrets.ovk
    for (const [p, url] of Object.entries(cfg.locators ?? {})) state[p] ??= { url }
    return state
  }
  async function save () {
    await local.write({ paths: state ?? {}, ...(owned ? { pastes: owned } : {}) })
  }
  async function loadOwned () {
    owned ??= (await local.read('pastes')) ?? {}
    return owned
  }
  // true when the paste is gone afterwards (deleted now, or already gone)
  async function remove (id, token) {
    const res = await api(`${base}/`, { method: 'POST', body: JSON.stringify({ pasteid: id, deletetoken: token }) })
    return res.status === 0 || /does not exist|expired|deleted/i.test(res.message ?? '')
  }

  async function api (url, init = {}) {
    const res = await fetch(url, {
      ...init,
      headers: browser
        ? { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'text/plain' } : {}) }
        : { 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'JSONHttpRequest', ...(init.body ? { 'Content-Type': 'application/json' } : {}) }
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { throw new Error(`${base} answered HTTP ${res.status} with non-JSON (${text.length} bytes)`) }
    return json
  }

  return {
    name: cfg.name,
    type: 'privatebin',
    where: base,
    addressing: 'locator',
    async put (rel, bytes) {
      const s = await load()
      const { key, body } = await sealPaste(bytes)
      let res
      for (let attempt = 0; ; attempt++) {
        res = await api(`${base}/`, { method: 'POST', body: JSON.stringify(body) })
        // PrivateBin's traffic limiter: "Please wait 10 seconds between each post."
        const wait = /wait (\d+) seconds?/i.exec(res.message ?? '')
        if (res.status === 0 || !wait || attempt >= 3) break
        logger.info(`${cfg.name}: instance asks for ${wait[1]} s between posts, waiting politely`)
        await new Promise((resolve) => setTimeout(resolve, (Number(wait[1]) + 1) * 1000))
      }
      if (res.status !== 0) throw new Error(`${base}: ${res.message ?? 'upload refused'}`)
      const o = await loadOwned()
      const old = s[rel]
      s[rel] = { url: `${base}/?${res.id}#${base58.encode(key)}`, deletetoken: res.deletetoken }
      o[res.id] = { path: rel, token: res.deletetoken, at: new Date().toISOString() }
      await save()
      // be a good guest on a volunteer server: drop the version we just replaced
      if (old && old.url !== s[rel].url) {
        const { id } = parseLocator(old.url)
        const token = old.deletetoken ?? o[id]?.token
        if (token) {
          const gone = await remove(id, token).catch((err) => { logger.debug(`${cfg.name}: could not delete old paste: ${err.message}`); return false })
          if (gone) { delete o[id]; await save() }
        }
      }
    },
    async get (rel) {
      const loc = (await load())[rel]
      if (!loc) return null
      const { id, key } = parseLocator(loc.url)
      const paste = await api(`${base}/?pasteid=${encodeURIComponent(id)}`)
      if (paste.status !== 0) {
        if (/does not exist|expired|deleted/i.test(paste.message ?? '')) return null
        throw new Error(`${base}: ${paste.message ?? 'read failed'}`)
      }
      // "never" pastes carry no time_to_live; an admin who capped expiry later would show up here
      if (paste.meta?.time_to_live > 0) expiry.set(rel, new Date(Date.now() + paste.meta.time_to_live * 1000))
      else expiry.delete(rel)
      try {
        return await openPaste(paste, key)
      } catch (err) {
        throw Object.assign(new Error(`PrivateBin layer failed: ${err.message}`), { corrupt: true })
      }
    },
    async exists (rel) {
      return Boolean((await load())[rel])
    },
    async list (dir) {
      const prefix = dir ? `${dir}/` : ''
      return Object.keys(await load()).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length))
    },
    /** When this copy will expire, as seen on the last get(); null = never. */
    expiresAt (rel) {
      return expiry.get(rel) ?? null
    },
    /** path -> locator URL, for the index and the recovery kit */
    async getLocators () {
      return Object.fromEntries(Object.entries(await load()).map(([p, v]) => [p, v.url]))
    },
    /** id -> { path, token, at } of every paste this vault still owns here (goes into the index). */
    async ownedPastes () {
      return { ...await loadOwned() }
    },
    /** Learn pastes (and their delete tokens) that other machines created. */
    async adoptPastes (map = {}) {
      const o = await loadOwned()
      let changed = false
      for (const [id, e] of Object.entries(map)) if (!o[id]) { o[id] = e; changed = true }
      if (changed) await save()
    },
    /** Delete one of the vault's pastes by id; true when it is gone (or was already). */
    async deletePaste (id, token = null) {
      const o = await loadOwned()
      token ??= o[id]?.token
      if (!token) return false
      const gone = await remove(id, token)
      if (gone && o[id]) { delete o[id]; await save() }
      return gone
    },
    /** Forget a path here and delete its paste (used to move the index off paste backends). */
    async dropPath (rel) {
      const s = await load()
      const o = await loadOwned()
      if (!s[rel]) return false
      const { id } = parseLocator(s[rel].url)
      const token = s[rel].deletetoken ?? o[id]?.token
      if (token) await remove(id, token).catch((err) => logger.debug(`${cfg.name}: could not delete ${rel} paste: ${err.message}`))
      delete s[rel]
      delete o[id]
      await save()
      return true
    },
    /** Adopt locators from the merged index. index.ovk is never in there (it cannot point to itself). */
    async learnLocators (map = {}) {
      const s = await load()
      let changed = false
      for (const [p, url] of Object.entries(map)) {
        if (p === paths.index || s[p]?.url === url) continue
        s[p] = { url } // no deletetoken: another device uploaded it
        changed = true
      }
      if (changed) await save()
    },
    async close () {}
  }
}
