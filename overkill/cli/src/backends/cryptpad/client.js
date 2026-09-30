// Minimal headless CryptPad client for Node: the logic is in client-core.js; this wires in
// CryptPad's own client modules (see vendor.sh), the chainpad/netflux npm packages, Node's scrypt
// and the ws package.
import { createRequire } from 'node:module';
import { scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import WS from 'ws';
import { makeClient } from './client-core.js';

const require = createRequire(import.meta.url);
const scryptAsync = promisify(scrypt);

const client = makeClient({
  Nacl: require('tweetnacl/nacl-fast'),
  Crypto: require('chainpad-crypto'),
  ChainPad: require('chainpad'),
  CPNetflux: require('chainpad-netflux'),
  Listmap: require('chainpad-listmap'),
  Netflux: require('netflux-websocket'),
  Sortify: require('json.sortify'),
  Util: require('./vendor/cryptpad/common-util.js'),
  Hash: require('./vendor/cryptpad/common-hash.js'),
  Block: require('./vendor/cryptpad/outer/login-block.js'),
  Pinpad: require('./vendor/cryptpad/pinpad.js'),
  Realtime: require('./vendor/cryptpad/common-realtime.js'),
  // common-credential.js + common-login.js allocateBytes(): N = 2^8, r = 1024, p = 1, 192 bytes
  scrypt: async (password, salt) => new Uint8Array(await scryptAsync(password, salt, 192, { N: 256, r: 1024, p: 1, maxmem: 256 * 1024 * 1024 })),
  // explicit Origin header: browsers send one, Node does not
  openSocket: (url, origin) => new WS(url, { headers: { Origin: origin } }),
  padTimeoutMs: Number(process.env.CP_PAD_TIMEOUT_MS || 30000),
  log: (...a) => { if (process.env.CP_DEBUG) console.error('[cryptpad]', ...a); },
});

export const { deriveKeys, connectNetwork, CryptPadSession, hashOf, Hash, Util, Sortify, Nacl, fetchApiConfig, fetchAppConfig } = client;
