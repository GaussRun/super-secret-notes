// The Blossom adapter against an in-memory fake server (BUD-01 get, BUD-02 upload/delete with
// kind 24242 auth), plus the store flow: check, a damaged blob, repair, locators in the index.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import nodeCrypto from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import winston from 'winston'
import { verifyEvent, getPublicKey } from 'nostr-tools/pure'
import * as c from '../src/crypto.js'
import * as blossom from '../src/backends/blossom.js'
import * as local from '../src/backends/local.js'
import { Overkill, STATUS, summarize } from '../src/store.js'

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const quiet = winston.createLogger({ silent: true })
const keys = await c.unlockKeys(V.decrypt.vault)
const pubkey = getPublicKey(keys.nostrSecret)
const blobs = new Map() // sha256 -> Buffer
const sha = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex')
let server
let url

// checks a BUD-02 Authorization header; returns the event or null
function auth (req, verb, x) {
  const h = req.headers.authorization
  if (!h?.startsWith('Nostr ')) return null
  const ev = JSON.parse(Buffer.from(h.slice(6), 'base64').toString())
  const tag = (n) => ev.tags.find((t) => t[0] === n)?.[1]
  if (ev.kind !== 24242 || !verifyEvent(ev) || tag('t') !== verb || Number(tag('expiration')) < Date.now() / 1000) return null
  if (x && !ev.tags.some((t) => t[0] === 'x' && t[1] === x)) return null
  return ev
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const ch of req) chunks.push(ch)
    const body = Buffer.concat(chunks)
    const fail = (status, reason) => { res.writeHead(status, { 'X-Reason': reason }); res.end() }
    if (req.method === 'PUT' && req.url === '/upload') {
      if (!auth(req, 'upload', sha(body))) return fail(401, 'bad auth')
      blobs.set(sha(body), body)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ url: `${url}/${sha(body)}`, sha256: sha(body), size: body.length, uploaded: Math.floor(Date.now() / 1000) }))
    }
    const id = req.url.slice(1)
    if (req.method === 'DELETE') {
      if (!auth(req, 'delete', id)) return fail(401, 'bad auth')
      blobs.delete(id)
      return fail(204, 'deleted')
    }
    if (!blobs.has(id)) return fail(404, 'not found')
    res.end(blobs.get(id))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

async function adapter (dir, name = 'bl') {
  const b = blossom.create({ name, type: 'blossom', url }, { root: 'ovk', home: dir })
  b.unlock(keys)
  return b
}

test('K_blossom is HKDF(master, "overkill v1 blossom")', async () => {
  const master = c.fromHex(V.derivation.master_hex)
  const raw = await c.deriveRawKeys(master)
  assert.equal(c.toHex(raw.blossom), Buffer.from(nodeCrypto.hkdfSync('sha256', master, Buffer.alloc(0), 'overkill v1 blossom', 32)).toString('hex'))
  assert.equal(c.toHex(raw.blossom), V.derivation.k_blossom_hex)
})

test('put, get, replace deletes the old blob, sha256 and layer checks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-blossom-'))
  const b = await adapter(dir)
  const data = new Uint8Array(nodeCrypto.randomBytes(200_000))
  assert.equal(await b.get('notes/a.ovk'), null)
  await b.put('notes/a.ovk', data)
  assert.deepEqual(await b.get('notes/a.ovk'), data)
  const [first] = Object.values(await b.getLocators())
  const firstSha = first.slice(-64)
  // the server holds our third layer, not the blob itself
  assert.ok(!blobs.get(firstSha).includes(Buffer.from(data.subarray(0, 64))))
  await b.put('notes/a.ovk', c.toBytes('v2'))
  assert.equal(new TextDecoder().decode(await b.get('notes/a.ovk')), 'v2')
  assert.equal(blobs.has(firstSha), false, 'replaced blob was deleted')

  // a server that serves other bytes under the hash, or a damaged third layer
  const loc = (await b.getLocators())['notes/a.ovk']
  const s = loc.slice(-64)
  blobs.set(s, Buffer.from('not it'))
  await assert.rejects(b.get('notes/a.ovk'), (err) => err.corrupt && /sha256/.test(err.message))
  // a fresh adapter that learned the locator from an index reads the same blob
  await b.put('notes/a.ovk', c.toBytes('v3'))
  const other = await adapter(await mkdtemp(path.join(os.tmpdir(), 'ssn-blossom-')))
  await other.learnLocators(await b.getLocators())
  assert.equal(new TextDecoder().decode(await other.get('notes/a.ovk')), 'v3')
  // without the key the blob is noise
  await assert.rejects(blossom.openBlob((await c.unlockKeys({ ...V.decrypt.vault, master: c.toBase64(new Uint8Array(32).fill(7)) })).blossomKey, blobs.get((await b.getLocators())['notes/a.ovk'].slice(-64))))
})

test('uploads are signed by the vault Nostr key; locked adapter refuses', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-blossom-'))
  const h = blossom.authHeader(keys.nostrSecret, 'upload', 'ab'.repeat(32), url)
  const ev = JSON.parse(Buffer.from(h.slice(6), 'base64').toString())
  assert.equal(ev.pubkey, pubkey)
  assert.deepEqual(ev.tags.slice(0, 1), [['t', 'upload']])
  const locked = blossom.create({ name: 'x', type: 'blossom', url }, { root: 'ovk', home: dir })
  await assert.rejects(locked.put('vault.age', c.toBytes('v')), /locked/)
  assert.equal(blossom.operator({ url: 'https://nostr.download' }), 'Blossom nostr.download')
})

test('store: check, damaged blob, repair moves the locator and the index follows', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-blossom-'))
  const ctx = { root: 'ovk', home: dir }
  const make = () => [local.create({ name: 'usb', type: 'local', path: dir }, ctx), blossom.create({ name: 'bl', type: 'blossom', url }, ctx)]
  const s = new Overkill({ backends: make(), keys, vaultBytes: c.toBytes('vault'), logger: quiet })
  await s.uploadVault()
  await s.writeIndex(c.emptyIndex())
  await s.put('groceries', 'oat milk')
  let r = await s.check()
  assert.ok([...r.vault, ...r.index, ...Object.values(r.notes).flat()].every((x) => x.status === STATUS.OK))
  const loc = (await s.backends[1].getLocators())[c.paths.note(await c.blobIdForName(keys, 'groceries'))]
  const damaged = Buffer.from(blobs.get(loc.slice(-64)))
  damaged[40] ^= 1
  blobs.set(loc.slice(-64), damaged)
  r = await s.check()
  assert.equal(r.notes.groceries.find((x) => x.backend === 'bl').status, STATUS.CORRUPT)
  const { fixed } = await s.repair(r)
  assert.ok(fixed.includes('groceries on bl'))
  // a second device with only the path-addressed index finds the new blob
  const s2 = new Overkill({ backends: [local.create({ name: 'usb', type: 'local', path: dir }, { root: 'ovk', home: path.join(dir, 'dev2') }), blossom.create({ name: 'bl', type: 'blossom', url }, { root: 'ovk', home: path.join(dir, 'dev2') })], keys, logger: quiet })
  const r2 = await s2.check()
  assert.equal(r2.notes.groceries.find((x) => x.backend === 'bl').status, STATUS.OK)
})

test('default servers are verified ones', () => {
  assert.ok(blossom.SERVERS.length >= blossom.DEFAULT_COUNT)
  assert.ok(blossom.SERVERS.every((s) => s.startsWith('https://')))
})

test('assumed retention: a Blossom copy counts as expiring 120 days after upload, and refresh republishes it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-blossom-'))
  const ctx = { root: 'ovk', home: dir }
  const bl = blossom.create({ name: 'bl', type: 'blossom', url }, ctx)
  const s = new Overkill({ backends: [local.create({ name: 'usb', type: 'local', path: dir }, ctx), bl], keys, vaultBytes: c.toBytes('vault'), logger: quiet })
  await s.uploadVault()
  await s.writeIndex(c.emptyIndex())
  await s.put('groceries', 'oat milk')
  assert.equal(blossom.ASSUMED_RETENTION_DAYS, 120)
  assert.equal(bl.assumedRetention, true)
  const due = bl.expiresAt(c.paths.note(await c.blobIdForName(keys, 'groceries')))
  assert.ok(Math.abs(due - (Date.now() + 120 * 86_400_000)) < 60_000, `expires about 120 days from now (${due})`)
  const r = await s.check()
  const copy = r.notes.groceries.find((x) => x.backend === 'bl')
  assert.equal(copy.assumed, true)
  assert.match(summarize(r).lines.find((l) => l.label === 'groceries').text, /bl OK \(republish by \d{4}-\d{2}-\d{2}\)/)
  // nothing is due within 30 days; everything on Blossom is due within 200
  assert.deepEqual((await s.refresh({ days: 30, report: r })).fixed, [])
  const { fixed } = await s.refresh({ days: 200 })
  assert.ok(fixed.some((x) => x.startsWith('groceries on bl')), fixed.join('; '))
  assert.ok(fixed.some((x) => x.startsWith('vault.age on bl')), fixed.join('; '))
  // (the index copies are rewritten with the new Blossom locators; the notes on the folder are not touched)
  assert.ok(!fixed.some((x) => /^(groceries|vault\.age) on usb/.test(x)), 'the folder promises its own retention')
})
