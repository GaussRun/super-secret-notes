// `super-secret-notes recover --kit`: back from the printed sheet alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseKit } from '../src/kit.js'
import * as c from '../src/crypto.js'

const BIN = fileURLToPath(new URL('../bin/super-secret-notes.js', import.meta.url))
const OLD = 'smite idealism emphasis overeater canal fever'
const NEW = 'trowel strewn naturist cause flashback glider'

function cli (env, args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], {
      env: { ...process.env, NO_COLOR: '1', OVERKILL_LOG: 'info', OVERKILL_DISCOVERY_RELAYS: '', OVERKILL_PASSPHRASE_FILE: '', ...env }
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('recover --kit: the printed sheet plus a new passphrase brings the vault back', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-kit-'))
  await writeFile(path.join(dir, 'cfg.json'), JSON.stringify({ name: 'Oma', root: 'ovk', backends: [{ name: 'usb', type: 'local', path: path.join(dir, 'usb') }, { name: 'nas', type: 'local', path: path.join(dir, 'nas') }] }))
  const home = path.join(dir, 'home')
  let r = await cli({ OVERKILL_HOME: home, OVERKILL_PASSPHRASE: OLD }, ['init', '--from', path.join(dir, 'cfg.json'), '--scrypt-log-n', '10'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /run `super-secret-notes recover --kit <file>`/)
  const kit = r.stdout.slice(r.stdout.indexOf('+---'))
  await writeFile(path.join(dir, 'kit.txt'), kit)
  await cli({ OVERKILL_HOME: home, OVERKILL_PASSPHRASE: OLD }, ['put', 'groceries'], 'oat milk\n')

  // new laptop, passphrase forgotten, only the sheet
  const home2 = path.join(dir, 'home2')
  r = await cli({ OVERKILL_HOME: home2, OVERKILL_PASSPHRASE: 'correct horse battery staple' }, ['recover', '--kit', path.join(dir, 'kit.txt')])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /a new vault wants 77\+/) // the new passphrase must be strong too
  r = await cli({ OVERKILL_HOME: home2, OVERKILL_PASSPHRASE: NEW }, ['recover', '--kit', '-', '--scrypt-log-n', '10'], kit)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Restored "Oma" with 2 backends: usb, nas\./)
  assert.match(r.stdout, /still open with the OLD passphrase\. Run `super-secret-notes repair`/)
  r = await cli({ OVERKILL_HOME: home2, OVERKILL_PASSPHRASE: NEW }, ['get', 'groceries'])
  assert.equal(r.stdout, 'oat milk\n', r.stderr)

  r = await cli({ OVERKILL_HOME: home2, OVERKILL_PASSPHRASE: NEW }, ['check'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /vault\.age +usb CORRUPT \(differs from the local vault\.age\), nas CORRUPT/)
  await cli({ OVERKILL_HOME: home2, OVERKILL_PASSPHRASE: NEW }, ['repair'])
  r = await cli({ OVERKILL_HOME: home2, OVERKILL_PASSPHRASE: NEW }, ['check'])
  assert.equal(r.code, 0, r.stdout)
  // the copies out there now open with the new passphrase, and not with the old one
  const remote = new Uint8Array(await readFile(path.join(dir, 'usb', 'ovk', 'vault.age')))
  await c.decryptVault(remote, NEW)
  await assert.rejects(c.decryptVault(remote, OLD), c.WrongPassphraseError)
})

test('parseKit: login-free backends come back, the rest are named; framed or not', () => {
  const sheet = [
    '+------------------------------------------------------------------------',
    '| SUPER SECRET NOTES  -  RECOVERY KIT',
    '|   age identity: AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX',
    '|   master (b64): AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    '|',
    '|   vault name:   Einkaufsliste für Oma',
    '|   created:      2026-09-29T20:00:00.000Z',
    '|   root folder:  overkill',
    '|   backends:',
    '|     - pb-envs (privatebin) at https://pb.envs.net',
    '|     - cp-private (cryptpad) at https://cryptpad.private.coffee drive:/overkill',
    '|     - cryptpad-fr (cryptpad) at https://cryptpad.fr drive:/overkill',
    '|     - nostr-nos (nostr) at wss://nos.lol',
    '|     - blossom-ditto (blossom) at https://blossom.ditto.pub',
    '|     - mega (mega) at mega:/overkill',
    '|     - usb (local) at /Volumes/USB/overkill',
    '|',
    '|   CryptPad accounts this vault created:',
    '|     cp-private: ovk-0123456789abcdef (password derived from master)',
    '|',
    '|   index_sync: manual. The index (the list of your notes) lives on this',
    '|',
    '|   vault.age on paste backends (the #key part is a key, keep it secret):',
    '|     pb-envs:',
    '|       vault.age: https://pb.envs.net/?0123456789abcdef#key',
    '+------------------------------------------------------------------------'
  ].join('\n')
  for (const text of [sheet, sheet.replace(/^\| ?/gm, '')]) {
    const { vault, cfg, others } = parseKit(text)
    assert.equal(vault.master, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')
    assert.equal(vault.created, '2026-09-29T20:00:00.000Z')
    assert.equal(cfg.name, 'Einkaufsliste für Oma')
    assert.equal(cfg.index_sync, 'manual')
    assert.deepEqual(cfg.backends, [
      { name: 'pb-envs', type: 'privatebin', url: 'https://pb.envs.net', locators: { 'vault.age': 'https://pb.envs.net/?0123456789abcdef#key' } },
      { name: 'cp-private', type: 'cryptpad', origin: 'https://cryptpad.private.coffee', derived: true },
      { name: 'nostr-nos', type: 'nostr', url: 'wss://nos.lol' },
      { name: 'blossom-ditto', type: 'blossom', url: 'https://blossom.ditto.pub' },
      { name: 'usb', type: 'local', path: '/Volumes/USB' }
    ])
    assert.deepEqual(others, [{ name: 'cryptpad-fr', type: 'cryptpad' }, { name: 'mega', type: 'mega' }])
  }
  assert.throws(() => parseKit('just a grocery list'), /does not look like an Overkill recovery kit/)
})

test('parseKit: a kit printed by the old `overkill` command still parses', () => {
  const old = [
    '+------------------------------------------------------------------------',
    '| OVERKILL NOTES  -  RECOVERY KIT',
    '|',
    '| Option B: this sheet. The two lines below ARE your keys; save the sheet as a',
    '| text file and run `overkill recover --kit <file>`:',
    '|',
    '|   age identity: AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX',
    '|   master (b64): AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    '|',
    '|   vault name:   groceries',
    '|   created:      2026-09-29T20:00:00.000Z',
    '|   root folder:  overkill',
    '|   backends:',
    '|     - pb-envs (privatebin) at https://pb.envs.net',
    '|     - nostr-nos (nostr) at wss://nos.lol',
    '|',
    '|   vault.age on paste backends (the #key part is a key, keep it secret):',
    '|     pb-envs:',
    '|       vault.age: https://pb.envs.net/?0123456789abcdef#3xampleKey',
    '+------------------------------------------------------------------------'
  ].join('\n')
  const { vault, cfg } = parseKit(old)
  assert.equal(vault.master, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')
  assert.equal(cfg.name, 'groceries')
  assert.deepEqual(cfg.backends.map((b) => b.name), ['pb-envs', 'nostr-nos'])
  assert.equal(cfg.backends[0].locators['vault.age'], 'https://pb.envs.net/?0123456789abcdef#3xampleKey')
})

test('the kit prints the vault link: the recover page with only the vault name, no passphrase', async () => {
  const { recoveryKit, vaultLink } = await import('../src/kit.js')
  const vault = await (await import('../src/crypto.js')).createVault()
  const kit = await recoveryKit({ vault, cfg: { name: 'Oma Rezepte', backends: [] }, backends: [], generated: 'alpha beta gamma delta epsilon zeta' })
  assert.match(kit, /vault link: {3}https:\/\/gaussrun\.github\.io\/super-secret-notes\/recover\/#v=Oma%20Rezepte$/m)
  const line = /vault link: +(\S+)/.exec(kit)[1]
  assert.ok(!line.includes('p='))
  assert.ok(!line.includes('alpha'))
  assert.equal(vaultLink('x', 'http://127.0.0.1:1/'), 'http://127.0.0.1:1/recover/#v=x')
})
