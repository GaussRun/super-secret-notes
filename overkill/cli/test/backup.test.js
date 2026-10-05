// The full backup file: every blob still encrypted, restore with no host reachable, then repair
// copies everything back to the hosts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBackup, openBackup, BACKUP_FORMAT } from '../src/backup.js'

const BIN = fileURLToPath(new URL('../bin/super-secret-notes.js', import.meta.url))
const PASS = 'correct horse battery staple'

function cli (env, args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1', OVERKILL_LOG: 'info', OVERKILL_DISCOVERY_RELAYS: '', ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

test('backup -o, then restore on a new machine with every host gone, read, and repair copies it back', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-backup-'))
  const cfgFile = path.join(dir, 'cfg.json')
  await writeFile(cfgFile, JSON.stringify({ name: 'backup vault', root: 'ovk', backends: [{ name: 'usb', type: 'local', path: path.join(dir, 'usb') }, { name: 'nas', type: 'local', path: path.join(dir, 'nas') }] }))
  const env = { OVERKILL_HOME: path.join(dir, 'home'), OVERKILL_PASSPHRASE: PASS }
  let r = await cli(env, ['init', '--from', cfgFile, '--scrypt-log-n', '12'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal((await cli(env, ['put', 'groceries'], 'oat milk\n')).code, 0)
  assert.equal((await cli(env, ['put', 'codes'], 'github: 1a2b\n')).code, 0)

  const file = path.join(dir, 'vault.backup.json')
  r = await cli(env, ['backup', '-o', file])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Backup written to .* \(2 notes\)/)
  const text = await readFile(file, 'utf8')
  // a documented container; nothing readable inside but the header and the vault name
  const doc = JSON.parse(text)
  assert.equal(doc.format, BACKUP_FORMAT)
  assert.equal(doc.v, 1)
  assert.equal(doc.vault_name, 'backup vault')
  assert.equal(Object.keys(doc.files).length, 4) // vault.age, index, 2 notes
  for (const secret of ['oat milk', 'github', 'groceries', 'codes', 'usb', 'nas']) assert.ok(!text.includes(secret), secret)
  assert.equal(Object.keys(parseBackup(text).files).length, 4)
  await assert.rejects(openBackup(text, 'not the passphrase'), /passphrase|decrypt|no identity/i)

  // every host gone (the folders moved away), a fresh machine
  await rename(path.join(dir, 'usb'), path.join(dir, 'usb-gone'))
  await rename(path.join(dir, 'nas'), path.join(dir, 'nas-gone'))
  const env2 = { OVERKILL_HOME: path.join(dir, 'home2'), OVERKILL_PASSPHRASE: PASS }
  r = await cli(env2, ['restore', file])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Restored "backup vault" with 2 notes/)
  r = await cli(env2, ['get', 'groceries'])
  assert.equal(r.stdout, 'oat milk\n')
  r = await cli(env2, ['get', 'codes'])
  assert.equal(r.stdout, 'github: 1a2b\n')

  // the hosts come back empty: repair fills them from the restored copy
  r = await cli(env2, ['repair'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal((await readFile(path.join(dir, 'usb', 'ovk', 'vault.age'))).length > 0, true)
  r = await cli(env2, ['check'])
  assert.match(r.stdout, /copies healthy/)
  assert.doesNotMatch(r.stdout, /MISSING/)
})
