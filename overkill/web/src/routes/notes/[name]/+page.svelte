<script lang="ts">
	import { page } from '$app/state';
	import { beforeNavigate } from '$app/navigation';
	import Locked from '$lib/components/Locked.svelte';
	import ActivityLog from '$lib/components/ActivityLog.svelte';
	import { activity } from '$lib/overkill/activity.svelte';
	import { vault, type NoteHost } from '$lib/overkill/vault.svelte';
	import { to } from '$lib/link';

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
		{#if readFrom}<p class="muted small" data-testid="note-source">Read from <span class="mono">{readFrom.backend}</span> in {(readFrom.ms / 1000).toFixed(1)} s, both layers and the sha256 verified.</p>{/if}
		{#if problems.length}<p class="warn small">Skipped on the way: {problems.map((p) => `${p.backend} ${p.status}`).join(', ')}.</p>{/if}
		{#if entry}<p class="muted small">Updated {entry.updated}. Blob id <span class="id">{entry.id}</span></p>{/if}

		<div class="panel">
			<div class="row">
				<h2>Where this note lives</h2>
				<button class="secondary" onclick={checkNow} disabled={busy} data-testid="check-note">{busy ? 'Checking...' : 'Check all copies now'}</button>
			</div>
			<div class="table-scroll">
				<table data-testid="note-hosts">
					<thead><tr><th>Host</th><th>Where</th><th>Status</th><th>Last verified</th></tr></thead>
					<tbody>
						{#each hosts as h (h.name)}
							<tr data-testid="host-{h.name}">
								<td class="mono">
									{h.name}
									{#if readFrom?.backend === h.name}<span class="badge read" data-testid="read-from">read from here</span>{/if}
								</td>
								<td class="id">{h.where}</td>
								<td class="mono {h.status === 'ok' ? 'ok' : h.status === 'unknown' ? 'muted' : 'bad'}">{h.status.toUpperCase()}</td>
								<td class="mono small">{when(h.lastOk)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="muted small">From the health ledger in this browser's copy of the index. UNKNOWN: not verified yet; "Check all copies now" downloads and verifies each one.</p>
		</div>
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
	.badge.read { color: var(--cyan); margin-left: 6px; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
