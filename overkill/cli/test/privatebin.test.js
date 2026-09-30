// The real PrivateBin adapter against an in-memory fake instance, plus the locator flow
// across devices: locators travel in the index, the kit locators alone are enough to recover.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import winston from 'winston'
import * as c from '../src/crypto.js'
import { createBackend } from '../src/backends/index.js'
import { sealPaste, openPaste } from '../src/backends/privatebin.js'
import { Overkill, STATUS, summarize } from '../src/store.js'

const quiet = winston.createLogger({ silent: true })
const dec = (b) => new TextDecoder().decode(b)
const pastes = new Map()
let adminTtl = 0 // simulates an admin capping "never" later: seconds left reported on read
let server
let url

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const ch of req) chunks.push(ch)
    const send = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) }
    if (req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.pasteid) {
        const p = pastes.get(body.pasteid)
        if (p?.deletetoken === body.deletetoken) pastes.delete(body.pasteid)
        return send({ status: 0 })
      }
      assert.equal(body.meta.expire, 'never')
      const id = c.toHex(c.randomBytes(8))
      pastes.set(id, { ...body, deletetoken: c.toHex(c.randomBytes(32)) })
      return send({ status: 0, id, url: `/?${id}`, deletetoken: pastes.get(id).deletetoken })
    }
    const id = new URL(req.url, 'http://x').searchParams.get('pasteid')
    const p = pastes.get(id)
    if (!p) return send({ status: 1, message: 'Paste does not exist, has expired or has been deleted.' })
    send({ status: 0, id, v: 2, adata: p.adata, ct: p.ct, meta: adminTtl ? { time_to_live: adminTtl } : {} })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

async function device (dir, name, backendCfgs, keys) {
  const ctx = { root: 'ovk', home: path.join(dir, name) }
  return new Overkill({ backends: backendCfgs.map((b) => createBackend(b, ctx)), keys, vaultBytes: new Uint8Array([1, 2, 3]), logger: quiet })
}

test('paste layer: round trip, wrong key and tampering fail', async () => {
  const data = c.randomBytes(5000)
  const { key, body } = await sealPaste(data)
  assert.deepEqual(await openPaste(body, key), data)
  await assert.rejects(openPaste(body, c.randomBytes(32)))
  const ct = c.fromBase64(body.ct)
  ct[3] ^= 1
  await assert.rejects(openPaste({ ...body, ct: c.toBase64(ct) }, key))
  await assert.rejects(openPaste({ ...body, adata: [body.adata[0], 'markdown', 0, 0] }, key))
})

test('locators: second device, corrupt paste, repair; the index lives only on the path-addressed backend', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-pb-'))
  const keys = await c.unlockKeys(await c.createVault())
  const pb = { name: 'pb', type: 'privatebin', url }
  const usb = { name: 'usb', type: 'local', path: path.join(dir, 'usb') }

  const a = await device(dir, 'a', [pb, usb], keys)
  await a.uploadVault()
  await a.put('groceries', 'oat milk')
  const locs = JSON.parse(await readFile(path.join(dir, 'a', 'locators', 'pb.json'), 'utf8'))
  assert.deepEqual(Object.keys(locs).sort(), [`notes/${await c.blobIdForName(keys, 'groceries')}.ovk`, 'vault.age'])
  assert.match(locs['vault.age'].url, /^http:\/\/127\.0\.0\.1:\d+\/\?[0-9a-f]{16}#[1-9A-HJ-NP-Za-km-z]+$/)
  const idx = await c.decryptIndex(keys, await (createBackend(usb, { root: 'ovk', home: dir })).get('index.ovk'))
  assert.equal(idx.locators.pb[`notes/${await c.blobIdForName(keys, 'groceries')}.ovk`], locs[`notes/${await c.blobIdForName(keys, 'groceries')}.ovk`].url)
  assert.equal(idx.locators.pb['index.ovk'], undefined)
  assert.equal(pastes.size, 2) // vault.age and the note: no index paste

  // device b: fresh home, learns note locators from the index on usb
  const b = await device(dir, 'b', [pb, usb], keys)
  const got = await b.get('groceries')
  assert.equal(dec(got.bytes), 'oat milk')
  assert.equal(got.from, 'pb')

  // corrupt the note paste on the server (PrivateBin layer)
  const noteId = new URL(locs[`notes/${await c.blobIdForName(keys, 'groceries')}.ovk`].url).search.slice(1)
  const p = pastes.get(noteId)
  const ct = c.fromBase64(p.ct)
  ct[0] ^= 1
  p.ct = c.toBase64(ct)
  const report = await b.check()
  assert.equal(report.notes.groceries[0].status, STATUS.CORRUPT)
  assert.match(report.notes.groceries[0].detail, /PrivateBin layer/)
  assert.equal((await b.get('groceries')).from, 'usb')
  const { fixed } = await b.repair(report)
  assert.ok(fixed.includes('groceries on pb'))
  assert.ok(fixed.includes('index (refreshed with new paste locators) on usb')) // the new locator reached the index

  // device a sees the new locator through the index
  const a2 = await device(dir, 'a', [pb, usb], keys)
  assert.equal((await a2.get('groceries')).from, 'pb')
  const s = summarize(await a2.check())
  assert.equal(`${s.healthy}/${s.total}`, '5/5') // vault 2, index 1 (usb only), note 2
  assert.deepEqual(summarize(await a2.check()).lines.find((l) => l.label === 'index').text, 'usb OK (1/1 healthy)')

  // device c knows only the kit's vault.age locator: vault.age comes back, the rest via usb
  const aLocs = await b.backends[0].getLocators()
  const cDev = await device(dir, 'c', [{ ...pb, locators: { 'vault.age': aLocs['vault.age'] } }, usb], keys)
  assert.deepEqual(await cDev.backends[0].get('vault.age'), new Uint8Array([1, 2, 3]))
  assert.equal(dec((await cDev.get('groceries')).bytes), 'oat milk')
  // a vault on paste backends only has nowhere to keep its index
  const pbOnly = await device(dir, 'd', [pb], keys)
  await assert.rejects(pbOnly.mergedIndex(), /no backend can hold the index/)
})

test('mergeIndexes: note locator follows the winning entry, others are unioned', () => {
  const p1 = 'notes/aa.ovk'
  const older = { v: 1, notes: { x: { id: 'aa', updated: '2026-01-01T00:00:00.000Z' } }, locators: { pb: { [p1]: 'old', 'vault.age': 'v' } } }
  const newer = { v: 1, notes: { x: { id: 'aa', updated: '2026-02-01T00:00:00.000Z' } }, locators: { pb: { [p1]: 'new' }, pb2: { [p1]: 'only' } } }
  for (const m of [c.mergeIndexes(older, newer), c.mergeIndexes(newer, older)]) {
    assert.deepEqual(m.locators, { pb: { [p1]: 'new', 'vault.age': 'v' }, pb2: { [p1]: 'only' } })
  }
  assert.equal(c.mergeIndexes({ v: 1, notes: {} }).locators, undefined)
})

test('mergeIndexes: equal updated (a repair moved a paste) goes to the newer written index', () => {
  const p1 = 'notes/aa.ovk'
  const entry = { id: 'aa', updated: '2026-01-01T00:00:00.000Z' }
  const before = { v: 1, written: '2026-01-01T00:00:00.000Z', notes: { x: entry }, locators: { pb: { [p1]: 'corrupt', 'vault.age': 'v1' } } }
  const repaired = { v: 1, written: '2026-01-02T00:00:00.000Z', notes: { x: entry }, locators: { pb: { [p1]: 'fresh', 'vault.age': 'v2' } } }
  for (const m of [c.mergeIndexes(before, repaired), c.mergeIndexes(repaired, before)]) {
    assert.deepEqual(m.locators, { pb: { [p1]: 'fresh', 'vault.age': 'v2' } })
    assert.equal(m.written, repaired.written)
  }
})

test('refresh: re-uploads missing copies and copies an admin made expire soon', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-refresh-'))
  const keys = await c.unlockKeys(await c.createVault())
  const pb = { name: 'pb', type: 'privatebin', url }
  const usb = { name: 'usb', type: 'local', path: path.join(dir, 'usb') }
  const a = await device(dir, 'a', [pb, usb], keys)
  await a.uploadVault()
  await a.put('groceries', 'oat milk')
  assert.deepEqual(await a.refresh(), { fixed: [], failed: [] })

  // the copy on usb vanishes; refresh (not only repair) brings it back
  const { rename } = await import('node:fs/promises')
  const noteRel = `notes/${await c.blobIdForName(keys, 'groceries')}.ovk`
  await rename(path.join(dir, 'usb', 'ovk', noteRel), path.join(dir, 'gone'))
  assert.deepEqual((await a.refresh()).fixed, ['groceries on usb'])

  // the instance now reports 30 days left on every paste
  adminTtl = 30 * 86400
  try {
    const report = await a.check()
    assert.ok(report.notes.groceries[0].expires instanceof Date)
    assert.match(summarize(report).lines.find((l) => l.label === 'groceries').text, /pb OK \(expires \d{4}-\d{2}-\d{2}\)/)
    assert.deepEqual((await a.refresh({ days: 7, report })).fixed, []) // 30 days left, not due within 7
    const { fixed } = await a.refresh({ days: 90, report })
    assert.deepEqual(fixed.map((f) => f.replace(/ \(was expiring .*\)$/, '')).sort(),
      ['groceries on pb', 'index (refreshed with new paste locators) on usb', 'vault.age on pb'].sort())
  } finally {
    adminTtl = 0
  }
  const s = summarize(await a.check())
  assert.equal(`${s.healthy}/${s.total}`, '5/5')
})

test('delete tokens travel in the index: another machine deletes superseded note pastes; old index pastes are migrated away', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-pb-tokens-'))
  const keys = await c.unlockKeys(await c.createVault())
  const pb = { name: 'pb', type: 'privatebin', url }
  const usb = { name: 'usb', type: 'local', path: path.join(dir, 'usb') }
  const at = (name) => {
    const ctx = { root: 'ovk', home: path.join(dir, name) }
    return new Overkill({ backends: [pb, usb].map((b) => createBackend(b, ctx)), keys, vaultBytes: new Uint8Array([1]), logger: quiet })
  }
  const idOf = (u) => new URL(u).search.slice(1)
  const noteRel = `notes/${await c.blobIdForName(keys, 'groceries')}.ovk`

  const a = at('a')
  await a.put('groceries', 'v1', { sample: false })
  const firstNote = idOf((await a.backends[0].getLocators())[noteRel])
  const idx = await c.decryptIndex(keys, await a.backends[1].get('index.ovk'))
  assert.equal(idx.pastes.pb[firstNote].path, noteRel)
  assert.match(idx.pastes.pb[firstNote].token, /^[0-9a-f]{64}$/)

  // machine b never saw that paste's token locally, yet replacing the note deletes it
  const b = at('b')
  await b.put('groceries', 'v2', { sample: false })
  assert.equal(pastes.has(firstNote), false)
  assert.equal(new TextDecoder().decode((await at('a').get('groceries')).bytes), 'v2')

  // an index paste from before the index moved off paste backends: the next write deletes it
  const old = at('old')
  await old.backends[0].put('index.ovk', await c.encryptIndex(keys, c.emptyIndex()))
  const oldIndexPaste = idOf((await old.backends[0].getLocators())['index.ovk'])
  assert.ok(pastes.has(oldIndexPaste))
  await old.put('todo', 'nap', { sample: false })
  assert.equal(pastes.has(oldIndexPaste), false)
  assert.equal((await old.backends[0].getLocators())['index.ovk'], undefined)
  const reg = await c.decryptIndex(keys, await old.backends[1].get('index.ovk'))
  assert.ok(Object.values(reg.pastes.pb).every((e) => e.path !== 'index.ovk'))
  for (const id of Object.keys(reg.pastes.pb)) assert.ok(pastes.has(id), `registered paste ${id} is gone from the server`)
  assert.equal(new TextDecoder().decode((await old.get('groceries')).bytes), 'v2')
})
