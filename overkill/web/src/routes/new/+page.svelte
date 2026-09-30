<script lang="ts">
	import { page } from '$app/state';
	import Locked from '$lib/components/Locked.svelte';
	import ActivityLog from '$lib/components/ActivityLog.svelte';
	import { activity } from '$lib/overkill/activity.svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { to, noteHref } from '$lib/link';

	const editing = page.url.searchParams.get('name');
	let name = $state(editing ?? '');
	let text = $state('');
	let busy = $state(false);
	let err = $state('');
	let saved = $state<{ name: string; ok: number; total: number; sampled: string[] } | null>(null);
	let loaded = false;

	// Editing: pull the current text first.
	$effect(() => {
		if (editing && vault.status === 'unlocked' && !loaded) {
			loaded = true;
			vault.get(editing).then((n) => (text = n.text), (x) => (err = (x as Error).message));
		}
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		err = '';
		saved = null;
		busy = true;
		activity.clear();
		try {
			const r = await vault.put(name.trim(), text);
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
		<label for="note-name">Name (only you see it; hosts get an HMAC)</label>
		<input id="note-name" type="text" autocomplete="off" bind:value={name} placeholder="recovery codes" />
		<label for="note-text">Top secret contents</label>
		<textarea id="note-text" bind:value={text} placeholder="github: 7f3a-91c2 ..."></textarea>
		{#if err}<p class="error-box" role="alert">{err}</p>{/if}
		<button type="submit" disabled={busy || !name.trim()}>{busy ? 'Applying layers...' : 'Encrypt and scatter'}</button>
	</form>
	{#if saved}
		<div class="panel" data-testid="saved">
			<p class={saved.ok === saved.total ? 'ok' : 'warn'}>Saved "{saved.name}" to {saved.ok}/{saved.total} hosts.</p>
			{#if saved.sampled.length}<p class="muted small">Spot check of other copies: {saved.sampled.join(', ')}</p>{/if}
			<a class="button" href={noteHref(saved.name)}>Open it</a>
			<a class="button secondary" href={to('/notes/')}>All notes</a>
		</div>
	{/if}
	<ActivityLog title="Upload log" />
</Locked>

<style>
	.small { font-size: 0.85rem; }
</style>
