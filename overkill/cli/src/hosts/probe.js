// Probes for directory candidates: the backend admission rule (docs/OVERKILL.md), checked live.
// Each probe writes at most one small test object under a throwaway key or no key at all, reads
// it back and deletes it again, so a host is left as it was found.
// Result: { status: 'ok' | 'failed', reason, details }
//   ok      usable as a backend
//   failed  reason says why (down, refuses writes, caps expiry, captcha, ...)
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { sealPaste, openPaste } from '../backends/privatebin.js'
import { RelayConn, sealEvents, openEvents, CHUNK, KIND } from '../backends/nostr.js'
import { authHeader } from '../backends/blossom.js'
import { randomBytes, sha256Hex } from '../crypto.js'

const TIMEOUT = 20_000
const DAY = 86_400
// some PrivateBin instances sit behind Cloudflare's browser integrity check
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const ORIGIN = 'https://example.org' // to see which CORS headers a browser client would get
const signal = () => AbortSignal.timeout(TIMEOUT)
const fail = (reason, details = {}) => ({ status: 'failed', reason, details })
const why = (err) => err.cause?.code ?? err.cause?.message ?? err.message

// ---- PrivateBin: `never` offered and honored, a test paste written, read back and deleted ----

export async function probePrivatebin (url) {
  const base = url.replace(/\/+$/, '')
  const details = {}
  try {
    const page = await fetch(`${base}/`, { headers: { 'User-Agent': UA }, signal: signal() })
    if (!page.ok) return fail(`front page answered HTTP ${page.status}`)
    const html = await page.text()
    if (!/privatebin/i.test(html)) return fail('front page is not PrivateBin')
    if (!/(value|data-expiration)="never"/.test(html)) return fail('no "never" in the expiry choices')
    const api = async (target, body) => {
      const res = await fetch(target, {
        method: body ? 'POST' : 'GET',
        headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'JSONHttpRequest', Origin: ORIGIN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal()
      })
      details.cors ??= res.headers.get('access-control-allow-origin')
      const text = await res.text()
      try { return JSON.parse(text) } catch { throw new Error(`HTTP ${res.status} with non-JSON (${text.length} bytes)`) }
    }
    const blob = randomBytes(64)
    const { key, body } = await sealPaste(blob)
    const made = await api(`${base}/`, body)
    if (made.status !== 0) return fail(`test paste refused: ${made.message ?? 'no reason given'}`, details)
    details.pasteid = made.id
    let result = null
    try {
      const back = await api(`${base}/?pasteid=${encodeURIComponent(made.id)}`)
      const ttl = back.meta?.time_to_live ?? 0
      if (back.status !== 0) result = fail(`test paste not readable: ${back.message ?? 'no reason given'}`, details)
      else if (!(await openPaste(back, key)).every((b, i) => b === blob[i])) result = fail('test paste came back different', details)
      else if (ttl > 0 && ttl < 365 * DAY) result = fail(`"never" is capped: the test paste expires in ${Math.round(ttl / DAY)} days`, details)
      else details.expiry = ttl > 0 ? `${Math.round(ttl / DAY)} days` : 'never'
    } finally {
      const del = await api(`${base}/`, { pasteid: made.id, deletetoken: made.deletetoken }).catch((err) => ({ status: -1, message: err.message }))
      details.deleted = del.status === 0
      if (!result && !details.deleted) result = fail(`test paste ${made.id} could not be deleted: ${del.message ?? 'no reason given'}`, details)
    }
    return result ?? { status: 'ok', details }
  } catch (err) {
    return fail(why(err), details)
  }
}

// ---- Nostr: NIP-11 limits, data older than 400 days, a kind 30078 event written and read ----

// a full-size chunk event is about 55 KB (backends/nostr.js CHUNK)
const NEEDED_MESSAGE = 60_000
const NEEDED_CONTENT = Math.ceil((CHUNK * 4) / 3) + 1000

export async function nip11 (url) {
  const res = await fetch(url.replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' }, signal: signal() })
  if (!res.ok) throw new Error(`NIP-11 answered HTTP ${res.status}`)
  return res.json()
}

export async function probeNostr (url, { pause = 1500 } = {}) {
  const details = {}
  const conn = new RelayConn(url, { timeout: TIMEOUT })
  try {
    const info = await nip11(url).catch((err) => { details.nip11 = `unavailable (${why(err)})`; return null })
    const lim = info?.limitation ?? {}
    if (info) details.software = info.software ?? null
    if (lim.auth_required) return fail('NIP-11: auth required', details)
    if (lim.payment_required) return fail('NIP-11: payment required', details)
    if (lim.restricted_writes) return fail('NIP-11: restricted writes', details)
    if (lim.max_message_length && lim.max_message_length < NEEDED_MESSAGE) return fail(`NIP-11: max_message_length ${lim.max_message_length} is under ${NEEDED_MESSAGE}`, details)
    if (lim.max_content_length && lim.max_content_length < NEEDED_CONTENT) return fail(`NIP-11: max_content_length ${lim.max_content_length} is under ${NEEDED_CONTENT}`, details)
    await conn.open()
    // relays answer newest first; anything at or before `until` shows how far back they keep data
    const until = Math.floor(Date.now() / 1000) - 400 * DAY
    details.servesOld = await conn.query({ kinds: [1], until, limit: 3 })
      .then((evs) => evs.some((e) => e.created_at <= until), () => null)

    const secret = generateSecretKey()
    const pubkey = getPublicKey(secret)
    const d = `overkill-probe/${Buffer.from(randomBytes(8)).toString('hex')}`
    const bytes = randomBytes(64)
    const [ev] = await sealEvents(secret, d, bytes, Math.floor(Date.now() / 1000))
    const res = await conn.publish(ev)
    if (!res.ok) return fail(`test event refused: ${res.message || 'no reason given'}`, details)
    details.event = ev.id
    await new Promise((resolve) => setTimeout(resolve, pause))
    const back = await openEvents(secret, d, (tags) => conn.query({ kinds: [KIND], authors: [pubkey], '#d': tags }))
    const same = back?.bytes?.length === bytes.length && back.bytes.every((b, i) => b === bytes[i])
    // NIP-09: ask the relay to drop the test event again
    const del = finalizeEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', ev.id], ['a', `${KIND}:${pubkey}:${d}`], ['k', String(KIND)]], content: 'overkill probe' }, secret)
    details.deleteRequested = (await conn.publish(del).catch(() => ({ ok: false }))).ok
    if (!same) return fail('test event not read back', details)
    return { status: 'ok', details }
  } catch (err) {
    return fail(why(err), details)
  } finally {
    conn.close()
  }
}

// ---- Blossom: application/octet-stream accepted, a random blob uploaded, read and deleted ----

export async function probeBlossom (url) {
  const base = url.replace(/\/+$/, '')
  const details = {}
  const secret = generateSecretKey()
  const data = randomBytes(1024)
  const sha = await sha256Hex(data)
  const reason = (res) => `HTTP ${res.status}${res.headers.get('x-reason') ? ` ${res.headers.get('x-reason')}` : ''}`
  try {
    // BUD-06 preflight: servers that support it turn media-only or whitelist policies down
    // without us sending a byte; 404/405 just means no preflight, so try the upload
    const pre = await fetch(`${base}/upload`, {
      method: 'HEAD',
      headers: { Authorization: authHeader(secret, 'upload', sha, base), 'X-SHA-256': sha, 'X-Content-Length': String(data.length), 'X-Content-Type': 'application/octet-stream' },
      signal: signal()
    })
    details.preflight = pre.status
    if (pre.status >= 400 && pre.status < 500 && pre.status !== 404 && pre.status !== 405) return fail(`octet-stream upload refused at preflight: ${reason(pre)}`, details)
    const up = await fetch(`${base}/upload`, {
      method: 'PUT',
      headers: { Authorization: authHeader(secret, 'upload', sha, base), 'Content-Type': 'application/octet-stream', 'X-SHA-256': sha, Origin: ORIGIN },
      body: data,
      signal: signal()
    })
    if (!up.ok) return fail(`octet-stream upload refused: ${reason(up)}`, details)
    details.sha256 = sha
    let result = null
    try {
      const get = await fetch(`${base}/${sha}`, { headers: { Origin: ORIGIN }, signal: signal() })
      details.cors = get.headers.get('access-control-allow-origin')
      const back = new Uint8Array(await get.arrayBuffer())
      if (!get.ok) result = fail(`test blob not readable: ${reason(get)}`, details)
      else if (await sha256Hex(back) !== sha) result = fail('test blob came back different', details)
    } finally {
      const del = await fetch(`${base}/${sha}`, { method: 'DELETE', headers: { Authorization: authHeader(secret, 'delete', sha, base) }, signal: signal() })
        .catch((err) => ({ ok: false, status: 0, headers: new Headers({ 'x-reason': why(err) }) }))
      details.deleted = del.ok
      if (!result && !del.ok) result = fail(`test blob ${sha} could not be deleted: ${reason(del)}`, details)
    }
    return result ?? { status: 'ok', details }
  } catch (err) {
    return fail(why(err), details)
  }
}

// ---- CryptPad: config only. The probe never registers; a vault that uses the instance does. ----

/** /api/config is an AMD module around a JSON object literal. */
export function parseApiConfig (text) {
  const start = text.indexOf('return {')
  const end = text.lastIndexOf('};')
  if (start < 0 || end < start) throw new Error('/api/config is not a CryptPad config')
  return JSON.parse(text.slice(start + 'return '.length, end + 1))
}

export async function probeCryptpad (origin) {
  const base = origin.replace(/\/+$/, '')
  const details = {}
  try {
    const res = await fetch(`${base}/api/config`, { headers: { 'User-Agent': UA }, signal: signal() })
    if (!res.ok) return fail(`/api/config answered HTTP ${res.status}`)
    const cfg = parseApiConfig(await res.text())
    details.quota = cfg.defaultStorageLimit ?? null
    if (cfg.restrictRegistration) return fail('registration is closed', details)
    if (cfg.sso?.enforced || cfg.sso?.forceSSO) return fail('registration needs single sign-on', details)
    if (cfg.enforceMFA) return fail('every account must set up TOTP', details)
    const app = await fetch(`${base}/customize/application_config.js`, { headers: { 'User-Agent': UA }, signal: signal() })
      .then((r) => (r.ok ? r.text() : ''), () => '')
    if (/captcha/i.test(JSON.stringify(cfg)) || /captcha/i.test(app)) return fail('captcha at registration', details)
    return { status: 'ok', details }
  } catch (err) {
    return fail(why(err), details)
  }
}

export const PROBES = { privatebin: probePrivatebin, nostr: probeNostr, blossom: probeBlossom, cryptpad: probeCryptpad }
