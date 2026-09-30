// scrypt off the main thread when the page has workers (the UI keeps moving during CryptPad's
// 32 MiB derivation); in place otherwise (Node, tests).
import { scryptAsync } from '@noble/hashes/scrypt.js';

let worker = null;
let serial = 0;
const pending = new Map();

function getWorker() {
	if (worker || typeof Worker === 'undefined') return worker;
	try {
		worker = new Worker(new URL('./scrypt.worker.js', import.meta.url), { type: 'module' });
		worker.onmessage = ({ data }) => {
			const p = pending.get(data.id);
			pending.delete(data.id);
			if (!p) return;
			if (data.error) p.reject(new Error(data.error));
			else p.resolve(new Uint8Array(data.key));
		};
		worker.onerror = (e) => {
			for (const p of pending.values()) p.reject(new Error(`scrypt worker: ${e.message ?? 'failed'}`));
			pending.clear();
		};
	} catch {
		worker = null;
	}
	return worker;
}

/** scrypt(password, salt, { N, r, p, dkLen }) -> Uint8Array */
export function scrypt(password, salt, opts) {
	const w = getWorker();
	if (!w) return scryptAsync(password, salt, { ...opts, maxmem: 2 ** 30 });
	const id = ++serial;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		w.postMessage({ id, password, salt, opts });
	});
}
