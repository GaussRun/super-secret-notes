// Drives the real binary against two local-folder backends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/super-secret-notes.js', import.meta.url))

function cli (env, args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1', OVERKILL_LOG: 'info', ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

test('cli: init, put, get, ls, check, corrupt, fallback, repair, wrong passphrase, new device', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-cli-'))
  const cfgFile = path.join(dir, 'cfg.json')
  await writeFile(cfgFile, JSON.stringify({ root: 'ovk', backends: [{ name: 'usb', type: 'local', path: path.join(dir, 'usb') }, { name: 'nas', type: 'local', path: path.join(dir, 'nas') }] }))
  const env = { OVERKILL_HOME: path.join(dir, 'home'), OVERKILL_PASSPHRASE: 'correct horse battery staple' }

  let r = await cli(env, ['init', '--from', cfgFile, '--scrypt-log-n', '12'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stderr, /WEAK PASSPHRASE: about \d+ bits/) // init --from takes it, loudly
  assert.match(r.stdout, /RECOVERY KIT/)
  assert.match(r.stdout, /age identity: AGE-SECRET-KEY-1[0-9A-Z]{58}\n/)

  r = await cli(env, ['put', 'groceries'], 'oat milk\n')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /groceries: 9 bytes, 2\/2 backends \(usb OK, nas OK\)/)

  r = await cli(env, ['get', 'groceries'])
  assert.equal(r.stdout, 'oat milk\n')
  r = await cli(env, ['ls'])
  assert.match(r.stdout, /^groceries\t9 B\t\S+\t[0-9a-f]{64}\n$/)
  r = await cli(env, ['check'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /6\/6 copies healthy/)

  const id = r.stdout && (await cli(env, ['ls'])).stdout.trim().split('\t')[3]
  const f = path.join(dir, 'usb', 'ovk', 'notes', `${id}.ovk`)
  const blob = await readFile(f)
  blob[10] ^= 1
  await writeFile(f, blob)
  r = await cli(env, ['check'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /groceries +usb CORRUPT \(aes layer\), nas OK \(1\/2 healthy\)/)
  assert.match(r.stdout, /5\/6 copies healthy/)
  r = await cli(env, ['get', 'groceries'])
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'oat milk\n')
  assert.match(r.stderr, /usb: CORRUPT \(aes layer\), used nas instead/)
  r = await cli(env, ['repair'])
  assert.match(r.stdout, /repaired groceries on usb/)
  r = await cli(env, ['check'])
  assert.equal(r.code, 0)

  r = await cli({ ...env, OVERKILL_PASSPHRASE: 'nope' }, ['get', 'groceries'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /wrong passphrase/)
  assert.equal(r.stdout, '')

  const pwFile = path.join(dir, 'pw.txt')
  await writeFile(pwFile, 'correct horse battery staple\n', { mode: 0o600 })
  r = await cli({ ...env, OVERKILL_PASSPHRASE: '', OVERKILL_PASSPHRASE_FILE: pwFile }, ['get', 'groceries'])
  assert.equal(r.stdout, 'oat milk\n', r.stderr)

  // a new device: same config, empty home. vault.age comes from a backend.
  const env2 = { ...env, OVERKILL_HOME: path.join(dir, 'home2') }
  r = await cli(env2, ['init', '--from', cfgFile])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stderr, /found an existing vault.age on usb, joining it/)
  r = await cli(env2, ['get', 'groceries'])
  assert.equal(r.stdout, 'oat milk\n')
  // and with no local vault.age at all
  await rename(path.join(dir, 'home2', 'vault.age'), path.join(dir, 'vault-moved'))
  r = await cli(env2, ['get', 'groceries'])
  assert.equal(r.stdout, 'oat milk\n')
  assert.match(r.stderr, /no local vault.age, fetched it from usb/)
})
