// The CLI's backend adapters as the web build runs them, against in-memory stand-ins for the
// network (runs in Node and in headless Chromium).
import { describe, expect, test } from 'vitest';
import * as c from '$cli/crypto.js';
import * as nostr from '$cli/backends/nostr.js';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { SecretStoreCore } from '$cli/vaultsecrets-core.js';
import { makeBackends, TRAVELS_WITH_SECRETS } from './backends';

/** A relay inside a WebSocket-shaped object: EVENT, REQ (by d tag), addressable replacement. */
function memoryRelay() {
	const store = new Map<string, Event>();
	class MemorySocket {
		readyState = 0;
		onopen?: () => void;
		onmessage?: (e: { data: string }) => void;
		onerror?: () => void;
		onclose?: () => void;
		constructor() {
			setTimeout(() => {
				this.readyState = 1;
				this.onopen?.();
			}, 0);
		}
		send(raw: string) {
			const msg = JSON.parse(raw);
			const reply = (m: unknown) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0);
			if (msg[0] === 'EVENT') {
				const ev = msg[1] as Event;
				if (!verifyEvent(ev)) return reply(['OK', ev.id, false, 'invalid: bad signature']);
				store.set(`${ev.pubkey}:${ev.tags.find((t) => t[0] === 'd')?.[1]}`, ev);
				return reply(['OK', ev.id, true, '']);
			}
			if (msg[0] === 'REQ') {
				const [, id, f] = msg;
				for (const ev of store.values()) if (!f['#d'] || f['#d'].includes(ev.tags.find((t) => t[0] === 'd')?.[1])) reply(['EVENT', id, ev]);
				reply(['EOSE', id]);
			}
		}
		close() {
			this.readyState = 3;
		}
	}
	return { store, MemorySocket };
}

describe('Nostr adapter', () => {
	test('publishes right away (no browser setTimeout overflow) and reads back, chunked', { timeout: 20_000 }, async () => {
		const { store, MemorySocket } = memoryRelay();
		const keys = await c.unlockKeys(await c.createVault());
		const b = nostr.create({ name: 'n', type: 'nostr', url: 'wss://relay.example' }, { root: 'overkill' }, { WebSocketImpl: MemorySocket, pause: 0 });
		b.unlock(keys);
		const t0 = Date.now();
		const bytes = c.randomBytes(nostr.CHUNK + 5);
		await b.put('notes/x.ovk', bytes);
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(store.size).toBe(3);
		expect(await b.get('notes/x.ovk')).toEqual(bytes);
		expect(await b.get('notes/missing.ovk')).toBeNull();
		await b.close();
	});
});

describe('web backends', () => {
	test('PrivateBin, CryptPad, Nostr and Blossom are driven; the rest stay in the config', async () => {
		const keys = await c.unlockKeys(await c.createVault());
		const secrets = await new SecretStoreCore(null).unlock(keys);
		const cfg = {
			backends: [
				{ name: 'pb-x', type: 'privatebin', url: 'https://pb.example' },
				{ name: 'cp-x', type: 'cryptpad', origin: 'https://cp.example', derived: true },
				{ name: 'nostr-x', type: 'nostr', url: 'wss://relay.example' },
				{ name: 'blossom-x', type: 'blossom', url: 'https://bl.example' },
				{ name: 'cp-unredacted', type: 'cryptpad', origin: 'https://crypt.unredacted.org', derived: true },
				{ name: 'mega', type: 'mega', email: { stored: true } }
			]
		};
		const list = makeBackends(cfg, secrets);
		expect(list.map((b: { name: string }) => b.name)).toEqual(['pb-x', 'cp-x', 'nostr-x', 'blossom-x']);
		expect(list.map((b: { addressing?: string }) => b.addressing ?? 'path')).toEqual(['locator', 'path', 'path', 'locator']);
		expect(list.secrets).toBe(secrets);
	});

	test('the types that travel with secrets.ovk match the CLI', async () => {
		const sources = import.meta.glob('../../../../cli/src/backends/*.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
		const travels = Object.entries(sources)
			.filter(([, src]) => /export const travelsWithSecrets = true/.test(src))
			.map(([file]) => file.split('/').pop()!.replace(/(-adapter)?\.js$/, ''));
		expect(new Set(travels)).toEqual(TRAVELS_WITH_SECRETS);
	});
});
