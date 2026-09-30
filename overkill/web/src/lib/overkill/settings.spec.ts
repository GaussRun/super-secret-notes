// The hosts a new vault gets: by default a random draw from known-good pools a browser can use
// (4 PrivateBin, the CryptPad instances that allow other origins, 4 Nostr), one operator per
// host; lists saved in Settings replace the draw. Blossom stays addable.
import { describe, expect, test } from 'vitest';
import { defaultHosts, backendConfigs, defaultCounts, planHosts, POOLS, BLOSSOM_OPT_IN, type Hosts } from './settings';
import { diagramSvg, total } from '$lib/diagram';
import { site } from '$cli/defaults-core.js';

describe('new vault hosts', () => {
	test('the browser pools leave out hosts a page cannot use', () => {
		expect(POOLS.privatebin).not.toContain('https://paste.evolix.org');
		expect(POOLS.privatebin).not.toContain('https://paste.coalserver.de');
		expect(POOLS.cryptpad).toEqual(['https://cryptpad.private.coffee']);
		expect(POOLS.nostr).not.toContain('wss://relay.damus.io');
		expect(defaultHosts().draw).toBe(true);
		expect(defaultHosts().blossom).toEqual([]);
	});

	test('200 draws: the target counts, one of each type, an index holder, one operator per host, not all the same', () => {
		const seen = new Set<string>();
		const counts = defaultCounts();
		expect(counts).toEqual({ privatebin: 4, cryptpad: 1, nostr: 4 });
		for (let i = 0; i < 200; i++) {
			const { backends, fallbacks } = planHosts(defaultHosts());
			const of = (t: string) => backends.filter((b) => b.type === t);
			expect(of('privatebin')).toHaveLength(counts.privatebin);
			expect(of('cryptpad')).toHaveLength(counts.cryptpad);
			expect(of('nostr')).toHaveLength(counts.nostr);
			expect(of('blossom')).toHaveLength(0);
			const urls = backends.map((b) => String(b.url ?? b.origin));
			for (const b of backends) expect(POOLS[b.type as 'privatebin' | 'cryptpad' | 'nostr']).toContain(String(b.url ?? b.origin));
			expect(new Set(urls.map(site)).size).toBe(urls.length);
			expect(new Set(backends.map((b) => b.name)).size).toBe(backends.length);
			for (const u of [...fallbacks.privatebin, ...fallbacks.nostr]) expect(urls).not.toContain(u);
			seen.add(urls.sort().join(' '));
		}
		expect(seen.size).toBeGreaterThan(50);
	});

	test('lists saved in Settings replace the draw', () => {
		const fixed: Hosts = { ...defaultHosts(), draw: false, privatebin: ['https://a.example'], nostr: ['wss://r.example'], cryptpad: [] };
		const { backends } = planHosts(fixed);
		expect(backends.map((b) => b.url ?? b.origin)).toEqual(['https://a.example', 'wss://r.example']);
		expect(backendConfigs(fixed).filter((b) => b.type === 'privatebin').map((b) => b.name)).toEqual(['pb-a']);
	});

	test('the diagram shows what the browser draws', () => {
		const n = total(defaultCounts());
		expect(n).toBe(9);
		for (const layout of ['wide', 'tall'] as const) {
			const svg = diagramSvg(layout, defaultCounts());
			expect(svg).toContain(`data-total="${n}"`);
			expect(svg).toContain('4 PrivateBin + 1 CryptPad + 4 relays = 9 copies');
		}
	});

	test('Blossom servers can still be chosen and become backends', () => {
		expect(BLOSSOM_OPT_IN.length).toBeGreaterThan(0);
		const cfgs = backendConfigs({ privatebin: [], cryptpad: [], nostr: ['wss://r.example'], blossom: [BLOSSOM_OPT_IN[0]] });
		expect(cfgs.filter((b) => b.type === 'blossom')).toHaveLength(1);
	});
});
