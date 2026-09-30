// Failure handling (docs/OVERKILL.md): a host that never answers times out and counts as FAILED,
// a failed host gets a stand-in at setup, the index stays local when no index holder answers,
// and a put on a single host warns instead of failing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as c from '../src/crypto.js'
import { createBackend } from '../src/backends/index.js'
import { Overkill, MIN_COPIES } from '../src/store.js'
import { fallbackPicker, FALLBACKS } from '../src/fallbacks.js'

function recorder () {
  const lines = []
  const log = (level) => (m) => lines.push(`${level} ${m}`)
  return { lines, logger: { debug: () => {}, info: log('info'), warn: log('warn') } }
}

async function localBackends (names) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-failure-'))
  const ctx = { root: 'ovk', home: dir }
  return { dir, ctx, make: (name) => createBackend({ name, type: 'local', path: path.join(dir, name) }, ctx), list: names.map((n) => createBackend({ name: n, type: 'local', path: path.join(dir, n) }, ctx)) }
}

const hanging = (name, addressing) => ({ name, type: 'local', ...(addressing ? { addressing } : {}), put: () => new Promise(() => {}), get: () => new Promise(() => {}), exists: () => new Promise(() => {}) })
const failing = (name) => ({ name, type: 'local', put: async () => { throw new Error('down') }, get: async () => { throw new Error('down') }, exists: async () => { throw new Error('down') } })

async function keys () {
  const vault = await c.createVault()
  return { keys: await c.unlockKeys(vault), vaultBytes: await c.encryptVault(vault, 'pw', { logN: 10 }) }
}

test('a host that never answers is FAILED after its deadline; the others are stored', async () => {
  const { list } = await localBackends(['a', 'b'])
  const { logger, lines } = recorder()
  const store = new Overkill({ backends: [...list, hanging('silent')], ...(await keys()), logger, hostTimeoutMs: 200 })
  const t0 = Date.now()
  const res = await store.uploadVault()
  assert.ok(Date.now() - t0 < 2000)
  assert.deepEqual(res.map((r) => [r.backend.name, r.ok]), [['a', true], ['b', true], ['silent', false]])
  assert.match(res[2].error.message, /silent: no answer in 200 ms/)
  assert.ok(lines.some((l) => /silent: vault.age upload FAILED/.test(l)))
  // an adapter's own deadline wins over the store's
  const own = hanging('own')
  own.timeoutMs = 50
  const s2 = new Overkill({ backends: [own], ...(await keys()), logger, hostTimeoutMs: 60_000 })
  const t1 = Date.now()
  await s2.uploadVault()
  assert.ok(Date.now() - t1 < 1000)
})

test('setup fallbacks: a failed host is replaced by the next alternative of its type, one operator each', async () => {
  const { make } = await localBackends([])
  const cfg = { backends: [{ name: 'pb-a', type: 'privatebin', url: 'https://a.example' }, { name: 'pb-b', type: 'privatebin', url: 'https://b.example' }] }
  const offered = []
  const picker = fallbackPicker(cfg, {
    lists: { privatebin: ['https://paste.b.example', 'https://c.example', 'https://d.example'] },
    make: (bc) => { offered.push(bc.url); return bc.url === 'https://c.example' ? failing(bc.name) : make(bc.name) }
  })
  const { logger } = recorder()
  const good = make('pb-a')
  const store = new Overkill({ backends: [good, failing('pb-b')], ...(await keys()), logger })
  const res = await store.uploadVault({ next: (b) => picker.next(b) })
  // b.example's operator is taken (pb-b), c.example fails too, d.example takes it
  assert.deepEqual(offered, ['https://c.example', 'https://d.example'])
  assert.equal(res[1].ok, true)
  assert.equal(res[1].replaced, 'pb-b')
  const swaps = picker.apply(res)
  assert.deepEqual(cfg.backends.map((b) => b.url), ['https://a.example', 'https://d.example'])
  assert.equal(swaps.length, 1)
  assert.equal(store.backends[1], res[1].backend)
})

test('the built-in fallbacks skip the defaults, a broken instance and a relay that bans', () => {
  assert.ok(!FALLBACKS.privatebin.includes('https://pb.envs.net'))
  assert.ok(!FALLBACKS.privatebin.includes('https://paste.coalserver.de'))
  assert.ok(FALLBACKS.privatebin.includes('https://cryptostorm.is/paste'))
  assert.ok(!FALLBACKS.nostr.includes('wss://relay.damus.io'))
  assert.ok(!FALLBACKS.nostr.includes('wss://nos.lol'))
})

test('no index holder answers: the index stays local and a put still works on one host, with a warning', async () => {
  const { make } = await localBackends([])
  const { logger, lines } = recorder()
  const cache = { blob: null, write: async (b) => { cache.blob = b }, read: async () => cache.blob }
  // "p" stands in for a paste host (never holds the index); the index holder never answers
  const p = make('p')
  p.addressing = 'locator'
  const store = new Overkill({ backends: [p, hanging('idx')], ...(await keys()), logger, indexCache: cache, hostTimeoutMs: 100 })
  await store.uploadVault()
  const up = await store.writeIndex(c.emptyIndex())
  assert.equal(up.some((r) => r.ok), false)
  assert.ok(lines.some((l) => /kept on this device only/.test(l)))
  const r = await store.put('lonely', 'on one host', { sample: false })
  assert.equal(r.stored, 1)
  assert.ok(r.stored < MIN_COPIES)
  assert.ok(lines.some((l) => /is on only 1 host/.test(l)))
  assert.ok(lines.some((l) => /using the index kept on this device/.test(l)))
  assert.ok((await store.localIndex()).notes.lonely)
})

// A PrivateBin instance that answers posts only after `delay` ms (the paste is stored at once).
async function slowPrivatebin (delay) {
  const http = await import('node:http')
  const pastes = new Map()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const ch of req) chunks.push(ch)
    const send = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) }
    if (req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.pasteid) {
        if (pastes.get(body.pasteid)?.deletetoken === body.deletetoken) pastes.delete(body.pasteid)
        return send({ status: 0 })
      }
      const id = c.toHex(c.randomBytes(8))
      pastes.set(id, { ...body, deletetoken: c.toHex(c.randomBytes(32)) })
      return setTimeout(() => send({ status: 0, id, url: `/?${id}`, deletetoken: pastes.get(id).deletetoken }), delay)
    }
    const id = new URL(req.url, 'http://x').searchParams.get('pasteid')
    const p = pastes.get(id)
    send(p ? { status: 0, id, ...p, meta: {} } : { status: 1, message: 'Document does not exist, has expired or has been deleted.' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, pastes, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

test('a paste that lands after the deadline: kept with its locator on a backend in use, deleted on a replaced one', async () => {
  const slow = await slowPrivatebin(400)
  try {
    const { ctx, make } = await localBackends([])
    const { logger, lines } = recorder()

    // in use: the put times out, then lands; the adapter records its locator and token
    const pb = createBackend({ name: 'pb-slow', type: 'privatebin', url: slow.url }, ctx)
    const store = new Overkill({ backends: [make('a'), pb], ...(await keys()), logger, hostTimeoutMs: 100 })
    const res = await store.uploadVault()
    assert.equal(res[1].ok, false)
    await store.close()
    assert.equal(slow.pastes.size, 1)
    assert.ok((await pb.getLocators())[c.paths.vault], 'the late paste is findable')
    assert.equal((await pb.get(c.paths.vault)).length > 0, true)
    assert.ok(lines.some((l) => /pb-slow: vault.age arrived after the deadline; kept/.test(l)))

    // replaced at setup: the late paste is deleted again with its token
    const cfg = { backends: [{ name: 'pb-late', type: 'privatebin', url: slow.url }] }
    const picker = fallbackPicker(cfg, { lists: { privatebin: ['https://stand-in.example'] }, make: (bc) => make(bc.name) })
    const late = createBackend(cfg.backends[0], ctx)
    const s2 = new Overkill({ backends: [late], ...(await keys()), logger, hostTimeoutMs: 100 })
    const r2 = await s2.uploadVault({ next: (b) => picker.next(b) })
    assert.equal(r2[0].replaced, 'pb-late')
    await s2.close()
    assert.equal(slow.pastes.size, 1, 'only the first paste is left; the replaced host holds nothing')
    assert.ok(lines.some((l) => /pb-late: vault.age arrived after the deadline on a host this vault no longer uses; deleted it again/.test(l)))
  } finally {
    await slow.close()
  }
})
