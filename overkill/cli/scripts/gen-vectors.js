// Generates test/vectors.json. Run once; the tests then check against the committed file.
// Derivation vectors are fully deterministic. The "decrypt" vectors contain real age
// ciphertext (random at generation time) that any conforming client must be able to open.
import { readFile, writeFile } from 'node:fs/promises'
import { bech32 } from '@scure/base'
import * as c from '../src/crypto.js'
import { identity } from '../src/backends/nostr.js'
import { nsecEncode } from 'nostr-tools/nip19'

const master = c.fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
const vault = {
  v: 1,
  // fixed X25519 scalar 0x42 * 32, bech32-encoded the way age does it
  age_identity: bech32.encode('age-secret-key-', bech32.toWords(new Uint8Array(32).fill(0x42)), false).toUpperCase(),
  master: c.toBase64(master),
  created: '2026-09-29T00:00:00.000Z'
}
const raw = await c.deriveRawKeys(master)
const keys = await c.unlockKeys(vault)
// the NFD spelling of "für" must map to the same blob_id as the NFC one
const names = ['groceries', 'Groceries', 'Einkaufsliste für Oma 🥦', 'Einkaufsliste fu\u0308r Oma 🥦', 'a/b/c.txt', ' ']
const inner = c.toBytes('not really age, just bytes for the AES layer')
const nonce = c.fromHex('a0a1a2a3a4a5a6a7a8a9aaab')
const noteName = 'groceries'
const noteText = 'oat milk\nbananas\n1x tinfoil hat (extra thick)\n'
const noteId = await c.blobIdForName(keys, noteName)
const index = {
  v: 1,
  notes: { [noteName]: { id: noteId, sha256: await c.sha256Hex(noteText), size: c.toBytes(noteText).length, updated: '2026-09-29T12:00:00.000Z' } }
}
const passphrase = 'correct horse battery staple'
const file = new URL('../test/vectors.json', import.meta.url)
// keep previously published ciphertexts stable (they are random); only fill in what is missing
const prev = await readFile(file, 'utf8').then(JSON.parse, () => null)
const L = (id) => `notes/${id}.ovk`
const mergeCases = [
  {
    why: 'union of names; newest updated wins per name',
    inputs: [
      { v: 1, notes: { a: { id: '01', sha256: '00', size: 1, updated: '2026-01-01T00:00:00.000Z' }, b: { id: '02', sha256: '00', size: 1, updated: '2026-01-01T00:00:00.000Z' } } },
      { v: 1, notes: { a: { id: '01', sha256: '11', size: 2, updated: '2026-02-01T00:00:00.000Z' }, c: { id: '03', sha256: '00', size: 1, updated: '2025-01-01T00:00:00.000Z' } } }
    ]
  },
  {
    why: 'note locator follows the index whose entry won; other paths come from the newest written; missing ones are unioned',
    inputs: [
      { v: 1, written: '2026-03-01T00:00:00.000Z', notes: { a: { id: '01', sha256: '00', size: 1, updated: '2026-01-01T00:00:00.000Z' } }, locators: { pb: { [L('01')]: 'https://pb.example/?old#k', 'vault.age': 'https://pb.example/?v2#k' } } },
      { v: 1, written: '2026-02-01T00:00:00.000Z', notes: { a: { id: '01', sha256: '11', size: 2, updated: '2026-02-01T00:00:00.000Z' } }, locators: { pb: { [L('01')]: 'https://pb.example/?new#k', 'vault.age': 'https://pb.example/?v1#k' }, pb2: { 'vault.age': 'https://pb2.example/?v#k' } } }
    ]
  },
  {
    why: 'same updated (a repair moved a paste): the index with the newer written wins the tie',
    inputs: [
      { v: 1, written: '2026-01-02T00:00:00.000Z', notes: { a: { id: '01', sha256: '00', size: 1, updated: '2026-01-01T00:00:00.000Z' } }, locators: { pb: { [L('01')]: 'https://pb.example/?fresh#k' } } },
      { v: 1, written: '2026-01-01T00:00:00.000Z', notes: { a: { id: '01', sha256: '00', size: 1, updated: '2026-01-01T00:00:00.000Z' } }, locators: { pb: { [L('01')]: 'https://pb.example/?corrupt#k' } } }
    ]
  },
  {
    why: 'health ledger: per key and backend the newest last_checked wins, last_ok is the newest from any input',
    inputs: [
      { v: 1, written: '2026-09-01T00:00:00.000Z', notes: {}, health: { _vault: { pb: { last_ok: '2026-08-01T00:00:00.000Z', last_checked: '2026-08-01T00:00:00.000Z', status: 'ok', expires: null } }, a: { mega: { last_ok: '2026-08-20T00:00:00.000Z', last_checked: '2026-09-01T00:00:00.000Z', status: 'corrupt', expires: null } } } },
      { v: 1, written: '2026-08-15T00:00:00.000Z', notes: {}, health: { _vault: { pb: { last_ok: '2026-07-01T00:00:00.000Z', last_checked: '2026-08-10T00:00:00.000Z', status: 'error', expires: '2027-01-01T00:00:00.000Z' } }, a: { mega: { last_ok: '2026-08-25T00:00:00.000Z', last_checked: '2026-08-25T00:00:00.000Z', status: 'ok', expires: null }, filen: { last_checked: '2026-08-02T00:00:00.000Z', status: 'missing', expires: null } } } }
    ]
  },
  {
    why: 'pastes (delete tokens of paste-like copies): union by paste id per backend',
    inputs: [
      { v: 1, written: '2026-09-02T00:00:00.000Z', notes: {}, pastes: { pb: { aaaa: { path: 'index.ovk', token: '01', at: '2026-09-02T00:00:00.000Z' } } } },
      { v: 1, written: '2026-09-01T00:00:00.000Z', notes: {}, pastes: { pb: { bbbb: { path: 'notes/01.ovk', token: '02', at: '2026-09-01T00:00:00.000Z' } }, pb2: { cccc: { path: 'vault.age', token: '03', at: '2026-08-01T00:00:00.000Z' } } } }
    ]
  }
].map((m) => ({ ...m, expected: c.mergeIndexes(...m.inputs) }))
const discoveryCases = [
  { passphrase: 'correct horse battery staple', vault_name: 'groceries' },
  { passphrase: 'correct horse battery staple', vault_name: 'Einkaufsliste für Oma' },
  { passphrase: 'correct horse battery staple', vault_name: 'Einkaufsliste fu\u0308r Oma', note: 'NFD vault name; the salt uses the NFC form' },
  { passphrase: 'tofu-plinth-gravel-omen-sprocket-lagoon', vault_name: 'groceries' }
]
const discovery = {
  note: 'scrypt(passphrase UTF-8, salt "overkill v1 discovery:" || NFC(vault_name), N=2^18, r=8, p=1, 32 bytes) as a Nostr secret key; invalid scalars retry with "overkill v1 discovery 1:" and so on',
  cases: []
}
for (const x of discoveryCases) {
  const secret = await c.deriveDiscoverySecret(x.passphrase, x.vault_name)
  const id = identity(secret)
  discovery.cases.push({ ...x, salt: `overkill v1 discovery:${x.vault_name.normalize('NFC')}`, secret_hex: c.toHex(secret), nsec: nsecEncode(secret), pubkey_hex: id.pubkey, npub: id.npub })
}
const vectors = {
  description: 'Overkill Notes format v1 test vectors (docs/OVERKILL.md). Hex is lowercase.',
  derivation: {
    master_hex: c.toHex(master),
    master_b64: vault.master,
    k_aes_hex: c.toHex(raw.aes),
    k_name_hex: c.toHex(raw.name),
    k_nostr_hex: c.toHex(raw.nostr),
    k_blossom_hex: c.toHex(raw.blossom),
    k_nostr_note: 'HKDF info "overkill v1 nostr"; only if that is 0 or >= the secp256k1 order, retry with "overkill v1 nostr 1", then "overkill v1 nostr 2", and so on',
    nostr_pubkey_hex: identity(raw.nostr).pubkey,
    nostr_npub: identity(raw.nostr).npub
  },
  blob_ids: await Promise.all(names.map(async (name) => ({
    name,
    ...(name !== name.normalize('NFC') ? { note: 'NFD input; HMAC is over UTF-8 of the NFC form' } : {}),
    blob_id: await c.blobIdForName(keys, name)
  }))),
  aes_layer: {
    blob_id: noteId,
    nonce_hex: c.toHex(nonce),
    inner_hex: c.toHex(inner),
    aad_hex: c.toHex(c.concat(c.MAGIC, c.toBytes(noteId))),
    blob_hex: c.toHex(await c.aesSeal(keys, noteId, inner, nonce))
  },
  decrypt: {
    vault,
    age_recipient: keys.ageRecipient,
    note: prev?.decrypt?.note ?? { name: noteName, blob_id: noteId, plaintext: noteText, blob_hex: c.toHex(await c.encryptBlob(keys, noteId, noteText)) },
    index: prev?.decrypt?.index ?? { plaintext: index, blob_hex: c.toHex(await c.encryptIndex(keys, index)) },
    vault_age: prev?.decrypt?.vault_age ?? {
      passphrase,
      scrypt_log_n: 10,
      note: 'low work factor only to keep tests fast; real vaults use 18',
      hex: c.toHex(await c.encryptVault(vault, passphrase, { logN: 10 }))
    }
  },
  merge: mergeCases,
  cryptpad_credentials: await Promise.all(['cryptpad.private.coffee', 'crypt.unredacted.org', 'CryptPad.FR'].map(async (host) => ({
    host, ...await c.deriveCryptpadCredentials(master, host)
  }))),
  discovery
}
// sections added by other tools (e.g. "fileverse", tested in test/fileverse.test.js) stay as they are
for (const [k, v] of Object.entries(prev ?? {})) if (!(k in vectors)) vectors[k] = v
await writeFile(file, JSON.stringify(vectors, null, 2) + '\n')
console.log('wrote test/vectors.json')
