// Health ledger: sampling after put, check refreshing the ledger, and `status` warnings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import winston from 'winston'
import * as c from '../src/crypto.js'
import { createBackend } from '../src/backends/index.js'
import { Overkill, STATUS } from '../src/store.js'
import { ledgerStatus } from '../src/status.js'

const quiet = winston.createLogger({ silent: true })
const DAY = 86_400_000

async function setup (wrap = (b) => b) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-health-'))
  const ctx = { root: 'ovk', home: dir }
  const backends = ['a', 'b'].map((n) => wrap(createBackend({ name: n, type: 'local', path: path.join(dir, n) }, ctx)))
  const vault = await c.createVault()
  const store = new Overkill({ backends, keys: await c.unlockKeys(vault), vaultBytes: await c.encryptVault(vault, 'pw', { logN: 10 }), logger: quiet })
  await store.uploadVault()
  await store.writeIndex(c.emptyIndex())
  return { store, dir }
}

test('sampling: least recently verified first, never-verified before everything, excludes the note just written', async () => {
  const { store } = await setup()
  await store.put('one', '1', { sample: false })
  await store.put('two', '2', { sample: false })
  const index = await store.mergedIndex()
  const at = (d) => new Date(Date.UTC(2026, 8, d)).toISOString()
  const e = (d) => ({ last_ok: at(d), last_checked: at(d), status: 'ok', expires: null })
  index.health = {
    _vault: { a: e(20), b: e(21) },
    _index: { a: e(22), b: e(5) }, // b's index is the oldest
    one: { a: e(10), b: e(23) },
    two: { a: e(24) } // two on b: never verified
  }
  const picked = await store.sample(index, { exclude: 'three' })
  assert.deepEqual(picked.map((x) => `${x.key}@${x.backend}`), ['two@b', '_index@b', 'one@a'])
  assert.ok(picked.every((x) => x.status === STATUS.OK))
  const skipTwo = await store.sample(index, { exclude: 'two', max: 2 })
  assert.deepEqual(skipTwo.map((x) => `${x.key}@${x.backend}`), ['_index@b', 'one@a'])
})

test('sampling stops at the time budget', async () => {
  const slow = (b) => ({ ...b, get: async (p) => { await new Promise((resolve) => setTimeout(resolve, 150)); return b.get(p) } })
  const { store } = await setup(slow)
  await store.put('one', '1', { sample: false })
  const index = await store.mergedIndex()
  const t0 = Date.now()
  // each read takes 150 ms: without the budget this would verify 3 copies (450 ms)
  const picked = await store.sample(index, { budgetMs: 200 })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].status, STATUS.OK)
  assert.ok(Date.now() - t0 < 400)
  // a budget smaller than one read still verifies one copy; it only stops further reads
  const tiny = await store.sample(index, { budgetMs: 1 })
  assert.equal(tiny.length, 1)
  assert.equal(tiny[0].status, STATUS.OK)
})

test('put: sample results land in the ledger, failures never block the put', async () => {
  let broken = false
  // put has to read the index first, so only the other reads fail
  const flaky = (b) => ({ ...b, get: async (p) => { if (broken && p !== c.paths.index) throw new Error('network down'); return b.get(p) } })
  const { store } = await setup(flaky)
  await store.put('one', '1', { sample: false })
  broken = true // reads of notes and vault.age fail now; uploads still work
  const { sampled, results } = await store.put('two', '2')
  assert.ok(results.every((r) => r.ok))
  assert.equal(sampled.length, 3)
  const expected = (x) => (x.key === '_index' ? STATUS.OK : STATUS.ERROR)
  assert.ok(sampled.every((x) => x.status === expected(x)))
  broken = false
  const index = await store.mergedIndex()
  for (const x of sampled) {
    const entry = index.health[x.key][x.backend]
    assert.equal(entry.status, expected(x).toLowerCase())
    assert.ok(entry.last_checked)
    assert.equal(entry.last_ok === undefined, x.key !== '_index')
  }
  assert.equal(index.health.two, undefined) // the new note's copies are not verified yet
  assert.equal((await store.get('two')).from, 'a')

  // and the successes: the next spot check picks copies not seen yet and records them ok
  const next = await store.sample(index, { max: 6 })
  assert.ok(next.every((x) => x.status === STATUS.OK))
})

test('check refreshes the ledger for every copy and keeps last_ok of a copy that went bad', async () => {
  const { store, dir } = await setup()
  await store.put('one', '1', { sample: false })
  await store.check()
  const before = (await store.mergedIndex()).health
  for (const key of ['_vault', '_index', 'one']) for (const b of ['a', 'b']) assert.equal(before[key][b].status, 'ok')
  const f = path.join(dir, 'a', 'ovk', 'notes', `${await c.blobIdForName(store.keys, 'one')}.ovk`)
  const blob = await readFile(f)
  blob[30] ^= 1
  await writeFile(f, blob)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await store.check()
  const after = (await store.mergedIndex()).health
  assert.equal(after.one.a.status, 'corrupt')
  assert.equal(after.one.a.last_ok, before.one.a.last_ok)
  assert.ok(after.one.a.last_checked > before.one.a.last_checked)
})

test('status: STALE CHECK, AT RISK, FLAKY and never-verified copies', () => {
  const now = new Date('2026-09-29T12:00:00.000Z')
  const ago = (d) => new Date(now - d * DAY).toISOString()
  const ok = (d) => ({ last_ok: ago(d), last_checked: ago(d), status: 'ok', expires: null })
  const index = {
    v: 1,
    notes: { safe: {}, risky: {} },
    health: {
      _vault: { mega: ok(1), pb: { ...ok(2), expires: '2026-12-01T00:00:00.000Z' }, relay: { last_checked: ago(1), status: 'error', expires: null } },
      _index: { mega: ok(1), pb: ok(40), relay: { last_checked: ago(1), status: 'error', expires: null } },
      safe: { mega: ok(1), pb: ok(3) },
      risky: { mega: ok(1), pb: { last_ok: ago(9), last_checked: ago(1), status: 'corrupt', expires: null } }
    }
  }
  const { backends, warnings } = ledgerStatus(index, ['mega', 'pb', 'relay'], now)
  assert.deepEqual(backends.map((b) => [b.backend, b.healthy, b.copies, b.unverified]), [['mega', 4, 4, 0], ['pb', 3, 4, 0], ['relay', 0, 4, 2]])
  assert.equal(backends[1].nextExpiry, '2026-12-01T00:00:00.000Z')
  assert.equal(backends[1].oldestOk, ago(40))
  assert.deepEqual(warnings, [
    'STALE CHECK: _index on pb last verified 40 days ago',
    'STALE CHECK: 2 of 4 copies on relay never verified',
    'FLAKY: relay failed to answer for 2 of 2 copies',
    'AT RISK: risky has 1 known-healthy copy'
  ])
  const calm = ledgerStatus({ v: 1, notes: {}, health: { _vault: { m: ok(1) }, _index: { m: ok(1) } } }, ['m'], now)
  assert.deepEqual(calm.warnings, [])
})

test('status Retention column: the kind of promise, plain dates', async () => {
  const { retention } = await import('../src/status.js')
  assert.equal(retention('privatebin', null), 'never (host-confirmed)')
  assert.equal(retention('privatebin', '2027-01-02T03:04:05.678Z'), 'expires 2027-01-02 (host-confirmed)')
  assert.equal(retention('nostr', '2027-01-28T10:00:00.000Z'), 'none promised; republish by 2027-01-28')
  assert.equal(retention('blossom', null), 'none promised')
  assert.equal(retention('cryptpad', null), 'while the account is active (instance policy)')
  for (const t of ['mega', 'proton-cli', 'filen', 'fileverse']) assert.equal(retention(t, null), 'while the account exists')
})
