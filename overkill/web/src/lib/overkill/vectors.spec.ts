// The CLI's known-answer vectors (overkill/cli/test/vectors.json), run against the same modules
// the web build bundles. Runs twice: in Node and in headless Chromium (vite.config.ts projects).
import { describe, expect, test } from 'vitest';
import V from '../../../../cli/test/vectors.json';
import * as c from '$cli/crypto.js';
import { discoveryIdentity } from '$cli/bootstrap.js';
import { identity, sealEvents, openEvents, CHUNK } from '$cli/backends/nostr.js';
import { sealPaste, openPaste } from '$cli/backends/privatebin.js';
import { sealBlob, openBlob } from '$cli/backends/blossom.js';
import { parseKit, recoveryKit } from '$cli/kit.js';
import { generatePassphrase, estimateBits, isStrongEnough, WORDS } from './passphrase';

const keys = await c.unlockKeys(V.decrypt.vault);
const flip = (bytes: Uint8Array, i: number) => {
	const out = Uint8Array.from(bytes);
	out[i] ^= 0x01;
	return out;
};

describe('known-answer vectors from the CLI', () => {
	test('derived keys: aes, name, nostr, blossom, npub', async () => {
		const master = c.fromHex(V.derivation.master_hex);
		expect(c.fromBase64(V.derivation.master_b64)).toEqual(master);
		const raw = await c.deriveRawKeys(master);
		expect(c.toHex(raw.aes)).toBe(V.derivation.k_aes_hex);
		expect(c.toHex(raw.name)).toBe(V.derivation.k_name_hex);
		expect(c.toHex(raw.nostr)).toBe(V.derivation.k_nostr_hex);
		expect(c.toHex(raw.blossom)).toBe(V.derivation.k_blossom_hex);
		const id = identity(raw.nostr);
		expect(id.pubkey).toBe(V.derivation.nostr_pubkey_hex);
		expect(id.npub).toBe(V.derivation.nostr_npub);
	});

	test('blob ids, NFD and NFC spellings share one', async () => {
		for (const { name, blob_id } of V.blob_ids) expect(await c.blobIdForName(keys, name)).toBe(blob_id);
		expect(V.blob_ids[3].name).toBe(V.blob_ids[2].name.normalize('NFD'));
		expect(V.blob_ids[3].blob_id).toBe(V.blob_ids[2].blob_id);
	});

	test('AES layer', async () => {
		const a = V.aes_layer;
		const blob = await c.aesSeal(keys, a.blob_id, c.fromHex(a.inner_hex), c.fromHex(a.nonce_hex));
		expect(c.toHex(blob)).toBe(a.blob_hex);
		expect(c.toHex(await c.aesOpen(keys, a.blob_id, blob))).toBe(a.inner_hex);
	});

	test('sample note, index and vault.age decrypt', async () => {
		const d = V.decrypt;
		expect(keys.ageRecipient).toBe(d.age_recipient);
		const note = await c.decryptBlob(keys, d.note.blob_id, c.fromHex(d.note.blob_hex));
		expect(new TextDecoder().decode(note)).toBe(d.note.plaintext);
		expect(await c.decryptIndex(keys, c.fromHex(d.index.blob_hex))).toEqual(d.index.plaintext);
		expect(await c.decryptVault(c.fromHex(d.vault_age.hex), d.vault_age.passphrase)).toEqual(d.vault);
	});

	test('index merge, in both input orders', () => {
		for (const m of V.merge) {
			expect(c.mergeIndexes(...m.inputs), m.why).toEqual(m.expected);
			expect(c.mergeIndexes(...[...m.inputs].reverse()), m.why).toEqual(m.expected);
		}
	});

	test('derived CryptPad credentials', async () => {
		const master = c.fromHex(V.derivation.master_hex);
		for (const v of V.cryptpad_credentials) {
			expect(await c.deriveCryptpadCredentials(master, v.host)).toEqual({ username: v.username, password: v.password });
		}
	});

	test('discovery keys (scrypt N=2^18)', { timeout: 120_000 }, async () => {
		for (const x of V.discovery.cases) {
			const id = await discoveryIdentity(x.passphrase, x.vault_name);
			expect(c.toHex(id.secret)).toBe(x.secret_hex);
			expect(id.pubkey).toBe(x.pubkey_hex);
			expect(id.npub).toBe(x.npub);
		}
	});

	test('discovery record d tags', async () => {
		for (const x of V.discovery_tags.cases) {
			expect(await c.deriveDiscoveryTags(c.fromHex(x.secret_hex))).toEqual({ 'vault.age': x['vault.age'], 'bootstrap.json': x['bootstrap.json'] });
		}
	});
});

describe('the layers the browser adds', () => {
	test('two-layer round trip and tamper detection', async () => {
		const id = await c.blobIdForName(keys, 'groceries');
		const blob = await c.encryptBlob(keys, id, 'milk');
		expect(new TextDecoder().decode(await c.decryptBlob(keys, id, blob))).toBe('milk');
		await expect(c.decryptBlob(keys, id, flip(blob, 30))).rejects.toMatchObject({ layer: 'aes' });
		await expect(c.decryptBlob(keys, 'index', blob)).rejects.toMatchObject({ layer: 'aes' });
	});

	test('PrivateBin paste layer', async () => {
		const blob = c.randomBytes(1000);
		const { key, body } = await sealPaste(blob);
		expect(body.meta.expire).toBe('never');
		expect(await openPaste(body, key)).toEqual(blob);
		await expect(openPaste(body, c.randomBytes(32))).rejects.toThrow();
	});

	test('Blossom layer', async () => {
		const blob = c.randomBytes(500);
		const sealed = await sealBlob(keys.blossomKey, blob);
		expect(new TextDecoder().decode(sealed.subarray(0, 4))).toBe('OVKB');
		expect(await openBlob(keys.blossomKey, sealed)).toEqual(blob);
		await expect(openBlob(keys.blossomKey, flip(sealed, 20))).rejects.toThrow();
	});

	test('Nostr events, chunked above 30000 bytes', async () => {
		const bytes = c.randomBytes(CHUNK * 2 + 17);
		const events = await sealEvents(keys.nostrSecret, 'ovk/notes/x.ovk', bytes, 1_700_000_000);
		expect(events).toHaveLength(4);
		const got = await openEvents(keys.nostrSecret, 'ovk/notes/x.ovk', async () => events);
		expect(got.bytes).toEqual(bytes);
	});

	test('generated passphrases: 6 EFF words, strong enough; weak ones rejected', () => {
		expect(WORDS).toHaveLength(7776);
		const p = generatePassphrase();
		expect(p.split(' ')).toHaveLength(6);
		expect(isStrongEnough(p)).toBe(true);
		expect(estimateBits(p)).toBeGreaterThan(77);
		expect(isStrongEnough('correct horse battery staple')).toBe(false);
		expect(isStrongEnough('hunter2')).toBe(false);
	});

	test('the recovery kit prints and parses back', async () => {
		const cfg = { v: 1, name: 'groceries', root: 'overkill', backends: [{ name: 'nostr-mom', type: 'nostr', url: 'wss://nostr.mom' }] };
		const kit = await recoveryKit({ vault: V.decrypt.vault, cfg, backends: [{ name: 'nostr-mom', type: 'nostr', where: 'wss://nostr.mom' }], generated: null });
		const back = parseKit(kit);
		expect(back.vault.master).toBe(V.decrypt.vault.master);
		expect(back.cfg.name).toBe('groceries');
		expect(back.cfg.backends).toEqual(cfg.backends);
	});
});
