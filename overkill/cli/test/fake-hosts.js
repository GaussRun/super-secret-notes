// In-process fake hosts and directories for the `hosts` tests: no network.
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { verifyEvent } from 'nostr-tools/pure'
import * as c from '../src/crypto.js'

async function listen (server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function body (req) {
  const chunks = []
  for await (const ch of req) chunks.push(ch)
  return Buffer.concat(chunks)
}

/**
 * A PrivateBin instance. Options: never (offer "never" in the select), ttl (seconds left that a
 * read reports, as when an admin caps "never"), refuse (message for every new paste).
 * -> { url, pastes, requests, close() }
 */
export async function startFakePrivatebin ({ never = true, ttl = 0, refuse = null } = {}) {
  const pastes = new Map()
  const requests = []
  const server = http.createServer(async (req, res) => {
    const raw = await body(req)
    requests.push(`${req.method} ${req.url}`)
    const send = (o) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Access-Control-Allow-Origin', '*'); res.end(JSON.stringify(o)) }
    if (req.method === 'POST') {
      const b = JSON.parse(raw.toString())
      if (b.pasteid) {
        const p = pastes.get(b.pasteid)
        if (p?.deletetoken !== b.deletetoken) return send({ status: 1, message: 'Wrong deletion token. Paste was not deleted.' })
        pastes.delete(b.pasteid)
        return send({ status: 0 })
      }
      if (refuse) return send({ status: 1, message: refuse })
      const id = c.toHex(c.randomBytes(8))
      pastes.set(id, { ...b, deletetoken: c.toHex(c.randomBytes(32)) })
      return send({ status: 0, id, url: `/?${id}`, deletetoken: pastes.get(id).deletetoken })
    }
    const id = new URL(req.url, 'http://x').searchParams.get('pasteid')
    if (id) {
      const p = pastes.get(id)
      if (!p) return send({ status: 1, message: 'Paste does not exist, has expired or has been deleted.' })
      return send({ status: 0, id, v: 2, adata: p.adata, ct: p.ct, meta: ttl ? { time_to_live: ttl } : {} })
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(`<html><title>PrivateBin</title><select id="pasteExpiration"><option value="1day">1 day</option>${never ? '<option value="never">Never</option>' : ''}</select></html>`)
  })
  const url = await listen(server)
  return { url, pastes, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

/**
 * A Blossom server. mediaOnly: refuse application/octet-stream like most big servers;
 * preflight: answer BUD-06 HEAD /upload (404 otherwise, like servers without it).
 */
export async function startFakeBlossom ({ mediaOnly = false, preflight = true } = {}) {
  const blobs = new Map()
  const requests = []
  const server = http.createServer(async (req, res) => {
    const raw = await body(req)
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'HEAD' && req.url === '/upload') {
      requests.push('HEAD /upload')
      if (!preflight) { res.statusCode = 404; return res.end() }
      if (mediaOnly && req.headers['x-content-type'] === 'application/octet-stream') {
        res.statusCode = 415
        res.setHeader('X-Reason', 'File type not allowed')
        return res.end()
      }
      return res.end()
    }
    if (req.method === 'PUT' && req.url === '/upload') {
      requests.push('PUT /upload')
      if (!req.headers.authorization?.startsWith('Nostr ')) { res.statusCode = 401; return res.end() }
      if (mediaOnly && req.headers['content-type'] === 'application/octet-stream') {
        res.statusCode = 415
        res.setHeader('X-Reason', 'File type not allowed')
        return res.end()
      }
      const sha = await c.sha256Hex(new Uint8Array(raw))
      blobs.set(sha, raw)
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ sha256: sha, size: raw.length, url: `http://x/${sha}` }))
    }
    const sha = req.url.slice(1)
    if (req.method === 'DELETE') {
      if (!req.headers.authorization) { res.statusCode = 401; return res.end() }
      blobs.delete(sha)
      res.statusCode = 204
      return res.end()
    }
    if (!blobs.has(sha)) { res.statusCode = 404; return res.end() }
    res.end(blobs.get(sha))
  })
  const url = await listen(server)
  return { url, blobs, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** A CryptPad instance: only /api/config and /customize/application_config.js. */
export async function startFakeCryptpad ({ restrictRegistration = false, captcha = false, enforceMFA = false, forbidden = false } = {}) {
  const server = http.createServer((req, res) => {
    if (forbidden) { res.statusCode = 403; return res.end('Forbidden') }
    if (req.url === '/api/config') {
      return res.end(`define(function(){;\nreturn ${JSON.stringify({ restrictRegistration, enforceMFA, defaultStorageLimit: 1073741824 })};\n});`)
    }
    if (req.url === '/customize/application_config.js') {
      return res.end(`define([], function (AppConfig) {${captcha ? ' AppConfig.captcha = true;' : ''} return AppConfig; });`)
    }
    res.statusCode = 404
    res.end()
  })
  return listen(server).then((url) => ({ url, close: () => new Promise((resolve) => server.close(resolve)) }))
}

const dOf = (ev) => ev.tags.find((t) => t[0] === 'd')?.[1]
function matches (ev, f) {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (f['#d'] && !f['#d'].includes(dOf(ev))) return false
  if (f.until && ev.created_at > f.until) return false
  if (f.since && ev.created_at < f.since) return false
  return true
}

/**
 * A Nostr relay with NIP-11 on the same port. `events` are served as they are (directory
 * events, old notes); written events go through signature checks, kind 5 deletes by id.
 * Options: limitation (NIP-11), refuse (OK false message for every write).
 * -> { url (ws://), events, deleted, close() }
 */
export async function startFakeRelayWithInfo ({ events = [], limitation = {}, refuse = null } = {}) {
  const relay = { events: [...events], deleted: [] }
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/nostr+json')
    res.end(JSON.stringify({ name: 'fake', software: 'fake-relay', limitation }))
  })
  const wss = new WebSocketServer({ server })
  const send = (ws, msg) => ws.send(JSON.stringify(msg))
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg[0] === 'EVENT') {
        const ev = msg[1]
        if (refuse) return send(ws, ['OK', ev.id, false, refuse])
        if (!verifyEvent(ev)) return send(ws, ['OK', ev.id, false, 'invalid: bad signature'])
        if (ev.kind === 5) {
          const ids = ev.tags.filter((t) => t[0] === 'e').map((t) => t[1])
          relay.events = relay.events.filter((e) => !(ids.includes(e.id) && e.pubkey === ev.pubkey))
          relay.deleted.push(...ids)
        } else {
          relay.events.push(ev)
        }
        return send(ws, ['OK', ev.id, true, ''])
      }
      if (msg[0] === 'REQ') {
        const [, id, ...filters] = msg
        const hits = relay.events.filter((ev) => filters.some((f) => matches(ev, f))).sort((a, b) => b.created_at - a.created_at)
        const limit = Math.min(...filters.map((f) => f.limit ?? Infinity))
        for (const ev of hits.slice(0, limit)) send(ws, ['EVENT', id, ev])
        send(ws, ['EOSE', id])
      }
    })
  })
  const url = await listen(server)
  relay.url = url.replace(/^http/, 'ws')
  relay.close = () => new Promise((resolve) => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(resolve) })
  return relay
}

/** A static web server for directory pages: routes { path: { body, status, type } }. */
export async function startFakeWeb (routes) {
  const server = http.createServer((req, res) => {
    const r = routes[req.url]
    if (!r) { res.statusCode = 404; return res.end('not found') }
    res.statusCode = r.status ?? 200
    res.setHeader('Content-Type', r.type ?? 'text/html')
    res.end(r.body)
  })
  const url = await listen(server)
  return { url, routes, close: () => new Promise((resolve) => server.close(resolve)) }
}
