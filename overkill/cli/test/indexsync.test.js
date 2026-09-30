// index_sync always / manual / never, `sync`, `config set`, `index export`, and the rule that
// paste-like backends never hold the index.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, access, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as c from '../src/crypto.js'
import { startFakeRelay } from './fake-relay.js'

const BIN = fileURLToPath(new URL('../bin/super-secret-notes.js', import.meta.url))
const STRONG = 'smite idealism emphasis overeater canal fever'
const exists = (p) => access(p).then(() => true, () => false)

function cli (env, args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], {
      env: { ...process.env, NO_COLOR: '1', OVERKILL_LOG: 'info', OVERKILL_DISCOVERY_RELAYS: '', OVERKILL_PASSPHRASE_FILE: '', OVERKILL_PASSPHRASE: STRONG, ...env }
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
    child.stdin.end(input)
  })
}

async function vaultDir (mode, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `overkill-sync-${mode}-`))
  const cfg = { name: `sync-${mode}`, root: 'ovk', ...(mode ? { index_sync: mode } : {}), backends: [{ name: 'usb', type: 'local', path: path.join(dir, 'usb') }, { name: 'nas', type: 'local', path: path.join(dir, 'nas') }], ...extra }
  await writeFile(path.join(dir, 'cfg.json'), JSON.stringify(cfg))
  const usb = cfg.backends.find((b) => b.name === 'usb')
  return { dir, env: { OVERKILL_HOME: path.join(dir, 'home') }, remoteIndex: usb ? path.join(usb.path, 'ovk', 'index.ovk') : null }
}

test('manual: the index stays local until `sync`; check and status say so; recovery warns', async () => {
  const relay = await startFakeRelay()
  try {
    // a relay backend (portable, holds the index) next to a folder, like a zero-signup vault
    const { dir, env: e, remoteIndex } = await vaultDir('manual', {
      backends: [{ name: 'relay', type: 'nostr', url: relay.url }, { name: 'usb', type: 'local', path: path.join(os.tmpdir(), `overkill-sync-usb-${process.pid}-${Date.now()}`) }]
    })
    const env = { ...e, OVERKILL_DISCOVERY_RELAYS: relay.url, OVERKILL_NOSTR_PAUSE_MS: '0' }
    let r = await cli(env, ['init', '--from', path.join(dir, 'cfg.json'), '--scrypt-log-n', '10'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /index_sync: manual\. The index \(the list of your notes\) lives on this/)
    r = await cli(env, ['put', 'groceries'], 'oat milk\n')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(await exists(remoteIndex), false)
    assert.equal((await cli(env, ['get', 'groceries'])).stdout, 'oat milk\n')

    r = await cli(env, ['check'])
    assert.equal(r.code, 0, r.stdout)
    assert.doesNotMatch(r.stdout, /^index /m)
    assert.match(r.stdout, /index: local only \(index_sync manual; last synced never\)/)
    assert.match(r.stdout, /4\/4 copies healthy/) // vault.age x2, groceries x2; no remote index expected
    r = await cli(env, ['status'])
    assert.match(r.stdout, /usb +2\/2/)
    assert.match(r.stdout, /index: local only \(index_sync manual; last synced never\)/)

    r = await cli(env, ['sync'])
    assert.match(r.stdout, /relay: index synced/)
    assert.match(r.stdout, /usb: index synced/)
    assert.equal(await exists(remoteIndex), true)
    assert.match((await cli(env, ['check'])).stdout, /last synced \d{4}-\d\d-\d\dT[^ ]+ \(\d+ min ago\)/)
    // a note written after the sync is not in the remote index
    await cli(env, ['put', 'after-sync'], 'late\n')
    const remote = await c.decryptIndex(await keysOf(env), new Uint8Array(await readFile(remoteIndex)))
    assert.deepEqual(Object.keys(remote.notes), ['groceries'])

    // recover by name: the index as of the last sync, with a warning; exact names still work
    const env2 = { ...env, OVERKILL_HOME: path.join(dir, 'home2') }
    r = await cli(env2, ['recover', '--name', 'sync-manual'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /keeps its index locally \(index_sync manual\): what came back is the index as of its last sync/)
    assert.match((await cli(env2, ['ls'])).stdout, /^groceries\t/)
    assert.doesNotMatch((await cli(env2, ['ls'])).stdout, /after-sync/)
    r = await cli(env2, ['get', 'after-sync'])
    assert.equal(r.stdout, 'late\n')
    assert.match(r.stderr, /"after-sync" is not in the index \(written after the last index sync\?\); read it by name, its sha256 cannot be checked/)
  } finally {
    relay.close()
  }
})

async function keysOf (env) {
  const home = env.OVERKILL_HOME
  return c.unlockKeys(await c.decryptVault(new Uint8Array(await readFile(path.join(home, 'vault.age'))), STRONG))
}

test('never: sync refuses without --force; config set switches modes', async () => {
  const { dir, env, remoteIndex } = await vaultDir('never')
  assert.equal((await cli(env, ['init', '--from', path.join(dir, 'cfg.json'), '--scrypt-log-n', '10'])).code, 0)
  await cli(env, ['put', 'x'], 'x')
  let r = await cli(env, ['sync'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /index_sync is "never"; use --force/)
  assert.equal(await exists(remoteIndex), false)
  r = await cli(env, ['sync', '--force'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(await exists(remoteIndex), true)

  r = await cli(env, ['config', 'set', 'index_sync', 'sometimes'])
  assert.equal(r.code, 1)
  r = await cli(env, ['config', 'set', 'index_sync', 'always'])
  assert.match(r.stdout, /index_sync: never -> always/)
  await cli(env, ['put', 'y'], 'y')
  const remote = await c.decryptIndex(await keysOf(env), new Uint8Array(await readFile(remoteIndex)))
  assert.deepEqual(Object.keys(remote.notes).sort(), ['x', 'y'])
  assert.match((await cli(env, ['check'])).stdout, /^index +usb OK, nas OK \(2\/2 healthy\)/m)
})

test('always is the default; --index-sync on init; invalid modes and paste-only vaults are refused', async () => {
  const a = await vaultDir(undefined)
  assert.equal((await cli(a.env, ['init', '--from', path.join(a.dir, 'cfg.json'), '--scrypt-log-n', '10'])).code, 0)
  await cli(a.env, ['put', 'x'], 'x')
  assert.equal(await exists(a.remoteIndex), true)

  const m = await vaultDir(undefined)
  assert.equal((await cli(m.env, ['init', '--from', path.join(m.dir, 'cfg.json'), '--index-sync', 'manual', '--scrypt-log-n', '10'])).code, 0)
  await cli(m.env, ['put', 'x'], 'x')
  assert.equal(await exists(m.remoteIndex), false)
  assert.equal(JSON.parse(await readFile(path.join(m.dir, 'home', 'config.json'), 'utf8')).index_sync, 'manual')

  const bad = await vaultDir('sometimes')
  let r = await cli(bad.env, ['init', '--from', path.join(bad.dir, 'cfg.json')])
  assert.match(r.stderr, /index_sync must be one of always, manual, never/)

  const paste = await vaultDir(undefined, { backends: [{ name: 'pb', type: 'privatebin', url: 'http://127.0.0.1:9' }] })
  r = await cli(paste.env, ['init', '--from', path.join(paste.dir, 'cfg.json')])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /none of these backends can hold the index/)
})

test('index export: encrypted by default, plaintext only with a confirmation', async () => {
  const { dir, env } = await vaultDir(undefined)
  await cli(env, ['init', '--from', path.join(dir, 'cfg.json'), '--scrypt-log-n', '10'])
  await cli(env, ['put', 'geheim'], 'x')
  const out = path.join(dir, 'index-export.ovk')
  let r = await cli(env, ['index', 'export', '-o', out])
  assert.equal(r.code, 0, r.stderr)
  const blob = new Uint8Array(await readFile(out))
  assert.equal(new TextDecoder().decode(blob.subarray(0, 4)), 'OVK1')
  assert.deepEqual(Object.keys((await c.decryptIndex(await keysOf(env), blob)).notes), ['geheim'])
  assert.doesNotMatch(Buffer.from(blob).toString('latin1'), /geheim/)

  r = await cli(env, ['index', 'export', '--plaintext'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /needs --yes-reveal-note-names/)
  assert.equal(r.stdout, '')
  r = await cli(env, ['index', 'export', '--plaintext', '--yes-reveal-note-names'])
  assert.equal(r.code, 0)
  assert.deepEqual(Object.keys(JSON.parse(r.stdout).notes), ['geheim'])
  assert.match(r.stderr, /plaintext index: note names and paste\/Blossom locators/)
})
