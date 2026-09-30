<script lang="ts">
	import Locked from '$lib/components/Locked.svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { ago, retention } from '$cli/status.js';
	import { to } from '$lib/link';
	import HostType from '$lib/components/HostType.svelte';
	import HostLink from '$lib/components/HostLink.svelte';

	type Row = { backend: string; copies: number; healthy: number; errors: number; unverified: number; oldestOk: string | null; nextExpiry: string | null };
	let data = $state<{ rows: Row[]; warnings: string[]; written: string | null } | null | undefined>(undefined);
	let err = $state('');

	$effect(() => {
		if (vault.status !== 'unlocked') return;
		vault.ledger().then(
			(l) => (data = l ? { rows: l.backends, warnings: l.warnings, written: l.index.written ?? null } : null),
			(x) => (err = (x as Error).message)
		);
	});
</script>

<Locked>
	<h1>Status</h1>
	<p class="muted">What the health ledger in the index says, from this browser's encrypted copy. No network; <a href={to('/check/')}>Check</a> verifies everything live.</p>
	{#if err}<p class="error-box" role="alert">{err}</p>{/if}
	{#if data === null}
		<p class="muted">No ledger in this browser yet: open <a href={to('/notes/')}>Notes</a> or run a <a href={to('/check/')}>check</a> once.</p>
	{:else if data}
		<div class="panel table-scroll">
			<table data-testid="status-table">
				<thead><tr><th>Type</th><th>Where</th><th>Healthy</th><th>Oldest OK</th><th>Retention</th></tr></thead>
				<tbody>
					{#each data.rows as r (r.backend)}
						{@const h = vault.hostOf(r.backend)}
						<tr data-backend={r.backend}>
							<td><HostType type={h?.type ?? ''} name={r.backend} /></td>
							<td>{#if h}<HostLink where={h.where} />{/if}</td>
							<td class="mono {r.copies - r.unverified - r.healthy > 0 ? 'bad' : r.unverified ? '' : 'ok'}">{r.healthy}/{r.copies}</td>
							<td class="mono">{ago(r.oldestOk)}</td>
							<td class="small">{retention(vault.backends.find((b) => b.name === r.backend)?.type, r.nextExpiry)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="muted small">Ledger from {data.written ?? 'unknown'}. Nostr relays and Blossom servers promise no retention: "republish by" is our own policy (a copy counts as gone 120 days after it was published, and Refresh on the Check page republishes it once it is 30 days old), not the host's promise.</p>
		{#each data.warnings as w (w)}<div class="mono small {w.startsWith('STALE CHECK') ? 'muted' : 'bad'}">{w}</div>{/each}
		{#if !data.warnings.length}<p class="ok">No warnings. Every copy was verified recently.</p>{/if}
	{/if}
</Locked>

<style>
	.small { font-size: 0.82rem; }
</style>
