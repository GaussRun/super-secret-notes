// Browser stand-in for overkill/cli/src/backends/cryptpad/client.js: the same client
// (client-core.js) with the browser's parts: scrypt in a Web Worker (CryptPad's parameters take
// 32 MiB and a moment), the page's WebSocket, and the login block written as a form POST (the
// instances answer no CORS preflight for the JSON one).
import Nacl from 'tweetnacl/nacl-fast';
import Crypto from 'chainpad-crypto';
import ChainPad from 'chainpad';
import CPNetflux from 'chainpad-netflux';
import Listmap from 'chainpad-listmap';
import Netflux from 'netflux-websocket';
import Sortify from 'json.sortify';
import Util from '$cli/backends/cryptpad/vendor/cryptpad/common-util.js';
import Hash from '$cli/backends/cryptpad/vendor/cryptpad/common-hash.js';
import Block from '$cli/backends/cryptpad/vendor/cryptpad/outer/login-block.js';
import Pinpad from '$cli/backends/cryptpad/vendor/cryptpad/pinpad.js';
import Realtime from '$cli/backends/cryptpad/vendor/cryptpad/common-realtime.js';
import { makeClient, formWriteLoginBlock } from '$cli/backends/cryptpad/client-core.js';
import { scrypt } from '../scrypt.js';

const client = makeClient({
	Nacl,
	Crypto,
	ChainPad,
	CPNetflux,
	Listmap,
	Netflux,
	Sortify,
	Util,
	Hash,
	Block,
	Pinpad,
	Realtime,
	scrypt: (password, salt) => scrypt(password, salt, { N: 256, r: 1024, p: 1, dkLen: 192 }),
	openSocket: (url) => new WebSocket(url),
	writeLoginBlock: formWriteLoginBlock({ Nacl, Util, Block })
});

export const { deriveKeys, connectNetwork, CryptPadSession, hashOf, fetchApiConfig, fetchAppConfig } = client;
export { Hash, Util, Sortify, Nacl };
