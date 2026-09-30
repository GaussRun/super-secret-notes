// Web Worker: one scrypt per message ({ id, password, salt, opts } -> { id, key } or { id, error }).
import { scryptAsync } from '@noble/hashes/scrypt.js';

self.onmessage = async ({ data }) => {
	try {
		const key = await scryptAsync(data.password, data.salt, { ...data.opts, maxmem: 2 ** 30 });
		self.postMessage({ id: data.id, key: key.buffer }, [key.buffer]);
	} catch (err) {
		self.postMessage({ id: data.id, error: err?.message ?? String(err) });
	}
};
