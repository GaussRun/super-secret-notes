// Which hosts a NEW vault uses, and which relays hold the recovery-by-name record. Not secret,
// so it lives in localStorage (wrapped: storage can be missing or throw). An existing vault
// keeps the host list it was made with (in its encrypted config).
// By default nothing is fixed: each new vault draws its hosts at random from known-good pools
// that a browser can use (the CLI's pools.js); host lists saved in Settings replace the draw.
import { SERVERS, DEFAULT_COUNT as BLOSSOM_COUNT } from '$cli/backends/blossom.js';
import { DISCOVERY_RELAYS } from '$cli/bootstrap.js';
import { CRYPTPAD_NO_BROWSER } from './backends';
import { backendConfig } from '$cli/defaults-core.js';
import { pools, drawHosts, targetCounts } from '$cli/pools.js';

export interface Hosts {
	/** true: each new vault draws its PrivateBin, CryptPad and Nostr hosts from POOLS (the lists below are unused) */
	draw: boolean;
	privatebin: string[];
	nostr: string[];
	blossom: string[];
	/** CryptPad instances with derived accounts (registered on first use) */
	cryptpad: string[];
	/** relays for the name + passphrase recovery record (fixed, well known) */
	discovery: string[];
	/** pause between two publishes to one relay (relays rate-limit per IP) */
	nostrPauseMs: number;
	/** setup fallbacks for fixed lists: known-good hosts that stand in for one that fails, per type */
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

/** The known-good pools a page can use: PrivateBin instances that take posts from a page, CryptPad instances that allow other origins, the good relays. */
export const POOLS: { privatebin: string[]; cryptpad: string[]; nostr: string[] } = pools({ browser: true, cryptpadNoBrowser: CRYPTPAD_NO_BROWSER });

/** Blossom servers: opt-in (no encryption of their own), offered on /hosts. */
export const BLOSSOM_OPT_IN: string[] = SERVERS.slice(0, BLOSSOM_COUNT);

export function defaultHosts(): Hosts {
	return {
		draw: true,
		privatebin: [],
		nostr: [],
		// Blossom servers add no encryption of their own: not drawn (they can still be added)
		blossom: [],
		cryptpad: [],
		discovery: [...DISCOVERY_RELAYS],
		nostrPauseMs: 3000,
		fallbacks: { privatebin: [], nostr: [], cryptpad: [], blossom: [] },
		timeouts: { ...DEFAULT_TIMEOUTS }
	};
}

/** How many hosts of each type a new vault gets in this browser (the targets, capped by the pools). */
export function defaultCounts(): { privatebin: number; cryptpad: number; nostr: number } {
	return targetCounts(POOLS);
}

/** A new vault's hosts: drawn from the pools (the rest of each pool are its fallbacks), or the fixed lists. */
export function planHosts(h: Hosts = loadHosts()): { backends: BackendCfg[]; fallbacks: Hosts['fallbacks'] } {
	if (!h.draw) return { backends: backendConfigs(h), fallbacks: h.fallbacks };
	const { chosen, rest } = drawHosts(POOLS);
	return {
		backends: backendConfigs({ ...h, privatebin: chosen.privatebin, cryptpad: chosen.cryptpad, nostr: chosen.nostr }),
		fallbacks: { privatebin: rest.privatebin, cryptpad: rest.cryptpad, nostr: rest.nostr, blossom: [] }
	};
}

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
	const fixed = { privatebin: urls(saved.privatebin), nostr: urls(saved.nostr), cryptpad: urls(saved.cryptpad) };
	return {
		// lists saved in Settings (or by tests) replace the random draw
		draw: !fixed.privatebin && !fixed.nostr && !fixed.cryptpad,
		privatebin: fixed.privatebin ?? d.privatebin,
		nostr: fixed.nostr ?? d.nostr,
		blossom: urls(saved.blossom) ?? d.blossom,
		cryptpad: fixed.cryptpad ?? d.cryptpad,
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
export function backendConfigs(h: Pick<Hosts, 'privatebin' | 'cryptpad' | 'nostr' | 'blossom'>): BackendCfg[] {
	const taken = new Set<string>();
	return [
		...h.privatebin.map((u) => backendConfig('privatebin', u, taken)),
		...h.cryptpad.map((u) => backendConfig('cryptpad', u, taken)),
		...h.nostr.map((u) => backendConfig('nostr', u, taken)),
		...h.blossom.map((u) => backendConfig('blossom', u, taken))
	];
}
