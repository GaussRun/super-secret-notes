// The web client's CryptPad backend (the CLI adapter and drive with the browser client shim:
// form-encoded WRITE_BLOCK, noble scrypt, the global WebSocket) against the fake instance.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as c from '$cli/crypto.js';
import { SecretStoreCore } from '$cli/vaultsecrets-core.js';
import { makeBackends } from './backends';
import { startFakeCryptpad, type FakeCryptpad } from '../../../e2e/fake-cryptpad';

let fake: FakeCryptpad;
beforeAll(async () => {
	fake = await startFakeCryptpad();
});
afterAll(async () => {
	await fake?.close();
});

async function adapter(keys: Awaited<ReturnType<typeof c.unlockKeys>>) {
	const secrets = await new SecretStoreCore(null).unlock(keys);
	const [b] = makeBackends({ root: 'ovk', backends: [{ name: 'cp-fake', type: 'cryptpad', origin: fake.url, derived: true }] }, secrets);
	b.unlock(keys);
	return b;
}

describe('CryptPad from the web client', () => {
	test('registers the derived account with form posts, then put, get, overwrite, list', { timeout: 60_000 }, async () => {
		const keys = await c.unlockKeys(await c.createVault());
		const b = await adapter(keys);
		const bytes = c.randomBytes(5000);
		await b.put('notes/a.ovk', bytes);
		expect(fake.authRequests).toEqual(['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded']);
		expect(fake.blocks.size).toBe(1);
		expect(await b.get('notes/a.ovk')).toEqual(bytes);
		expect(await b.get('notes/missing.ovk')).toBeNull();
		await b.put('notes/a.ovk', new Uint8Array([7]));
		expect(await b.get('notes/a.ovk')).toEqual(new Uint8Array([7]));
		expect(await b.list('notes')).toEqual(['a.ovk']);
		const { username } = await c.deriveCryptpadCredentials(keys.master, new URL(fake.url).host);
		expect(await b.accountName()).toBe(username);
		await b.close();

		// a second session (another device) logs into the same account and sees the same drive
		const again = await adapter(keys);
		expect(await again.get('notes/a.ovk')).toEqual(new Uint8Array([7]));
		expect(fake.blocks.size).toBe(1);
		await again.close();
	});
});
