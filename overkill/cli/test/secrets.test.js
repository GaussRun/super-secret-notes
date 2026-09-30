// secrets.ovk: no credential or session in plaintext under OVERKILL_HOME; migration of old
// plaintext configs and session files; recover --name brings the logins back.
// Runs the CLI in process, with a fake login backend ("fakemega") registered for the test.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as c from '../src/crypto.js'
import { BACKENDS } from '../src/backends/index.js'
import * as local from '../src/backends/local.js'
import { resolveSecret } from '../src/secrets.js'
import { buildCli } from '../src/cli.js'
import { startFakeRelay } from './fake-relay.js'
import http from 'node:http'

const STRONG = 'smite idealism emphasis overeater canal fever'
const EMAIL = 'oma-marker@example.com'
const PASSWORD = 'hunter2-MARKER-pw'
const SESSION = 'SESSION-MARKER-account-key'

// behaves like MEGA: logs in with email + password, then keeps a session with account keys
BACKENDS.fakemega = {
  info: { title: 'fake MEGA', blurb: '', signup: null },
  operator: () => 'fake MEGA',
  travelsWithSecrets: true,
  create (cfg, ctx) {
    const inner = local.create({ ...cfg, type: 'local' }, ctx)
    const login = async () => {
      if (ctx.secrets?.session(`${cfg.name}.fakemega`)) return
      assert.equal(resolveSecret(cfg.email, 'email', ctx.secrets, cfg.name, 'email'), EMAIL)
      assert.equal(resolveSecret(cfg.password, 'password', ctx.secrets, cfg.name, 'password'), PASSWORD)
      if (ctx.secrets?.unlocked) await ctx.secrets.setSession(`${cfg.name}.fakemega`, { sid: SESSION })
    }
    return { ...inner, type: 'fakemega', async put (p, b) { await login(); return inner.put(p, b) }, async get (p) { await login(); return inner.get(p) } }
  }
}

let relay
let pb
const pastes = new Map()
before(async () => {
  relay = await startFakeRelay()
  // a minimal PrivateBin: create, read, delete
  pb = http.createServer(async (req, res) => {
    const chunks = []
    for await (const ch of req) chunks.push(ch)
    const send = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) }
    if (req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.pasteid) { pastes.delete(body.pasteid); return send({ status: 0 }) }
      const id = c.toHex(c.randomBytes(8))
      pastes.set(id, body)
      return send({ status: 0, id, deletetoken: c.toHex(c.randomBytes(32)) })
    }
    const p = pastes.get(new URL(req.url, 'http://x').searchParams.get('pasteid'))
    send(p ? { status: 0, v: 2, adata: p.adata, ct: p.ct, meta: {} } : { status: 1, message: 'Paste does not exist' })
  })
  await new Promise((resolve) => pb.listen(0, '127.0.0.1', resolve))
})
after(() => { relay.close(); pb.close() })
const pbUrl = () => `http://127.0.0.1:${pb.address().port}`

async function run (env, args, input) {
  const saved = { ...process.env }
  Object.assign(process.env, { NO_COLOR: '1', OVERKILL_LOG: 'error', OVERKILL_PASSPHRASE: STRONG, OVERKILL_PASSPHRASE_FILE: '', OVERKILL_NOSTR_PAUSE_MS: '0', ...env })
  const write = process.stdout.write
  let out = ''
  process.stdout.write = (s) => { out += typeof s === 'string' ? s : new TextDecoder().decode(s); return true }
  if (input !== undefined) {
    const { Readable } = await import('node:stream')
    Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from(input)]), configurable: true })
  }
  try {
    await buildCli().parseAsync(['node', 'overkill', ...args])
    return out
  } finally {
    process.stdout.write = write
    process.env = saved
    process.exitCode = 0
  }
}

async function allFiles (dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await allFiles(p))
    else out.push(p)
  }
  return out
}

async function secretsOf (home) {
  const keys = await c.unlockKeys(await c.decryptVault(new Uint8Array(await readFile(path.join(home, 'vault.age'))), STRONG))
  return JSON.parse(new TextDecoder().decode(await c.decryptBlob(keys, 'secrets', new Uint8Array(await readFile(path.join(home, 'secrets.ovk'))))))
}

async function assertNoPlaintext (home, extra = []) {
  // paste keys (the #... part of a PrivateBin locator) and delete tokens count as secrets too
  const s = await secretsOf(home).catch(() => null)
  const pasteSecrets = []
  for (const st of Object.values(s?.locators ?? {})) {
    for (const v of Object.values(st.paths ?? {})) {
      if (v.url?.includes('#')) pasteSecrets.push(v.url.split('#')[1])
      if (v.deletetoken) pasteSecrets.push(v.deletetoken)
    }
    for (const v of Object.values(st.pastes ?? {})) pasteSecrets.push(v.token)
  }
  for (const f of await allFiles(home)) {
    const text = (await readFile(f)).toString('latin1')
    for (const marker of [EMAIL, PASSWORD, SESSION, ...pasteSecrets, ...extra]) assert.ok(!text.includes(marker), `${marker} in plaintext in ${f}`)
  }
  return pasteSecrets.length
}

async function setup (name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `overkill-secrets-${name}-`))
  const cfg = {
    name,
    root: 'ovk',
    backends: [
      { name: 'relay', type: 'nostr', url: relay.url },
      { name: 'mega', type: 'fakemega', path: path.join(dir, 'mega'), email: EMAIL, password: PASSWORD },
      { name: 'pb', type: 'privatebin', url: pbUrl() }
    ]
  }
  await writeFile(path.join(dir, 'cfg.json'), JSON.stringify(cfg))
  return { dir, home: path.join(dir, 'home'), cfg }
}

test('init with a login backend: credentials and session only in secrets.ovk', async () => {
  const { dir, home } = await setup('Oma1')
  const env = { OVERKILL_HOME: home, OVERKILL_DISCOVERY_RELAYS: relay.url }
  await run(env, ['init', '--from', path.join(dir, 'cfg.json'), '--scrypt-log-n', '10'])
  await run(env, ['put', 'groceries'], 'oat milk\n')
  const cfg = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'))
  assert.deepEqual(cfg.backends[1].email, { stored: true })
  assert.deepEqual(cfg.backends[1].password, { stored: true })
  assert.ok(await assertNoPlaintext(home) >= 3, 'the PrivateBin locators should be in secrets.ovk') // vault + note: keys and tokens
  const keys = await c.unlockKeys(await c.decryptVault(new Uint8Array(await readFile(path.join(home, 'vault.age'))), STRONG))
  const secrets = JSON.parse(new TextDecoder().decode(await c.decryptBlob(keys, 'secrets', new Uint8Array(await readFile(path.join(home, 'secrets.ovk'))))))
  assert.deepEqual(secrets.creds.mega, { email: EMAIL, password: PASSWORD })
  assert.deepEqual(secrets.sessions['mega.fakemega'], { sid: SESSION })
  assert.equal(await run(env, ['get', 'groceries']), 'oat milk\n')
})

test('migration: an old plaintext config.json and session file move into secrets.ovk', async () => {
  const { dir, home } = await setup('Oma2')
  const env = { OVERKILL_HOME: home, OVERKILL_DISCOVERY_RELAYS: '' }
  await run(env, ['init', '--from', path.join(dir, 'cfg.json'), '--scrypt-log-n', '10'])
  // turn it back into what older versions wrote: plaintext credentials and a session file
  const cfgFile = path.join(home, 'config.json')
  const cfg = JSON.parse(await readFile(cfgFile, 'utf8'))
  Object.assign(cfg.backends[1], { email: EMAIL, password: PASSWORD })
  await writeFile(cfgFile, JSON.stringify(cfg))
  await mkdir(path.join(home, 'sessions'), { recursive: true })
  await writeFile(path.join(home, 'sessions', 'old.mega.json'), JSON.stringify({ sid: SESSION }))

  await run(env, ['ls'])
  await assertNoPlaintext(home)
  const stub = JSON.parse(await readFile(path.join(home, 'sessions', 'old.mega.json'), 'utf8'))
  assert.equal(stub.moved_to, 'secrets.ovk')
  assert.deepEqual(JSON.parse(await readFile(cfgFile, 'utf8')).backends[1].password, { stored: true })
  const keys = await c.unlockKeys(await c.decryptVault(new Uint8Array(await readFile(path.join(home, 'vault.age'))), STRONG))
  const secrets = JSON.parse(new TextDecoder().decode(await c.decryptBlob(keys, 'secrets', new Uint8Array(await readFile(path.join(home, 'secrets.ovk'))))))
  assert.deepEqual(secrets.sessions['old.mega'], { sid: SESSION })
  await run(env, ['put', 'still-works'], 'x')
  assert.equal(await run(env, ['get', 'still-works']), 'x')
})

test('recover --name brings the logins back (secrets.ovk travels in the bootstrap record)', async () => {
  const { dir, home } = await setup('Oma3')
  const env = { OVERKILL_HOME: home, OVERKILL_DISCOVERY_RELAYS: relay.url }
  await run(env, ['init', '--from', path.join(dir, 'cfg.json'), '--scrypt-log-n', '10'])
  await run(env, ['put', 'groceries'], 'oat milk\n')

  const home2 = path.join(dir, 'home2')
  const env2 = { OVERKILL_HOME: home2, OVERKILL_DISCOVERY_RELAYS: relay.url }
  const out = await run(env2, ['recover', '--name', 'Oma3'])
  assert.match(out, /This machine now knows 3 backends: relay, mega, pb\./)
  await assertNoPlaintext(home2)
  const cfg = JSON.parse(await readFile(path.join(home2, 'config.json'), 'utf8'))
  assert.deepEqual(cfg.backends[1].password, { stored: true })
  // the fake MEGA login only works with the right credentials, which now come from secrets.ovk
  const via = JSON.parse(JSON.stringify(cfg))
  via.backends = [cfg.backends[1]]
  await writeFile(path.join(home2, 'config.json'), JSON.stringify(via))
  assert.equal(await run(env2, ['get', 'groceries']), 'oat milk\n')
})

test('migration: old plaintext locator files (paste keys, delete tokens) move into secrets.ovk', async () => {
  const { dir, home } = await setup('Oma4')
  const env = { OVERKILL_HOME: home, OVERKILL_DISCOVERY_RELAYS: '' }
  await run(env, ['init', '--from', path.join(dir, 'cfg.json'), '--scrypt-log-n', '10'])
  await run(env, ['put', 'groceries'], 'oat milk\n')
  const before = await secretsOf(home)
  // write what older versions kept in plaintext, then drop it from the store
  await mkdir(path.join(home, 'locators'), { recursive: true })
  await writeFile(path.join(home, 'locators', 'pb.json'), JSON.stringify(before.locators.pb.paths))
  await writeFile(path.join(home, 'locators', 'pb.pastes.json'), JSON.stringify(before.locators.pb.pastes))
  const keys = await c.unlockKeys(await c.decryptVault(new Uint8Array(await readFile(path.join(home, 'vault.age'))), STRONG))
  const trimmed = { ...before, locators: {} }
  await writeFile(path.join(home, 'secrets.ovk'), await c.encryptBlob(keys, 'secrets', JSON.stringify(trimmed)))

  assert.equal(await run(env, ['get', 'groceries']), 'oat milk\n')
  const stub = JSON.parse(await readFile(path.join(home, 'locators', 'pb.json'), 'utf8'))
  assert.equal(stub.moved_to, 'secrets.ovk')
  const after = await secretsOf(home)
  assert.deepEqual(after.locators.pb.paths, before.locators.pb.paths)
  assert.deepEqual(after.locators.pb.pastes, before.locators.pb.pastes)
  assert.ok(await assertNoPlaintext(home) >= 3)
})

test('secrets.ovk: concurrent saves (parallel paste uploads) leave a file that opens, with the last data', async () => {
  const { SecretStore } = await import('../src/vaultsecrets.js')
  const home = await mkdtemp(path.join(os.tmpdir(), 'ssn-secrets-race-'))
  const keys = await c.unlockKeys(await c.createVault())
  const store = await new SecretStore(home).unlock(keys)
  for (let round = 0; round < 10; round++) {
    await Promise.all([0, 1, 2].map(async (i) => {
      store.data.locators[`b${i}`] = { paths: { [`p${round}`]: { url: 'x'.repeat(40 * (i + 1) * (round + 1)) } } }
      await store.save()
    }))
    const back = await new SecretStore(home).unlock(keys)
    assert.deepEqual(back.data.locators, store.data.locators)
  }
})
