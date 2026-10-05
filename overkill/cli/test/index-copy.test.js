// A copy of the encrypted index travels with the recovery record (docs/OVERKILL.md, format
// history 18): name + passphrase give keys, backends and the index in one hop, so notes on
// PrivateBin stay findable even when every index-holding host lost the index.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as c from '../src/crypto.js'
import { Overkill } from '../src/store.js'
import { startFakeRelay } from './fake-relay.js'
import { startFakePrivatebin } from './fake-hosts.js'

const BIN = fileURLToPath(new URL('../bin/super-secret-notes.js', import.meta.url))
const STRONG = 'smite idealism emphasis overeater canal fever'

function cli (env, args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1', OVERKILL_LOG: 'info', OVERKILL_DISCOVERY_RELAYS: '', OVERKILL_PASSPHRASE: '', OVERKILL_PASSPHRASE_FILE: '', ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

test('every index holder lost the index: recover by name still lists the notes and reads a PrivateBin-only note', async () => {
  const vaultRelay = await startFakeRelay() // the vault's only index holder
  const discovery = await startFakeRelay()
  const pb = await startFakePrivatebin()
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-index-copy-'))
    const defaults = JSON.stringify([
      { name: 'pb', type: 'privatebin', url: pb.url },
      { name: 'relay', type: 'nostr', url: vaultRelay.url }
    ])
    const env = { OVERKILL_DEFAULT_BACKENDS: defaults, OVERKILL_VAULT_NAME: 'Oma', OVERKILL_PASSPHRASE: STRONG, OVERKILL_DISCOVERY_RELAYS: discovery.url, OVERKILL_NOSTR_PAUSE_MS: '0' }
    const home = path.join(dir, 'home')
    let r = await cli({ ...env, OVERKILL_HOME: home }, ['put', 'groceries'], 'oat milk\n')
    assert.equal(r.code, 0, r.stderr)
    r = await cli({ ...env, OVERKILL_HOME: home }, ['put', 'todo'], 'nap\n')
    assert.equal(r.code, 0, r.stderr)

    // the relay that held the index (and the notes) forgets everything; only PrivateBin is left
    vaultRelay.store.clear()

    const home2 = path.join(dir, 'home2')
    r = await cli({ ...env, OVERKILL_HOME: home2 }, ['recover', '--name', 'Oma'])
    assert.equal(r.code, 0, r.stderr)
    r = await cli({ ...env, OVERKILL_HOME: home2 }, ['ls'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^groceries\t9 B\t.*\ntodo\t4 B\t/)
    r = await cli({ ...env, OVERKILL_HOME: home2 }, ['get', 'todo'])
    assert.equal(r.stdout, 'nap\n', r.stderr)
  } finally {
    await Promise.all([vaultRelay.close(), discovery.close(), pb.close()])
  }
})

test('the store hands index writes to the mirror and flushes it on close', async () => {
  const vault = await c.createVault()
  const keys = await c.unlockKeys(vault)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-mirror-'))
  const { createBackend } = await import('../src/backends/index.js')
  const backends = [createBackend({ name: 'a', type: 'local', path: path.join(dir, 'a') }, { root: 'ovk', home: dir })]
  const offered = []
  let flushed = 0
  const indexMirror = { offer: (index) => { offered.push(index) }, flush: async () => { flushed++ } }
  const store = new Overkill({ backends, keys, logger: { debug () {}, info () {}, warn () {} }, indexMirror })
  await store.writeIndex(c.emptyIndex())
  await store.put('x', 'y', { sample: false })
  assert.equal(offered.length, 2)
  assert.ok(offered[1].notes.x)
  await store.close()
  assert.equal(flushed, 1)
  // index_sync manual or never: the index stays on this device, and so does the mirror
  const local = new Overkill({ backends, keys, logger: { debug () {}, info () {}, warn () {} }, indexMirror, indexSync: 'manual', indexCache: { blob: null, write: async () => {}, read: async () => null } })
  await local.writeIndex(c.emptyIndex())
  assert.equal(offered.length, 2)
})

test('check and repair republish the recovery record when a discovery relay lost it', async () => {
  const discovery = await startFakeRelay()
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-check-record-'))
    const defaults = JSON.stringify([{ name: 'usb', type: 'local', path: path.join(dir, 'usb') }, { name: 'usb2', type: 'local', path: path.join(dir, 'usb2') }])
    const env = { OVERKILL_DEFAULT_BACKENDS: defaults, OVERKILL_VAULT_NAME: 'Oma', OVERKILL_PASSPHRASE: STRONG, OVERKILL_DISCOVERY_RELAYS: discovery.url, OVERKILL_NOSTR_PAUSE_MS: '0', OVERKILL_HOME: path.join(dir, 'home') }
    let r = await cli(env, ['put', 'groceries'], 'oat milk\n')
    assert.equal(r.code, 0, r.stderr)
    const { discoveryIdentity } = await import('../src/bootstrap.js')
    const tags = await c.deriveDiscoveryTags((await discoveryIdentity(STRONG, 'Oma')).secret)
    const has = () => [...discovery.store.values()].some((e) => e.tags[0][1] === tags['bootstrap.json'])
    for (const cmd of ['check', 'repair']) {
      discovery.store.clear()
      r = await cli(env, [cmd])
      assert.equal(r.code, 0, r.stderr)
      assert.ok(has(), `${cmd} put the record back`)
      assert.match(r.stdout, /recovery by name: bootstrap on 1\/1 relays/)
    }
    // with every relay holding a young record, check publishes nothing
    r = await cli(env, ['check'])
    assert.doesNotMatch(r.stdout, /recovery by name/)
  } finally {
    await discovery.close()
  }
})

test('the mirror: a change to the notes goes out at once, a ledger-only change waits for the interval or flush', async () => {
  const relay = await startFakeRelay()
  try {
    const { indexMirror, discoveryIdentity } = await import('../src/bootstrap.js')
    const nostr = await import('../src/backends/nostr.js')
    const keys = await c.unlockKeys(await c.createVault())
    const { secret } = await discoveryIdentity(STRONG, 'Oma')
    let derived = 0
    const m = indexMirror({ keys, relays: [relay.url], pause: 0, minIntervalMs: 60_000, secret: async () => { derived++; return secret } })
    const tags = await c.deriveDiscoveryTags(secret)
    const read = async () => {
      const b = nostr.create({ name: 'r', type: 'nostr', url: relay.url }, { root: 'x' }, { pause: 0, dTags: tags })
      b.unlock({ nostrSecret: secret })
      try { const blob = await b.get('index.ovk'); return blob && c.decryptIndex(keys, blob) } finally { await b.close() }
    }
    const one = { ...c.emptyIndex(), notes: { a: { id: '1', sha256: 'x', size: 1, updated: '2026-10-05T00:00:00.000Z' } } }
    await m.offer(one)
    assert.deepEqual(Object.keys((await read()).notes), ['a'])
    // the ledger alone changed: not sent yet
    assert.equal(m.offer({ ...one, health: { a: { r: { status: 'ok', last_checked: '2026-10-05T00:00:01.000Z' } } } }), undefined)
    assert.equal((await read()).health, undefined)
    // a new note: at once, carrying the ledger along
    const two = { ...one, notes: { ...one.notes, b: { id: '2', sha256: 'y', size: 1, updated: '2026-10-05T00:00:02.000Z' } }, health: { a: { r: { status: 'ok', last_checked: '2026-10-05T00:00:01.000Z' } } } }
    await m.offer(two)
    assert.deepEqual(Object.keys((await read()).notes), ['a', 'b'])
    // ledger-only again, then flush (close) sends it
    m.offer({ ...two, health: { b: { r: { status: 'ok', last_checked: '2026-10-05T00:00:03.000Z' } } } })
    await m.flush()
    assert.ok((await read()).health.b)
    assert.equal(derived, 1, 'the discovery key is derived once')
  } finally {
    await relay.close()
  }
})
