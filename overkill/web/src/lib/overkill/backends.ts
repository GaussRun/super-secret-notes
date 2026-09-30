// The backends the web client can drive from a browser tab, using the CLI's own adapters:
// PrivateBin (CORS simple requests), Nostr relays (WebSocket), Blossom (CORS preflight) and
// CryptPad (its HTTP API with CORS, the realtime protocol over WebSocket).
// Backends of other types in a vault made by the CLI stay in its config (and in the recovery
// record) but are left out here.
import * as privatebin from '$cli/backends/privatebin.js';
import * as nostr from '$cli/backends/nostr.js';
import * as blossom from '$cli/backends/blossom.js';
import { createCryptpad } from '$cli/backends/cryptpad-adapter.js';
import { DEFAULT_ROOT } from '$cli/defaults-core.js';
import type { SecretStoreCore } from '$cli/vaultsecrets-core.js';
import type { BackendCfg } from './settings';

export const WEB_TYPES = ['privatebin', 'nostr', 'blossom', 'cryptpad'];

// CryptPad instances whose HTTP API only allows their own origins (Access-Control-Allow-Origin
// pinned to the instance's sandbox), so a page served from anywhere else cannot log in. Checked
// live 2026-09-30.
export const CRYPTPAD_NO_BROWSER = ['crypt.unredacted.org'];

// types whose logins may travel in the recovery record with secrets.ovk (the CLI marks them
// `travelsWithSecrets`; src/lib/overkill/backends.spec.ts keeps this list in step)
export const TRAVELS_WITH_SECRETS = new Set(['cryptpad', 'fileverse', 'filen', 'mega']);

export const supported = (b: BackendCfg) =>
	WEB_TYPES.includes(b.type) && !(b.type === 'cryptpad' && CRYPTPAD_NO_BROWSER.includes(new URL(String(b.origin ?? 'https://cryptpad.fr')).host));

/** Logins that are not derived from the vault: only ones stored in secrets.ovk exist here. */
function resolveSecret(spec: unknown, what: string, store: SecretStoreCore | null, backend: string, field: string) {
	if (typeof spec === 'string') return spec;
	if ((spec as { stored?: boolean })?.stored && store) return store.cred(backend, field);
	throw new Error(`${what}: kept outside the vault (env or file), which a browser cannot read`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Adapter = any;

export function makeBackends(cfg: { root?: string; backends: BackendCfg[] }, secrets: SecretStoreCore, { nostrPauseMs = 3000, timeouts = null as { host: number; cryptpad: number; nostr: number } | null } = {}) {
	const ctx = { root: cfg.root ?? DEFAULT_ROOT, home: null, secrets };
	const list: Adapter[] & { secrets?: SecretStoreCore } = cfg.backends.filter(supported).map((b) => {
		const adapter: Adapter =
			b.type === 'privatebin' ? privatebin.create(b, ctx, { browser: true })
			: b.type === 'nostr' ? nostr.create(b, ctx, { pause: nostrPauseMs })
			: b.type === 'cryptpad' ? createCryptpad(b, ctx, { loadDrive: () => import('$cli/backends/cryptpad/drive.js'), resolveSecret })
			: blossom.create(b, ctx);
		// the store gives every call this deadline (store.js `bounded`): one silent host never blocks the rest
		if (timeouts) adapter.timeoutMs = b.type === 'cryptpad' ? timeouts.cryptpad : b.type === 'nostr' ? timeouts.nostr : timeouts.host;
		return adapter;
	});
	list.secrets = secrets;
	return list;
}
