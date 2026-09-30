// Fileverse embedded mode. The writer runs the real @fileverse/api library (in-memory DB,
// migrations, createFile/updateFile, events) with only the network edges replaced: key material
// comes from a fake init and processEvent is a fake chain that enforces the portal contract's
// fileId <-> appFileId (ddocId) check. The adapter tests use a fake writer and reader.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as c from '../src/crypto.js'
import { createBackend } from '../src/backends/index.js'
import { create, decodeDoc, titleFor, redact } from '../src/backends/fileverse.js'
import { makeEmbeddedWriter, MemoryAdapter } from '../src/backends/fileverse-embedded.js'

const API_KEY = 'embedded-test-key-0123456789abcd'
const PORTAL = '0x2378b45E6d5beB92B922c42ee134265D2bdA4a5A'
const realBase = await import('@fileverse/api/base')

/** A fake Gnosis portal: fileId -> { ddocId, title, content, version } */
function fakeChain (base) {
  const files = []
  const processEvent = async (event) => {
    const row = await base.FilesModel.findByIdIncludingDeleted(event.fileId)
    if (event.type === 'create') {
      files.push({ ddocId: row.ddocId, title: row.title, content: row.content, version: row.localVersion })
      await base.FilesModel.update(row._id, { onChainFileId: files.length - 1, onchainVersion: row.localVersion, syncStatus: 'synced' }, row.portalAddress)
      return { success: true }
    }
    if (!row.onChainFileId) { // @fileverse/api 1.0.10: `if (fileId)` sends addFile for file 0
      files.push({ ddocId: row.ddocId, title: row.title, content: row.content, version: 1 })
      return { success: false, error: 'EditedFile event not found' }
    }
    const f = files[row.onChainFileId]
    if (!f || f.ddocId !== row.ddocId) return { success: false, error: 'UserOperation reverted during simulation with reason: FileId to AppFileId mismatch' }
    Object.assign(f, { title: row.title, content: row.content, version: f.version + 1 })
    await base.FilesModel.update(row._id, { onchainVersion: row.localVersion, syncStatus: 'synced' }, row.portalAddress)
    return { success: true }
  }
  return { files, processEvent }
}

function writerOver (chain) {
  const base = { ...realBase, processEvent: chain.processEvent }
  const init = (b) => b.initializeWithData({
    keyMaterial: { apiKeySeed: API_KEY, name: 'test', collaboratorAddress: '0x1111111111111111111111111111111111111111' },
    appMaterial: { portalAddress: PORTAL, portalSeed: c.toBase64(c.randomBytes(48)), ownerAddress: '0x2222222222222222222222222222222222222222' }
  })
  return makeEmbeddedWriter(base, { apiKey: API_KEY, init })
}

test('memory adapter speaks the library interface', async () => {
  const db = new MemoryAdapter()
  await db.exec('CREATE TABLE t (a TEXT, b INTEGER)')
  assert.deepEqual(await db.execute('INSERT INTO t VALUES (?, ?)', ['x', 1]), { changes: 1, lastInsertRowid: 1 })
  assert.deepEqual((await db.select('SELECT * FROM t WHERE b = ?', [1])).map((r) => ({ ...r })), [{ a: 'x', b: 1 }])
  assert.deepEqual({ ...(await db.selectOne('SELECT a FROM t')) }, { a: 'x' })
  assert.equal(db.isConnected(), true)
})

test('writer: create, then update in place keeps fileId and ddocId; file 0 is refused', async () => {
  const chain = fakeChain(realBase)
  const w = writerOver(chain)
  const zero = await w.create('t0', 'first file of the portal')
  assert.equal(zero.fileId, 0)
  await assert.rejects(w.update(zero, 't0', 'x'), /file 0 cannot be edited/)
  const ref = await w.create('t1', 'one')
  assert.equal(chain.files[ref.fileId].ddocId, ref.ddocId)
  const again = await w.update(ref, 't1', 'two')
  assert.deepEqual(again, ref)
  assert.equal(chain.files.length, 2)
  assert.equal(chain.files[ref.fileId].content, 'two')
  assert.equal(chain.files[ref.fileId].version, 2)
})

test('writer: a fresh process updates a file it never created by reusing its ddocId', async () => {
  const chain = fakeChain(realBase)
  await writerOver(chain).create('t-zero', 'occupies file 0')
  const ref = await writerOver(chain).create('t2', 'first')
  // new writer = new process = empty in-memory DB, knows only (fileId, ddocId) from the network
  const fresh = writerOver(chain)
  const out = await fresh.update(ref, 't2', 'second')
  assert.deepEqual(out, ref)
  assert.equal(chain.files.length, 2, 'no extra on-chain file')
  assert.equal(chain.files[ref.fileId].content, 'second')
  assert.equal(chain.files[ref.fileId].title, 't2')
  // and a second update from the same fresh writer reuses its row
  await fresh.update(ref, 't2', 'third')
  assert.equal(chain.files[ref.fileId].content, 'third')
})

test('writer: the contract check is real in the fake, so a wrong ddocId fails loudly', async () => {
  const chain = fakeChain(realBase)
  await writerOver(chain).create('t-zero', 'occupies file 0')
  const ref = await writerOver(chain).create('t3', 'x')
  await assert.rejects(writerOver(chain).update({ fileId: ref.fileId, ddocId: 'someOtherDdocId12345' }, 't3', 'y'), /FileId to AppFileId mismatch/)
})

test('redact strips the key, bearer tokens, JWTs and apiKey= parameters', () => {
  const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJkaWQ6a2V5In0.c2lnbmF0dXJlc2lnbmF0dXJl'
  const out = redact(`failed ${API_KEY} Authorization: Bearer abc.def-ghi ${jwt} http://x/?apiKey=zzz&b=1`, [API_KEY])
  assert.ok(!out.includes(API_KEY) && !out.includes('abc.def-ghi') && !out.includes(jwt) && !out.includes('zzz'))
})

function fakes () {
  const chain = new Map() // fileId -> { ddocId, title, text }
  let nextId = 0
  const calls = []
  const writer = {
    async create (title, content) { calls.push(['create', title]); const ref = { fileId: nextId++, ddocId: c.toHex(c.randomBytes(8)) }; chain.set(ref.fileId, { ...ref, title, text: content }); return ref },
    async update (ref, title, content) { calls.push(['update', title, ref]); const f = chain.get(ref.fileId); assert.equal(f.ddocId, ref.ddocId); f.text = content; return ref },
    close () { calls.push(['close']) }
  }
  let scans = 0
  const reader = {
    async index () { scans++; return new Map([...chain.values()].map((f) => [f.title, { fileId: f.fileId, ddocId: f.ddocId }])) },
    note () {},
    // markdown -> Yjs -> text drops the code fence; emulate that
    async read (fileId) { return chain.get(fileId)?.text.replaceAll('```', '').trim() ?? null }
  }
  return { chain, calls, writer, reader, scans: () => scans }
}

test('adapter (embedded, default mode): put creates then updates the same file; get/list read the network', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ssn-fve-'))
  const f = fakes()
  const fv = create({ name: 'fv', type: 'fileverse', apiKey: API_KEY }, { root: 'ovk', home }, { writer: f.writer, reader: f.reader })
  const a = c.randomBytes(1024)
  await fv.put('notes/n.ovk', a)
  assert.deepEqual(await fv.get('notes/n.ovk'), a)
  const b = c.randomBytes(50 * 1024)
  // the first file of a portal (fileId 0) cannot be edited through the library: a new file
  // replaces it, then edits happen in place
  await fv.put('notes/n.ovk', b)
  assert.deepEqual(await fv.get('notes/n.ovk'), b)
  await fv.put('notes/n.ovk', a)
  assert.deepEqual(await fv.get('notes/n.ovk'), a)
  assert.deepEqual(f.calls.map((x) => x[0]), ['create', 'create', 'update'])
  assert.equal(f.calls[2][1], titleFor('ovk', 'notes/n.ovk'))
  assert.equal(f.calls[2][2].fileId, 1)
  assert.equal(f.chain.size, 2)
  assert.equal(await fv.get('notes/none.ovk'), null)
  assert.equal(await fv.exists('notes/n.ovk'), true)
  await fv.put('index.ovk', c.randomBytes(5))
  assert.deepEqual(await fv.list('notes'), ['n.ovk'])
  assert.deepEqual(await fv.list(''), ['index.ovk'])
  await fv.close()
  assert.deepEqual(f.calls.at(-1), ['close'])
  // a second device (new adapter, empty home) finds the file on the network and edits it in place
  const other = create({ name: 'fv', type: 'fileverse', apiKey: API_KEY }, { root: 'ovk', home: await mkdtemp(path.join(os.tmpdir(), 'ssn-fve-')) }, { writer: f.writer, reader: f.reader })
  assert.deepEqual(await other.get('notes/n.ovk'), a)
  await other.put('notes/n.ovk', b)
  assert.equal(f.chain.size, 3, 'note (old file 0 and file 1) plus index.ovk, nothing more')
  assert.deepEqual(decodeDoc(await f.reader.read(1)), b)
})

test('adapter: old daemon configs are refused, registry wires it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ssn-fve-'))
  assert.throws(() => create({ name: 'fv', type: 'fileverse', apiKey: API_KEY, mode: 'daemon' }, { root: 'ovk', home }), /is gone/)
  const fv = createBackend({ name: 'fv', type: 'fileverse', apiKey: API_KEY }, { root: 'ovk', home })
  assert.equal(fv.type, 'fileverse')
  await fv.close()
})

test('adapter (derived account): locked vault refuses; unlocked, the key is derived and set up once per run', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ssn-fve-'))
  const f = fakes()
  const ensured = []
  const ensureApiKey = async (secrets) => { ensured.push(c.toHex(secrets.apiKeySeed)); return { apiKey: 'derived-key-' + ensured.length, created: ensured.length === 1, wallet: '0x0', portalAddress: '0x1' } }
  const keysSeen = []
  // reader and writer factories receive the adapter's key getter, like the real ones
  const reader = (key) => ({ ...f.reader, async index () { keysSeen.push(await key()); return f.reader.index() } })
  const writer = (key) => ({ ...f.writer, async create (t, content) { keysSeen.push(await key()); return f.writer.create(t, content) } })
  const fv = create({ name: 'fv', type: 'fileverse', derived: true }, { root: 'ovk', home }, { ensureApiKey, reader, writer })
  await assert.rejects(fv.put('notes/d.ovk', c.randomBytes(10)), /vault is locked/)
  const keys = await c.unlockKeys(await c.createVault())
  fv.unlock(keys)
  await fv.put('notes/d.ovk', c.randomBytes(10))
  await fv.get('notes/d.ovk')
  assert.deepEqual(ensured, [c.toHex((await c.deriveFileverseSecrets(keys.master)).apiKeySeed)], 'set up once, from this vault')
  assert.ok(keysSeen.length >= 3 && keysSeen.every((k) => k === 'derived-key-1'))
  await fv.close()
})
