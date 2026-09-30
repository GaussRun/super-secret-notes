// Fileverse account for a vault, with no browser: everything is derived from the vault master
// (crypto.deriveFileverseSecrets), so any machine with the vault re-derives the same API key.
//
// Provisioning does what the official dDocs web app does when a wallet user turns on
// Developer Mode and generates an API key, with the same contracts, endpoints and formats
// (read from the app's JS and checked against the account made through the web UI):
// 1. log in to Privy (app clya4y8w2044hmfniynuamwjj) with SIWE / EIP-4361 as docs.fileverse.io
//    does: siwe/init, sign, siwe/authenticate, then sessions/logout (the app also logs out right
//    after; Fileverse's own services never see the Privy session)
// 2. mint the Developer Space portal on the API access registry, from a Safe owned by a derived
//    key (sponsored user operation through Fileverse's Pimlico proxy, as the app sends it)
// 3. addCollaborator(collaborator Safe) on the portal, from the owner Safe
// 4. registerCollaboratorKeys(collaborator DID) on the portal, from the collaborator Safe
// 5. POST the encrypted key material to apps-storage /api-access/save
// The collaborator keys come from the API key exactly as @fileverse/api derives them, so the
// library can use the key right away. The key material is saved last, so a registered key always
// has its collaborator; progress is recorded (addresses and tx hashes only) so a rerun resumes
// instead of logging in or minting again.
//
// Unlike the web app, no dDocs identity module is created: the Developer Space is not listed in
// the dDocs web UI for this wallet (logging in there would start an empty account).
//
// Nothing here sends a transaction from the wallet or signs anything but the SIWE message and
// the two portal user operations; user operations are sent only when the paymaster sponsors them.
import { createHash, hkdfSync, createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { mapHashToField } from '@noble/curves/abstract/modular.js'
import { base58 } from '@scure/base'

export const FILEVERSE = {
  privyUrl: 'https://auth.privy.io',
  privyAppId: 'clya4y8w2044hmfniynuamwjj',
  privyClient: 'react-auth:2.8.2',
  appOrigin: 'https://docs.fileverse.io',
  storageUrl: 'https://apps-storage.fileverse.io',
  proxyUrl: 'https://prod-apps-proxy-c15b7a0b0c75.herokuapp.com/api/pimlico',
  rpcUrl: 'https://rpc.gnosischain.com',
  chainId: 100,
  apiAccessRegistry: '0x94b1Eca21D327C4966F8F7547e2c21bDBd950b40',
  portalMetadataCid: 'bafybeiaykerbqrx2x6ofcvholtkkknueazwedakyb5tri2e2uu7von2yke',
  // Mint(address indexed app, uint256 indexed tokenId, address indexed owner, ...) on the registry
  mintTopic: '0xbcad3d7d3dfccb90d49c6063bf70f828901fefc88937d90af74e58e6e55bc39d'
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const hkdf0 = (ikm, info) => new Uint8Array(hkdfSync('sha256', ikm, new Uint8Array([0]), info, 32))
const sha256Hex = (b) => '0x' + createHash('sha256').update(b).digest('hex')

/** did:key for an ed25519 seed (multicodec 0xed01, base58btc). */
export const didKeyFromSeed = (seed) => 'did:key:z' + base58.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(seed)]))

/**
 * Everything that follows from the derived secrets, without network or optional dependencies.
 * collaboratorKey / collaboratorDid match @fileverse/api's deriveCollaboratorKeys (HKDF-SHA256,
 * salt 0x00, infos COLLABORATOR_PRIVATE_KEY and COLLABORATOR_UCAN_SECRET).
 */
export function accountMaterial (secrets) {
  const apiKey = b64url(secrets.apiKeySeed)
  const appPrivateKey = mapHashToField(secrets.portalSeed, secp256k1.Point.CURVE().n)
  const appPublicKey = secp256k1.getPublicKey(appPrivateKey)
  return {
    apiKey,
    apiKeyId: sha256Hex(secrets.apiKeySeed),
    portalSeedB64: Buffer.from(secrets.portalSeed).toString('base64'),
    ownerDid: didKeyFromSeed(secrets.ownerUcan),
    verifiers: { enc: sha256Hex(appPublicKey), dec: sha256Hex(appPrivateKey) },
    collaboratorKey: hkdf0(secrets.apiKeySeed, 'COLLABORATOR_PRIVATE_KEY'),
    collaboratorDid: didKeyFromSeed(hkdf0(secrets.apiKeySeed, 'COLLABORATOR_UCAN_SECRET'))
  }
}

/** @fileverse/crypto webcrypto aesEncrypt format: base64(nonce(24) || ciphertext || tag(16)). */
export function sealSaved (apiKeySeed, obj, nonce = randomBytes(24)) {
  const key = hkdf0(apiKeySeed, 'SAVED_DATA_ENCRYPTION_KEY')
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64')
}

/** The EIP-4361 message docs.fileverse.io asks a wallet to sign (checked against a real login). */
export function siweMessage ({ address, nonce, issuedAt }) {
  return [
    'docs.fileverse.io wants you to sign in with your Ethereum account:',
    address,
    '',
    'By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.',
    '',
    `URI: ${FILEVERSE.appOrigin}`,
    'Version: 1',
    `Chain ID: ${FILEVERSE.chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    'Resources:',
    '- https://privy.io'
  ].join('\n')
}

class BlockedError extends Error {}

/** Privy SIWE login + logout. Stops (never retries around it) if an anti-bot check answers. */
export async function privyLogin ({ account, urls = FILEVERSE }) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    origin: FILEVERSE.appOrigin,
    referer: FILEVERSE.appOrigin + '/',
    'privy-app-id': FILEVERSE.privyAppId,
    'privy-client': FILEVERSE.privyClient,
    'privy-ca-id': randomUUID()
  }
  const post = async (route, body, extra = {}) => {
    const res = await fetch(`${urls.privyUrl}/api/v1/${route}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    if (!json || /challenge-platform|cf-chl|captcha/i.test(text.slice(0, 2000))) {
      throw new BlockedError(`Privy ${route} answered with an anti-bot page or non-JSON (HTTP ${res.status}); not retrying around it`)
    }
    if (!res.ok) throw new Error(`Privy ${route} failed (HTTP ${res.status}): ${json.error ?? json.message ?? ''}`)
    return json
  }
  const { nonce } = await post('siwe/init', { address: account.address })
  const message = siweMessage({ address: account.address, nonce, issuedAt: new Date().toISOString() })
  const signature = await account.signMessage({ message })
  const auth = await post('siwe/authenticate', { message, signature, chainId: `eip155:${FILEVERSE.chainId}`, walletClientType: 'unknown', connectorType: 'injected', mode: 'login-or-sign-up' })
  // the tokens are only used to end the session again, as the web app does; never stored or logged
  await post('sessions/logout', { refresh_token: auth.refresh_token }, { authorization: `Bearer ${auth.token}` }).catch(() => {})
  return { privyUserId: auth.user?.id, isNewUser: !!auth.is_new_user }
}

/** GET /api-access/<id>: 200 when the key is registered, 404 when not. */
export async function apiKeyRegistered (apiKeyId, urls = FILEVERSE) {
  const res = await fetch(`${urls.storageUrl}/api-access/${apiKeyId}`)
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`Fileverse api-access lookup failed (HTTP ${res.status})`)
  return true
}

/** The default chain side: permissionless Safe accounts through Fileverse's paymaster proxy. */
export async function chainOps (urls) {
  let viem, aa, accounts, perm, safe, pimlicoMod, chains
  try {
    viem = await import('viem')
    aa = await import('viem/account-abstraction')
    accounts = await import('viem/accounts')
    chains = await import('viem/chains')
    perm = await import('permissionless')
    safe = await import('permissionless/accounts')
    pimlicoMod = await import('permissionless/clients/pimlico')
  } catch (err) {
    const e = new Error(`Fileverse needs the optional dependencies viem and permissionless (pnpm install): ${err.message}`)
    e.code = 'FILEVERSE_DEPS_MISSING'
    throw e
  }
  const pub = viem.createPublicClient({ chain: chains.gnosis, transport: viem.http(urls.rpcUrl) })
  const pimlico = pimlicoMod.createPimlicoClient({ transport: viem.http(urls.proxyUrl), entryPoint: { address: aa.entryPoint07Address, version: '0.7' } })
  async function safeFor (key) {
    const account = await safe.toSafeSmartAccount({ client: pub, owners: [accounts.privateKeyToAccount(viem.toHex(key))], entryPoint: { address: aa.entryPoint07Address, version: '0.7' }, version: '1.4.1' })
    const client = perm.createSmartAccountClient({ account, chain: chains.gnosis, paymaster: pimlico, bundlerTransport: viem.http(urls.proxyUrl), userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast } })
    return {
      address: account.address,
      async send (to, data) {
        const op = await client.prepareUserOperation({ calls: [{ to, value: 0n, data }] })
        if (!op.paymaster) throw new Error('Fileverse paymaster did not sponsor the operation; refusing to pay gas')
        // prepare fills in a stub signature for estimation; sign the final operation
        const hash = await client.sendUserOperation({ ...op, signature: await account.signUserOperation(op) })
        const receipt = await pimlico.waitForUserOperationReceipt({ hash, timeout: 180000 })
        if (!receipt.success) throw new Error(`user operation ${hash} failed: ${receipt.reason ?? 'reverted'}`)
        return { userOpHash: hash, txHash: receipt.receipt.transactionHash, logs: receipt.logs }
      }
    }
  }
  const abi = viem.parseAbi(['function mint(string metadataIPFSHash, string ownerDid, bytes32 appEncryptionKeyVerifier, bytes32 appDecryptionKeyVerifier)', 'function addCollaborator(address collaborator)', 'function registerCollaboratorKeys(string did)'])
  const enc = (functionName, args) => viem.encodeFunctionData({ abi, functionName, args })
  return {
    walletAccount: (key) => accounts.privateKeyToAccount(viem.toHex(key)),
    async mintPortal (ownerKey, ownerDid, verifiers) {
      const owner = await safeFor(ownerKey)
      const r = await owner.send(urls.apiAccessRegistry, enc('mint', [urls.portalMetadataCid, ownerDid, verifiers.enc, verifiers.dec]))
      const log = r.logs.find((l) => l.address.toLowerCase() === urls.apiAccessRegistry.toLowerCase() && l.topics[0] === urls.mintTopic)
      if (!log) throw new Error(`no Mint event in ${r.txHash}`)
      return { portalAddress: viem.getAddress('0x' + log.topics[1].slice(26)), ownerAddress: owner.address, txHash: r.txHash }
    },
    async addCollaborator (ownerKey, portalAddress, collaboratorAddress) {
      return (await safeFor(ownerKey)).send(portalAddress, enc('addCollaborator', [collaboratorAddress]))
    },
    async collaboratorAddress (collaboratorKey) { return (await safeFor(collaboratorKey)).address },
    async registerCollaboratorKeys (collaboratorKey, portalAddress, did) {
      return (await safeFor(collaboratorKey)).send(portalAddress, enc('registerCollaboratorKeys', [did]))
    }
  }
}

/**
 * Returns the vault's API key, creating the account first if Fileverse does not know it yet.
 * deps (tests) replaces the chain side and/or the URLs. report(msg) gets progress lines.
 */
export async function ensureApiKey (secrets, { name = 'fileverse', report = () => {}, deps = {}, state = memoryState() } = {}) {
  const urls = { ...FILEVERSE, ...deps.urls }
  const m = accountMaterial(secrets)
  if (await apiKeyRegistered(m.apiKeyId, urls)) return { apiKey: m.apiKey, created: false }

  // progress survives a crash: a rerun skips the steps already done (nothing secret is kept)
  const st = { ...(await state.load()) }
  const done = async (patch) => { Object.assign(st, patch); await state.save(st) }
  const chain = deps.chain ?? await chainOps(urls)
  const wallet = chain.walletAccount(secrets.wallet)
  if (st.wallet && st.wallet !== wallet.address) throw new Error(`${name}: saved setup state is for another wallet (${st.wallet})`)
  report(`${name}: setting up this vault's Fileverse account for wallet ${wallet.address} (one time, about a minute)`)
  if (!st.privyLogin) {
    const login = await (deps.privyLogin ?? privyLogin)({ account: wallet, urls })
    await done({ wallet: wallet.address, privyLogin: new Date().toISOString(), privyNewUser: login.isNewUser })
  }
  if (!st.portalAddress) {
    const minted = await chain.mintPortal(secrets.ownerAgent, m.ownerDid, m.verifiers)
    await done({ portalAddress: minted.portalAddress, ownerAddress: minted.ownerAddress, mintTx: minted.txHash })
    report(`${name}: Developer Space portal ${minted.portalAddress} (tx ${minted.txHash})`)
  }
  const collaboratorAddress = await chain.collaboratorAddress(m.collaboratorKey)
  if (!st.addCollaboratorTx) await done({ addCollaboratorTx: (await chain.addCollaborator(secrets.ownerAgent, st.portalAddress, collaboratorAddress)).txHash })
  if (!st.registerKeysTx) await done({ registerKeysTx: (await chain.registerCollaboratorKeys(m.collaboratorKey, st.portalAddress, m.collaboratorDid)).txHash })
  const body = {
    encryptedKeyMaterial: sealSaved(secrets.apiKeySeed, { apiKeySeed: m.apiKey, name: 'overkill', collaboratorAddress, portalAddress: st.portalAddress }),
    encryptedAppMaterial: sealSaved(secrets.apiKeySeed, { portalSeed: m.portalSeedB64, ownerAddress: st.ownerAddress, portalAddress: st.portalAddress }),
    id: m.apiKeyId
  }
  const res = await fetch(`${urls.storageUrl}/api-access/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`Fileverse api-access/save failed (HTTP ${res.status})`)
  if (!await apiKeyRegistered(m.apiKeyId, urls)) throw new Error('Fileverse did not register the API key')
  await done({ saved: new Date().toISOString() })
  return { apiKey: m.apiKey, created: true, wallet: wallet.address, portalAddress: st.portalAddress, collaboratorAddress, steps: { ...st } }
}

/** Setup progress kept in memory only (tests); the backend passes a file-backed one. */
export function memoryState () {
  let v = {}
  return { load: async () => v, save: async (x) => { v = { ...x } } }
}

export { BlockedError }
