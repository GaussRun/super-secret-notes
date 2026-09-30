import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import winston from 'winston'
import * as c from '../src/crypto.js'
import { createBackend } from '../src/backends/index.js'
import { Overkill, STATUS, summarize } from '../src/store.js'

const quiet = winston.createLogger({ silent: true })
const dec = (b) => new TextDecoder().decode(b)

async function setup () {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-it-'))
  const ctx = { root: 'overkill-test', home: dir }
  const backends = [
    createBackend({ name: 'usb-a', type: 'local', path: path.join(dir, 'a') }, ctx),
    createBackend({ name: 'usb-b', type: 'local', path: path.join(dir, 'b') }, ctx)
  ]
  const vault = await c.createVault()
  const vaultBytes = await c.encryptVault(vault, 'pw', { logN: 10 })
  const ok = new Overkill({ backends, keys: await c.unlockKeys(vault), vaultBytes, logger: quiet })
  await ok.uploadVault()
  return { ok, dir, vault, noteFile: async (base, name) => path.join(dir, base, 'overkill-test', 'notes', `${await c.blobIdForName(ok.keys, name)}.ovk`) }
}

test('put, get, ls across two local backends; layout matches the spec', async () => {
  const { ok, dir } = await setup()
  await ok.put('groceries', 'milk\neggs\n')
  await ok.put('secret plans', 'world domination, but cozy')
  assert.equal(dec((await ok.get('groceries')).bytes), 'milk\neggs\n')
  assert.deepEqual(Object.keys(await ok.list()).sort(), ['groceries', 'secret plans'])
  for (const side of ['a', 'b']) {
    const root = path.join(dir, side, 'overkill-test')
    assert.deepEqual((await readdir(root)).sort(), ['index.ovk', 'notes', 'vault.age'])
    const notes = await readdir(path.join(root, 'notes'))
    assert.equal(notes.length, 2)
    for (const n of notes) assert.match(n, /^[0-9a-f]{64}\.ovk$/)
    const blob = await readFile(path.join(root, 'index.ovk'))
    assert.equal(blob.subarray(0, 4).toString(), 'OVK1')
  }
  // overwrite keeps the name, bumps the content
  await ok.put('groceries', 'milk\neggs\ncoffee\n')
  assert.equal(dec((await ok.get('groceries')).bytes), 'milk\neggs\ncoffee\n')
  const { healthy, total } = summarize(await ok.check())
  assert.equal(`${healthy}/${total}`, '8/8')
})

test('corrupt one copy: check reports it, get falls back, repair heals it', async () => {
  const { ok, noteFile } = await setup()
  await ok.put('groceries', 'milk\neggs\n')
  const f = await noteFile('a', 'groceries')
  const blob = await readFile(f)
  blob[blob.length - 5] ^= 0xff
  await writeFile(f, blob)

  const report = await ok.check()
  const copies = report.notes.groceries
  assert.deepEqual(copies.map((x) => [x.backend, x.status]), [['usb-a', STATUS.CORRUPT], ['usb-b', STATUS.OK]])
  assert.equal(copies[0].detail, 'aes layer')
  const s = summarize(report)
  assert.equal(`${s.healthy}/${s.total}`, '5/6')
  assert.match(s.lines.find((l) => l.label === 'groceries').text, /usb-a CORRUPT \(aes layer\), usb-b OK \(1\/2 healthy\)/)

  const got = await ok.get('groceries')
  assert.equal(dec(got.bytes), 'milk\neggs\n')
  assert.equal(got.from, 'usb-b')
  assert.deepEqual(got.problems, [{ backend: 'usb-a', status: STATUS.CORRUPT, detail: 'aes layer' }])

  const { fixed, failed } = await ok.repair(report)
  assert.deepEqual(fixed, ['groceries on usb-a'])
  assert.deepEqual(failed, [])
  const after = summarize(await ok.check())
  assert.equal(`${after.healthy}/${after.total}`, '6/6')
  assert.equal((await ok.get('groceries')).from, 'usb-a')
})

test('missing copy, stale copy, missing index and vault are detected and repaired', async () => {
  const { ok, dir, noteFile } = await setup()
  await ok.put('todo', 'v1')
  const oldBlob = await readFile(await noteFile('b', 'todo'))
  await ok.put('todo', 'v2')
  await writeFile(await noteFile('b', 'todo'), oldBlob) // b now holds a valid but outdated copy
  const base = path.join(dir, 'a', 'overkill-test')
  // "delete" the note, index and vault on a by moving them aside
  const { rename } = await import('node:fs/promises')
  await rename(await noteFile('a', 'todo'), path.join(dir, 'moved-note'))
  await rename(path.join(base, 'index.ovk'), path.join(dir, 'moved-index'))
  await rename(path.join(base, 'vault.age'), path.join(dir, 'moved-vault'))

  const report = await ok.check()
  assert.deepEqual(report.notes.todo.map((x) => x.status), [STATUS.MISSING, STATUS.STALE])
  assert.deepEqual(report.index.map((x) => x.status), [STATUS.MISSING, STATUS.OK])
  assert.deepEqual(report.vault.map((x) => x.status), [STATUS.MISSING, STATUS.OK])
  await assert.rejects(ok.get('todo'), /no healthy copy of "todo" \(usb-a MISSING, usb-b STALE\)/)

  const { fixed } = await ok.repair(report)
  assert.deepEqual(fixed.sort(), ['index on usb-a', 'vault.age on usb-a'])
  // nothing healthy to copy the note from, so that one stays broken and says so
  const again = await ok.repair()
  assert.deepEqual(again.failed, ['todo on usb-a: no healthy copy anywhere', 'todo on usb-b: no healthy copy anywhere'])
  await rename(path.join(dir, 'moved-note'), await noteFile('a', 'todo'))
  await ok.repair()
  assert.equal(dec((await ok.get('todo')).bytes), 'v2')
  const s = summarize(await ok.check())
  assert.equal(`${s.healthy}/${s.total}`, '6/6')
})

test('index merge across backends that disagree', async () => {
  const { ok } = await setup()
  const [a, b] = ok.backends
  await ok.put('shared', 'both')
  // write a note only to a, as if b had been offline
  const onlyA = new Overkill({ backends: [a], keys: ok.keys, logger: quiet })
  await onlyA.put('only-on-a', 'hello')
  const onlyB = new Overkill({ backends: [b], keys: ok.keys, logger: quiet })
  await onlyB.put('only-on-b', 'world')
  assert.deepEqual(Object.keys(await ok.list()).sort(), ['only-on-a', 'only-on-b', 'shared'])
  const s = summarize(await ok.check())
  assert.equal(`${s.healthy}/${s.total}`, '6/10') // vault 2, index 0/2 (both stale), shared 2, only-on-a 1, only-on-b 1
  await ok.repair()
  const s2 = summarize(await ok.check())
  assert.equal(`${s2.healthy}/${s2.total}`, '10/10')
})

test('a blob swapped between names is rejected (AAD binds the blob id)', async () => {
  const { ok, noteFile } = await setup()
  await ok.put('one', '1')
  await ok.put('two', '2')
  await writeFile(await noteFile('a', 'one'), await readFile(await noteFile('a', 'two')))
  const got = await ok.get('one')
  assert.equal(dec(got.bytes), '1')
  assert.equal(got.from, 'usb-b')
  assert.equal(got.problems[0].status, STATUS.CORRUPT)
})

test('summarize: compact mode lists only the copies with problems', () => {
  const ok = (backend) => ({ backend, status: STATUS.OK, expires: null })
  const report = {
    vault: ['a', 'b', 'c'].map(ok),
    index: ['a', 'b', 'c'].map(ok),
    notes: { groceries: [ok('a'), { backend: 'b', status: STATUS.CORRUPT, detail: 'aes layer' }, ok('c')] }
  }
  const full = summarize(report)
  assert.equal(full.lines[2].text, 'a OK, b CORRUPT (aes layer), c OK (2/3 healthy)')
  const short = summarize(report, { compact: true })
  assert.equal(short.lines[0].text, 'all 3/3 healthy')
  assert.equal(short.lines[2].text, 'b CORRUPT (aes layer) (2/3 healthy, the rest OK)')
  assert.equal(`${short.healthy}/${short.total}`, '8/9')
})
