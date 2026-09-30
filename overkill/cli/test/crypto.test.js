import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import nodeCrypto from 'node:crypto'
import * as c from '../src/crypto.js'
import * as age from 'age-encryption'

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const keys = await c.unlockKeys(V.decrypt.vault)

const flip = (bytes, i) => { const out = Uint8Array.from(bytes); out[i] ^= 0x01; return out }
const rejects = (p, layer) => assert.rejects(p, (err) => err instanceof c.CorruptBlobError && err.layer === layer)

test('HKDF known answers match vectors.json and node:crypto', async () => {
  const master = c.fromHex(V.derivation.master_hex)
  assert.deepEqual(c.fromBase64(V.derivation.master_b64), master)
  const raw = await c.deriveRawKeys(master)
  assert.equal(c.toHex(raw.aes), V.derivation.k_aes_hex)
  assert.equal(c.toHex(raw.name), V.derivation.k_name_hex)
  const ref = (info) => Buffer.from(nodeCrypto.hkdfSync('sha256', master, Buffer.alloc(0), info, 32)).toString('hex')
  assert.equal(ref('overkill v1 aes'), V.derivation.k_aes_hex)
  assert.equal(ref('overkill v1 name'), V.derivation.k_name_hex)
})

test('HMAC blob id known answers match vectors.json and node:crypto', async () => {
  for (const { name, blob_id: id } of V.blob_ids) {
    assert.equal(await c.blobIdForName(keys, name), id)
    const ref = nodeCrypto.createHmac('sha256', c.fromHex(V.derivation.k_name_hex)).update(name.normalize('NFC'), 'utf8').digest('hex')
    assert.equal(ref, id)
    assert.match(id, /^[0-9a-f]{64}$/)
  }
})

test('names are NFC-normalized: NFD and NFC spellings share a blob id', async () => {
  const nfc = 'Einkaufsliste f\u00fcr Oma 🥦'
  const nfd = nfc.normalize('NFD')
  assert.notEqual(nfc, nfd)
  assert.equal(await c.blobIdForName(keys, nfd), await c.blobIdForName(keys, nfc))
  assert.equal(V.blob_ids[3].name, nfd)
  assert.equal(V.blob_ids[3].blob_id, V.blob_ids[2].blob_id)
})

test('AES layer known answer matches vectors.json and node:crypto', async () => {
  const a = V.aes_layer
  const blob = await c.aesSeal(keys, a.blob_id, c.fromHex(a.inner_hex), c.fromHex(a.nonce_hex))
  assert.equal(c.toHex(blob), a.blob_hex)
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', c.fromHex(V.derivation.k_aes_hex), c.fromHex(a.nonce_hex))
  cipher.setAAD(c.fromHex(a.aad_hex))
  const ref = Buffer.concat([Buffer.from('OVK1'), c.fromHex(a.nonce_hex), cipher.update(c.fromHex(a.inner_hex)), cipher.final(), cipher.getAuthTag()])
  assert.equal(ref.toString('hex'), a.blob_hex)
  assert.equal(Buffer.from(c.fromHex(a.aad_hex)).toString(), 'OVK1' + a.blob_id)
  assert.equal(c.toHex(await c.aesOpen(keys, a.blob_id, blob)), a.inner_hex)
})

test('vector blobs decrypt (note, index, vault.age)', async () => {
  const d = V.decrypt
  assert.equal(keys.ageRecipient, d.age_recipient)
  const note = await c.decryptBlob(keys, d.note.blob_id, c.fromHex(d.note.blob_hex))
  assert.equal(new TextDecoder().decode(note), d.note.plaintext)
  assert.deepEqual(await c.decryptIndex(keys, c.fromHex(d.index.blob_hex)), d.index.plaintext)
  assert.deepEqual(await c.decryptVault(c.fromHex(d.vault_age.hex), d.vault_age.passphrase), d.vault)
})

test('round trip with a fresh vault, binary and text', async () => {
  const vault = await c.createVault()
  assert.match(vault.age_identity, /^AGE-SECRET-KEY-1[0-9A-Z]+$/)
  const k = await c.unlockKeys(vault)
  const id = await c.blobIdForName(k, 'x')
  const bin = new Uint8Array(nodeCrypto.randomBytes(70000)) // crosses the 64 KiB age chunk size
  assert.deepEqual(await c.decryptBlob(k, id, await c.encryptBlob(k, id, bin)), bin)
  const text = 'hello 🌍'
  assert.equal(new TextDecoder().decode(await c.decryptBlob(k, id, await c.encryptBlob(k, id, text))), text)
  const empty = await c.encryptBlob(k, id, new Uint8Array(0))
  assert.equal((await c.decryptBlob(k, id, empty)).length, 0)
  // two encryptions of the same plaintext differ (random nonce and age file key)
  assert.notDeepEqual(await c.encryptBlob(k, id, text), await c.encryptBlob(k, id, text))
})

test('tamper: header, nonce, ciphertext, tag, truncation', async () => {
  const d = V.decrypt.note
  const blob = c.fromHex(d.blob_hex)
  await rejects(c.decryptBlob(keys, d.blob_id, flip(blob, 0)), 'header')
  await rejects(c.decryptBlob(keys, d.blob_id, blob.subarray(0, 20)), 'header')
  await rejects(c.decryptBlob(keys, d.blob_id, flip(blob, 5)), 'aes') // nonce
  await rejects(c.decryptBlob(keys, d.blob_id, flip(blob, 40)), 'aes') // body
  await rejects(c.decryptBlob(keys, d.blob_id, flip(blob, blob.length - 1)), 'aes') // tag
  await rejects(c.decryptBlob(keys, d.blob_id, blob.subarray(0, blob.length - 1)), 'aes')
})

test('tamper: AAD binds the blob id (swapped copies are rejected)', async () => {
  const d = V.decrypt.note
  const other = V.blob_ids[1].blob_id
  await rejects(c.decryptBlob(keys, other, c.fromHex(d.blob_hex)), 'aes')
  await rejects(c.decryptIndex(keys, c.fromHex(d.blob_hex)), 'aes')
})

test('tamper: age layer is checked independently of AES', async () => {
  const d = V.decrypt.note
  const inner = await c.aesOpen(keys, d.blob_id, c.fromHex(d.blob_hex))
  // re-seal a tampered age payload with a valid AES tag, so only age can notice
  for (const i of [inner.length - 1, inner.length - 20, 30]) {
    await rejects(c.decryptBlob(keys, d.blob_id, await c.aesSeal(keys, d.blob_id, flip(inner, i))), 'age')
  }
  // a valid age file for a different identity is rejected too
  const stranger = await c.unlockKeys({ ...V.decrypt.vault, age_identity: (await c.createVault()).age_identity })
  const foreign = await c.encryptBlob(stranger, d.blob_id, 'hi')
  const mixed = await c.aesSeal(keys, d.blob_id, await c.aesOpen(stranger, d.blob_id, foreign))
  await rejects(c.decryptBlob(keys, d.blob_id, mixed), 'age')
})

test('wrong master key fails at the AES layer', async () => {
  const other = await c.unlockKeys({ ...V.decrypt.vault, master: c.toBase64(new Uint8Array(32)) })
  await rejects(c.decryptBlob(other, V.decrypt.note.blob_id, c.fromHex(V.decrypt.note.blob_hex)), 'aes')
})

test('vault: wrong passphrase and tampered vault.age', async () => {
  const va = V.decrypt.vault_age
  await assert.rejects(c.decryptVault(c.fromHex(va.hex), 'correct horse battery stapler'), c.WrongPassphraseError)
  await assert.rejects(c.decryptVault(flip(c.fromHex(va.hex), c.fromHex(va.hex).length - 3), va.passphrase), c.WrongPassphraseError)
  const armored = new TextEncoder().encode(age.armor.encode(c.fromHex(va.hex)))
  assert.deepEqual(await c.decryptVault(armored, va.passphrase), V.decrypt.vault)
  const fresh = await c.createVault()
  const bytes = await c.encryptVault(fresh, 'pw', { logN: 10 })
  assert.deepEqual(await c.decryptVault(bytes, 'pw'), fresh)
})

test('index merge: union of names, newest updated wins', () => {
  const a = { v: 1, notes: { x: { id: '1', updated: '2026-01-01T00:00:00Z' }, y: { id: 'y', updated: '2026-01-01T00:00:00Z' } } }
  const b = { v: 1, notes: { x: { id: '2', updated: '2026-02-01T00:00:00Z' }, z: { id: 'z', updated: '2025-01-01T00:00:00Z' } } }
  const m = c.mergeIndexes(a, null, b)
  assert.deepEqual(Object.keys(m.notes).sort(), ['x', 'y', 'z'])
  assert.equal(m.notes.x.id, '2')
  assert.equal(c.mergeIndexes(b, a).notes.x.id, '2')
})

test('index merge vectors from vectors.json', () => {
  assert.ok(V.merge.length >= 3)
  for (const m of V.merge) {
    assert.deepEqual(c.mergeIndexes(...m.inputs), m.expected, m.why)
    assert.deepEqual(c.mergeIndexes(...[...m.inputs].reverse()), m.expected, `${m.why} (reversed input order)`)
  }
})

test('derived CryptPad credentials: vectors, lowercase host, independent per host', async () => {
  const master = c.fromHex(V.derivation.master_hex)
  for (const v of V.cryptpad_credentials) {
    const got = await c.deriveCryptpadCredentials(master, v.host)
    assert.deepEqual(got, { username: v.username, password: v.password })
    assert.match(got.username, /^ovk-[0-9a-f]{16}$/)
    assert.match(got.password, /^[A-Za-z0-9_-]{32}$/)
    const ref = nodeCrypto.hkdfSync('sha256', master, Buffer.alloc(0), `overkill v1 cryptpad:${v.host.toLowerCase()}`, 32)
    assert.equal(got.username, 'ovk-' + Buffer.from(ref).subarray(0, 8).toString('hex'))
  }
  assert.notEqual(V.cryptpad_credentials[0].username, V.cryptpad_credentials[1].username)
  assert.deepEqual(await c.deriveCryptpadCredentials(master, 'cryptpad.fr'), { username: V.cryptpad_credentials[2].username, password: V.cryptpad_credentials[2].password })
})
