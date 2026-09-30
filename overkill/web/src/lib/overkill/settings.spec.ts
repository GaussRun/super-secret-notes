// The hosts a new vault gets: the CLI's zero-signup defaults (4 PrivateBin + 2 CryptPad + 4 Nostr
// = 10), no Blossom (it adds no encryption of its own), minus the CryptPad instance that refuses
// other origins. Blossom stays addable.
import { describe, expect, test } from 'vitest';
import { defaultHosts, backendConfigs, defaultCounts, KNOWN } from './settings';
import { diagramSvg, total } from '$lib/diagram';
import { SIGNUP_INSTANCES } from '$cli/backends/cryptpad-adapter.js';
import { CRYPTPAD_NO_BROWSER } from './backends';

describe('default hosts', () => {
	test('4 PrivateBin, 4 relays, the browser-usable CryptPad instances, no Blossom', () => {
		const d = defaultHosts();
		expect(d.privatebin).toEqual(['https://pb.envs.net', 'https://paste.systemli.org', 'https://extrait.facil.services', 'https://bin.disroot.org']);
		expect(d.nostr).toHaveLength(4);
		expect(d.blossom).toEqual([]);
		expect(SIGNUP_INSTANCES).toHaveLength(2);
		expect(d.cryptpad).toEqual(SIGNUP_INSTANCES.filter((u: string) => !CRYPTPAD_NO_BROWSER.includes(new URL(u).host)));
		// the same 10 as the command line tool, counting both CryptPad instances
		expect(d.privatebin.length + SIGNUP_INSTANCES.length + d.nostr.length).toBe(10);
		// named like the CLI names them
		expect(backendConfigs(d).filter((b) => b.type === 'privatebin').map((b) => b.name)).toEqual(['pb-envs', 'pb-systemli', 'pb-extrait', 'pb-disroot']);
	});

	test('one operator per host: no two defaults share a domain', () => {
		const d = defaultHosts();
		const base = (u: string) => new URL(u).hostname.split('.').slice(-2).join('.');
		const all = [...d.privatebin, ...SIGNUP_INSTANCES, ...d.nostr].map(base);
		expect(new Set(all).size).toBe(all.length);
	});

	test('the next verified PrivateBin instances stay known alternatives, not defaults', () => {
		expect(KNOWN.privatebin).toEqual(expect.arrayContaining(['https://cryptostorm.is/paste', 'https://paste.d-ku.de']));
		expect(defaultHosts().privatebin).not.toContain('https://cryptostorm.is/paste');
		expect(defaultHosts().privatebin).not.toContain('https://paste.d-ku.de');
	});

	test('the diagram total is the length of the defaults list', () => {
		const d = defaultHosts();
		const n = d.privatebin.length + SIGNUP_INSTANCES.length + d.nostr.length;
		expect(total(defaultCounts())).toBe(n);
		for (const layout of ['wide', 'tall'] as const) {
			const svg = diagramSvg(layout, defaultCounts());
			expect(svg).toContain(`data-total="${n}"`);
			expect(svg).toContain(`${d.privatebin.length} PrivateBin + ${SIGNUP_INSTANCES.length} CryptPad + ${d.nostr.length} relays = ${n} copies`);
		}
	});

	test('Blossom servers can still be chosen and become backends', () => {
		expect(KNOWN.blossom.length).toBeGreaterThan(0);
		const cfgs = backendConfigs({ ...defaultHosts(), blossom: [KNOWN.blossom[0]] });
		expect(cfgs.filter((b) => b.type === 'blossom')).toHaveLength(1);
		expect(backendConfigs(defaultHosts()).filter((b) => b.type === 'blossom')).toHaveLength(0);
	});
});
