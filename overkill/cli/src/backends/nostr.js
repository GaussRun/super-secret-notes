// Nostr relays (EXPERIMENTAL, relies on `super-secret-notes refresh`). Each path is a NIP-78 (kind 30078)
// addressable event whose d tag is "<root>/<path>", signed with a key derived from the vault
// master (crypto.deriveNostrSecret), so there is no extra secret. The content is NIP-44 v2
// encryption to ourselves (ChaCha20 + HMAC-SHA256), a third layer like PrivateBin's AES.
// Blobs over CHUNK bytes are split into several events. Relays promise no retention, so
// copies report an assumed expiry and `refresh` republishes them. See docs/NOSTR.md.
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { npubEncode } from 'nostr-tools/nip19'
import { toBase64, fromBase64, concat, sha256Hex, paths } from '../crypto.js'
import { logger } from '../log.js'

export const info = {
  title: 'Nostr relay (experimental)',
  blurb: 'Public relays, no account: your blobs as NIP-44 encrypted events signed by a key derived from your vault. Relays promise no retention, so run `super-secret-notes refresh` from cron. Add four.',
  signup: 'https://nostr.watch/'
}

// verified 2026-09-29 by scripts/probe-nostr-relays.js (write, read-back, size, old data);
// the best 10 of 24 writable relays, results in docs/NOSTR.md. The first DEFAULT_COUNT are what `init` offers.
// relay.damus.io passed too but bans an IP for a while after a few quick writes, so it is
// listed last and not a default
export const RELAYS = [
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://purplerelay.com',
  'wss://nostr.oxtr.dev',
  'wss://nostr.data.haus',
  'wss://relay.nostr.wirednet.jp',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.illuminodes.com',
  'wss://strfry.bonsai.com',
  'wss://schnorr.me',
  'wss://relay.damus.io'
]
export const DEFAULT_COUNT = 4

export const KIND = 30078
// strfry relays (most of them) refuse events over 64 KiB ("event too large"), whatever their
// NIP-11 max_message_length says. 30000 bytes -> 40000 base64 chars in {"b": base64}, which
// NIP-44 pads to 40960 -> an event of about 55 KB. Measured in docs/NOSTR.md.
export const CHUNK = 30000
// relays promise nothing; a copy counts as "expiring" this long after it was published, so
// the default `refresh --days 90` republishes Nostr copies older than 30 days
export const ASSUMED_RETENTION_DAYS = 120

const TIMEOUT = 20_000
const hostOf = (url) => new URL(url).host
const nameFor = (url) => 'nostr-' + hostOf(url).replace(/^(relay|nostr)\./, '').split('.')[0]

export async function prompt (ask) {
  const url = await ask(`  Relay URL (verified ones: ${RELAYS.join(', ')}): `)
  return { url: url.trim().replace(/\/+$/, '') }
}

/** init: the default relays, or a hand-picked list. Each relay becomes its own backend. */
export async function promptMany (ask, askYesNo) {
  const urls = await askYesNo(`  Use the ${DEFAULT_COUNT} default relays (${RELAYS.slice(0, DEFAULT_COUNT).join(', ')})?`, true)
    ? RELAYS.slice(0, DEFAULT_COUNT)
    : (await ask(`  Relay URLs, comma separated (verified ones: ${RELAYS.join(', ')}): `)).split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean)
  return urls.map((url) => ({ name: nameFor(url), type: 'nostr', url }))
}

// every relay is run by someone else, so each one is its own operator
export const operator = (cfg) => `Nostr relay ${hostOf(cfg.url)}`

export function identity (secret) {
  const pubkey = getPublicKey(secret)
  return { pubkey, npub: npubEncode(pubkey) }
}

/** One WebSocket to one relay: publish events, run queries until EOSE. */
export class RelayConn {
  constructor (url, { WebSocketImpl = globalThis.WebSocket, timeout = TIMEOUT } = {}) {
    this.url = url
    this.WebSocketImpl = WebSocketImpl
    this.timeout = timeout
    this.pending = new Map() // event id or subscription id -> handler
    this.serial = 0
  }

  async open () {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url)
      const timer = setTimeout(() => { reject(new Error(`${this.url}: connect timed out`)); ws.close() }, this.timeout)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = (ev) => { clearTimeout(timer); reject(new Error(`${this.url}: ${ev.message || 'connection failed (down, or refusing us)'}`)) }
      ws.onclose = () => {
        this.ready = null
        for (const h of this.pending.values()) h.fail(new Error(`${this.url}: connection closed`))
        this.pending.clear()
      }
      ws.onmessage = (ev) => this.onmessage(ev.data)
      this.ws = ws
    })
    return this.ready
  }

  onmessage (data) {
    let msg
    try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) } catch { return }
    const [type, key] = msg
    if (type === 'NOTICE') return logger.debug(`${this.url} notice: ${key}`)
    if (type === 'AUTH') return logger.debug(`${this.url} asks for NIP-42 auth, not supported`)
    this.pending.get(key)?.on(type, msg)
  }

  // one request/response exchange, keyed by event id or subscription id
  exchange (key, frame, on) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`${this.url}: no answer within ${this.timeout / 1000} s`)), this.timeout)
      const done = (err, value) => {
        clearTimeout(timer)
        this.pending.delete(key)
        if (err) reject(err)
        else resolve(value)
      }
      this.pending.set(key, { on: (type, msg) => on(type, msg, done), fail: done })
      this.ws.send(JSON.stringify(frame))
    })
  }

  /** -> { ok, message } as the relay reported it */
  async publish (event) {
    await this.open()
    return this.exchange(event.id, ['EVENT', event], (type, msg, done) => {
      if (type === 'OK') done(null, { ok: msg[2] === true, message: msg[3] ?? '' })
    })
  }

  /** All events matching the filters, as stored by the relay (not verified here). */
  async query (...filters) {
    await this.open()
    const id = `ovk${++this.serial}`
    const events = []
    try {
      return await this.exchange(id, ['REQ', id, ...filters], (type, msg, done) => {
        if (type === 'EVENT') events.push(msg[2])
        else if (type === 'EOSE') done(null, events)
        else if (type === 'CLOSED') done(new Error(`${this.url} refused the query: ${msg[2] ?? ''}`))
      })
    } finally {
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(['CLOSE', id]))
    }
  }

  close () {
    this.ws?.close()
  }
}

// ---- event encoding: pure functions, tested without a relay ----

const conversationKey = (secret) => nip44.getConversationKey(secret, getPublicKey(secret))
const seal = (ck, obj) => nip44.encrypt(JSON.stringify(obj), ck)

/**
 * Events for one blob, chunks first and head last (so a head never points at chunks that
 * were not sent yet). Small blob: head content {"b": base64}. Big blob: chunk i of n at
 * d "<d>#<i>/<n>" with {"b": base64}, head {"n", "sha256", "size"}. All NIP-44 to self.
 */
export async function sealEvents (secret, d, bytes, createdAt) {
  const ck = conversationKey(secret)
  const event = (tag, obj) => finalizeEvent({ kind: KIND, created_at: createdAt, tags: [['d', tag]], content: seal(ck, obj) }, secret)
  if (bytes.length <= CHUNK) return [event(d, { b: toBase64(bytes) })]
  const n = Math.ceil(bytes.length / CHUNK)
  const out = []
  for (let i = 0; i < n; i++) out.push(event(`${d}#${i + 1}/${n}`, { b: toBase64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) }))
  out.push(event(d, { n, sha256: await sha256Hex(bytes), size: bytes.length }))
  return out
}

const corrupt = (message) => Object.assign(new Error(message), { corrupt: true })
const dOf = (ev) => ev.tags.find((t) => t[0] === 'd')?.[1]

/** Newest valid event per d tag, keeping only ours: signature, author, kind and d checked. */
export function newestByD (events, pubkey, wanted) {
  const best = new Map()
  for (const ev of events) {
    const d = dOf(ev)
    if (ev.kind !== KIND || ev.pubkey !== pubkey || !wanted.includes(d) || !verifyEvent(ev)) continue
    const cur = best.get(d)
    // NIP-01: newest created_at wins, a tie goes to the lowest id
    if (!cur || ev.created_at > cur.created_at || (ev.created_at === cur.created_at && ev.id < cur.id)) best.set(d, ev)
  }
  return best
}

/**
 * Reassemble a blob. `fetch(dTags)` returns events; null = no head (missing). A missing,
 * undecryptable or mismatching chunk throws an error marked corrupt.
 */
export async function openEvents (secret, d, fetch) {
  const pubkey = getPublicKey(secret)
  const ck = conversationKey(secret)
  const open = (ev) => {
    try { return JSON.parse(nip44.decrypt(ev.content, ck)) } catch (err) { throw corrupt(`NIP-44 layer failed on ${dOf(ev)}: ${err.message}`) }
  }
  const head = newestByD(await fetch([d]), pubkey, [d]).get(d)
  if (!head) return { bytes: null }
  const h = open(head)
  if (typeof h.b === 'string') return { bytes: fromBase64(h.b), head }
  if (!Number.isInteger(h.n) || h.n < 1 || typeof h.sha256 !== 'string') throw corrupt(`unexpected head event on ${d}`)
  const tags = Array.from({ length: h.n }, (_, i) => `${d}#${i + 1}/${h.n}`)
  const got = newestByD(await fetch(tags), pubkey, tags)
  const parts = tags.map((t) => {
    const ev = got.get(t)
    if (!ev) throw corrupt(`chunk ${t.slice(d.length + 1)} missing`)
    const c = open(ev)
    if (typeof c.b !== 'string') throw corrupt(`chunk ${t.slice(d.length + 1)} has no data`)
    return fromBase64(c.b)
  })
  const bytes = concat(...parts)
  if (bytes.length !== h.size || await sha256Hex(bytes) !== h.sha256) throw corrupt('chunks do not add up to the blob the head describes (sha256 mismatch)')
  return { bytes, head }
}

// ---- adapter ----

// Relays rate-limit per IP and ban after repeated violations (relay.damus.io did, 2026-09-29,
// on chunks sent 1 s apart), so every publish waits `pause` ms after the previous one and a
// "rate-limited:" answer backs off for half a minute before the one retry.
/**
 * @param {any} cfg
 * @param {any} ctx
 * @param {{WebSocketImpl?: any, pause?: number, backoff?: number}} [opts]
 */
export function create (cfg, ctx, { WebSocketImpl, pause = 3000, backoff = 30_000 } = {}) {
  const url = cfg.url.replace(/\/+$/, '')
  const root = cfg.root ?? ctx.root
  const dTag = (rel) => `${root}/${rel}`
  const retentionDays = cfg.assumeRetentionDays ?? ASSUMED_RETENTION_DAYS
  let secret = null
  let pubkey = null
  let conn = null
  const seen = new Map() // d tag -> newest created_at we saw or wrote, so replacements always move forward
  const published = new Map() // path -> created_at (s) of the copy read last, for expiresAt

  const relay = () => (conn ??= new RelayConn(url, { WebSocketImpl }))
  const query = async (tags) => {
    const events = await relay().query({ kinds: [KIND], authors: [pubkey], '#d': tags, limit: tags.length * 4 })
    for (const ev of events) {
      const d = dOf(ev)
      if (d && ev.pubkey === pubkey) seen.set(d, Math.max(seen.get(d) ?? 0, ev.created_at))
    }
    return events
  }

  let lastPublish = 0
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  async function publish (ev) {
    for (let attempt = 0; ; attempt++) {
      // clamped: browsers wrap a huge negative timeout modulo 2^32 into a long wait
      await sleep(Math.max(0, lastPublish + pause - Date.now()))
      const res = await relay().publish(ev)
      lastPublish = Date.now()
      if (res.ok || /^duplicate:/.test(res.message)) return
      if (!/^rate-limited:/.test(res.message) || attempt >= 1) throw new Error(`${url} refused ${dOf(ev)}: ${res.message || 'no reason given'}`)
      logger.info(`${cfg.name}: relay says "${res.message}", waiting ${backoff / 1000} s`)
      await sleep(backoff)
    }
  }

  // Before unlock() there is no key: nothing can be read or written. Nostr copies of
  // vault.age therefore only serve `check` and kit-based recovery (docs/NOSTR.md).
  const locked = () => !secret

  return {
    name: cfg.name,
    type: 'nostr',
    where: url,
    /** Called by the store with the unlocked keys; the Nostr key comes from the master. */
    unlock (keys) {
      secret = keys.nostrSecret
      pubkey = getPublicKey(secret)
    },
    npub () {
      return pubkey ? npubEncode(pubkey) : null
    },
    async put (rel, bytes) {
      if (locked()) throw new Error('vault is locked, no Nostr key yet')
      const d = dTag(rel)
      const now = Math.floor(Date.now() / 1000)
      const createdAt = Math.max(now, (seen.get(d) ?? 0) + 1)
      const events = await sealEvents(secret, d, bytes, createdAt)
      for (const ev of events) {
        await publish(ev)
        seen.set(dOf(ev), createdAt)
      }
      published.set(rel, createdAt)
      logger.debug(`${cfg.name}: published ${d} as ${events.length} event(s)`)
    },
    async get (rel) {
      if (locked()) {
        logger.debug(`${cfg.name}: cannot read ${rel} before the vault is unlocked`)
        return null
      }
      const { bytes, head } = await openEvents(secret, dTag(rel), query)
      if (head) published.set(rel, head.created_at)
      else published.delete(rel)
      return bytes
    },
    /** The events this relay returns for the copy (head and chunks), as served: content is NIP-44 ciphertext. */
    async raw (rel) {
      if (locked()) return null
      const got = []
      await openEvents(secret, dTag(rel), async (tags) => {
        const events = await query(tags)
        got.push(...events)
        return events
      })
      return { text: JSON.stringify(got, null, 2), format: 'json' }
    },
    async exists (rel) {
      if (locked()) return false
      const d = dTag(rel)
      return newestByD(await query([d]), pubkey, [d]).has(d)
    },
    async list (dir) {
      if (locked()) return []
      const prefix = `${root}/${dir ? `${dir}/` : ''}`
      const events = await relay().query({ kinds: [KIND], authors: [pubkey] })
      const names = new Set()
      for (const ev of events) {
        const d = dOf(ev)
        if (ev.pubkey === pubkey && d?.startsWith(prefix) && !d.includes('#') && !d.slice(prefix.length).includes('/')) names.add(d.slice(prefix.length))
      }
      return [...names]
    },
    /** When the copy read or written last was published; null = none. */
    publishedAt (rel) {
      const t = published.get(rel)
      return t ? new Date(t * 1000) : null
    },
    /** The expiry below is our assumption, not the relay's (see ASSUMED_RETENTION_DAYS). */
    assumedRetention: true,
    /** Relays promise no retention: a copy counts as expiring ASSUMED_RETENTION_DAYS after it was published. */
    expiresAt (rel) {
      const t = published.get(rel)
      return t ? new Date((t + retentionDays * 86_400) * 1000) : null
    },
    /** For the recovery kit: the public key all events are signed with. */
    kitLines () {
      return pubkey ? [`${cfg.name}: kind ${KIND} events by ${npubEncode(pubkey)}, d tags "${root}/<path>" (for example "${root}/${paths.vault}")`] : []
    },
    async close () {
      conn?.close()
      conn = null
    }
  }
}
