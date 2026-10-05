// The recovery record under per-vault d tags (docs/OVERKILL.md, format history 17): nobody can
// list every vault's record by asking relays for one well-known d tag, old records still
// recover (and move to the new tags), and refresh fills in discovery relays that lost it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import nodeCrypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import * as c from '../src/crypto.js'
import { publishBootstrap, fetchBootstrap, DISCOVERY_ROOT, DISCOVERY_RELAYS } from '../src/bootstrap.js'
import { publishDue, DISCOVERY_TAGS_VERSION } from '../src/discovery-core.js'
import * as nostr from '../src/backends/nostr.js'
import { startFakeRelay } from './fake-relay.js'

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const fast = { pause: 0 }
const LEGACY = [`${DISCOVERY_ROOT}/vault.age`, `${DISCOVERY_ROOT}/bootstrap.json`]
let relays
before(async () => { relays = await Promise.all([startFakeRelay(), startFakeRelay(), startFakeRelay()]) })
after(() => Promise.all(relays.map((r) => r.close())))

const x = V.discovery.cases[0]
const secret = c.fromHex(x.secret_hex)
const vaultAge = c.toBytes('age-encryption.org/v1 pretend vault')
const record = { v: 1, name: x.vault_name, backends: [{ name: 'pb', type: 'privatebin', url: 'https://pb.example.org' }] }
const dTags = (relay) => [...relay.store.values()].filter((e) => e.pubkey === x.pubkey_hex).map((e) => e.tags[0][1]).sort()
// what a harvester asks: every kind 30078 event with a well-known d tag, from anyone
const harvest = async (relay) => {
  const conn = new nostr.RelayConn(relay.url)
  try { return await conn.query({ kinds: [nostr.KIND], '#d': LEGACY }) } finally { conn.close() }
}

test('discovery tag known answers: vectors.json and node:crypto HKDF agree', async () => {
  assert.ok(V.discovery_tags.cases.length >= 3)
  for (const v of V.discovery_tags.cases) {
    const tags = await c.deriveDiscoveryTags(c.fromHex(v.secret_hex))
    assert.deepEqual(tags, { 'vault.age': v['vault.age'], 'bootstrap.json': v['bootstrap.json'] })
    for (const p of ['vault.age', 'bootstrap.json']) {
      const ref = Buffer.from(nodeCrypto.hkdfSync('sha256', c.fromHex(v.secret_hex), new Uint8Array(0), `overkill v1 discovery tag:${p}`, 32)).toString('hex')
      assert.equal(ref, v[p])
    }
  }
  // every discovery case has its tags listed
  assert.deepEqual(V.discovery_tags.cases.map((v) => v.secret_hex), [...new Set(V.discovery.cases.map((d) => d.secret_hex))])
})

test('a new vault publishes under its own tags; a harvest by the old fixed tags finds nothing', async () => {
  const [a] = relays
  a.store.clear()
  await publishBootstrap(x.passphrase, x.vault_name, vaultAge, record, { relays: [a.url], secret, ...fast })
  const tags = await c.deriveDiscoveryTags(secret)
  assert.deepEqual(dTags(a), [tags['bootstrap.json'], tags['vault.age']].sort())
  assert.deepEqual(await harvest(a), [])
  const got = await fetchBootstrap(x.passphrase, x.vault_name, { relays: [a.url], secret, ...fast })
  assert.deepEqual(got.bootstrap, record)
  assert.equal(got.legacy, false)
})

test('a vault published under the old fixed tags still recovers and is republished under the new ones', async () => {
  const [a, b] = relays
  a.store.clear()
  b.store.clear()
  // what the old code published
  for (const r of [a, b]) {
    const old = nostr.create({ name: r.url, type: 'nostr', url: r.url, root: DISCOVERY_ROOT }, { root: DISCOVERY_ROOT, home: null }, fast)
    old.unlock({ nostrSecret: secret })
    await old.put('vault.age', vaultAge)
    await old.put('bootstrap.json', c.toBytes(JSON.stringify(record)))
    await old.close()
  }
  const got = await fetchBootstrap(x.passphrase, x.vault_name, { relays: [a.url, b.url], secret, ...fast })
  assert.deepEqual(got.bootstrap, record)
  assert.deepEqual(got.vaultAge, vaultAge)
  assert.equal(got.legacy, true)
  const tags = await c.deriveDiscoveryTags(secret)
  for (const r of [a, b]) {
    // republished under the new tags; the old events are left where they are
    assert.deepEqual(dTags(r), [...LEGACY, tags['bootstrap.json'], tags['vault.age']].sort())
  }
  const again = await fetchBootstrap(x.passphrase, x.vault_name, { relays: [a.url, b.url], secret, ...fast })
  assert.equal(again.legacy, false)
})

test('a publish stamp from before the new tags is due at once', () => {
  const now = Date.parse('2026-10-04T00:00:00.000Z')
  const at = '2026-10-03T00:00:00.000Z'
  assert.equal(publishDue({ sha256: 'h', at }, 'h', now), true)
  assert.equal(publishDue({ sha256: 'h', at, tags: DISCOVERY_TAGS_VERSION }, 'h', now), false)
})

test('the discovery relays: the original four first, then more good-retention relays', () => {
  assert.deepEqual(DISCOVERY_RELAYS.slice(0, 4), ['wss://nos.lol', 'wss://nostr.mom', 'wss://purplerelay.com', 'wss://nostr.oxtr.dev'])
  assert.ok(DISCOVERY_RELAYS.length >= 6 && DISCOVERY_RELAYS.length <= 8)
  assert.ok(!DISCOVERY_RELAYS.includes('wss://relay.damus.io'))
  assert.equal(new Set(DISCOVERY_RELAYS).size, DISCOVERY_RELAYS.length)
})

test('refresh republishes a young record when a discovery relay lost it', async () => {
  const [a, b, d] = relays
  for (const r of relays) r.store.clear()
  const { publishIfNeeded } = await import('../src/discovery.js')
  const before = process.env.OVERKILL_DISCOVERY_RELAYS
  process.env.OVERKILL_DISCOVERY_RELAYS = [a.url, b.url, d.url].join(',')
  process.env.OVERKILL_NOSTR_PAUSE_MS = '0'
  try {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ssn-disc-'))
    const vault = await c.createVault()
    const keys = await c.unlockKeys(vault)
    const vaultBytes = await c.encryptVault(vault, x.passphrase, { logN: 10 })
    const cfg = { v: 1, name: x.vault_name, backends: [] }
    const backends = []
    const o = { cfg, home, passphrase: x.passphrase, vaultBytes, backends, keys }
    assert.equal((await publishIfNeeded(o)).filter((r) => r.ok).length, 3)
    assert.equal(await publishIfNeeded(o), null, 'young and unchanged: nothing to do')
    assert.equal(await publishIfNeeded({ ...o, audit: true }), null, 'every relay still has it')
    d.store.clear()
    assert.equal(await publishIfNeeded(o), null, 'without the audit the stamp alone decides')
    const res = await publishIfNeeded({ ...o, audit: true })
    assert.equal(res.filter((r) => r.ok).length, 3)
    assert.equal(dTags(d).length, 2)
  } finally {
    if (before === undefined) delete process.env.OVERKILL_DISCOVERY_RELAYS
    else process.env.OVERKILL_DISCOVERY_RELAYS = before
  }
})
