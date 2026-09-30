<script lang="ts">
	import { page } from '$app/state';
	import { beforeNavigate } from '$app/navigation';
	import Locked from '$lib/components/Locked.svelte';
	import ActivityLog from '$lib/components/ActivityLog.svelte';
	import { activity } from '$lib/overkill/activity.svelte';
	import { vault, type NoteHost } from '$lib/overkill/vault.svelte';
	import { to } from '$lib/link';
	import HostType from '$lib/components/HostType.svelte';
	import HostLink from '$lib/components/HostLink.svelte';
	import { typeName, baseUrl } from '$lib/hosttype';

	const BAD = ['missing', 'corrupt', 'stale', 'error'];
	const LAYERS: Record<string, string> = {
		privatebin: "PrivateBin's encrypted paste, as its API serves it: PrivateBin's AES-256-GCM layer (ct, adata) over our two layers.",
		cryptpad: 'The pad as CryptPad hands it over once its own layer is removed in transit: our base64 ciphertext (two layers) inside.',
		nostr: 'The kind 30078 event(s) straight from this relay: content is the NIP-44 ciphertext over our two layers, signed by the vault key.',
		blossom: 'The blob as served, base64: our extra AES-256-GCM layer over our two layers.'
	};
	// collapsed by default: one summary line and the first hosts; details (and raw copies) on request
	let showAll = $state(false);
	// the raw copy panel per host: closed, loading, or what the host serves
	let raw = $state<Record<string, { loading: boolean; text?: string; format?: string; link?: string; error?: string }>>({});

	async function toggleRaw(h: NoteHost) {
		if (raw[h.name]) return void delete raw[h.name];
		raw[h.name] = { loading: true };
		try {
			const r = await vault.rawCopy(name, h.name);
			raw[h.name] = r ? { loading: false, ...r } : { loading: false, error: 'This host has no copy of this note.' };
		} catch (x) {
			raw[h.name] = { loading: false, error: (x as Error).message };
		}
	}

	const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
	const summary = $derived.by(() => {
		const total = hosts.length;
		const ok = hosts.filter((h) => h.status === 'ok').length;
		const bad = hosts.filter((h) => BAD.includes(h.status)).length;
		const unknown = total - ok - bad;
		const latest = hosts.map((h) => h.lastChecked).filter((x): x is string => Boolean(x)).sort().at(-1);
		const checked = latest ? `, checked ${hhmm(latest)}` : '';
		if (total && ok === total) return { text: `Stored on ${total} of ${total} hosts, all OK${checked}`, warn: false };
		const parts = [`${ok} of ${total} OK`];
		if (bad) parts.push(`${bad} need repair`);
		if (unknown) parts.push(`${unknown} not verified yet`);
		return { text: parts.join(', ') + checked, warn: bad > 0 };
	});

	const name = $derived(page.params.name ?? '');
	let text = $state('');
	// what the hosts hold: the text as loaded or last published
	let saved = $state<string | null>(null);
	let readFrom = $state<{ backend: string; ms: number } | null>(null);
	let entry = $state<{ id: string; updated: string } | null>(null);
	let problems = $state<{ backend: string; status: string }[]>([]);
	let hosts = $state<NoteHost[]>([]);
	let savedOn = $state<{ ok: number; total: number } | null>(null);
	let err = $state('');
	let busy = $state(false);
	let loadedFor = '';

	const dirty = $derived(saved !== null && text !== saved);
	const okCount = (list: NoteHost[]) => list.filter((h) => h.status === 'ok').length;

	$effect(() => {
		const n = name;
		if (vault.status !== 'unlocked' || loadedFor === n) return;
		loadedFor = n;
		saved = null;
		err = '';
		activity.clear();
		vault.get(n).then(
			(r) => {
				text = r.text;
				saved = r.text;
				readFrom = { backend: r.from, ms: r.ms };
				entry = r.entry ?? null;
				problems = r.problems;
				hosts = r.hosts;
				savedOn = null;
			},
			(x) => (err = (x as Error).message)
		);
	});

	async function publish() {
		busy = true;
		err = '';
		activity.clear();
		try {
			const r = await vault.put(name, text);
			saved = text;
			entry = r.entry;
			savedOn = { ok: r.results.filter((x) => x.ok).length, total: r.results.length };
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}

	async function checkNow() {
		busy = true;
		err = '';
		activity.clear();
		try {
			hosts = await vault.checkNote(name);
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}

	// unpublished changes: ask before leaving, in the app and for the whole tab
	beforeNavigate((nav) => {
		if (dirty && nav.type !== 'leave' && !confirm('This note has changes that are not published yet. Leave anyway?')) nav.cancel();
	});
	$effect(() => {
		if (!dirty) return;
		const guard = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener('beforeunload', guard);
		return () => window.removeEventListener('beforeunload', guard);
	});

	const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : 'never');
</script>

<Locked>
	<div class="row">
		<h1 class="name">{name}</h1>
		<a class="button secondary" href={to('/notes/')}>All notes</a>
	</div>
	{#if err}<p class="error-box" role="alert">{err}</p>{/if}
	{#if saved !== null}
		<label for="note-body" class="sr-only">Note</label>
		<textarea id="note-body" class="body" bind:value={text} data-testid="note-text"></textarea>
		<div class="row status">
			{#if dirty}
				<button onclick={publish} disabled={busy} data-testid="publish">{busy ? 'Publishing...' : 'Publish changes'}</button>
				<span class="warn small">Not published yet.</span>
			{:else}
				<span class="ok small" data-testid="saved-status">
					{#if savedOn}Saved on {savedOn.ok}/{savedOn.total} hosts.{:else if okCount(hosts)}Saved on {okCount(hosts)}/{hosts.length} hosts (as last verified).{:else}Saved. Copies not verified from this browser yet.{/if}
				</span>
			{/if}
		</div>
		{#if readFrom}{@const src = vault.hostOf(readFrom.backend)}<p class="muted small" data-testid="note-source" data-backend={readFrom.backend}>Read from {src ? `${typeName(src.type)} (${baseUrl(src.where) ?? src.where})` : 'a host'} in {(readFrom.ms / 1000).toFixed(1)} s, both layers and the sha256 verified.</p>{/if}
		{#if problems.length}<p class="warn small">Skipped on the way: {problems.map((p) => { const h = vault.hostOf(p.backend); return `${h ? `${typeName(h.type)} ${baseUrl(h.where) ?? ''}` : 'a host'} ${p.status}`; }).join(', ')}.</p>{/if}
		{#if entry}<p class="muted small">Updated {entry.updated}. Blob id <span class="id">{entry.id}</span></p>{/if}

		<section class="lives" data-testid="note-lives">
			<p class="lives-line">
				<span data-testid="lives-summary" class={summary.warn ? 'warn' : ''}>{summary.text}</span>
				{#if !showAll}<button class="link" onclick={() => (showAll = true)} data-testid="show-all">Show all details</button>{/if}
			</p>
			{#if !showAll}
				<ul class="preview" data-testid="lives-preview">
					{#each hosts.slice(0, 3) as h (h.name)}
						<li data-backend={h.name}>
							<HostType type={h.type} name={h.name} /> <span class="id">{baseUrl(h.where) ?? h.where}</span>
							<span class={BAD.includes(h.status) ? 'warn' : ''}>{h.status === 'ok' ? 'OK' : h.status.toUpperCase()}</span>
							{#if readFrom?.backend === h.name}<span class="badge read" data-testid="read-from">read from here</span>{/if}
						</li>
					{/each}
					{#if hosts.length > 3}<li>and {hosts.length - 3} more</li>{/if}
				</ul>
			{:else}
				<div class="table-scroll">
					<table data-testid="note-hosts" class="compact">
						<thead><tr><th>Type</th><th>Where</th><th>Status</th><th>Last verified</th><th></th></tr></thead>
						<tbody>
							{#each hosts as h (h.name)}
								<tr data-testid="host-{h.name}" data-backend={h.name}>
									<td>
										<HostType type={h.type} name={h.name} />
										{#if readFrom?.backend === h.name}<span class="badge read" data-testid="read-from">read from here</span>{/if}
									</td>
									<td><HostLink where={h.where} /></td>
									<td class="mono {BAD.includes(h.status) ? 'warn' : ''}">{h.status.toUpperCase()}</td>
									<td class="mono">{h.lastChecked && h.status === 'ok' && Date.now() - Date.parse(h.lastChecked) < 60_000 ? 'just now' : when(h.lastOk)}</td>
									<td><button class="link" onclick={() => toggleRaw(h)} aria-expanded={Boolean(raw[h.name])} data-testid="raw-{h.name}">{raw[h.name] ? 'Hide raw copy' : 'View raw copy'}</button></td>
								</tr>
								{#if raw[h.name]}
									{@const r = raw[h.name]}
									<tr class="raw-row">
										<td colspan="5" data-testid="raw-view-{h.name}">
											{#if r.loading}
												<p class="mono">Fetching what this host stores...</p>
											{:else if r.error}
												<p class="warn">{r.error}</p>
											{:else}
												<p>{LAYERS[h.type] ?? 'The stored bytes, base64.'} Nothing is decrypted here.</p>
												<pre class="raw" data-testid="raw-text">{r.text}</pre>
												{#if r.link}
													<p>
														<a href={r.link} target="_blank" rel="noopener noreferrer" data-testid="raw-link">{h.type === 'privatebin' ? 'Open in PrivateBin' : h.type === 'cryptpad' ? 'Open in CryptPad' : 'Open'}</a>
														<span class="warn">This link contains {h.type === 'privatebin' ? "PrivateBin's" : "CryptPad's"} key for this copy; don't share it.</span>
													</p>
												{/if}
											{/if}
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
				<p>From this browser's health ledger; UNKNOWN means not verified yet.</p>
				<button class="secondary small-button" onclick={checkNow} disabled={busy} data-testid="check-note">{busy ? 'Checking...' : 'Check all copies now'}</button>
				<button class="link" onclick={() => ((showAll = false), (raw = {}))} data-testid="show-less">Show less</button>
			{/if}
		</section>
	{:else if !err}
		<p class="muted mono">Peeling the layers...</p>
	{/if}
	<ActivityLog />
</Locked>

<style>
	.name { overflow-wrap: anywhere; }
	.body { width: 100%; min-height: 12em; font-size: 0.95rem; }
	.small { font-size: 0.85rem; }
	.status { min-height: 2.6em; }
	.badge.read { color: var(--muted); margin-left: 6px; font-size: 0.72rem; border: 1px solid var(--line); border-radius: 8px; padding: 0 6px; white-space: nowrap; }
	.lives { color: var(--muted); font-size: 0.82rem; margin: 18px 0; }
	.lives-line { margin: 0 0 4px; }
	.lives .preview { list-style: none; padding: 0; margin: 0; }
	.lives .preview li { margin: 2px 0; }
	.lives table { color: var(--muted); }
	.small-button { font-size: 0.8rem; padding: 4px 10px; }
	table.compact { font-size: 0.85rem; }
	table.compact td, table.compact th { padding: 3px 8px; }
	.raw { max-height: 24em; overflow: auto; white-space: pre-wrap; word-break: break-all; font-size: 0.75rem; background: var(--panel-2); padding: 8px; border-radius: 6px; margin: 4px 0; }
	button.link { background: none; border: 0; color: var(--cyan); text-decoration: underline; padding: 0 4px; font-weight: 400; font-size: 0.8rem; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
