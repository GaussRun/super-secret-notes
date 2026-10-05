// With every index holder silent, reads answer from this device's index copy at once and refresh
// from the hosts in the background; a note read does not wait for one dead host after another.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as c from '../src/crypto.js'
import { createBackend } from '../src/backends/index.js'
import { Overkill } from '../src/store.js'

const quiet = { debug () {}, info () {}, warn () {} }
const hanging = (name) => ({ name, type: 'local', put: () => new Promise(() => {}), get: () => new Promise(() => {}), exists: () => new Promise(() => {}) })

test('all index holders hang: list and get answer from the local copy, well under the host timeout', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-offline-'))
  const ctx = { root: 'ovk', home: dir }
  const vault = await c.createVault()
  const keys = await c.unlockKeys(vault)
  const cache = { blob: null, write: async (b) => { cache.blob = b }, read: async () => cache.blob }
  const local = (name) => createBackend({ name, type: 'local', path: path.join(dir, name) }, ctx)
  const before = new Overkill({ backends: [local('idx1'), local('idx2'), local('usb')], keys, logger: quiet, indexCache: cache })
  await before.writeIndex(c.emptyIndex())
  await before.put('diary', 'kept on the stick', { sample: false })

  // later: both index holders (and every other host) hang; only the USB stick answers
  const hostTimeoutMs = 10_000
  const store = new Overkill({ backends: [hanging('idx1'), hanging('idx2'), local('usb')], keys, logger: quiet, indexCache: cache, hostTimeoutMs })
  let t = Date.now()
  const notes = await store.list()
  assert.ok(Date.now() - t < 1000, `list took ${Date.now() - t} ms`)
  assert.deepEqual(Object.keys(notes), ['diary'])
  t = Date.now()
  const got = await store.get('diary')
  assert.ok(Date.now() - t < hostTimeoutMs / 2, `get took ${Date.now() - t} ms`)
  assert.equal(new TextDecoder().decode(got.bytes), 'kept on the stick')
  assert.equal(got.from, 'usb')
  await store.close({ lateGraceMs: 0 })
})

test('the background refresh merges what the hosts know into the local copy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-offline-merge-'))
  const ctx = { root: 'ovk', home: dir }
  const keys = await c.unlockKeys(await c.createVault())
  const local = (name) => createBackend({ name, type: 'local', path: path.join(dir, name) }, ctx)
  const cacheOf = () => { const x = { blob: null, write: async (b) => { x.blob = b }, read: async () => x.blob }; return x }
  const mine = cacheOf()
  const a = new Overkill({ backends: [local('idx')], keys, logger: quiet, indexCache: mine })
  await a.writeIndex(c.emptyIndex())
  await a.put('first', '1', { sample: false })
  // another device adds a note
  const b = new Overkill({ backends: [local('idx')], keys, logger: quiet, indexCache: cacheOf() })
  await b.put('second', '2', { sample: false })
  // this device: the first answer is its own copy; the refresh brings the other note in
  const again = new Overkill({ backends: [local('idx')], keys, logger: quiet, indexCache: mine })
  assert.deepEqual(Object.keys(await again.list()), ['first'])
  await again.refreshing
  assert.deepEqual(Object.keys(await again.list()).sort(), ['first', 'second'])
  // a note only the hosts know is read after waiting for them, with its sha256 checked
  const fresh = new Overkill({ backends: [local('idx')], keys, logger: quiet, indexCache: cacheOf() })
  await fresh.cache({ ...c.emptyIndex() })
  const got = await fresh.get('second')
  assert.ok(got.entry, 'found in the hosts\' index')
})

test('no index copy on this device yet (a restored backup): the first index holder that answers is enough for a read', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-offline-first-'))
  const ctx = { root: 'ovk', home: dir }
  const keys = await c.unlockKeys(await c.createVault())
  const local = (name) => createBackend({ name, type: 'local', path: path.join(dir, name) }, ctx)
  const a = new Overkill({ backends: [local('backup')], keys, logger: quiet })
  await a.writeIndex(c.emptyIndex())
  await a.put('diary', 'from the backup', { sample: false })
  const cache = { blob: null, write: async (b) => { cache.blob = b }, read: async () => cache.blob }
  const hostTimeoutMs = 10_000
  const store = new Overkill({ backends: [local('backup'), hanging('relay'), hanging('pad')], keys, logger: quiet, indexCache: cache, hostTimeoutMs })
  // the other holders get a short grace (hedgeMs, 2 s) once one answered, not the host timeout
  const t = Date.now()
  assert.deepEqual(Object.keys(await store.list()), ['diary'])
  assert.ok(Date.now() - t < 3000, `list took ${Date.now() - t} ms`)
  assert.equal(new TextDecoder().decode((await store.get('diary')).bytes), 'from the backup')
  assert.ok(Date.now() - t < 3500, `list and get took ${Date.now() - t} ms`)
})
