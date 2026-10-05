// The vault in this tab. All format and replication logic is the CLI's (crypto.js, store.js,
// bootstrap.js, discovery-core.js, kit.js, status.js); this file only wires it to IndexedDB and
// the page. Keys, the passphrase and plaintext live in memory only.
import * as c from '$cli/crypto.js';
import { Overkill, MIN_COPIES } from '$cli/store.js';
import { fallbackPicker } from '$cli/fallbacks.js';
import { makeBackup, openBackup } from '$cli/backup.js';
import { readLocalCopy, writeLocalCopy, localCopyBackend, type LocalFiles } from './localcopy';
import * as bootstrap from '$cli/bootstrap.js';
import { bootstrapRecord, recordHash, publishDue, auditDue, configFromBootstrap, indexCacheFromCopies, DISCOVERY_TAGS_VERSION } from '$cli/discovery-core.js';
import { SecretStoreCore, migrateConfig, SECRETS_ID } from '$cli/vaultsecrets-core.js';
import { recoveryKit } from '$cli/kit.js';
import { ledgerStatus } from '$cli/status.js';
import { DEFAULT_ROOT, validVaultName, backendConfig } from '$cli/defaults-core.js';
import { identity } from '$cli/backends/nostr.js';
import { logger } from './shims/log.js';
import { activity } from './activity.svelte';
import { FILES, readBlob, writeBlob, clearAll, clearStored, blobIo, goEphemeral, endEphemeral, saveBackup, readBackup, dropBackup, type VaultBackup } from './idb';
import { handoffLink, plainText, vaultLinkFor } from './qr';
import { loadHosts, planHosts, type BackendCfg, type Hosts } from './settings';
import { makeBackends, supported, TRAVELS_WITH_SECRETS, type Adapter } from './backends';
import { isStrongEnough, estimateBits, MIN_BITS } from './passphrase';
import { rememberName, rememberedName } from './credentials';
import { to } from '$lib/link';

export interface VaultCfg {
	v: 1;
	name?: string;
	root?: string;
	index_sync?: 'always' | 'manual' | 'never';
	backends: BackendCfg[];
}

/** This device's encrypted config.ovk: the vault's config plus when the recovery record went out. */
interface WebConfig {
	v: 1;
	cfg: VaultCfg;
	published: { sha256: string; at: string; tags?: number } | null;
	/** when the last full check (every copy on every host) ran from this browser */
	checkedAt?: string | null;
}

// blob_id of config.ovk (a web-only local file, same two-layer format as notes)
const CONFIG_ID = 'webconfig';
const dec = new TextDecoder();

type VaultJson = { v: number; age_identity: string; master: string; created: string };
type Keys = Awaited<ReturnType<typeof c.unlockKeys>>;

export interface NoteHost {
	name: string;
	type: string;
	where: string;
	status: string;
	lastOk: string | null;
	lastChecked: string | null;
}

export type Status = 'loading' | 'none' | 'locked' | 'unlocked';

class VaultState {
	status = $state<Status>('loading');
	cfg = $state<VaultCfg | null>(null);
	/** The passphrase generated at setup, shown on the recovery kit page until the tab locks. */
	generated = $state<string | null>(null);
	/** Public-computer mode: this vault lives in the tab's memory only (see idb.ts). */
	ephemeral = $state(false);

	#vault: VaultJson | null = null;
	#keys: Keys | null = null;
	#pass: string | null = null;
	#vaultBytes: Uint8Array | null = null;
	#store: Overkill | null = null;
	#conf: WebConfig | null = null;
	#discoverySecret: Uint8Array | null = null;
	#secrets: SecretStoreCore | null = null;
	#localCopy: LocalFiles | null = null;

	/** The last full check of this vault from this browser (or, before the first, when the vault was made). */
	lastFullCheck = $state<string | null>(null);

	/** Set when load() put back a vault whose replacement was interrupted: its name, for a notice. */
	restored = $state<string | null>(null);

	async load() {
		if (this.#store) return;
		// a replacement that never finished (tab closed, crash): the old vault comes back
		const backup = await readBackup();
		if (backup) {
			const complete = (await readBlob(FILES.vault)) && (await readBlob(FILES.config));
			if (!complete) {
				await this.#putBack(backup);
				this.restored = backup.name ?? '';
			}
		}
		const bytes = await readBlob(FILES.vault);
		this.status = bytes ? 'locked' : 'none';
	}

	async #putBack(backup: VaultBackup) {
		await clearAll();
		for (const [f, b] of Object.entries(backup.files)) await writeBlob(f, b);
		rememberName(backup.name || null);
		await dropBackup();
	}

	get store(): Overkill {
		if (!this.#store) throw new Error('the vault is locked');
		return this.#store;
	}

	get backends(): Adapter[] {
		return this.#store?.backends ?? [];
	}

	/** Backends in the config that this browser cannot drive (made by the CLI). */
	get unsupported(): BackendCfg[] {
		return (this.cfg?.backends ?? []).filter((b) => !supported(b));
	}

	get npub(): string | null {
		return this.#keys ? (identity(this.#keys.nostrSecret).npub as string) : null;
	}

	async unlock(passphrase: string, { ephemeral = false } = {}) {
		if (ephemeral) {
			// carry on from memory: whatever changes from now on is not written back
			const seed: Record<string, Uint8Array | null> = {};
			for (const f of Object.values(FILES)) seed[f] = await readBlob(f);
			goEphemeral(seed);
			this.ephemeral = true;
		}
		const vaultBytes = await readBlob(FILES.vault);
		if (!vaultBytes) throw new Error('no vault in this browser');
		const vault = await c.decryptVault(vaultBytes, passphrase);
		const keys = await c.unlockKeys(vault);
		const blob = await readBlob(FILES.config);
		if (!blob) throw new Error('this browser has vault.age but lost its config: forget this device in Settings and recover by name');
		const conf = JSON.parse(dec.decode(await c.decryptBlob(keys, CONFIG_ID, blob))) as WebConfig;
		await this.#open({ vault, keys, passphrase, vaultBytes, conf });
		// in the background: put the recovery record back where a discovery relay lost it or it is old
		void this.publishDiscovery({ audit: true }).catch((err) => logger.warn(`recovery by name: ${(err as Error).message}`));
	}

	async #saveConfig() {
		await writeBlob(FILES.config, await c.encryptBlob(this.#keys, CONFIG_ID, JSON.stringify(this.#conf)));
	}

	async #open({ vault, keys, passphrase, vaultBytes, conf }: { vault: VaultJson; keys: Keys; passphrase: string; vaultBytes: Uint8Array; conf: WebConfig }) {
		const secrets = new SecretStoreCore(blobIo(FILES.secrets));
		await secrets.unlock(keys);
		this.#keys = keys;
		this.#conf = conf;
		// locators that came with a recovery record (paste URLs with their keys) go into secrets.ovk
		if (migrateConfig(conf.cfg, secrets)) {
			await secrets.save();
			await this.#saveConfig();
		}
		this.#secrets = secrets;
		this.#localCopy = await readLocalCopy().catch(() => null);
		this.#store = this.#makeStore(conf.cfg, keys, vaultBytes);
		this.#vault = vault;
		this.#pass = passphrase;
		this.#vaultBytes = vaultBytes;
		this.cfg = conf.cfg;
		this.lastFullCheck = conf.checkedAt ?? vault.created ?? null;
		if (conf.cfg.name && !this.ephemeral) rememberName(conf.cfg.name);
		this.status = 'unlocked';
	}

	#makeStore(cfg: VaultCfg, keys: Keys, vaultBytes: Uint8Array) {
		const hosts = loadHosts();
		const backends = makeBackends(cfg, this.#secrets!, { nostrPauseMs: hosts.nostrPauseMs, timeouts: hosts.timeouts });
		// a restored backup in this browser: read first (instant, no host needed)
		if (this.#localCopy) backends.unshift(localCopyBackend(this.#localCopy));
		if (!backends.length) throw new Error('none of this vault\'s backends works from a browser (PrivateBin, CryptPad, Nostr and Blossom do); use the CLI');
		// the index copy next to the recovery record (format history 18), on the discovery relays
		const indexMirror = cfg.name && hosts.discovery.length
			? bootstrap.indexMirror({ keys, relays: hosts.discovery, pause: hosts.nostrPauseMs, secret: async () => (this.#discoverySecret ??= (await bootstrap.discoveryIdentity(this.#pass!, cfg.name!)).secret) })
			: null;
		return new Overkill({ backends, keys, vaultBytes, logger, indexCache: blobIo(FILES.indexCache), indexSync: cfg.index_sync ?? 'always', hostTimeoutMs: hosts.timeouts.host, indexMirror });
	}

	/**
	 * Add a host to this vault (one more independent copy): check everything, then repair, which
	 * copies vault.age, the index and every note there; then the recovery record learns about it.
	 */
	async addHost(type: 'privatebin' | 'cryptpad' | 'nostr' | 'blossom', url: string) {
		const conf = this.#conf!;
		url = url.trim().replace(/\/+$/, '');
		const host = new URL(url).host;
		const same = conf.cfg.backends.find((b) => [b.url, b.origin].some((u) => u && new URL(String(u)).host === host));
		if (same) throw new Error(`${host} is already in this vault (${same.name}): one account per operator`);
		const cfg = backendConfig(type, url, new Set(conf.cfg.backends.map((b) => b.name))) as BackendCfg;
		if (!supported(cfg)) throw new Error(`${host} does not let other sites use its API (CORS), so a browser cannot store anything there; the CLI can`);
		const next: VaultCfg = { ...conf.cfg, backends: [...conf.cfg.backends, cfg] };
		const store = this.#makeStore(next, this.#keys!, this.#vaultBytes!);
		await this.#store?.close().catch(() => {});
		this.#store = store;
		conf.cfg = next;
		this.cfg = next;
		await this.#saveConfig();
		const report = await this.check();
		const r = await this.repair(report);
		return { name: cfg.name, ...r };
	}

	/**
	 * New vault: keys, vault.age on every backend, an empty index, the recovery-by-name record.
	 * `replace`: this browser already holds a vault; the new one takes its place only once it is
	 * made (if anything fails, the old files come back). The old one stays on its hosts.
	 */
	async create({ name, passphrase, generated = null, ephemeral = false, replace = false, plan = null }: { name: string; passphrase: string; generated?: string | null; ephemeral?: boolean; replace?: boolean; plan?: { backends: BackendCfg[]; fallbacks: Hosts['fallbacks'] } | null }) {
		if (!validVaultName(name)) throw new Error('vault name: letters, digits, space, dot, dash or underscore (up to 63)');
		if (!isStrongEnough(passphrase)) throw new Error(`that passphrase is about ${Math.round(estimateBits(passphrase))} bits; a new vault wants ${MIN_BITS}+ (6 random words)`);
		return this.#taking({ replace, ephemeral }, () => this.#create(name, passphrase, generated, plan ?? planHosts()));
	}

	/**
	 * Run a create or recover that writes a vault into this browser. With `replace` the vault
	 * already stored here is kept aside and comes back, locked, if `fn` fails; it is only gone
	 * from this browser once the new one is in place.
	 */
	async #taking<T>({ replace, ephemeral }: { replace: boolean; ephemeral: boolean }, fn: () => Promise<T>): Promise<T> {
		let previous: VaultBackup | null = null;
		if (replace && !ephemeral) {
			if (this.status === 'unlocked') await this.lock();
			const files: Record<string, Uint8Array> = {};
			for (const f of Object.values(FILES)) {
				const b = await readBlob(f);
				if (b) files[f] = b;
			}
			if (files[FILES.vault]) {
				previous = { files, name: rememberedName() || null, at: new Date().toISOString() };
				// on disk before anything is cleared: a closed tab mid-create still has it (load() puts it back)
				await saveBackup(previous);
			}
		}
		if (ephemeral) this.#goPublic();
		if (!replace && (await readBlob(FILES.vault))) throw new Error('this browser already holds a vault: forget it in Settings first');
		try {
			const result = await fn();
			if (previous) await dropBackup(); // the new vault is fully in place
			return result;
		} catch (err) {
			if (previous) {
				// put the old vault back, locked, as it was
				await this.lock();
				await this.#putBack(previous);
				this.status = 'locked';
			}
			throw err;
		}
	}

	async #create(name: string, passphrase: string, generated: string | null, plan: { backends: BackendCfg[]; fallbacks: Hosts['fallbacks'] }) {
		// this vault's own hosts (a random draw from the pools, unless Settings fixes them)
		const cfg: VaultCfg = { v: 1, name: name.normalize('NFC'), root: DEFAULT_ROOT, backends: plan.backends.map((b) => ({ ...b })) };
		const vault = await c.createVault();
		const vaultBytes = await step('stretching the passphrase with scrypt (slow on purpose)', () => c.encryptVault(vault, passphrase));
		const keys = await c.unlockKeys(vault);
		await clearAll(); // leftovers of a vault this browser forgot
		await testHook();
		await writeBlob(FILES.vault, vaultBytes);
		const conf: WebConfig = { v: 1, cfg, published: null };
		this.#keys = keys;
		this.#conf = conf;
		await this.#saveConfig();
		await this.#open({ vault, keys, passphrase, vaultBytes, conf });
		const store = this.store;
		// best effort: every host on its own deadline; a default that fails gets a known-good stand-in
		const hosts = loadHosts();
		const picker = fallbackPicker(cfg, {
			lists: plan.fallbacks,
			make: (bc: BackendCfg) => makeBackends({ root: cfg.root, backends: [bc] }, this.#secrets!, { nostrPauseMs: hosts.nostrPauseMs, timeouts: hosts.timeouts })[0]
		});
		const res = await step(`uploading vault.age to ${store.backends.length} hosts`, () => store.uploadVault({ next: (b: Adapter) => picker.next(b) }), (r) => `vault.age on ${r.filter((x) => x.ok).length}/${r.length} hosts`);
		if (!res.some((r) => r.ok)) throw new Error('vault.age could not be stored anywhere; check your connection and the hosts in Settings, then try again');
		const swaps = picker.apply(res);
		if (swaps.length) {
			conf.cfg = cfg;
			this.cfg = { ...cfg };
			await this.#saveConfig();
		}
		// a new vault's index is empty: no need to read one; if no index holder takes it, it stays here
		const indexRes = await step('writing the empty index', () => store.writeIndex(c.emptyIndex()), (r) => `index on ${r.filter((x: { ok: boolean }) => x.ok).length}/${r.length} hosts`);
		const record = await this.publishDiscovery({ force: true });
		this.generated = generated;
		return {
			hosts: res.map((r: { backend: Adapter; ok: boolean; error?: unknown; replaced?: string }) => ({ backend: r.backend.name as string, ok: r.ok, error: (r.error as Error | undefined)?.message, replaced: r.replaced })),
			swaps,
			indexLocal: store.remoteIndex && !indexRes.some((r: { ok: boolean }) => r.ok),
			// null: no relays configured for the record at all
			// counted on the fixed discovery relays only: that is where recovery by name looks
			recordRelays: hosts.discovery.length ? (record ? record.filter((x: { ok: boolean; relay: string }) => x.ok && hosts.discovery.includes(x.relay)).length : 0) : null
		};
	}

	/** Name + passphrase only: the recovery record on the relays, then vault.age, then everything. */
	async recover(name: string, passphrase: string, { ephemeral = false, replace = false } = {}) {
		return this.#taking({ replace, ephemeral }, () => this.#recover(name, passphrase));
	}

	async #recover(name: string, passphrase: string) {
		const hosts = loadHosts();
		name = name.normalize('NFC');
		const { secret } = await step('deriving the discovery key (scrypt, a few seconds)', () => bootstrap.discoveryIdentity(passphrase, name));
		const found = await step(`asking ${hosts.discovery.length} relays for the recovery record`, () => bootstrap.fetchBootstrap(passphrase, name, { relays: hosts.discovery, secret, pause: hosts.nostrPauseMs }), (f) => `found it on ${f.from}`);
		const { vaultBytes, cfg, others, from, secretsBlob, indexBlobs } = configFromBootstrap(found, name);
		const vault = await step('opening vault.age', () => c.decryptVault(vaultBytes, passphrase));
		const keys = await c.unlockKeys(vault);
		if (secretsBlob) await c.decryptBlob(keys, SECRETS_ID, secretsBlob); // must open before anything is written
		await clearAll();
		await testHook();
		await writeBlob(FILES.vault, vaultBytes);
		if (secretsBlob) await writeBlob(FILES.secrets, secretsBlob);
		// the index copy from the record: the notes are found even when no index holder has the index
		const indexCache = await indexCacheFromCopies(keys, indexBlobs);
		if (indexCache) await writeBlob(FILES.indexCache, indexCache);
		const conf: WebConfig = { v: 1, cfg: cfg as VaultCfg, published: null };
		this.#keys = keys;
		this.#conf = conf;
		await this.#saveConfig();
		await this.#open({ vault, keys, passphrase, vaultBytes, conf });
		this.#discoverySecret = secret;
		return { cfg, others, from, unsupported: this.unsupported };
	}

	#goPublic() {
		goEphemeral();
		this.ephemeral = true;
	}

	/** A link that recovers this vault on another device: name and passphrase in the fragment. */
	handoff(recoverUrl: string) {
		return handoffLink(recoverUrl, this.cfg!.name!, this.#pass!);
	}

	/**
	 * The file "Download recovery kit" saves: name, passphrase and access link on top (what Recover
	 * and the unlock form take in one paste), then the CLI's kit sheet (what `recover --kit` reads).
	 * Made here in the page; nothing is uploaded.
	 */
	async kitFile(recoverUrl: string) {
		const name = this.cfg!.name!;
		return [
			'SUPER SECRET NOTES  -  VAULT ACCESS AND RECOVERY KIT',
			'',
			'Store this somewhere safe and offline. It contains your passphrase: anyone with it can open your',
			'vault (all notes, and change them). It is the backstop if the passphrase is lost.',
			'',
			`vault name:   ${name}`,
			`passphrase:   ${this.#pass}`,
			`vault link:   ${this.vaultLink(recoverUrl)}`,
			'              (safe to keep in notes or bookmarks: it opens nothing without the passphrase)',
			`access link:  ${this.handoff(recoverUrl)}`,
			'              (the link WITH the passphrase: as secret as this file)',
			'',
			'To open the vault on another device: open the access link, or paste this whole file into',
			'"Paste your access link or recovery kit" on the Recover page.',
			'Command line: super-secret-notes recover --kit <this file>',
			'',
			await this.kit(),
			''
		].join('\n');
	}

	/** The vault link: only the name, safe to keep in notes or bookmarks. */
	vaultLink(recoverUrl: string) {
		return vaultLinkFor(recoverUrl, this.cfg!.name!);
	}

	/** The vault name and passphrase as text, for a password manager or notes app. */
	handoffText() {
		return plainText(this.cfg!.name!, this.#pass!);
	}

	/**
	 * Keep the recovery-by-name record current (CLI rule: when it changed, or every 30 days); with
	 * `audit` (repair, refresh) also when a discovery relay lost it or holds an old one.
	 */
	async publishDiscovery({ force = false, audit = false } = {}) {
		const hosts = loadHosts();
		const conf = this.#conf!;
		if (!conf.cfg.name || !hosts.discovery.length) return null;
		const store = this.store;
		const record = await bootstrapRecord(conf.cfg, store.backends, this.#keys, { travelsWithSecrets: (t: string) => TRAVELS_WITH_SECRETS.has(t) });
		const hash = await recordHash(record, this.#vaultBytes!);
		if (!force && !publishDue(conf.published, hash) && !audit) return null;
		try {
			this.#discoverySecret ??= await step('deriving the discovery key (scrypt, a few seconds)', async () => (await bootstrap.discoveryIdentity(this.#pass!, conf.cfg.name!)).secret);
			if (!force && !publishDue(conf.published, hash)) {
				const seen = await step(`asking ${hosts.discovery.length} discovery relays for the recovery record`, () => bootstrap.auditBootstrap(this.#discoverySecret!, hosts.discovery, { pause: hosts.nostrPauseMs }), (a) => `recovery record on ${a.filter((x) => x.at).length}/${a.length} relays`);
				if (!auditDue(seen)) return null;
			}
			// the fixed discovery relays (where recovery by name looks), and the vault's own relays as well
			const relays = [...new Set([...hosts.discovery, ...conf.cfg.backends.filter((b) => b.type === 'nostr').map((b) => String(b.url).replace(/\/+$/, ''))])];
			const results = await step(`publishing the recovery-by-name record to ${relays.length} relays`, () => bootstrap.publishBootstrap(this.#pass!, conf.cfg.name!, this.#vaultBytes!, record, { relays, secret: this.#discoverySecret ?? undefined, pause: hosts.nostrPauseMs }), (r) => `recovery by name: record on ${r.filter((x: { ok: boolean }) => x.ok).length}/${r.length} relays`);
			conf.published = { sha256: hash, at: new Date().toISOString(), tags: DISCOVERY_TAGS_VERSION };
			await this.#saveConfig();
			return results;
		} catch (err) {
			logger.warn(`recovery by name: record not published (${(err as Error).message}); the recovery kit still works`);
			return null;
		}
	}

	async put(name: string, text: string) {
		const store = this.store;
		const r = await step(`encrypting "${name}" and uploading it to ${store.backends.length} hosts`, () => store.put(name, text), (x) => `stored on ${x.results.filter((y) => y.ok).length}/${x.results.length} hosts`);
		await this.publishDiscovery();
		return r;
	}

	/** `from`: read that backend's copy even if the index does not know it (a DIVERGED copy). */
	async get(name: string, { from }: { from?: string } = {}) {
		const t0 = performance.now();
		const r = await this.store.get(name, from ? { from } : {});
		const ms = performance.now() - t0;
		return { ...r, text: dec.decode(r.bytes), ms, hosts: await this.noteHosts(name) };
	}

	/**
	 * Where a note lives: every backend of this vault with what the health ledger (in this
	 * browser's index copy) last saw there. Hosts are named by their base URL only: the paste
	 * locators carry keys and never leave the encrypted index.
	 */
	async noteHosts(name: string): Promise<NoteHost[]> {
		const index = await this.store.localIndex().catch(() => null);
		const health = index?.health?.[name.normalize('NFC')] ?? {};
		return this.backends.map((b) => {
			const h = health[b.name];
			return { name: b.name, type: b.type, where: b.where, status: h?.status ?? 'unknown', lastOk: h?.last_ok ?? null, lastChecked: h?.last_checked ?? null };
		});
	}

	/** The full backup file: vault.age, the index and every note, all still encrypted (cli/src/backup.js). */
	async backupFile() {
		return step('reading every note for the backup', () => makeBackup({ store: this.store, cfg: this.cfg, keys: this.#keys, vaultBytes: this.#vaultBytes! }), () => 'backup ready');
	}

	/**
	 * A vault from a backup file and its passphrase, with no host needed: its blobs become this
	 * browser's local copy (read first), and Repair copies them back to the hosts.
	 */
	async restoreBackup(text: string, passphrase: string, { replace = false } = {}) {
		return this.#taking({ replace, ephemeral: false }, async () => {
			const b = await step('opening the backup (scrypt, a few seconds)', () => openBackup(text, passphrase), (x) => `${Object.keys(x.index.notes).length} notes, all verified`);
			await clearAll();
			await writeBlob(FILES.vault, b.vaultBytes);
			const files: LocalFiles = {};
			for (const [rel, bytes] of Object.entries(b.files)) files[rel] = c.toBase64(bytes as Uint8Array);
			await writeLocalCopy(files);
			await writeBlob(FILES.indexCache, await c.encryptIndex(b.keys, b.index));
			const conf: WebConfig = { v: 1, cfg: { v: 1, ...b.cfg, backends: b.cfg.backends ?? [] } as VaultCfg, published: null };
			this.#keys = b.keys;
			this.#conf = conf;
			await this.#saveConfig();
			await this.#open({ vault: b.vault, keys: b.keys, passphrase, vaultBytes: b.vaultBytes, conf });
			return { name: conf.cfg.name ?? null, notes: Object.keys(b.index.notes).length };
		});
	}

	/** Exactly what one host stores for a note (nothing decrypted), for "View raw copy". */
	async rawCopy(name: string, backend: string): Promise<{ text: string; format: 'json' | 'base64'; link?: string } | null> {
		return this.store.rawCopy(name, backend);
	}

	/** Type and location of a backend of this vault, by its internal name (also ones the browser cannot drive). */
	hostOf(name: string): { type: string; where: string } | null {
		const b = this.backends.find((x) => x.name === name);
		if (b) return { type: b.type, where: b.where };
		const cfg = this.cfg?.backends.find((x) => x.name === name);
		return cfg ? { type: cfg.type, where: String(cfg.url ?? cfg.origin ?? cfg.path ?? '') } : null;
	}

	/** Download and verify every copy of one note now; the result goes into the health ledger. */
	async checkNote(name: string) {
		const store = this.store;
		name = name.normalize('NFC');
		const index = await store.mergedIndex();
		if (!index.notes[name]) throw new Error(`"${name}" is not in the index`);
		await step(`checking every copy of "${name}"`, () => Promise.all(store.backends.map((b: Adapter) => store.verify(name, b, index))), (r) => `${r.filter((x) => x.status === 'OK').length}/${r.length} copies OK`);
		await store.writeIndex(index);
		return this.noteHosts(name);
	}

	/** The merged index from the hosts; offline, this device's last copy. */
	async list(): Promise<{ notes: Record<string, { id: string; sha256: string; size: number; updated: string }>; offline: boolean }> {
		try {
			return { notes: await this.store.list(), offline: false };
		} catch (err) {
			const local = await this.store.localIndex().catch(() => null);
			if (!local) throw err;
			logger.warn(`index not reachable (${(err as Error).message}); showing this device's last copy`);
			return { notes: local.notes, offline: true };
		}
	}

	async check() {
		const report = await step('downloading and verifying every copy', () => this.store.check());
		const conf = this.#conf;
		if (conf) {
			conf.checkedAt = new Date().toISOString();
			this.lastFullCheck = conf.checkedAt;
			await this.#saveConfig().catch(() => {});
		}
		return report;
	}

	async repair(report: Awaited<ReturnType<Overkill['check']>>) {
		const r = await step('re-uploading missing, corrupt or stale copies', () => this.store.repair(report), (x) => `${x.fixed.length} repaired, ${x.failed.length} failed`);
		await this.publishDiscovery({ audit: true });
		return r;
	}

	/** Republish copies that are missing or due within `days` (the CLI's `refresh`; Nostr and Blossom copies by our 120-day assumption). */
	async refresh(report: Awaited<ReturnType<Overkill['check']>>, days = 90) {
		const r = await step(`republishing copies due within ${days} days`, () => this.store.refresh({ days, report }), (x) => `${x.fixed.length} republished, ${x.failed.length} failed`);
		await this.publishDiscovery({ audit: true });
		return r;
	}

	/** What the health ledger says, from this device's encrypted index copy (no network). */
	async ledger() {
		const index = await this.store.localIndex();
		if (!index) return null;
		const names = this.backends.map((b) => b.name);
		const indexOn = this.store.remoteIndex ? this.store.indexHolders.map((b: Adapter) => b.name) : [];
		return { index, ...ledgerStatus(index, names, new Date(), { indexOn }) };
	}

	/** The same recovery kit the CLI prints. */
	async kit() {
		const keys = this.#keys!;
		const adapters = new Map(this.backends.map((b) => [b.name, b]));
		// backends this browser cannot drive still belong on the sheet
		const all = await Promise.all(this.cfg!.backends.map(async (b) => adapters.get(b.name) ?? {
			name: b.name,
			type: b.type,
			where: b.type === 'cryptpad' ? `${b.origin} drive:/${this.cfg!.root ?? DEFAULT_ROOT}` : String(b.url ?? b.origin ?? b.path ?? '(set up in the CLI)'),
			...(b.type === 'cryptpad' && b.derived ? { accountName: async () => (await c.deriveCryptpadCredentials(keys.master, new URL(String(b.origin)).host)).username } : {})
		}));
		// the vault link points at this copy of the web app
		const site = new URL(to('/'), location.href).href;
		return recoveryKit({ vault: this.#vault, cfg: this.cfg, backends: all, generated: this.generated, site });
	}

	async lock() {
		await this.#store?.close().catch(() => {});
		this.#store = null;
		this.#keys = null;
		this.#vault = null;
		this.#pass = null;
		this.#vaultBytes = null;
		this.#conf = null;
		this.#discoverySecret = null;
		this.#secrets = null;
		this.cfg = null;
		this.generated = null;
		if (this.ephemeral) {
			// on a public computer, locking forgets the in-memory vault too
			endEphemeral();
			this.ephemeral = false;
		}
		this.status = (await readBlob(FILES.vault)) ? 'locked' : 'none';
	}

	/** "Done: wipe this tab": forget the keys, the in-memory files and this browser's stored copy. */
	async wipe() {
		await this.lock();
		await clearStored();
		rememberName(null);
		try {
			sessionStorage.clear();
		} catch {
			// nothing stored there anyway
		}
		this.status = 'none';
	}

	/** Drop this browser's copy (the hosts keep theirs; recover by name brings it back). */
	async forget() {
		await this.lock();
		await clearAll();
		rememberName(null);
		this.status = 'none';
	}
}

export { MIN_COPIES };

// test builds only (VITE_OVERKILL_TEST_HOOKS, set by build:test; gone from real builds): lets
// the e2e tests interrupt a create or recover right after the old files were cleared
async function testHook() {
	if (!import.meta.env.VITE_OVERKILL_TEST_HOOKS) return;
	const mode = (globalThis as { __ovkAfterClear?: string }).__ovkAfterClear;
	if (mode === 'throw') throw new Error('interrupted after clearing (test hook)');
	if (mode === 'hang') await new Promise(() => {});
}

const step = <T>(message: string, fn: () => Promise<T>, done?: (v: T) => string) => activity.step(message, fn, done);

export const vault = new VaultState();
