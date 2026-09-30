// Copies that differ from the index: a copy the index knows to be older is STALE and repair
// replaces it; a copy the index does not know (possibly newer, from a device whose index update
// never arrived) is DIVERGED and is never overwritten (docs/OVERKILL.md, "Failure handling").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as c from '../src/crypto.js'
import { createBackend } from '../src/backends/index.js'
import { Overkill, STATUS } from '../src/store.js'

const quiet = { debug: () => {}, info: () => {}, warn: () => {} }

// Two index holders and two paste-like hosts over folders; each "device" gets its own adapters
// (and its own index cache) over the same folders. `down` makes a host refuse writes.
async function world () {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-diverge-'))
  const ctx = { root: 'ovk', home: dir }
  const vault = await c.createVault()
  const keys = await c.unlockKeys(vault)
  const vaultBytes = await c.encryptVault(vault, 'pw', { logN: 10 })
  const down = new Set()
  const downIndex = new Set()
  const adapters = () => ['idx1', 'idx2', 'p1', 'p2'].map((name) => {
    const b = createBackend({ name, type: 'local', path: path.join(dir, name) }, ctx)
    if (name.startsWith('p')) b.addressing = 'locator'
    const put = b.put.bind(b)
    b.put = async (rel, bytes) => {
      if (down.has(name) || (rel === c.paths.index && downIndex.has(name))) throw new Error(`${name} refuses writes`)
      return put(rel, bytes)
    }
    return b
  })
  const device = () => {
    const cache = { blob: null, write: async (b) => { cache.blob = b }, read: async () => cache.blob }
    return new Overkill({ backends: adapters(), keys, vaultBytes, logger: quiet, indexCache: cache })
  }
  // what one host holds for a note, decrypted (bypassing the index)
  const raw = async (name, note) => {
    const b = adapters().find((x) => x.name === name)
    const blob = await b.get(c.paths.note(await c.blobIdForName(keys, note)))
    return blob && new TextDecoder().decode(await c.decryptBlob(keys, await c.blobIdForName(keys, note), blob))
  }
  return { down, downIndex, device, raw }
}

test('split brain: a device with an older index never overwrites newer copies (DIVERGED, not STALE)', async () => {
  const w = await world()
  const a = w.device()
  await a.uploadVault()
  await a.writeIndex(c.emptyIndex())
  await a.put('diary', 'v1', { sample: false })
  // v2 reaches only the paste hosts; no index holder takes the new index
  w.down.add('idx1').add('idx2')
  const r = await a.put('diary', 'v2', { sample: false })
  assert.equal(r.stored, 2)
  w.down.clear()

  // device B only knows the remote index (v1)
  const b = w.device()
  const report = await b.check()
  const { fixed, failed, diverged } = await b.repair(report)
  assert.equal(await w.raw('p1', 'diary'), 'v2', 'the newer copy survived repair')
  assert.equal(await w.raw('p2', 'diary'), 'v2')
  assert.deepEqual(report.notes.diary.map((x) => [x.backend, x.status]), [['idx1', STATUS.OK], ['idx2', STATUS.OK], ['p1', STATUS.DIVERGED], ['p2', STATUS.DIVERGED]])
  assert.deepEqual(fixed.filter((x) => x.startsWith('diary')), [])
  assert.deepEqual(failed, [])
  assert.deepEqual(diverged, ['diary on p1', 'diary on p2'])

  // get: the index's version, plus where the other one is; --from reads that one
  const got = await w.device().get('diary')
  assert.equal(new TextDecoder().decode(got.bytes), 'v1')
  assert.deepEqual(got.diverged, ['p1', 'p2'])
  const other = await w.device().get('diary', { from: 'p1' })
  assert.equal(new TextDecoder().decode(other.bytes), 'v2')
  assert.equal(other.from, 'p1')
  assert.equal(other.status, STATUS.DIVERGED)
})

test('a copy the index knows to be older is STALE and repair replaces it', async () => {
  const w = await world()
  const a = w.device()
  await a.uploadVault()
  await a.writeIndex(c.emptyIndex())
  await a.put('diary', 'v1', { sample: false })
  w.down.add('p2')
  await a.put('diary', 'v2', { sample: false })
  w.down.clear()
  const b = w.device()
  const report = await b.check()
  assert.deepEqual(report.notes.diary.map((x) => x.status), [STATUS.OK, STATUS.OK, STATUS.OK, STATUS.STALE])
  const { fixed } = await b.repair(report)
  assert.ok(fixed.includes('diary on p2'))
  assert.equal(await w.raw('p2', 'diary'), 'v2')
})

test('an index entry from before blob hashes were recorded: a differing copy is DIVERGED, never overwritten', async () => {
  const w = await world()
  const a = w.device()
  await a.uploadVault()
  await a.writeIndex(c.emptyIndex())
  await a.put('diary', 'v1', { sample: false })
  w.down.add('p2')
  await a.put('diary', 'v2', { sample: false })
  w.down.clear()
  // an index written by an older client: no blob_sha256, no superseded
  const index = await a.mergedIndex()
  const { blob_sha256: _b, superseded: _s, ...legacy } = index.notes.diary
  index.notes.diary = legacy
  await a.writeIndex(index)
  const b = w.device()
  const report = await b.check()
  await b.repair(report)
  assert.equal(await w.raw('p2', 'diary'), 'v1', 'unknown copies are left alone')
  assert.equal(report.notes.diary.find((x) => x.backend === 'p2').status, STATUS.DIVERGED)
})

test('status warns about a DIVERGED copy, and a host holding one never counts as dead', async () => {
  const { ledgerStatus } = await import('../src/status.js')
  const { deadBackends } = await import('../src/hosts/pick.js')
  const old = '2026-01-01T00:00:00.000Z'
  const index = {
    notes: { diary: { id: 'x', sha256: 'y', size: 1, updated: '2026-09-01T00:00:00.000Z' } },
    health: { diary: { 'pb-a': { status: 'diverged', last_checked: '2026-09-02T00:00:00.000Z' }, 'pb-b': { status: 'diverged', last_checked: '2026-08-01T00:00:00.000Z' } } }
  }
  const { warnings } = ledgerStatus(index, ['pb-a', 'pb-b'], new Date('2026-09-03T00:00:00.000Z'))
  // pb-b's result predates the note's last update, so it says nothing about this version
  assert.ok(warnings.includes('DIVERGED: diary on pb-a is a version the index does not know (maybe newer); `get "diary" --from pb-a` reads it'))
  const dead = deadBackends({ index, backends: [{ name: 'pb-a', type: 'privatebin', url: 'https://a.example' }], cache: null, created: old, now: new Date('2027-09-01T00:00:00.000Z') })
  assert.deepEqual(dead, [])
})

test('false quorum: two paste copies but no index holder took the index is reported as not findable', async () => {
  const w = await world()
  const a = w.device()
  await a.uploadVault()
  await a.writeIndex(c.emptyIndex())
  const lines = []
  a.log = { debug: () => {}, info: () => {}, warn: (m) => lines.push(m) }
  w.down.add('idx1').add('idx2')
  const r = await a.put('diary', 'v1', { sample: false })
  assert.equal(r.stored, 2)
  assert.equal(r.indexed, 0)
  assert.equal(r.findable, false)
  assert.ok(lines.some((l) => /"diary" is stored on 2 hosts but NOT yet findable from other devices/.test(l)), lines.join('\n'))
  w.down.clear()
  const ok = await a.put('diary', 'v2', { sample: false })
  assert.equal(ok.indexed, 2)
  assert.equal(ok.findable, true)
})

test('an index kept on this device is merged into the next write, not replaced by the older remote one', async () => {
  const w = await world()
  const a = w.device()
  await a.uploadVault()
  await a.writeIndex(c.emptyIndex())
  // the index holders answer reads but refuse the index write
  w.downIndex.add('idx1').add('idx2')
  await a.put('first', 'one', { sample: false })
  assert.ok((await a.list()).first, 'this device still lists it')
  w.downIndex.clear()
  await a.put('second', 'two', { sample: false })
  const remote = await w.device().list()
  assert.deepEqual(Object.keys(remote).sort(), ['first', 'second'])
})

test('check and repair upload an index kept on this device to the holders that lack it', async () => {
  const w = await world()
  const a = w.device()
  await a.uploadVault()
  await a.writeIndex(c.emptyIndex())
  w.downIndex.add('idx1').add('idx2')
  await a.put('first', 'one', { sample: false })
  w.downIndex.clear()
  const report = await a.check()
  assert.ok(report.notes.first, 'check covers the note only this device knows so far')
  await a.repair(report)
  assert.ok((await w.device().list()).first)
})
