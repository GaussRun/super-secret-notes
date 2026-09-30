// Minimal headless CryptPad client: login, drive (user object) access, pad read/write, pinning.
// Reuses CryptPad's own client modules (see vendor.sh) plus the chainpad/netflux npm packages.
// No Node or browser APIs are touched directly: the caller passes the modules and the platform
// parts (scrypt, WebSocket, optionally how to write the login block). client.js wires it for
// Node; the web client wires it for the browser.
import { fetchApiConfig, fetchAppConfig } from './config.js';

/**
 * @param {object} deps
 * @param {any} deps.Nacl tweetnacl
 * @param {any} deps.Crypto chainpad-crypto
 * @param {any} deps.ChainPad
 * @param {any} deps.CPNetflux chainpad-netflux
 * @param {any} deps.Listmap chainpad-listmap
 * @param {any} deps.Netflux netflux-websocket
 * @param {any} deps.Sortify json.sortify
 * @param {any} deps.Util vendored common-util
 * @param {any} deps.Hash vendored common-hash
 * @param {any} deps.Block vendored outer/login-block
 * @param {any} deps.Pinpad vendored pinpad
 * @param {any} deps.Realtime vendored common-realtime
 * @param {(password: Uint8Array, salt: Uint8Array) => Promise<Uint8Array>} deps.scrypt CryptPad's
 *   parameters: N = 2^8, r = 1024, p = 1, 192 bytes
 * @param {(url: string, origin: string) => any} deps.openSocket a WebSocket to the instance
 * @param {(o: {api: any, blockKeys: any, content: object}) => Promise<void>} [deps.writeLoginBlock]
 *   default: the vendored Block.writeLoginBlock (a JSON POST to /api/auth)
 * @param {number} [deps.padTimeoutMs]
 * @param {(...a: any[]) => void} [deps.log]
 */
export function makeClient(deps) {
const { Nacl, Crypto, ChainPad, CPNetflux, Listmap, Netflux, Sortify, Util, Hash, Block, Pinpad, Realtime } = deps;
const PAD_TIMEOUT_MS = deps.padTimeoutMs ?? 30000;
const log = deps.log ?? (() => {});

function vendorWriteLoginBlock({ api, blockKeys, content }) {
  Block.setCustomize({ ApiConfig: api });
  return new Promise((resolve, reject) => Block.writeLoginBlock({ pw: true, blockKeys, content },
    (e, res) => (e ? reject(new Error(`WRITE_BLOCK failed: ${e}${res ? ' ' + JSON.stringify(res) : ''}`)) : resolve(res))));
}

// Same derivation as common-credential.js + common-login.js allocateBytes():
// scrypt(password, salt = lowercase username + loginSalt, N = 2^8, r = 1024, p = 1, 192 bytes).
async function deriveKeys(username, password, loginSalt = '') {
  const enc = new TextEncoder();
  const bytes = await deps.scrypt(enc.encode(password), enc.encode(username.toLowerCase() + loginSalt));
  let used = 0;
  const take = (n) => bytes.slice(used, (used += n));
  const encryptionSeed = take(18);
  const channelSeed = take(16);
  const curveSeed = take(32);
  const edSeed = take(32);
  const blockKeys = Block.genkeys(take(64));
  return { encryptionSeed, channelSeed, curveSeed, edSeed, blockKeys };
}

function blockUrl(fileHost, blockKeys) {
  const pub = Util.encodeBase64(blockKeys.sign.publicKey).replace(/\//g, '-');
  return `${fileHost}/block/${pub.slice(0, 2)}/${pub}`;
}

async function connectNetwork(wsUrl, origin) {
  return Netflux.connect(wsUrl, (u) => deps.openSocket(u, origin));
}

class CryptPadSession {
  static async login({ origin, user, pass }) {
    const s = new CryptPadSession();
    s.origin = origin;
    const t0 = Date.now();
    s.api = await fetchApiConfig(origin);
    const app = await fetchAppConfig(origin);
    const keys = await deriveKeys(user, pass, app.loginSalt);
    log(`scrypt ${Date.now() - t0} ms`);
    const url = blockUrl(s.api.fileHost || origin, keys.blockKeys);
    const res = await fetch(url);
    if (res.status === 404) throw Object.assign(new Error('NO_SUCH_USER (no login block; legacy accounts unsupported)'), { code: 'NO_SUCH_USER' });
    if (res.status === 401) throw new Error('ACCOUNT_HAS_2FA (TOTP login not implemented)');
    if (!res.ok) throw new Error(`block fetch failed: HTTP ${res.status}`);
    const blockInfo = Block.decrypt(new Uint8Array(await res.arrayBuffer()), keys.blockKeys);
    if (!blockInfo || !blockInfo.User_hash) throw new Error('BLOCK_DECRYPTION_ERROR');
    s.blockInfo = blockInfo;
    s.userSecret = Hash.getSecrets('drive', blockInfo.User_hash);
    s.network = await connectNetwork(s.api.websocketPath, origin);
    await s.#loadUserObject();
    log(`login ${Date.now() - t0} ms`);
    return s;
  }

  // Registers a new account the way common-login.js loginOrRegister does for a new user:
  // a fresh drive (random v2 hash, random account keys) plus a login block, written through
  // the /api/auth WRITE_BLOCK command and signed with the password-derived block key.
  static async register({ origin, user, pass }) {
    const api = await fetchApiConfig(origin);
    if (api.restrictRegistration) throw new Error(`${origin} does not allow registration`);
    const app = await fetchAppConfig(origin);
    if (pass.length < app.minimumPasswordLength) throw new Error(`${origin} wants passwords of at least ${app.minimumPasswordLength} characters`);
    const keys = await deriveKeys(user, pass, app.loginSalt);
    const url = blockUrl(api.fileHost || origin, keys.blockKeys);
    const existing = await fetch(url);
    if (existing.ok || existing.status === 401) throw Object.assign(new Error('ALREADY_REGISTERED'), { code: 'ALREADY_REGISTERED' });

    const ed = Nacl.sign.keyPair();
    const curve = Nacl.box.keyPair();
    const edPublic = Util.encodeBase64(ed.publicKey);
    const userHash = Hash.createRandomHash('drive');
    const s = new CryptPadSession();
    s.origin = origin;
    s.api = api;
    s.blockInfo = { User_hash: userHash, edPublic };
    s.userSecret = Hash.getSecrets('drive', userHash);
    s.network = await connectNetwork(api.websocketPath, origin);
    try {
      await s.#loadUserObject();
      const proxy = s.proxy;
      if (Object.keys(proxy).some((k) => k !== 'on' && k !== '_events')) throw new Error('new drive is not empty');
      proxy.edPublic = edPublic;
      proxy.edPrivate = Util.encodeBase64(ed.secretKey);
      proxy.curvePublic = Util.encodeBase64(curve.publicKey);
      proxy.curvePrivate = Util.encodeBase64(curve.secretKey);
      proxy.login_name = user.toLowerCase();
      proxy['cryptpad.username'] = user.toLowerCase();
      proxy.version = 11;
      proxy.drive = { root: {}, trash: {}, filesData: {} };
      await s.syncDrive();
      await (deps.writeLoginBlock ?? vendorWriteLoginBlock)({ api, blockKeys: keys.blockKeys, content: { User_hash: userHash, edPublic } });
      const check = await fetch(url);
      if (!check.ok) throw new Error(`login block not readable after registration: HTTP ${check.status}`);
      // keep the drive itself alive like any other pinned document
      await s.pin([s.userSecret.channel]);
    } finally {
      s.close();
    }
  }

  #loadUserObject() {
    const secret = this.userSecret;
    return new Promise((resolve, reject) => {
      const rt = Listmap.create({
        network: this.network,
        channel: secret.channel,
        data: {},
        validateKey: secret.keys.validateKey,
        crypto: Crypto.createEncryptor(secret.keys),
        logLevel: 0,
        classic: true,
        ChainPad,
        owners: [this.blockInfo.edPublic],
      });
      this.rt = rt;
      this.proxy = rt.proxy;
      rt.proxy.on('ready', () => resolve())
        .on('error', (info) => reject(new Error(`user object: ${info.type} ${info.message}`)))
        .on('disconnect', () => log('user object disconnected'));
    });
  }

  get edPublic() { return this.proxy.edPublic; }

  // Resolves once the local user-object changes are acknowledged by the server.
  syncDrive() {
    return new Promise((resolve) => setTimeout(() => Realtime.whenRealtimeSyncs(this.rt.realtime, resolve)));
  }

  async rpc() {
    if (this._rpc) return this._rpc;
    this._rpc = await new Promise((resolve, reject) => {
      Pinpad.create(this.network, { edPrivate: this.proxy.edPrivate, edPublic: this.proxy.edPublic }, (e, call) => {
        if (e) return reject(new Error(`rpc: ${e}`));
        resolve(call);
      });
    });
    return this._rpc;
  }

  // Open a pad channel with chainpad; `onReady` gets the realtime object once history is loaded.
  #openPad(secret, extra = {}) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        try { session.stop(); } catch { /* not started */ }
        reject(new Error(`pad open timeout (${PAD_TIMEOUT_MS} ms) for channel ${secret.channel}`));
      }, PAD_TIMEOUT_MS);
      const session = CPNetflux.start({
        network: this.network,
        channel: secret.channel,
        validateKey: secret.keys.validateKey || undefined,
        crypto: Crypto.createEncryptor(secret.keys),
        logLevel: 0,
        ChainPad,
        onReady: (info) => { clearTimeout(to); resolve({ session, realtime: info.realtime }); },
        onError: (info) => { clearTimeout(to); reject(new Error(`pad error: ${JSON.stringify(info)}`)); },
        onChannelError: (info) => { clearTimeout(to); reject(new Error(`pad channel error: ${JSON.stringify(info)}`)); },
        ...extra,
      });
    });
  }

  async readPad(href) {
    const secret = Hash.getSecrets('pad', hashOf(href));
    const { session, realtime } = await this.#openPad(secret);
    const doc = realtime.getUserDoc();
    session.stop();
    return doc;
  }

  // Replace the whole document of a pad (creating the channel if new). `owners` only applies on creation.
  async writePad(href, docString, { owners } = {}) {
    const secret = Hash.getSecrets('pad', hashOf(href));
    const { session, realtime } = await this.#openPad(secret, owners ? { owners } : {});
    realtime.contentUpdate(docString);
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('pad sync timeout (60 s)')), 60000);
      Realtime.whenRealtimeSyncs(realtime, () => { clearTimeout(to); resolve(); });
    });
    const ok = realtime.getAuthDoc() === docString;
    session.stop();
    if (!ok) throw new Error('pad write did not converge to the expected document');
    return { channel: secret.channel };
  }

  async pin(channels) {
    const call = await this.rpc();
    return new Promise((resolve, reject) => {
      call.pin(channels, (e, hash) => (e ? reject(new Error(`pin: ${e}`)) : resolve(hash)));
    });
  }

  async unpin(channels) {
    const call = await this.rpc();
    return new Promise((resolve, reject) => {
      call.unpin(channels, (e, hash) => (e ? reject(new Error(`unpin: ${e}`)) : resolve(hash)));
    });
  }

  // Deletes an owned channel (history and all) on the server.
  async removeOwnedChannel(channel) {
    const call = await this.rpc();
    return new Promise((resolve, reject) => {
      call.removeOwnedChannel(channel, (e) => (e ? reject(new Error(`removeOwnedChannel: ${e}`)) : resolve()));
    });
  }

  async usage() {
    const call = await this.rpc();
    const get = (fn) => new Promise((resolve, reject) => call[fn]((e, v) => (e ? reject(new Error(`${fn}: ${e}`)) : resolve(v))));
    return { usedBytes: await get('getFileListSize'), limit: await get('getLimit') };
  }

  close() {
    try { this.network.disconnect(); } catch { /* already closed */ }
  }
}

function hashOf(href) {
  const i = href.indexOf('#');
  return i === -1 ? href : href.slice(i + 1);
}

return { deriveKeys, connectNetwork, CryptPadSession, hashOf, Hash, Util, Sortify, Nacl, fetchApiConfig, fetchAppConfig };
}

/**
 * WRITE_BLOCK through /api/auth as CORS simple requests (application/x-www-form-urlencoded), for
 * browsers: instances answer no preflight for the JSON POST the vendored http-command.js makes,
 * but the server also parses urlencoded bodies (body-parser, extended). The server signs over
 * JSON.stringify of the body as it parsed it, where every value is a string, so the request
 * carries strings only (hasPassword as "true"; the server does not read it) and the signature
 * covers exactly that object.
 */
export function formWriteLoginBlock({ Nacl, Util, Block }, fetchImpl = globalThis.fetch) {
  const form = (obj, prefix = '', params = new URLSearchParams()) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v && typeof v === 'object') form(v, key, params);
      else params.append(key, v);
    }
    return params;
  };
  const post = async (url, obj) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(obj).toString() });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    if (!res.ok) throw new Error(`WRITE_BLOCK failed: HTTP ${res.status}${json?.error ? ` ${json.error}` : ''}`);
    return json;
  };
  return async ({ api, blockKeys, content }) => {
    const block = Block.serialize(JSON.stringify(content), blockKeys);
    const obj = {
      command: 'WRITE_BLOCK',
      content: { ...block, hasPassword: 'true' },
      publicKey: Util.encodeBase64(blockKeys.sign.publicKey),
      nonce: Util.encodeBase64(Nacl.randomBytes(24)),
    };
    const url = new URL('/api/auth/', api.httpUnsafeOrigin).href;
    const challenge = await post(url, obj);
    if (!challenge?.txid || !challenge?.date) throw new Error('WRITE_BLOCK: the server sent no challenge');
    const signed = JSON.stringify({ ...obj, txid: challenge.txid, date: challenge.date });
    const sig = Util.encodeBase64(Nacl.sign.detached(Util.decodeUTF8(signed), blockKeys.sign.secretKey));
    await post(url, { sig, txid: challenge.txid });
  };
}
