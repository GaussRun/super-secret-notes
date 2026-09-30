// Every network call and subprocess has a bound, including the ones the store's per-host
// deadline does not cover (paste and blob deletes, dropPath, the proton-drive CLI).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as c from '../src/crypto.js'
import * as privatebin from '../src/backends/privatebin.js'
import * as blossom from '../src/backends/blossom.js'
import { run } from '../src/backends/run.js'

// fails the test instead of hanging it when `p` never settles
const within = (ms, p) => {
  let timer
  return Promise.race([p, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms) })]).finally(() => clearTimeout(timer))
}
const settled = (p) => p.then(() => 'ok', (err) => err)
const home = () => mkdtemp(path.join(os.tmpdir(), 'ssn-timeouts-'))

// PrivateBin that stores pastes but never answers a delete
async function deafToDeletes () {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const ch of req) chunks.push(ch)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    if (body?.pasteid) return // hangs
    res.setHeader('Content-Type', 'application/json')
    const id = c.toHex(c.randomBytes(8))
    res.end(JSON.stringify({ status: 0, id, url: `/?${id}`, deletetoken: 'tok' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

test('PrivateBin: deletePaste, dropPath and the replace-delete inside put give up after the request timeout', async () => {
  const srv = await deafToDeletes()
  try {
    const pb = privatebin.create({ name: 'pb', url: srv.url }, { root: 'ovk', home: await home() }, { requestTimeoutMs: 200 })
    const err = await within(3000, settled(pb.deletePaste('abc', 'tok')))
    assert.match(String(err.message), /no answer in 200 ms/)
    await within(3000, pb.put('notes/a.ovk', new Uint8Array([1])))
    await within(3000, pb.put('notes/a.ovk', new Uint8Array([2]))) // deletes the first paste
    assert.equal(await within(3000, pb.dropPath('notes/a.ovk')), true)
  } finally {
    await srv.close()
  }
})

test('Blossom: the delete of a replaced blob and dropPath give up after the request timeout', async () => {
  const blobs = new Map()
  // answers uploads and reads, never a DELETE; honours the abort signal like fetch does
  const fetchImpl = async (url, init = {}) => {
    const sha = new URL(url).pathname.split('/').pop()
    if (init.method === 'PUT') {
      const body = new Uint8Array(init.body)
      const h = await c.sha256Hex(body)
      blobs.set(h, body)
      return new Response(JSON.stringify({ sha256: h }), { status: 200 })
    }
    if (init.method === 'DELETE') {
      return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)))
    }
    return blobs.has(sha) ? new Response(blobs.get(sha)) : new Response('', { status: 404 })
  }
  const keys = await c.unlockKeys(await c.createVault())
  const b = blossom.create({ name: 'bl', url: 'https://blossom.example.org' }, { root: 'ovk', home: await home() }, { fetchImpl, requestTimeoutMs: 200 })
  b.unlock(keys)
  await within(3000, b.put('notes/a.ovk', new Uint8Array([1])))
  await within(3000, b.put('notes/a.ovk', new Uint8Array([2]))) // deletes the first blob
  assert.deepEqual(await b.get('notes/a.ovk'), new Uint8Array([2]))
  assert.equal(await within(3000, b.dropPath('notes/a.ovk')), true)
  assert.equal(await b.get('notes/a.ovk'), null)
})

test('a CLI backend subprocess that ignores SIGTERM is killed after the grace period', async () => {
  const child = run(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 10000)"], { timeoutMs: 200, killGraceMs: 200 })
  const err = await within(5000, settled(child))
  assert.match(String(err.message), /timed out after 200 ms/)
})
