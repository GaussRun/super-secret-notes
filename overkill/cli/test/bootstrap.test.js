// Discovery key vectors and the bootstrap round trip (vault name + passphrase only) against
// two in-process fake relays.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import nodeCrypto from 'node:crypto'
import { getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as c from '../src/crypto.js'
import { discoveryIdentity, publishBootstrap, fetchBootstrap, DEFAULT_RELAYS, DISCOVERY_ROOT } from '../src/bootstrap.js'
import * as nostr from '../src/backends/nostr.js'
import { startFakeRelay } from './fake-relay.js'

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const fast = { pause: 0 }
let a
let b
before(async () => { [a, b] = await Promise.all([startFakeRelay(), startFakeRelay()]) })
after(() => Promise.all([a.close(), b.close()]))

test('discovery key known answers match vectors.json and node:crypto scrypt', async () => {
  assert.equal(V.discovery.cases.length, 4)
  for (const x of V.discovery.cases) {
    const id = await discoveryIdentity(x.passphrase, x.vault_name)
    assert.equal(c.toHex(id.secret), x.secret_hex)
    assert.equal(id.pubkey, x.pubkey_hex)
    assert.equal(id.npub, x.npub)
    assert.equal(nip19.nsecEncode(id.secret), x.nsec)
    assert.equal(x.salt, `overkill v1 discovery:${x.vault_name.normalize('NFC')}`)
    const ref = nodeCrypto.scryptSync(x.passphrase, x.salt, 32, { N: 2 ** 18, r: 8, p: 1, maxmem: 2 ** 29 }).toString('hex')
    assert.equal(ref, x.secret_hex)
    assert.ok(c.nostrScalarOk(id.secret))
  }
  // NFD and NFC spellings of the vault name give the same key
  assert.equal(V.discovery.cases[1].secret_hex, V.discovery.cases[2].secret_hex)
  // and it is not the master-derived key
  assert.notEqual(V.discovery.cases[0].secret_hex, V.derivation.k_nostr_hex)
})

test('invalid-scalar rule: 0 and n and above are rejected, n-1 and 1 accepted', () => {
  const n = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
  assert.equal(c.nostrScalarOk(new Uint8Array(32)), false)
  assert.equal(c.nostrScalarOk(c.fromHex(n)), false)
  assert.equal(c.nostrScalarOk(new Uint8Array(32).fill(0xff)), false)
  assert.equal(c.nostrScalarOk(c.fromHex(n.slice(0, -1) + '0')), true)
  assert.equal(c.nostrScalarOk(c.fromHex('00'.repeat(31) + '01')), true)
})

test('publish, then fetch with name + passphrase from any relay; newest record wins', async () => {
  const x = V.discovery.cases[0]
  const secret = c.fromHex(x.secret_hex)
  const vaultAge = c.toBytes('age-encryption.org/v1 pretend vault')
  const record = { v: 1, main_npub: V.derivation.nostr_npub, locators: { 'pb-envs': { 'index.ovk': 'https://pb.envs.net/?abc#key' } }, cryptpad: [{ instance: 'https://cryptpad.fr', username: 'ovk-123' }] }
  const res = await publishBootstrap(x.passphrase, x.vault_name, vaultAge, record, { relays: [a.url, b.url], secret, ...fast })
  assert.deepEqual(res.map((r) => r.ok), [true, true])

  // what a relay sees: two kind 30078 events by the discovery key, content NIP-44 only
  const evs = [...a.store.values()].filter((e) => e.pubkey === x.pubkey_hex)
  assert.deepEqual(evs.map((e) => e.tags[0][1]).sort(), [`${DISCOVERY_ROOT}/bootstrap.json`, `${DISCOVERY_ROOT}/vault.age`])
  assert.ok(evs.every((e) => e.kind === nostr.KIND && !e.content.includes('pb.envs') && !e.content.includes('npub')))

  // the full path: derive from name + passphrase (no secret passed), fetch
  const got = await fetchBootstrap(x.passphrase, x.vault_name, { relays: [a.url, b.url], ...fast })
  assert.deepEqual(got.vaultAge, vaultAge)
  assert.deepEqual(got.bootstrap, record)
  assert.equal(got.npub, x.npub)

  // only relay b gets a newer record: fetch prefers it even when a is asked first
  const newer = { ...record, main_npub: 'npub-newer' }
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await publishBootstrap(x.passphrase, x.vault_name, vaultAge, newer, { relays: [b.url], secret, ...fast })
  const got2 = await fetchBootstrap(x.passphrase, x.vault_name, { relays: [a.url, b.url], secret, ...fast })
  assert.equal(got2.bootstrap.main_npub, 'npub-newer')
  assert.equal(got2.from, b.url)

  // one relay gone: the other still answers
  a.store.clear()
  assert.equal((await fetchBootstrap(x.passphrase, x.vault_name, { relays: [a.url, b.url], secret, ...fast })).from, b.url)
})

test('wrong passphrase or vault name finds nothing; a dead relay does not break publish', async () => {
  const x = V.discovery.cases[3]
  const secret = c.fromHex(x.secret_hex)
  const res = await publishBootstrap(x.passphrase, x.vault_name, c.toBytes('v'), '{"v":1}', { relays: [a.url, 'ws://127.0.0.1:9'], secret, ...fast })
  assert.deepEqual(res.map((r) => r.ok), [true, false])
  const other = (await discoveryIdentity('wrong passphrase', x.vault_name)).secret
  await assert.rejects(fetchBootstrap('wrong passphrase', x.vault_name, { relays: [a.url], secret: other, ...fast }), /no bootstrap/)
  await assert.rejects(publishBootstrap(x.passphrase, x.vault_name, c.toBytes('v'), {}, { relays: ['ws://127.0.0.1:9'], secret, ...fast }), /not stored on any relay/)
  await assert.rejects(publishBootstrap(x.passphrase, x.vault_name, c.toBytes('v'), 'not json', { relays: [a.url], secret, ...fast }), SyntaxError)
  assert.equal(getPublicKey(secret), x.pubkey_hex)
})

test('default bootstrap relays are the verified default relays', () => {
  assert.deepEqual(DEFAULT_RELAYS, nostr.RELAYS.slice(0, nostr.DEFAULT_COUNT))
  assert.ok(DEFAULT_RELAYS.length >= 3)
})
