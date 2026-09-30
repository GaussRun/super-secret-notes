// Fileverse: payload format, derived account (vectors, Privy SIWE against a fake Privy, the
// provisioning order against a fake chain and a fake apps-storage). The writer and the adapter
// are in fileverse-embedded.test.js. (A live run against the real service is not part of the suite.)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import nodeCrypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as Y from 'yjs'
import { verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as c from '../src/crypto.js'
import { encodeDoc, decodeDoc, titleFor, yjsText, operator } from '../src/backends/fileverse.js'
import { accountMaterial, sealSaved, siweMessage, privyLogin, ensureApiKey, FILEVERSE } from '../src/backends/fileverse-account.js'

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const master = c.fromHex(V.derivation.master_hex)

test('doc format: base64 in a code fence survives, garbage is rejected', () => {
  const data = c.randomBytes(3000)
  const doc = encodeDoc(data)
  assert.match(doc, /^```\n[A-Za-z0-9+/]+=*\n```$/)
  assert.deepEqual(decodeDoc(doc), data)
  const b64 = Buffer.from(data).toString('base64')
  assert.deepEqual(decodeDoc(b64.slice(0, 100) + '\n' + b64.slice(100)), data)
  assert.throws(() => decodeDoc('# my shopping list'), /not an Overkill blob/)
  assert.deepEqual(decodeDoc(encodeDoc(new Uint8Array())), new Uint8Array())
})

test('titles are hex hashes of root/path, never the path itself', () => {
  const t = titleFor('ovk', 'notes/abc.ovk')
  assert.match(t, /^[0-9a-f]{64}$/)
  assert.notEqual(t, titleFor('other', 'notes/abc.ovk'))
  assert.equal(operator(), 'Fileverse')
})

test('yjsText reads text out of a dDoc-shaped Yjs state', () => {
  const doc = new Y.Doc()
  const block = new Y.XmlElement('dBlock')
  const code = new Y.XmlElement('codeBlock')
  const text = new Y.XmlText()
  doc.getXmlFragment('default').insert(0, [block])
  block.insert(0, [code])
  code.insert(0, [text])
  text.insert(0, 'QUJD')
  const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  assert.deepEqual(decodeDoc(yjsText(update)), new TextEncoder().encode('ABC'))
})

test('derived Fileverse secrets: vectors and an independent HKDF', async () => {
  const s = await c.deriveFileverseSecrets(master)
  const F = V.fileverse
  assert.equal(c.toHex(s.wallet), F.wallet_hex)
  assert.equal(c.toHex(s.ownerAgent), F.owner_agent_hex)
  assert.equal(c.toHex(s.ownerUcan), F.owner_ucan_hex)
  assert.equal(c.toHex(s.portalSeed), F.portal_seed_hex)
  assert.equal(c.toHex(s.apiKeySeed), F.api_key_seed_hex)
  const ref = (info, n = 32) => Buffer.from(nodeCrypto.hkdfSync('sha256', master, Buffer.alloc(0), info, n)).toString('hex')
  assert.equal(ref('overkill v1 fileverse'), F.wallet_hex) // valid scalar on the first try for this master
  assert.equal(ref('overkill v1 fileverse portal seed', 48), F.portal_seed_hex)
  assert.equal(ref('overkill v1 fileverse api key', 24), F.api_key_seed_hex)
  assert.equal(privateKeyToAccount('0x' + F.wallet_hex).address, F.wallet_address)
  const m = accountMaterial(s)
  assert.equal(m.apiKey, F.api_key)
  assert.match(m.apiKey, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(m.apiKeyId, F.api_key_id)
  assert.equal(m.ownerDid, F.owner_did)
  assert.equal(m.collaboratorDid, F.collaborator_did)
  assert.equal(c.toHex(m.collaboratorKey), F.collaborator_key_hex)
  assert.deepEqual(m.verifiers, { enc: F.app_encryption_key_verifier, dec: F.app_decryption_key_verifier })
  // different masters, different accounts
  const other = accountMaterial(await c.deriveFileverseSecrets(c.randomBytes(32)))
  assert.notEqual(other.apiKey, m.apiKey)
})

test('saved key material opens with the library format (nonce 24 || ciphertext || tag)', () => {
  const seed = c.randomBytes(24)
  const sealed = Buffer.from(sealSaved(seed, { a: 1 }), 'base64')
  const key = nodeCrypto.hkdfSync('sha256', seed, Buffer.from([0]), 'SAVED_DATA_ENCRYPTION_KEY', 32)
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(key), sealed.subarray(0, 24))
  d.setAuthTag(sealed.subarray(sealed.length - 16))
  assert.deepEqual(JSON.parse(Buffer.concat([d.update(sealed.subarray(24, sealed.length - 16)), d.final()])), { a: 1 })
})

// a fake Privy and a fake apps-storage in one server
const privyCalls = []
const saved = new Map()
let blockPrivy = false
let server
let base
before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const ch of req) chunks.push(ch)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    const send = (status, o) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
    if (req.url.startsWith('/api/v1/')) {
      privyCalls.push({ route: req.url, headers: req.headers, body })
      if (blockPrivy) { res.statusCode = 403; return res.end('<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></html>') }
      if (req.url === '/api/v1/siwe/init') return send(200, { nonce: 'ab'.repeat(32), address: body.address })
      if (req.url === '/api/v1/siwe/authenticate') return send(200, { user: { id: 'did:privy:test' }, token: 'tok', refresh_token: 'ref', is_new_user: true })
      if (req.url === '/api/v1/sessions/logout') return send(200, {})
    }
    if (req.url === '/api-access/save') { saved.set(body.id, body); return send(201, { ok: true }) }
    const id = req.url.split('/api-access/')[1]
    if (id) return saved.has(id) ? send(200, saved.get(id)) : send(404, { message: 'API key not found' })
    send(404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

test('Privy SIWE login: the web app message, verifiable signature, then logout; anti-bot page stops it', async () => {
  privyCalls.length = 0
  const account = privateKeyToAccount('0x' + V.fileverse.wallet_hex)
  const out = await privyLogin({ account, urls: { ...FILEVERSE, privyUrl: base } })
  assert.deepEqual(out, { privyUserId: 'did:privy:test', isNewUser: true })
  assert.deepEqual(privyCalls.map((x) => x.route), ['/api/v1/siwe/init', '/api/v1/siwe/authenticate', '/api/v1/sessions/logout'])
  const auth = privyCalls[1].body
  assert.equal(auth.message, siweMessage({ address: account.address, nonce: 'ab'.repeat(32), issuedAt: auth.message.match(/Issued At: (.*)/)[1] }))
  assert.match(auth.message, /^docs\.fileverse\.io wants you to sign in with your Ethereum account:\n0x0dE2c2340401A294FeE098E15A7480229DF683A6\n/)
  assert.match(auth.message, /\nChain ID: 100\n/)
  assert.equal(await verifyMessage({ address: account.address, message: auth.message, signature: auth.signature }), true)
  assert.equal(privyCalls[0].headers['privy-app-id'], 'clya4y8w2044hmfniynuamwjj')
  assert.equal(privyCalls[0].headers.origin, 'https://docs.fileverse.io')
  assert.equal(privyCalls[2].headers.authorization, 'Bearer tok')
  assert.deepEqual(privyCalls[2].body, { refresh_token: 'ref' })

  blockPrivy = true
  await assert.rejects(privyLogin({ account, urls: { ...FILEVERSE, privyUrl: base } }), /anti-bot page/)
  blockPrivy = false
})

function fakeChain () {
  const calls = []
  return {
    calls,
    walletAccount: (key) => privateKeyToAccount('0x' + c.toHex(key)),
    async mintPortal (ownerKey, ownerDid, verifiers) { calls.push(['mint', c.toHex(ownerKey), ownerDid, verifiers]); return { portalAddress: '0x' + '11'.repeat(20), ownerAddress: '0x' + '22'.repeat(20), txHash: '0x' + 'aa'.repeat(32) } },
    async collaboratorAddress (key) { calls.push(['collaboratorAddress', c.toHex(key)]); return '0x' + '33'.repeat(20) },
    async addCollaborator (ownerKey, portal, collab) { calls.push(['addCollaborator', portal, collab]); return { txHash: '0x' + 'bb'.repeat(32) } },
    async registerCollaboratorKeys (key, portal, did) { calls.push(['registerCollaboratorKeys', portal, did]); return { txHash: '0x' + 'cc'.repeat(32) } }
  }
}

test('ensureApiKey: provisions once in order (login, mint, add, register, save), then just re-derives', async () => {
  const secrets = await c.deriveFileverseSecrets(master)
  const chain = fakeChain()
  const logins = []
  const deps = { chain, urls: { storageUrl: base }, privyLogin: async ({ account }) => { logins.push(account.address); return { isNewUser: true } } }
  const first = await ensureApiKey(secrets, { deps })
  assert.equal(first.created, true)
  assert.equal(first.apiKey, V.fileverse.api_key)
  assert.deepEqual(logins, [V.fileverse.wallet_address])
  assert.deepEqual(chain.calls.map((x) => x[0]), ['mint', 'collaboratorAddress', 'addCollaborator', 'registerCollaboratorKeys'])
  assert.equal(chain.calls[0][1], V.fileverse.owner_agent_hex)
  assert.equal(chain.calls[0][2], V.fileverse.owner_did)
  assert.equal(chain.calls[1][1], V.fileverse.collaborator_key_hex)
  assert.equal(chain.calls[3][2], V.fileverse.collaborator_did)
  // what was saved opens with the API key and holds what @fileverse/api expects
  const rec = saved.get(V.fileverse.api_key_id)
  const { decryptSavedData } = await import('@fileverse/api/base')
  assert.deepEqual(await decryptSavedData(first.apiKey, rec.encryptedKeyMaterial), { apiKeySeed: first.apiKey, name: 'overkill', collaboratorAddress: '0x' + '33'.repeat(20), portalAddress: '0x' + '11'.repeat(20) })
  assert.deepEqual(await decryptSavedData(first.apiKey, rec.encryptedAppMaterial), { portalSeed: Buffer.from(c.fromHex(V.fileverse.portal_seed_hex)).toString('base64'), ownerAddress: '0x' + '22'.repeat(20), portalAddress: '0x' + '11'.repeat(20) })

  // second run (any machine with the vault): no login, no chain, same key
  const again = await ensureApiKey(secrets, { deps: { ...deps, chain: { walletAccount () { throw new Error('should not touch the chain') } } } })
  assert.deepEqual(again, { apiKey: first.apiKey, created: false })
  assert.equal(logins.length, 1)
})

test('ensureApiKey: a failure before the save leaves the key unregistered, so the next run starts over', async () => {
  const secrets = await c.deriveFileverseSecrets(c.randomBytes(32))
  const chain = fakeChain()
  chain.registerCollaboratorKeys = async () => { throw new Error('paymaster said no') }
  const deps = { chain, urls: { storageUrl: base }, privyLogin: async () => ({}) }
  await assert.rejects(ensureApiKey(secrets, { deps }), /paymaster said no/)
  assert.equal(saved.has(accountMaterial(secrets).apiKeyId), false)
})

test('the real chain side loads its optional dependencies (no network until used)', async () => {
  const { chainOps } = await import('../src/backends/fileverse-account.js')
  const ops = await chainOps(FILEVERSE)
  for (const f of ['walletAccount', 'mintPortal', 'addCollaborator', 'collaboratorAddress', 'registerCollaboratorKeys']) assert.equal(typeof ops[f], 'function')
  assert.equal(ops.walletAccount(c.fromHex(V.fileverse.wallet_hex)).address, V.fileverse.wallet_address)
})

test('ensureApiKey: resumes from saved progress without logging in or minting again', async () => {
  const secrets = await c.deriveFileverseSecrets(c.randomBytes(32))
  const state = (await import('../src/backends/fileverse-account.js')).memoryState()
  const chain = fakeChain()
  let fail = true
  chain.registerCollaboratorKeys = async () => { if (fail) throw new Error('bundler hiccup'); return { txHash: '0x' + 'dd'.repeat(32) } }
  let logins = 0
  const deps = { chain, urls: { storageUrl: base }, privyLogin: async () => { logins++; return {} } }
  await assert.rejects(ensureApiKey(secrets, { deps, state }), /bundler hiccup/)
  const st = await state.load()
  assert.equal(st.portalAddress, '0x' + '11'.repeat(20))
  assert.ok(st.privyLogin && st.addCollaboratorTx && !st.registerKeysTx)
  fail = false
  const res = await ensureApiKey(secrets, { deps, state })
  assert.equal(res.created, true)
  assert.equal(logins, 1, 'no second Privy login')
  assert.equal(chain.calls.filter((x) => x[0] === 'mint').length, 1, 'no second mint')
  assert.equal(chain.calls.filter((x) => x[0] === 'addCollaborator').length, 1)
  assert.equal((await state.load()).registerKeysTx, '0x' + 'dd'.repeat(32))
})

test('network reader: the title -> file map is scanned once, then only new files are fetched', async () => {
  const { makeNetworkReader } = await import('../src/backends/fileverse.js')
  const { encodeAbiParameters } = await import('viem')
  const { secp256k1 } = await import('@noble/curves/secp256k1.js')
  const { mapHashToField } = await import('@noble/curves/abstract/modular.js')
  const apiKeySeed = c.randomBytes(24)
  const apiKey = Buffer.from(apiKeySeed).toString('base64url')
  const portalSeed = c.randomBytes(48)
  const portal = '0x' + '44'.repeat(20)
  const appPub = secp256k1.getPublicKey(mapHashToField(portalSeed, secp256k1.Point.CURVE().n))
  const gcm = (key, iv, data) => { const e = nodeCrypto.createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([e.update(data), e.final()]); return [ct, e.getAuthTag()] }
  const eciesSeal = (msg) => { // @fileverse/crypto ECIES format
    const eph = secp256k1.utils.randomSecretKey()
    const ephPub = secp256k1.getPublicKey(eph)
    const key = nodeCrypto.hkdfSync('sha256', secp256k1.getSharedSecret(eph, appPub), ephPub, 'ECIES-AES256-GCM-SHA256', 32)
    const iv = c.randomBytes(12)
    const [ct, tag] = gcm(Buffer.from(key), iv, msg)
    return [ephPub, iv, ct, tag].map((b) => Buffer.from(b).toString('base64')).join('__n__')
  }
  const files = [] // { title, metaCid }
  const blobs = new Map()
  let metaFetches = 0
  const addFile = (title) => {
    const fileKey = c.randomBytes(32)
    const iv = c.randomBytes(24)
    const [ct, tag] = gcm(Buffer.from(fileKey), iv, Buffer.from(title))
    const cid = 'bafymeta' + files.length
    blobs.set(cid, JSON.stringify({ title: Buffer.concat([iv, ct, tag]).toString('base64'), appLock: { lockedFileKey: eciesSeal(fileKey) } }))
    files.push({ title, cid, ddocId: 'ddoc' + files.length })
  }
  const srv = http.createServer(async (req, res) => {
    const chunks = []
    for await (const ch of req) chunks.push(ch)
    if (req.url.startsWith('/api-access/')) return res.end(JSON.stringify({ encryptedAppMaterial: sealSaved(apiKeySeed, { portalSeed: Buffer.from(portalSeed).toString('base64'), portalAddress: portal }) }))
    if (req.url.startsWith('/ipfs/')) { metaFetches++; return res.end(blobs.get(req.url.slice(6))) }
    const { params } = JSON.parse(Buffer.concat(chunks))
    const data = params[0].data
    const result = data === '0xbab50cc9'
      ? encodeAbiParameters([{ type: 'uint256' }], [BigInt(files.length)])
      : (() => { const f = files[parseInt(data.slice(10), 16)]; return encodeAbiParameters([{ type: 'string' }, { type: 'uint8' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'address' }], [f.ddocId, 2, f.cid, 'bafycontent', 'bafygate', 0n, portal]) })()
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const u = `http://127.0.0.1:${srv.address().port}`
  let stored = null
  const cache = { load: async () => stored, save: async (v) => { stored = v } }
  const mk = () => makeNetworkReader({ apiKey: async () => apiKey, rpcUrl: u, gateways: [u + '/ipfs'], storageUrl: u, cache })
  try {
    addFile('a'); addFile('b'); addFile('a') // "a" rewritten as a new file: newest wins
    const idx1 = await mk().index()
    assert.deepEqual(idx1.get('a'), { fileId: 2, ddocId: 'ddoc2' })
    assert.equal(metaFetches, 3)
    assert.equal(stored.scanned, 3)
    const idx2 = await mk().index() // next run: nothing new, nothing fetched
    assert.equal(metaFetches, 3)
    assert.deepEqual(idx2.get('b'), { fileId: 1, ddocId: 'ddoc1' })
    addFile('c')
    const idx3 = await mk().index() // one new file, one fetch
    assert.equal(metaFetches, 4)
    assert.deepEqual([...idx3.keys()].sort(), ['a', 'b', 'c'])
    stored = { ...stored, portal: '0x' + '55'.repeat(20) } // cache of another portal: full rescan
    await mk().index()
    assert.equal(metaFetches, 8)
  } finally {
    srv.close()
  }
})
