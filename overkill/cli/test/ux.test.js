// Fixes from the fresh-user acceptance run: --version, a quiet put, a clear error for a note
// that does not exist, one Nostr block in the kit, and derived CryptPad accounts in --advanced.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promptMany } from '../src/backends/cryptpad.js'
import { recoveryKit } from '../src/cli.js'

const BIN = fileURLToPath(new URL('../bin/super-secret-notes.js', import.meta.url))
const STRONG = 'smite idealism emphasis overeater canal fever'

function cli (env, args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], {
      env: { ...process.env, NO_COLOR: '1', OVERKILL_LOG: 'info', OVERKILL_DISCOVERY_RELAYS: '', OVERKILL_PASSPHRASE_FILE: '', OVERKILL_PASSPHRASE: STRONG, ...env }
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('--version prints the package version', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const flag of ['--version', '-V']) {
    const r = await cli({}, [flag])
    assert.equal(r.code, 0)
    assert.equal(r.stdout.trim(), version)
  }
})

test('put is quiet per backend; get of an unknown name says so in one line', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-ux-'))
  await writeFile(path.join(dir, 'cfg.json'), JSON.stringify({ root: 'ovk', backends: [{ name: 'usb', type: 'local', path: path.join(dir, 'usb') }, { name: 'nas', type: 'local', path: path.join(dir, 'nas') }] }))
  const env = { OVERKILL_HOME: path.join(dir, 'home') }
  assert.equal((await cli(env, ['init', '--from', path.join(dir, 'cfg.json'), '--scrypt-log-n', '10'])).code, 0)
  let r = await cli(env, ['put', 'groceries'], 'oat milk\n')
  assert.equal(r.code, 0, r.stderr)
  assert.doesNotMatch(r.stderr, /stored notes\//)
  assert.match(r.stdout, /groceries: 9 bytes, 2\/2 backends/)

  r = await cli(env, ['get', 'grocerys'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /no note called "grocerys"\. `super-secret-notes ls` lists your notes\./)
  assert.doesNotMatch(r.stderr, /MISSING|not in the index/)
})

test('kit: the Nostr key is listed once for all relays', async () => {
  const relay = (name) => ({ name, type: 'nostr', where: `wss://${name}.example`, kitLines: () => [`${name}: kind 30078 events by npub1abc, d tags "ovk/<path>" (for example "ovk/vault.age")`] })
  const kit = await recoveryKit({
    vault: { age_identity: 'AGE-SECRET-KEY-1X', master: 'bWFzdGVy', created: '2026-09-30T00:00:00.000Z' },
    cfg: { root: 'ovk' },
    backends: [relay('r1'), relay('r2'), relay('r3')]
  })
  assert.equal(kit.match(/kind 30078 events by npub1abc/g).length, 1)
  assert.match(kit, /on: r1, r2, r3/)
})

test('init --advanced, CryptPad: derived accounts by default, your own account on request', async () => {
  const derived = await promptMany(async () => '', async () => true, async () => '')
  assert.deepEqual(derived, [
    { name: 'cp-private', type: 'cryptpad', origin: 'https://cryptpad.private.coffee', derived: true },
    { name: 'cp-unredacted', type: 'cryptpad', origin: 'https://crypt.unredacted.org', derived: true }
  ])
  const answers = ['https://cryptpad.example', 'me']
  const own = await promptMany(async () => answers.shift() ?? '', async () => false, async () => 'env:CP_PASS')
  assert.deepEqual(own, [{ name: 'cryptpad', type: 'cryptpad', origin: 'https://cryptpad.example', user: 'me', password: { env: 'CP_PASS' } }])
})

test('the command is super-secret-notes: package bin, --help usage, --version', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(pkg.bin), ['super-secret-notes'])
  assert.equal(pkg.name, 'super-secret-notes')
  const help = await new Promise((resolve) => execFile(process.execPath, [BIN, '--help'], (err, stdout) => resolve({ err, stdout })))
  assert.match(help.stdout, /^Usage: super-secret-notes \[options\] \[command\]/)
  assert.doesNotMatch(help.stdout, /Usage: overkill/)
})
