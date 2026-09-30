<script lang="ts">
	import { page } from '$app/state';
	import { beforeNavigate } from '$app/navigation';
	import Locked from '$lib/components/Locked.svelte';
	import ActivityLog from '$lib/components/ActivityLog.svelte';
	import { activity } from '$lib/overkill/activity.svelte';
	import { vault, MIN_COPIES } from '$lib/overkill/vault.svelte';
	import { generateNoteName } from '$lib/overkill/passphrase';
	import { to, noteHref } from '$lib/link';

	const editing = page.url.searchParams.get('name');
	// a new note gets a made-up name (optional to change): notes never collide on one default
	let name = $state(editing ?? generateNoteName());
	let retrying = $state(false);
	let retried = $state<{ fixed: string[]; failed: string[] } | null>(null);
	let text = $state('');
	let busy = $state(false);
	let err = $state('');
	let saved = $state<{ name: string; ok: number; total: number; sampled: string[] } | null>(null);
	let loaded = false;
	// the text as last stored (or loaded for editing): anything else is not stored yet
	let storedText = $state('');

	const dirty = $derived(!busy && text.trim().length > 0 && text !== storedText);
	beforeNavigate((nav) => {
		if (dirty && nav.type !== 'leave' && !confirm('Your note is not stored yet. Leave anyway?')) nav.cancel();
	});
	$effect(() => {
		if (!dirty) return;
		const guard = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener('beforeunload', guard);
		return () => window.removeEventListener('beforeunload', guard);
	});

	// Editing: pull the current text first.
	$effect(() => {
		if (editing && vault.status === 'unlocked' && !loaded) {
			loaded = true;
			vault.get(editing).then((n) => ((text = n.text), (storedText = n.text)), (x) => (err = (x as Error).message));
		}
	});

	// copies that failed: check every copy, then repair
	async function retry() {
		retrying = true;
		err = '';
		activity.clear();
		try {
			retried = await vault.repair(await vault.check());
			const now = await vault.check();
			const notes = now.notes as Record<string, { status: string }[]>;
			const copies = saved ? notes[saved.name] : null;
			if (saved && copies) saved = { ...saved, ok: copies.filter((x: { status: string }) => x.status === 'OK').length, total: copies.length };
		} catch (x) {
			err = (x as Error).message;
		} finally {
			retrying = false;
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		err = '';
		saved = null;
		if (!name.trim()) name = generateNoteName();
		busy = true;
		activity.clear();
		try {
			const r = await vault.put(name.trim(), text);
			storedText = text;
			saved = {
				name: name.trim().normalize('NFC'),
				ok: r.results.filter((x) => x.ok).length,
				total: r.results.length,
				sampled: r.sampled.map((x: { key: string; backend: string; status: string }) => `${x.key} on ${x.backend} ${x.status}`)
			};
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<Locked>
	<h1>{editing ? 'Edit note' : 'New note'}</h1>
	<form class="panel" onsubmit={save}>
		<label for="note-text">Top secret contents</label>
		<textarea id="note-text" bind:value={text}></textarea>
		<label for="note-name">Name (optional; only you see it, hosts get an HMAC)</label>
		<div class="name-row">
			<input id="note-name" type="text" autocomplete="off" readonly={Boolean(editing)} bind:value={name} />
			{#if !editing}<button type="button" class="link" onclick={() => (name = generateNoteName())}>roll</button>{/if}
		</div>
		{#if err}<p class="error-box" role="alert">{err}</p>{/if}
		<button type="submit" disabled={busy}>{busy ? 'Applying layers...' : 'Encrypt and scatter'}</button>
	</form>
	{#if saved}
		<div class="panel" data-testid="saved">
			<p class={saved.ok === saved.total ? 'ok' : 'warn'}>Saved "{saved.name}" to {saved.ok}/{saved.total} hosts.</p>
			{#if saved.ok < saved.total}<p data-testid="stored-summary">Stored on {saved.ok} hosts; {saved.total - saved.ok} failed (will retry).</p>{/if}
			{#if saved.ok < MIN_COPIES}<p class="warn" data-testid="few-copies">Only {saved.ok} copy so far. Retry copies it to the hosts that did not answer.</p>{/if}
			{#if saved.ok < saved.total}
				<button type="button" onclick={retry} disabled={retrying} data-testid="retry">{retrying ? 'Retrying...' : 'Retry now'}</button>
				{#if retried}<p class="small" data-testid="retried">Retry: {retried.fixed.length} repaired, {retried.failed.length} still failing.</p>{/if}
			{/if}
			{#if saved.sampled.length}<p class="muted small">Spot check of other copies: {saved.sampled.join(', ')}</p>{/if}
			<a class="button" href={noteHref(saved.name)}>Open it</a>
			<a class="button secondary" href={to('/notes/')}>All notes</a>
		</div>
	{/if}
	<ActivityLog title="Upload log" />
</Locked>

<style>
	.small { font-size: 0.85rem; }
	.name-row { display: flex; gap: 6px; align-items: center; }
	.name-row input { flex: 1; }
	button.link { background: none; border: 0; color: var(--cyan); text-decoration: underline; padding: 4px 6px; font-weight: 400; }
</style>
