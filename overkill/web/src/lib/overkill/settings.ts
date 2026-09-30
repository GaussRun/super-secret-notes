// Which hosts a NEW vault uses, and which relays hold the recovery-by-name record. Not secret,
// so it lives in localStorage (wrapped: storage can be missing or throw). An existing vault
// keeps the host list it was created with (in its encrypted config).
import { INSTANCES, DEFAULT_COUNT as PB_COUNT } from '$cli/backends/privatebin.js';
import { RELAYS, DEFAULT_COUNT as RELAY_COUNT } from '$cli/backends/nostr.js';
import { SERVERS, DEFAULT_COUNT as BLOSSOM_COUNT } from '$cli/backends/blossom.js';
import { DEFAULT_RELAYS } from '$cli/bootstrap.js';
import { SIGNUP_INSTANCES } from '$cli/backends/cryptpad-adapter.js';
import { CRYPTPAD_NO_BROWSER } from './backends';
import { backendConfig } from '$cli/defaults-core.js';
import { FALLBACKS } from '$cli/fallbacks.js';
import { NO_BROWSER as PB_NO_BROWSER } from '$cli/backends/privatebin.js';

export interface Hosts {
	privatebin: string[];
	nostr: string[];
	blossom: string[];
	/** CryptPad instances with derived accounts (registered on first use) */
	cryptpad: string[];
	/** relays for the name + passphrase recovery record */
	discovery: string[];
	/** pause between two publishes to one relay (relays rate-limit per IP) */
	nostrPauseMs: number;
	/** setup fallbacks: known-good hosts that stand in for a default that fails, per type */
	fallbacks: Record<'privatebin' | 'nostr' | 'cryptpad' | 'blossom', string[]>;
	/** how long one host may take for one call before it counts as FAILED (ms) */
	timeouts: { host: number; cryptpad: number; nostr: number };
}

// CryptPad's first use registers the account and opens the drive (several round trips); a Nostr
// note goes out in chunks with a pause between them
export const DEFAULT_TIMEOUTS = { host: 20_000, cryptpad: 45_000, nostr: 60_000 };

export interface BackendCfg {
	name: string;
	type: string;
	url?: string;
	origin?: string;
	derived?: boolean;
	[k: string]: unknown;
}

const KEY = 'overkill.hosts';

export function defaultHosts(): Hosts {
	return {
		privatebin: INSTANCES.slice(0, PB_COUNT),
		nostr: RELAYS.slice(0, RELAY_COUNT),
		// Blossom servers add no encryption of their own: not a default (they can still be added)
		blossom: [],
		// the CLI's signup instances that let other origins use their API
		cryptpad: SIGNUP_INSTANCES.filter((u: string) => !CRYPTPAD_NO_BROWSER.includes(new URL(u).host)),
		discovery: [...DEFAULT_RELAYS],
		nostrPauseMs: 3000,
		// the CLI's fallbacks, minus hosts a browser page cannot use
		fallbacks: {
			privatebin: FALLBACKS.privatebin.filter((u: string) => !PB_NO_BROWSER.includes(u)),
			nostr: [...FALLBACKS.nostr],
			cryptpad: FALLBACKS.cryptpad.filter((u: string) => !CRYPTPAD_NO_BROWSER.includes(new URL(u).host)),
			blossom: [...FALLBACKS.blossom]
		},
		timeouts: { ...DEFAULT_TIMEOUTS }
	};
}

/** Known-good hosts that are not defaults: the two PrivateBin instances after the defaults also
 *  passed the browser probe (privatebin.js), and the Blossom servers are opt-in (no encryption of
 *  their own). Offered on /hosts. */
export const ALTERNATIVES = {
	privatebin: INSTANCES.slice(PB_COUNT, PB_COUNT + 2),
	blossom: SERVERS.slice(0, BLOSSOM_COUNT)
};

/** Default host counts as the diagram and the copy show them: CryptPad counts every signup
 *  instance (the command line tool uses both; this browser can use fewer, see /how-it-works/). */
export function defaultCounts() {
	const d = defaultHosts();
	return { privatebin: d.privatebin.length, cryptpad: SIGNUP_INSTANCES.length, nostr: d.nostr.length };
}

export const KNOWN = { privatebin: INSTANCES, nostr: RELAYS, blossom: SERVERS, cryptpad: SIGNUP_INSTANCES };

const urls = (v: unknown): string[] | null =>
	Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean) : null;

export function loadHosts(): Hosts {
	const d = defaultHosts();
	let saved: Record<string, unknown> = {};
	try {
		saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
	} catch {
		saved = {};
	}
	return {
		privatebin: urls(saved.privatebin) ?? d.privatebin,
		nostr: urls(saved.nostr) ?? d.nostr,
		blossom: urls(saved.blossom) ?? d.blossom,
		cryptpad: urls(saved.cryptpad) ?? d.cryptpad,
		discovery: urls(saved.discovery) ?? d.discovery,
		nostrPauseMs: typeof saved.nostrPauseMs === 'number' && saved.nostrPauseMs >= 0 ? saved.nostrPauseMs : d.nostrPauseMs,
		fallbacks: fallbacksFrom(saved.fallbacks, d.fallbacks),
		timeouts: timeoutsFrom(saved.timeouts, d.timeouts)
	};
}

function fallbacksFrom(v: unknown, d: Hosts['fallbacks']): Hosts['fallbacks'] {
	const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
	return { privatebin: urls(o.privatebin) ?? d.privatebin, nostr: urls(o.nostr) ?? d.nostr, cryptpad: urls(o.cryptpad) ?? d.cryptpad, blossom: urls(o.blossom) ?? d.blossom };
}

function timeoutsFrom(v: unknown, d: Hosts['timeouts']): Hosts['timeouts'] {
	const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
	const ms = (x: unknown, fallback: number) => (typeof x === 'number' && x > 0 ? x : fallback);
	return { host: ms(o.host, d.host), cryptpad: ms(o.cryptpad, d.cryptpad), nostr: ms(o.nostr, d.nostr) };
}

export function saveHosts(h: Hosts | null): void {
	try {
		if (h) localStorage.setItem(KEY, JSON.stringify(h));
		else localStorage.removeItem(KEY);
	} catch {
		throw new Error('this browser would not save the settings (storage blocked?)');
	}
}

/** Backend configs for a new vault, named exactly like the CLI names them. */
export function backendConfigs(h: Hosts): BackendCfg[] {
	const taken = new Set<string>();
	return [
		...h.privatebin.map((u) => backendConfig('privatebin', u, taken)),
		...h.cryptpad.map((u) => backendConfig('cryptpad', u, taken)),
		...h.nostr.map((u) => backendConfig('nostr', u, taken)),
		...h.blossom.map((u) => backendConfig('blossom', u, taken))
	];
}
