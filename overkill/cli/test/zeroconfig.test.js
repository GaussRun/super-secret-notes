// `super-secret-notes put` on a machine with no vault: zero-config init on the default backends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, access, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultBackends, validVaultName } from '../src/defaults.js'

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

test('defaults: 3 PrivateBin, 2 CryptPad with derived accounts, 4 Nostr relays, 3 Blossom servers', () => {
  const d = defaultBackends({ cryptpad: true })
  assert.ok(!defaultBackends({ cryptpad: false }).some((b) => b.type === 'cryptpad'))
  assert.deepEqual(d.map((b) => b.name), ['pb-envs', 'pb-systemli', 'pb-extrait', 'cp-private', 'cp-unredacted',
    'nostr-nos', 'nostr-mom', 'nostr-purplerelay', 'nostr-oxtr', 'blossom-nostr', 'blossom-ditto', 'blossom-hzrd149'])
  assert.deepEqual(d.filter((b) => b.type === 'blossom').map((b) => b.url), ['https://nostr.download', 'https://blossom.ditto.pub', 'https://cdn.hzrd149.com'])
  assert.deepEqual(d.filter((b) => b.type === 'nostr').map((b) => b.url), ['wss://nos.lol', 'wss://nostr.mom', 'wss://purplerelay.com', 'wss://nostr.oxtr.dev'])
  assert.deepEqual(d.filter((b) => b.type === 'cryptpad').map((b) => [b.origin, b.derived]),
    [['https://cryptpad.private.coffee', true], ['https://crypt.unredacted.org', true]])
  assert.ok(validVaultName('Oma\'s Rezepte'.replace("'", '')))
  assert.ok(!validVaultName('../etc'))
  assert.ok(!validVaultName(''))
})

test('put with no vault: refuses a weak preset passphrase, then sets everything up with a strong one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-zero-'))
  const defaults = JSON.stringify([
    { name: 'usb', type: 'local', path: path.join(dir, 'usb') },
    { name: 'nas', type: 'local', path: path.join(dir, 'nas') }
  ])
  const env = { OVERKILL_HOME: path.join(dir, 'home'), OVERKILL_DEFAULT_BACKENDS: defaults, OVERKILL_VAULT_NAME: 'Einkauf' }

  let r = await cli({ ...env, OVERKILL_PASSPHRASE: 'correct horse battery staple' }, ['put', 'groceries'], 'oat milk\n')
  assert.equal(r.code, 1)
  assert.match(r.stderr, /a new vault wants 77\+/)
  await assert.rejects(access(path.join(dir, 'home', 'config.json')))

  r = await cli({ ...env, OVERKILL_PASSPHRASE: STRONG }, ['put', 'groceries'], 'oat milk\n')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /No vault here yet/)
  assert.match(r.stdout, /Copies go to: usb, nas/)
  assert.match(r.stdout, /RECOVERY KIT/)
  assert.match(r.stdout, /vault name: {3}Einkauf/)
  assert.doesNotMatch(r.stdout, /passphrase: {3}/) // not generated here, so not printed
  assert.match(r.stdout, /groceries: 9 bytes, 2\/2 backends \(usb OK, nas OK\)/)
  const cfg = JSON.parse(await readFile(path.join(dir, 'home', 'config.json'), 'utf8'))
  assert.equal(cfg.name, 'Einkauf')

  // the second put just puts, then spot-checks 3 other copies
  r = await cli({ ...env, OVERKILL_PASSPHRASE: STRONG }, ['put', 'todo'], 'nap\n')
  assert.doesNotMatch(r.stdout, /No vault here yet/)
  assert.match(r.stdout, /spot check: (\S+ on (usb|nas)(, )?){3} OK/)

  r = await cli({ ...env, OVERKILL_PASSPHRASE: STRONG }, ['status'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /STALE CHECK: \d of 4 copies on (usb|nas) never verified/)
  r = await cli({ ...env, OVERKILL_PASSPHRASE: STRONG }, ['check'])
  assert.equal(r.code, 0, r.stderr)
  r = await cli({ ...env, OVERKILL_PASSPHRASE: STRONG }, ['status'])
  assert.match(r.stdout, /usb +4\/4 +\d+ min ago +while the folder exists/)
  assert.match(r.stdout, /nas +4\/4/)
  assert.match(r.stdout, /No warnings/)
  r = await cli({ ...env, OVERKILL_PASSPHRASE: STRONG }, ['get', 'groceries'])
  assert.equal(r.stdout, 'oat milk\n')
})

test('recover --name: publish on first put, then a fresh home reads the note with name + passphrase only', async () => {
  const { startFakeRelay } = await import('./fake-relay.js')
  const relay = await startFakeRelay()
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-recover-'))
    const defaults = JSON.stringify([
      { name: 'relay', type: 'nostr', url: relay.url },
      { name: 'usb', type: 'local', path: path.join(dir, 'usb') }
    ])
    const env = { OVERKILL_DEFAULT_BACKENDS: defaults, OVERKILL_VAULT_NAME: 'Oma', OVERKILL_PASSPHRASE: STRONG, OVERKILL_DISCOVERY_RELAYS: relay.url, OVERKILL_NOSTR_PAUSE_MS: '0' }
    const home = path.join(dir, 'home')
    let r = await cli({ ...env, OVERKILL_HOME: home }, ['put', 'groceries'], 'oat milk\n')
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /groceries: 9 bytes, 2\/2 backends \(relay OK, usb OK\)/)
    assert.match(r.stdout, /recovery by name: bootstrap on 1\/1 relays/)
    // unchanged backends: the next put does not publish the bootstrap again
    r = await cli({ ...env, OVERKILL_HOME: home }, ['put', 'todo'], 'nap\n')
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /recovery by name/)

    const home2 = path.join(dir, 'home2')
    r = await cli({ ...env, OVERKILL_HOME: home2, OVERKILL_PASSPHRASE: 'smite idealism emphasis overeater canal flavor' }, ['recover', '--name', 'Oma'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /no bootstrap for this vault name and passphrase/)
    r = await cli({ ...env, OVERKILL_HOME: home2 }, ['recover', '--name', 'oma'])
    assert.equal(r.code, 1) // the name is part of the key
    await assert.rejects(access(path.join(home2, 'config.json')))

    r = await cli({ ...env, OVERKILL_HOME: home2 }, ['recover', '--name', 'Oma'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Found "Oma" on ws:\/\/127\.0\.0\.1:\d+\. This machine now knows 1 backends: relay\./)
    assert.match(r.stdout, /Not restored .*usb \(local\)/)
    r = await cli({ ...env, OVERKILL_HOME: home2 }, ['get', 'groceries'])
    assert.equal(r.stdout, 'oat milk\n', r.stderr)
    r = await cli({ ...env, OVERKILL_HOME: home2 }, ['ls'])
    assert.match(r.stdout, /^groceries\t9 B\t.*\ntodo\t4 B\t/)
  } finally {
    relay.close()
  }
})

test('recover: a vault whose backends all need their own logins says so', async () => {
  const { startFakeRelay } = await import('./fake-relay.js')
  const relay = await startFakeRelay()
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-recover-local-'))
    const env = { OVERKILL_DEFAULT_BACKENDS: JSON.stringify([{ name: 'usb', type: 'local', path: path.join(dir, 'usb') }]), OVERKILL_VAULT_NAME: 'Opa', OVERKILL_PASSPHRASE: STRONG, OVERKILL_DISCOVERY_RELAYS: relay.url, OVERKILL_NOSTR_PAUSE_MS: '0' }
    let r = await cli({ ...env, OVERKILL_HOME: path.join(dir, 'home') }, ['put', 'x'], 'x')
    assert.equal(r.code, 0, r.stderr)
    r = await cli({ ...env, OVERKILL_HOME: path.join(dir, 'home2') }, ['recover', '--name', 'Opa'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /found the vault on ws:.*none of its backends works without its own login \(usb \(local\)\)/)
  } finally {
    relay.close()
  }
})

test('recover: portable backends come back, others are named, a wrong passphrase writes nothing', async () => {
  const { recover } = await import('../src/recover.js')
  const c = await import('../src/crypto.js')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-recover-hook-'))
  const vault = await c.createVault()
  const vaultBytes = await c.encryptVault(vault, STRONG, { logN: 10 })
  const cfg = { v: 1, name: 'Einkaufsliste für Oma', root: 'overkill', backends: [{ name: 'pb-envs', type: 'privatebin', url: 'https://pb.envs.net', locators: { 'vault.age': 'https://pb.envs.net/?x#y' } }] }
  let asked
  const fetchVault = async (q) => { asked = q; return { vaultBytes, cfg, others: [{ name: 'mega', type: 'mega' }], from: 'wss://relay.example' } }
  await assert.rejects(recover({ name: 'x', passphrase: 'wrong', home: path.join(dir, 'x'), fetchVault }), c.WrongPassphraseError)
  await assert.rejects(access(path.join(dir, 'x', 'config.json')))
  const got = await recover({ name: 'Einkaufsliste für Oma', passphrase: STRONG, home: path.join(dir, 'home'), fetchVault })
  assert.equal(asked.name, 'Einkaufsliste für Oma') // NFC before it salts the discovery key
  assert.deepEqual(got.others, [{ name: 'mega', type: 'mega' }])
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'home', 'config.json'), 'utf8')), cfg)
  assert.deepEqual(new Uint8Array(await readFile(path.join(dir, 'home', 'vault.age'))), vaultBytes)
})

test('bootstrap record: login-free backends travel (paste-like ones with their vault.age locator), others are only named', async () => {
  const { bootstrapRecord } = await import('../src/discovery.js')
  const c = await import('../src/crypto.js')
  const keys = await c.unlockKeys(await c.createVault())
  const cfg = {
    v: 1,
    name: 'Oma',
    root: 'overkill',
    backends: [
      { name: 'pb-envs', type: 'privatebin', url: 'https://pb.envs.net' },
      { name: 'blossom-ditto', type: 'blossom', url: 'https://blossom.ditto.pub' },
      { name: 'cp-private', type: 'cryptpad', origin: 'https://cryptpad.private.coffee', derived: true },
      { name: 'cryptpad-fr', type: 'cryptpad', origin: 'https://cryptpad.fr', user: 'me', password: { env: 'X' } },
      { name: 'nostr-nos', type: 'nostr', url: 'wss://nos.lol' },
      { name: 'mega', type: 'mega', email: 'a@example.com', password: 'secret' }
    ]
  }
  const adapters = [
    { name: 'pb-envs', getLocators: async () => ({ 'vault.age': 'https://pb.envs.net/?a#k', 'index.ovk': 'https://pb.envs.net/?b#k' }) },
    { name: 'blossom-ditto', getLocators: async () => ({ 'vault.age': 'https://blossom.ditto.pub/abc' }) }
  ]
  const rec = await bootstrapRecord(cfg, adapters, keys)
  const creds = await c.deriveCryptpadCredentials(keys.master, 'cryptpad.private.coffee')
  assert.deepEqual(rec.backends, [
    { name: 'pb-envs', type: 'privatebin', url: 'https://pb.envs.net', locators: { 'vault.age': 'https://pb.envs.net/?a#k' } },
    { name: 'blossom-ditto', type: 'blossom', url: 'https://blossom.ditto.pub', locators: { 'vault.age': 'https://blossom.ditto.pub/abc' } },
    { name: 'cp-private', type: 'cryptpad', origin: 'https://cryptpad.private.coffee', derived: true },
    { name: 'nostr-nos', type: 'nostr', url: 'wss://nos.lol' }
  ])
  assert.deepEqual(rec.others, [{ name: 'cryptpad-fr', type: 'cryptpad' }, { name: 'mega', type: 'mega' }])
  assert.deepEqual(rec.cryptpad, [{ instance: 'https://cryptpad.private.coffee', username: creds.username }])
  assert.doesNotMatch(JSON.stringify(rec), /secret|a@example\.com|index\.ovk/) // no logins, no ever-changing index locator
  assert.match(rec.main_npub, /^npub1/)
})
