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
}

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
		blossom: SERVERS.slice(0, BLOSSOM_COUNT),
		// the CLI's signup instances that let other origins use their API
		cryptpad: SIGNUP_INSTANCES.filter((u: string) => !CRYPTPAD_NO_BROWSER.includes(new URL(u).host)),
		discovery: [...DEFAULT_RELAYS],
		nostrPauseMs: 3000
	};
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
		nostrPauseMs: typeof saved.nostrPauseMs === 'number' && saved.nostrPauseMs >= 0 ? saved.nostrPauseMs : d.nostrPauseMs
	};
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
