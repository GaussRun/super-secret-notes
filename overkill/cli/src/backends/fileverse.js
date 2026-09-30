// Fileverse dDocs (https://ddocs.new), opt-in. Each blob becomes a private dDoc in the account's
// Developer Space: title = sha256(root/path) in hex, so note names never reach Fileverse;
// content = the blob as base64 inside a fenced code block, so the markdown -> Yjs conversion
// keeps it verbatim. Fileverse adds its own layer on top (AES-256-GCM per save, file key locked
// with ECIES to the portal key), pins to IPFS and records the CIDs on Gnosis with a sponsored
// user operation.
//
// Account: with "derived": true (the default from init) the vault owns it. A wallet, the portal
// keys and the API key are derived from the master (crypto.deriveFileverseSecrets) and the
// account is created on first use with a Privy SIWE wallet login and the same calls the web app
// makes for Developer Mode (fileverse-account.js). Nothing is cached: every run re-derives the
// key. Alternatively "apiKey" holds a key the user generated in the web app.
//
// Writes run the official @fileverse/api library (its `base` export, optional dependency) in a
// child process with an in-memory database (fileverse-embedded.js): no server, no port, no file.
// Reads never need it: portal contract on Gnosis -> metadata and content on IPFS -> decrypt with
// the portal key, which the API key unlocks.
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { mapHashToField } from '@noble/curves/abstract/modular.js'
import * as Y from 'yjs'
import { resolveSecret } from '../secrets.js'
import { logger } from '../log.js'
import { deriveFileverseSecrets } from '../crypto.js'

export const info = {
  title: 'Fileverse dDocs (opt-in)',
  blurb: 'End-to-end encrypted docs on IPFS + Gnosis, gasless. No signup: the vault derives a wallet, logs in to Fileverse with it (Privy SIWE, like their web app) and creates its Developer Space and API key on first use. Uses the official @fileverse/api library (optional dependency, about 200 MB). Their Acceptable Use Policy bans backing up to the service and account creation outside their public interfaces; decide for yourself whether your use fits.',
  signup: 'https://ddocs.new'
}

export const DEFAULTS = {
  rpcUrl: 'https://rpc.gnosischain.com',
  storageUrl: 'https://apps-storage.fileverse.io',
  gateways: ['https://apps-ipfs.fileverse.io/ipfs', 'https://gateway.pinata.cloud/ipfs']
}

export async function prompt (ask, askSecret) {
  const apiKey = (await askSecret('  Fileverse API key from the web app, or Enter to let the vault create its own account: ')).trim()
  if (!apiKey) return { derived: true }
  return { apiKey: apiKey.startsWith('env:') ? { env: apiKey.slice(4) } : apiKey }
}

// a login backend: with its API key in secrets.ovk (or derived) it can travel in the bootstrap record
export const travelsWithSecrets = true

export const operator = () => 'Fileverse'

/** Removes anything secret-looking from an error message before it leaves the writer. */
export function redact (text, secrets = []) {
  let out = String(text)
  for (const s of secrets) if (s) out = out.split(s).join('<redacted>')
  return out
    .replace(/apiKey=[^\s&"']+/g, 'apiKey=<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '<jwt>')
}

// ---------------------------------------------------------------------------------------------
// payload format inside a dDoc

const FENCE = '```'

/** The dDoc body for a blob: base64 in a code block, so markdown never rewrites it. */
export const encodeDoc = (bytes) => `${FENCE}\n${Buffer.from(bytes).toString('base64')}\n${FENCE}`

/** Inverse of encodeDoc; accepts the raw markdown (daemon DB) or the text read back from Yjs. */
export function decodeDoc (text) {
  const b64 = text.replaceAll(FENCE, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4) throw new Error('fileverse: document is not an Overkill blob')
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

export const titleFor = (root, rel) => createHash('sha256').update(`${root}/${rel}`).digest('hex')

// ---------------------------------------------------------------------------------------------
// network read path (no daemon needed)

const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function gcmOpen (key, iv, ct, tag) {
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

// @fileverse/crypto webcrypto format: base64(nonce(24) || ciphertext || tag(16))
function webcryptoOpen (key, data) {
  const buf = Buffer.isBuffer(data) ? data : b64(data)
  return gcmOpen(key, buf.subarray(0, 24), buf.subarray(24, buf.length - 16), buf.subarray(buf.length - 16))
}

// @fileverse/crypto ECIES: secp256k1 ECDH, HKDF-SHA256(salt = ephemeral pubkey), AES-256-GCM,
// serialized as ephemeralPub__n__nonce__n__ciphertext__n__mac (base64 parts)
function eciesOpen (priv, str) {
  const [eph, nonce, ct, mac] = str.split('__n__').map(b64)
  if (!mac) throw new Error('fileverse: bad ECIES string')
  const shared = secp256k1.getSharedSecret(priv, eph)
  const key = Buffer.from(hkdfSync('sha256', shared, eph, 'ECIES-AES256-GCM-SHA256', 32))
  return gcmOpen(key, nonce, ct, mac)
}

/** API key -> { portalAddress, portalKey }, from the encrypted material Fileverse stores for the key. */
export async function unlockPortal (apiKey, storageUrl = DEFAULTS.storageUrl) {
  const raw = b64(apiKey)
  const id = '0x' + createHash('sha256').update(raw).digest('hex')
  const res = await fetch(`${storageUrl}/api-access/${id}`)
  if (!res.ok) throw new Error(`fileverse: API key lookup failed (HTTP ${res.status})`)
  const { encryptedAppMaterial } = await res.json()
  const aes = Buffer.from(hkdfSync('sha256', raw, Buffer.from([0]), 'SAVED_DATA_ENCRYPTION_KEY', 32))
  const app = JSON.parse(webcryptoOpen(aes, encryptedAppMaterial).toString('utf8'))
  const portalKey = mapHashToField(b64(app.portalSeed), secp256k1.Point.CURVE().n)
  return { portalAddress: app.portalAddress, portalKey }
}

const SEL_FILES = '0xf4c714b4' // files(uint256)
const SEL_COUNT = '0xbab50cc9' // getFileCount()

async function ethCall (rpcUrl, to, data) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
  })
  const j = await res.json()
  if (j.error) throw new Error(`fileverse: eth_call failed: ${j.error.message}`)
  return Buffer.from(j.result.slice(2), 'hex')
}

// files(i) returns (string appFileId, uint8 type, string metadataCID, string contentCID, string gateCID, uint256 version, address owner)
function decodeFile (buf) {
  const word = (i) => buf.subarray(i * 32, i * 32 + 32)
  const num = (w) => Number(BigInt('0x' + Buffer.from(w).toString('hex')))
  const str = (i) => {
    const off = num(word(i))
    const len = num(buf.subarray(off, off + 32))
    return buf.subarray(off + 32, off + 32 + len).toString('utf8')
  }
  return { ddocId: str(0), metadataCID: str(2), contentCID: str(3), gateCID: str(4) }
}

export async function portalFileCount (rpcUrl, portalAddress) {
  return Number(BigInt('0x' + (await ethCall(rpcUrl, portalAddress, SEL_COUNT)).toString('hex')))
}

export async function portalFile (rpcUrl, portalAddress, fileId) {
  return { fileId, ...decodeFile(await ethCall(rpcUrl, portalAddress, SEL_FILES + fileId.toString(16).padStart(64, '0'))) }
}

export async function listPortalFiles (rpcUrl, portalAddress, from = 0) {
  const count = await portalFileCount(rpcUrl, portalAddress)
  const out = []
  for (let i = from; i < count; i++) {
    const f = await portalFile(rpcUrl, portalAddress, i)
    if (f.metadataCID && f.contentCID) out.push(f)
  }
  return out
}

async function ipfs (gateways, cid) {
  let last
  for (const g of gateways) {
    try {
      const res = await fetch(`${g}/${cid}`, { signal: AbortSignal.timeout(30000) })
      if (res.ok) return Buffer.from(await res.arrayBuffer())
      last = new Error(`HTTP ${res.status} from ${g}`)
    } catch (err) { last = err }
  }
  throw new Error(`fileverse: could not fetch ${cid} (${last?.message})`)
}

/** Plain text of a dDoc Yjs state (all text nodes, in document order, one line per block). */
export function yjsText (updateB64) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Buffer.from(updateB64, 'base64'))
  const lines = []
  const walk = (node) => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) lines.push(child.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '')).join(''))
      else walk(child)
    }
  }
  walk(doc.getXmlFragment('default'))
  doc.destroy()
  return lines.join('\n')
}

/** Decrypts one on-chain file: its title and its text. */
export async function readRemoteFile (portalKey, gateways, file) {
  const meta = JSON.parse((await ipfs(gateways, file.metadataCID)).toString('utf8'))
  const fileKey = eciesOpen(portalKey, meta.appLock.lockedFileKey)
  const title = webcryptoOpen(fileKey, meta.title).toString('utf8')
  const blob = await ipfs(gateways, file.contentCID)
  // content file: ciphertext || tag(16) || iv(12)
  const n = blob.length
  const json = JSON.parse(gcmOpen(fileKey, blob.subarray(n - 12), blob.subarray(0, n - 28), blob.subarray(n - 28, n - 12)).toString('utf8'))
  return { title, text: yjsText(json.file), ddocId: meta.ddocId }
}

// ---------------------------------------------------------------------------------------------
// network reader: title -> newest on-chain file, and file contents, from Gnosis + IPFS only

// cache: optional { load(), save(v) } for the title -> file map. File ids only grow and our
// titles never change, so a run only has to look at files added since the last scan (one
// getFileCount call plus one metadata fetch per new file) instead of every file of the portal.
export function makeNetworkReader ({ apiKey, rpcUrl = DEFAULTS.rpcUrl, gateways = DEFAULTS.gateways, storageUrl = DEFAULTS.storageUrl, name = 'fileverse', cache = null }) {
  let unlocked = null
  let index = null // Map title -> { fileId, ddocId }
  const unlock = () => (unlocked ??= (async () => unlockPortal(await apiKey(), storageUrl))().catch((err) => { unlocked = null; throw err }))
  return {
    async index () {
      if (index) return index
      const { portalAddress, portalKey } = await unlock()
      const saved = (await cache?.load().catch(() => null)) ?? null
      const fresh = !saved || saved.v !== 1 || saved.portal !== portalAddress.toLowerCase()
      const byTitle = new Map(fresh ? [] : Object.entries(saved.titles).map(([t, [fileId, ddocId]]) => [t, { fileId, ddocId }]))
      const from = fresh ? 0 : saved.scanned
      const count = await portalFileCount(rpcUrl, portalAddress)
      for (let i = from; i < count; i++) {
        const f = await portalFile(rpcUrl, portalAddress, i)
        if (!f.metadataCID || !f.contentCID) continue
        try {
          const meta = JSON.parse((await ipfs(gateways, f.metadataCID)).toString('utf8'))
          const title = webcryptoOpen(eciesOpen(portalKey, meta.appLock.lockedFileKey), meta.title).toString('utf8')
          if (!byTitle.has(title) || byTitle.get(title).fileId < f.fileId) byTitle.set(title, { fileId: f.fileId, ddocId: f.ddocId })
        } catch (err) {
          logger.debug(`${name}: skipping portal file ${f.fileId}: ${err.message}`)
        }
      }
      if (cache && (fresh || count > from)) {
        await cache.save({ v: 1, portal: portalAddress.toLowerCase(), scanned: count, titles: Object.fromEntries([...byTitle].map(([t, r]) => [t, [r.fileId, r.ddocId]])) }).catch((err) => logger.debug(`${name}: file map cache: ${err.message}`))
      }
      return (index = byTitle)
    },
    /** Records a write so later lookups in this run need no rescan (the next run scans it once). */
    note (title, ref) { index?.set(title, ref) },
    /** The current text of an on-chain file (always the latest version: files(i) is read fresh). */
    async read (fileId) {
      const { portalAddress, portalKey } = await unlock()
      const f = await portalFile(rpcUrl, portalAddress, fileId)
      if (!f.metadataCID || !f.contentCID) return null
      return (await readRemoteFile(portalKey, gateways, f)).text
    }
  }
}

// ---------------------------------------------------------------------------------------------
// embedded writer client: forks fileverse-embedded.js and talks to it over IPC

export function makeEmbeddedClient ({ apiKey, rpcUrl, name = 'fileverse' }) {
  let child = null
  let seq = 0
  const pending = new Map()
  let secret = null
  function start () {
    if (child) return child
    child = fork(fileURLToPath(new URL('./fileverse-embedded.js', import.meta.url)), [], {
      // the key goes in the environment, never argv (visible in ps); output is discarded because
      // the library logs to stdout on its own
      env: { ...process.env, FILEVERSE_API_KEY: secret, FILEVERSE_RPC_URL: rpcUrl },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    child.on('message', (msg) => {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg)
      else p.reject(new Error(msg.missing
        ? `${name}: Fileverse needs the optional dependency @fileverse/api (pnpm install)`
        : `${name}: ${msg.error}`))
    })
    child.on('exit', (code) => {
      const err = new Error(`${name}: Fileverse writer exited (code ${code}) ${redact(stderr.trim().split('\n').pop() ?? '', [secret])}`)
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      child = null
    })
    return child
  }
  const call = async (msg) => {
    secret ??= await apiKey()
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      start().send({ id, ...msg })
    })
  }
  return {
    create: (title, content) => call({ op: 'create', title, content }),
    update: (ref, title, content) => call({ op: 'update', title, content, fileId: ref.fileId, ddocId: ref.ddocId }),
    close () { if (child) { child.disconnect(); child = null } }
  }
}

// ---------------------------------------------------------------------------------------------
// adapter

// deps (tests only) replaces the writer, the reader and/or the account setup.
export function create (cfg, ctx, deps = {}) {
  if (cfg.mode && cfg.mode !== 'embedded') throw new Error(`${cfg.name}: Fileverse mode "${cfg.mode}" is gone; only the embedded library mode exists`)
  const root = (cfg.root ?? ctx.root).replace(/^\/+|\/+$/g, '')
  const rpcUrl = cfg.rpcUrl ?? DEFAULTS.rpcUrl
  let keys = null
  let apiKeyP = null
  // the API key: from config, or derived from the vault and registered with Fileverse on first use
  const key = () => (cfg.derived && !keys) ? Promise.reject(new Error('vault is locked')) : (apiKeyP ??= (async () => {
    if (!cfg.derived) return resolveSecret(cfg.apiKey, `${cfg.name} API key`, ctx.secrets, cfg.name, 'apiKey')
    const secrets = await deriveFileverseSecrets(keys.master)
    const ensure = deps.ensureApiKey ?? (await import('./fileverse-account.js')).ensureApiKey
    const stateFile = path.join(ctx.home, 'locators', `${cfg.name}.fileverse-account.json`)
    const state = {
      load: () => readFile(stateFile, 'utf8').then(JSON.parse, () => ({})),
      save: async (v) => { await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 }); await writeFile(stateFile, JSON.stringify(v, null, 1), { mode: 0o600 }) }
    }
    const res = await ensure(secrets, { name: cfg.name, report: (m) => logger.info(m), state })
    if (res.created) logger.info(`${cfg.name}: Fileverse account ready (wallet ${res.wallet}, portal ${res.portalAddress})`)
    return res.apiKey
  })())
  // one setup attempt per run: a failure is kept for the rest of the run instead of hitting
  // Privy and the paymaster again for every blob; the next run resumes from the saved progress
  // deps.reader / deps.writer: an object, or a factory that gets the key getter
  const pick = (d, make) => (typeof d === 'function' ? d(key) : d ?? make())
  const mapFile = path.join(ctx.home, 'locators', `${cfg.name}.fileverse-files.json`)
  const cache = {
    load: () => readFile(mapFile, 'utf8').then(JSON.parse, () => null),
    save: async (v) => { await mkdir(path.dirname(mapFile), { recursive: true, mode: 0o700 }); await writeFile(mapFile, JSON.stringify(v), { mode: 0o600 }) }
  }
  const reader = pick(deps.reader, () => makeNetworkReader({ apiKey: key, rpcUrl, gateways: cfg.gateways, storageUrl: cfg.storageUrl, name: cfg.name, cache }))
  const writer = pick(deps.writer, () => makeEmbeddedClient({ apiKey: key, rpcUrl, name: cfg.name }))

  // titles are hashes, so list() needs the paths back: title -> rel for every path seen, kept
  // next to the other per-backend state (it holds no secrets, only Overkill's own blob paths)
  const pathsFile = path.join(ctx.home, 'locators', `${cfg.name}.fileverse-paths.json`)
  let paths = null
  async function knownPaths () {
    paths ??= new Map(Object.entries(await readFile(pathsFile, 'utf8').then(JSON.parse, () => ({}))))
    return paths
  }
  async function remember (title, rel) {
    const m = await knownPaths()
    if (m.get(title) === rel) return
    m.set(title, rel)
    await mkdir(path.dirname(pathsFile), { recursive: true, mode: 0o700 })
    await writeFile(pathsFile, JSON.stringify(Object.fromEntries(m), null, 1), { mode: 0o600 })
  }

  return {
    name: cfg.name,
    type: 'fileverse',
    where: `fileverse:${root}`,
    unlock (k) { keys = k },
    async put (rel, bytes) {
      const title = titleFor(root, rel)
      await remember(title, rel)
      const content = encodeDoc(bytes)
      // an existing on-chain file for this title is edited in place (same fileId and ddocId).
      // Except fileId 0: @fileverse/api 1.0.10 decides edit vs add with `if (fileId)`, so it
      // re-adds file 0 instead of editing it (and then reports "EditedFile event not found").
      // A fresh create is fine: the reader takes the newest fileId for a title.
      const existing = (await reader.index()).get(title)
      const ref = existing?.fileId > 0 ? await writer.update(existing, title, content) : await writer.create(title, content)
      reader.note(title, { fileId: ref.fileId, ddocId: ref.ddocId })
    },
    async get (rel) {
      const title = titleFor(root, rel)
      const ref = (await reader.index()).get(title)
      if (!ref) return null
      const text = await reader.read(ref.fileId)
      if (text === null) return null
      const bytes = decodeDoc(text)
      await remember(title, rel)
      return bytes
    },
    async exists (rel) {
      return (await reader.index()).has(titleFor(root, rel))
    },
    // Titles are hashes, so a listing only names paths this machine has written or read
    // (the store itself enumerates notes from the index, not from list()).
    async list (dir) {
      const prefix = dir.replace(/^\/+|\/+$/g, '')
      const titles = await reader.index()
      const names = []
      for (const [title, rel] of await knownPaths()) {
        if (!titles.has(title)) continue
        const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        if (parent === prefix) names.push(rel.slice(parent ? parent.length + 1 : 0))
      }
      return names.sort()
    },
    async close () { writer?.close?.() }
  }
}
