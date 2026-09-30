// The only thing this page persists: encrypted blobs in IndexedDB (vault.age, config.ovk,
// index-cache.ovk, secrets.ovk). Keys and plaintext stay in memory; a reload means unlocking again.
const DB = 'overkill-notes';
const STORE = 'blobs';

export const FILES = {
	vault: 'vault.age',
	config: 'config.ovk',
	indexCache: 'index-cache.ovk',
	secrets: 'secrets.ovk'
} as const;

// Public-computer mode: the same files, kept in this tab's memory only. Nothing reaches
// IndexedDB while it is on; a reload (or "Done: wipe this tab") forgets everything.
let memory: Map<string, Uint8Array> | null = null;

export const isEphemeral = () => memory !== null;

/** Switch to memory-only storage, starting from `seed` (the files an unlock just read). */
export function goEphemeral(seed: Record<string, Uint8Array | null> = {}) {
	memory = new Map(Object.entries(seed).filter((e): e is [string, Uint8Array] => e[1] !== null));
}

/** Drop the in-memory files and go back to IndexedDB. */
export function endEphemeral() {
	memory?.clear();
	memory = null;
}

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB would not open'));
		req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
	});
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await open();
	try {
		return await new Promise<T>((resolve, reject) => {
			const t = db.transaction(STORE, mode);
			const req = fn(t.objectStore(STORE));
			t.oncomplete = () => resolve(req.result);
			t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
			t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
		});
	} finally {
		db.close();
	}
}

/** The stored bytes, or null (missing, or storage unavailable: private mode, blocked site data). */
export async function readBlob(name: string): Promise<Uint8Array | null> {
	if (memory) return memory.get(name) ?? null;
	try {
		const v = await tx('readonly', (s) => s.get(name));
		return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
	} catch (err) {
		console.debug(`overkill: IndexedDB read ${name}: ${(err as Error).message}`);
		return null;
	}
}

/** Throws when the browser refuses to store (the caller says so on the page). */
export async function writeBlob(name: string, bytes: Uint8Array): Promise<void> {
	if (memory) return void memory.set(name, new Uint8Array(bytes));
	try {
		await tx('readwrite', (s) => s.put(new Uint8Array(bytes), name));
	} catch (err) {
		throw new Error(`this browser would not save ${name} (${(err as Error).message}); private mode?`);
	}
}

/** Forget this device's copy of the vault (the copies on the hosts stay). */
export async function clearAll(): Promise<void> {
	if (memory) return memory.clear();
	try {
		await tx('readwrite', (s) => s.clear());
	} catch (err) {
		throw new Error(`could not clear this browser's storage: ${(err as Error).message}`);
	}
}

/** Clear IndexedDB itself, whatever the mode ("Done: wipe this tab"). */
export async function clearStored(): Promise<void> {
	const was = memory;
	memory = null;
	try {
		await clearAll();
	} finally {
		memory = was;
	}
}

/** { read, write } over one blob, the shape the CLI's store and secret store expect. */
export function blobIo(name: string) {
	return { read: () => readBlob(name), write: (bytes: Uint8Array) => writeBlob(name, bytes) };
}
