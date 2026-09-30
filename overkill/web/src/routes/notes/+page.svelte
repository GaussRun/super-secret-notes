<script lang="ts">
	import Locked from '$lib/components/Locked.svelte';
	import ActivityLog from '$lib/components/ActivityLog.svelte';
	import { activity } from '$lib/overkill/activity.svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { to, noteHref } from '$lib/link';
	import ShareVault from '$lib/components/ShareVault.svelte';
	let phone = $state(false);

	type Entry = { id: string; sha256: string; size: number; updated: string };
	let notes = $state<[string, Entry][] | null>(null);
	let offline = $state(false);
	let err = $state('');

	async function load() {
		err = '';
		activity.clear();
		try {
			const r = await vault.list();
			notes = Object.entries(r.notes).sort(([a], [b]) => a.localeCompare(b));
			offline = r.offline;
		} catch (x) {
			err = (x as Error).message;
		}
	}

	$effect(() => {
		if (vault.status === 'unlocked') load();
	});
</script>

<Locked>
	<div class="row">
		<h1>Notes</h1>
		<a class="button" href={to('/new/')}>New note</a>
		<button class="secondary" onclick={load}>Reload</button>
		<button class="secondary" onclick={() => (phone = !phone)} aria-expanded={phone}>Share this vault</button>
	</div>
	{#if phone}<ShareVault />{/if}
	{#if err}<p class="error-box" role="alert">{err}</p>{/if}
	{#if offline}<p class="warn">The hosts holding the index did not answer; this is this browser's last copy.</p>{/if}
	{#if notes === null && !err}
		<p class="muted mono">Fetching the index from the relays...</p>
	{:else if notes?.length === 0}
		<p class="muted" data-testid="no-notes">No notes yet. <a href={to('/new/')}>Write the first one.</a></p>
	{:else if notes}
		<div class="panel table-scroll">
			<table data-testid="notes-table">
				<thead><tr><th>Name</th><th>Size</th><th>Updated</th><th>Blob id</th></tr></thead>
				<tbody>
					{#each notes as [name, e] (name)}
						<tr>
							<td><a href={noteHref(name)}>{name}</a></td>
							<td class="mono">{e.size} B</td>
							<td class="mono small">{e.updated}</td>
							<td class="id">{e.id}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	<ActivityLog />
</Locked>

<style>
	.small { font-size: 0.8rem; }
</style>
