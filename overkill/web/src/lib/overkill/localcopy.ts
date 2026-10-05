// A restored backup lives on in this browser as a backend of its own ("this browser"): every blob
// of the backup, still encrypted, in IndexedDB. Reads are instant and need no host, and Repair
// copies from it back to the hosts. Web-only: it is not in the vault config or the recovery record.
import { toBase64, fromBase64 } from '$cli/crypto.js';
import { FILES, readBlob, writeBlob } from './idb';

const enc = new TextEncoder();
const dec = new TextDecoder();

export type LocalFiles = Record<string, string>; // path -> base64 of the encrypted blob

export async function readLocalCopy(): Promise<LocalFiles | null> {
	const bytes = await readBlob(FILES.localCopy);
	return bytes ? (JSON.parse(dec.decode(bytes)) as LocalFiles) : null;
}

export async function writeLocalCopy(files: LocalFiles) {
	await writeBlob(FILES.localCopy, enc.encode(JSON.stringify(files)));
}

/** The adapter (the same shape as the CLI's backends). */
export function localCopyBackend(files: LocalFiles) {
	return {
		name: 'this-browser',
		type: 'backup',
		where: 'this browser (restored backup)',
		addressing: 'path',
		async put(rel: string, bytes: Uint8Array) {
			files[rel] = toBase64(bytes);
			await writeLocalCopy(files);
		},
		async get(rel: string) {
			return files[rel] ? fromBase64(files[rel]) : null;
		},
		async exists(rel: string) {
			return rel in files;
		},
		async list(dir: string) {
			const prefix = dir ? `${dir}/` : '';
			return Object.keys(files).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length));
		},
		async close() {}
	};
}
