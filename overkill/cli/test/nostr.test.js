// The Nostr adapter against an in-memory fake relay (ws server, in process): put, get,
// replaceable overwrite, chunking, a missing chunk, key derivation, and the store flow
// (check, a corrupt replacement event, repair, refresh).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import nodeCrypto from 'node:crypto'
import { startFakeRelay, MAX_EVENT } from './fake-relay.js'
import winston from 'winston'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import * as c from '../src/crypto.js'
import * as nostr from '../src/backends/nostr.js'
import * as local from '../src/backends/local.js'
import { Overkill, STATUS } from '../src/store.js'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const quiet = winston.createLogger({ silent: true })
const rnd = (n) => new Uint8Array(nodeCrypto.randomBytes(n)) // getRandomValues stops at 64 KiB

const dOf = (ev) => ev.tags.find((t) => t[0] === 'd')?.[1]
let fake
let url
let store
before(async () => {
  fake = await startFakeRelay()
  url = fake.url
  store = fake.store
})
after(() => fake.close())

const keys = await c.unlockKeys(V.decrypt.vault)
const pubkey = getPublicKey(keys.nostrSecret)
const ctx = { root: 'ovk', home: '/nonexistent' }
function relayBackend (name, extra = {}) {
  const b = nostr.create({ name, type: 'nostr', url, ...extra }, ctx, { pause: 0 })
  b.unlock(keys)
  return b
}
const ours = (d) => [...store.values()].filter((ev) => ev.pubkey === pubkey && dOf(ev)?.startsWith(d))

test('Nostr key: HKDF known answer, matches node:crypto, valid key and npub', async () => {
  const master = c.fromHex(V.derivation.master_hex)
  const raw = await c.deriveRawKeys(master)
  assert.equal(c.toHex(raw.nostr), V.derivation.k_nostr_hex)
  assert.equal(Buffer.from(nodeCrypto.hkdfSync('sha256', master, Buffer.alloc(0), 'overkill v1 nostr', 32)).toString('hex'), V.derivation.k_nostr_hex)
  assert.equal(c.toHex(keys.nostrSecret), V.derivation.k_nostr_hex)
  assert.deepEqual(nostr.identity(raw.nostr), { pubkey: V.derivation.nostr_pubkey_hex, npub: V.derivation.nostr_npub })
  // the web client shares crypto.js; the key must not depend on anything but the master
  assert.equal(c.toHex(await c.deriveNostrSecret(master)), V.derivation.k_nostr_hex)
})

test('put, get, missing, exists', async () => {
  const b = relayBackend('r1')
  try {
    const data = c.randomBytes(1234)
    assert.equal(await b.get('notes/aa.ovk'), null)
    assert.equal(await b.exists('notes/aa.ovk'), false)
    await b.put('notes/aa.ovk', data)
    assert.deepEqual(await b.get('notes/aa.ovk'), data)
    assert.equal(await b.exists('notes/aa.ovk'), true)
    assert.deepEqual(await b.list('notes'), ['aa.ovk'])
    const [ev] = ours('ovk/notes/aa.ovk')
    assert.equal(ev.kind, 30078)
    assert.deepEqual(ev.tags, [['d', 'ovk/notes/aa.ovk']])
    // the relay only sees NIP-44 ciphertext, never our blob
    assert.ok(!ev.content.includes(c.toBase64(data).slice(0, 40)))
    assert.match(ev.content, /^[A-Za-z0-9+/=]+$/)
  } finally {
    await b.close()
  }
})

test('overwrite replaces the event, even twice within one second', async () => {
  const b = relayBackend('r2')
  try {
    for (const n of [1, 2, 3]) await b.put('index.ovk', c.toBytes(`version ${n}`))
    assert.equal(new TextDecoder().decode(await b.get('index.ovk')), 'version 3')
    assert.equal(ours('ovk/index.ovk').length, 1)
    // a second device (fresh adapter, no memory of created_at) also moves forward
    const other = relayBackend('r2-other')
    await other.get('index.ovk')
    await other.put('index.ovk', c.toBytes('version 4'))
    await other.close()
    assert.equal(new TextDecoder().decode(await b.get('index.ovk')), 'version 4')
  } finally {
    await b.close()
  }
})

test('a 200 KB blob is chunked under the relay size cap and reassembled', async () => {
  const b = relayBackend('r3')
  try {
    const big = rnd(200_000)
    await b.put('notes/big.ovk', big)
    const evs = ours('ovk/notes/big.ovk')
    const n = Math.ceil(big.length / nostr.CHUNK)
    assert.equal(evs.length, n + 1)
    for (const ev of evs) assert.ok(JSON.stringify(['EVENT', ev]).length < MAX_EVENT)
    assert.deepEqual(evs.map(dOf).sort(), ['ovk/notes/big.ovk', ...Array.from({ length: n }, (_, i) => `ovk/notes/big.ovk#${i + 1}/${n}`)].sort())
    assert.deepEqual(await b.get('notes/big.ovk'), big)
    // shrinking back to one event: the head wins, leftover chunks are ignored
    await b.put('notes/big.ovk', c.toBytes('small now'))
    assert.equal(new TextDecoder().decode(await b.get('notes/big.ovk')), 'small now')
  } finally {
    await b.close()
  }
})

test('a missing or swapped chunk is reported as corrupt', async () => {
  const b = relayBackend('r4')
  try {
    const big = rnd(100_000)
    await b.put('notes/gap.ovk', big)
    const n = Math.ceil(big.length / nostr.CHUNK)
    store.delete(`30078:${pubkey}:ovk/notes/gap.ovk#2/${n}`)
    await assert.rejects(b.get('notes/gap.ovk'), (err) => err.corrupt && /chunk 2\/4 missing/.test(err.message))

    // a validly signed chunk from another blob with the same d tag: sha256 check catches it
    await b.put('notes/gap.ovk', big)
    const stray = await nostr.sealEvents(keys.nostrSecret, 'ovk/notes/gap.ovk', rnd(100_000), Math.floor(Date.now() / 1000) + 5)
    store.set(`30078:${pubkey}:ovk/notes/gap.ovk#3/${n}`, stray[2])
    await assert.rejects(b.get('notes/gap.ovk'), (err) => err.corrupt && /sha256/.test(err.message))
  } finally {
    await b.close()
  }
})

test('events by other keys or with bad content are not ours', async () => {
  const b = relayBackend('r5')
  try {
    const stranger = generateSecretKey()
    const fake = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000) + 60, tags: [['d', 'ovk/notes/x.ovk']], content: 'hi' }, stranger)
    store.set(`30078:${fake.pubkey}:ovk/notes/x.ovk`, fake)
    assert.equal(await b.get('notes/x.ovk'), null)
    // our key, but content that is not NIP-44 to self
    const ck = nip44.getConversationKey(keys.nostrSecret, getPublicKey(stranger))
    const bad = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'ovk/notes/y.ovk']], content: nip44.encrypt('{"b":"AAAA"}', ck) }, keys.nostrSecret)
    store.set(`30078:${pubkey}:ovk/notes/y.ovk`, bad)
    await assert.rejects(b.get('notes/y.ovk'), (err) => err.corrupt && /NIP-44/.test(err.message))
  } finally {
    await b.close()
  }
})

test('rate-limited: one polite retry, then give up', async () => {
  const b = nostr.create({ name: 'slow', type: 'nostr', url }, ctx, { pause: 0, backoff: 10 })
  b.unlock(keys)
  try {
    fake.rateLimited = 1
    await b.put('notes/slow.ovk', c.toBytes('eventually'))
    assert.equal(new TextDecoder().decode(await b.get('notes/slow.ovk')), 'eventually')
    fake.rateLimited = 2
    await assert.rejects(b.put('notes/slow.ovk', c.toBytes('never')), /rate-limited/)
  } finally {
    fake.rateLimited = 0
    await b.close()
  }
})

test('locked adapter: reads return nothing, writes refuse', async () => {
  const b = nostr.create({ name: 'locked', type: 'nostr', url }, ctx, { pause: 0 })
  assert.equal(await b.get('vault.age'), null)
  await assert.rejects(b.put('vault.age', c.randomBytes(3)), /locked/)
  assert.deepEqual(b.kitLines(), [])
  await b.close()
})

test('store: check, corrupt replacement event, repair, refresh republishes old copies', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-nostr-'))
  const lctx = { root: 'ovk-store', home: dir }
  const make = (retention) => [
    local.create({ name: 'usb', type: 'local', path: dir }, lctx),
    nostr.create({ name: 'na', type: 'nostr', url, root: 'ovk-store' }, lctx, { pause: 0 }),
    nostr.create({ name: 'nb', type: 'nostr', url: url + '/', root: 'ovk-store-b', assumeRetentionDays: retention }, lctx, { pause: 0 })
  ]
  const s = new Overkill({ backends: make(120), keys, vaultBytes: c.toBytes('vault bytes'), logger: quiet })
  try {
    await s.uploadVault()
    await s.writeIndex(c.emptyIndex())
    await s.put('groceries', 'oat milk')
    await s.put('big', rnd(90_000))
    let r = await s.check()
    assert.ok([...r.vault, ...r.index, ...Object.values(r.notes).flat()].every((x) => x.status === STATUS.OK))
    assert.ok(r.notes.groceries.find((x) => x.backend === 'na').expires > new Date(Date.now() + 100 * 86_400_000))

    // chaos on a relay: publish a flipped copy as a newer replacement event
    const na = s.backends[1]
    const p = c.paths.note(await c.blobIdForName(keys, 'groceries'))
    const blob = await na.get(p)
    blob[Math.floor(blob.length / 2)] ^= 0x42
    await na.put(p, blob)
    r = await s.check()
    assert.equal(r.notes.groceries.find((x) => x.backend === 'na').status, STATUS.CORRUPT)
    const { fixed } = await s.repair(r)
    assert.deepEqual(fixed, ['groceries on na'])
    assert.equal(new TextDecoder().decode((await s.get('groceries')).bytes), 'oat milk')
    r = await s.check()
    assert.ok(Object.values(r.notes).flat().every((x) => x.status === STATUS.OK))
  } finally {
    await s.close()
  }

  // refresh: with an assumed retention of 0 days every nb copy is due, na copies are not
  const s2 = new Overkill({ backends: make(0), keys, vaultBytes: c.toBytes('vault bytes'), logger: quiet })
  try {
    const before = ours('ovk-store-b/index.ovk')[0].created_at
    const { fixed, failed } = await s2.refresh({ days: 90 })
    assert.deepEqual(failed, [])
    assert.deepEqual(fixed.map((x) => x.replace(/ \(was expiring .*\)$/, '')).sort(), ['big on nb', 'groceries on nb', 'index on nb', 'vault.age on nb'])
    assert.ok(ours('ovk-store-b/index.ovk')[0].created_at > before)
    const r = await s2.check()
    assert.ok([...r.vault, ...r.index, ...Object.values(r.notes).flat()].every((x) => x.status === STATUS.OK))
  } finally {
    await s2.close()
  }
})

test('operators: every relay is its own operator; init defaults are verified relays', async () => {
  assert.equal(nostr.operator({ url: 'wss://nos.lol' }), 'Nostr relay nos.lol')
  assert.notEqual(nostr.operator({ url: 'wss://nos.lol' }), nostr.operator({ url: 'wss://relay.damus.io' }))
  const cfgs = await nostr.promptMany(async () => '', async () => true)
  assert.equal(cfgs.length, nostr.DEFAULT_COUNT)
  assert.equal(new Set(cfgs.map((x) => x.name)).size, cfgs.length)
  assert.ok(cfgs.every((x) => x.type === 'nostr' && nostr.RELAYS.includes(x.url)))
})
