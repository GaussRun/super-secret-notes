<script lang="ts">
	// A quiet nudge on every visit with the vault open: free hosts decay, so a full check (and a
	// repair of what is missing) every month keeps every copy alive. Shown once the last full
	// check from this browser is older than 30 days.
	import { vault } from '$lib/overkill/vault.svelte';

	const DAYS = 30;
	let busy = $state(false);
	let done = $state<string | null>(null);
	let err = $state('');
	const age = $derived(vault.lastFullCheck ? Math.floor((Date.now() - Date.parse(vault.lastFullCheck)) / 86_400_000) : null);

	async function checkNow() {
		busy = true;
		err = '';
		try {
			const report = await vault.check();
			const r = await vault.repair(report);
			done = r.fixed.length ? `Checked; ${r.fixed.length} ${r.fixed.length === 1 ? 'copy' : 'copies'} restored${r.failed.length ? `, ${r.failed.length} still failing` : ''}.` : r.failed.length ? `Checked; ${r.failed.length} ${r.failed.length === 1 ? 'copy' : 'copies'} could not be restored yet.` : 'Checked: every copy is fine.';
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

{#if vault.status === 'unlocked' && ((age !== null && age > DAYS) || done || busy)}
	<p class="health muted" data-testid="health-banner">
		{#if busy}
			Checking every copy and restoring missing ones...
		{:else if done}
			{done}
		{:else}
			Last full check {age} days ago: <button class="link" onclick={checkNow} data-testid="health-check-now">Check now</button>
		{/if}
		{#if err}<span class="warn"> {err}</span>{/if}
	</p>
{/if}

<style>
	.health { font-size: 0.85rem; margin: 6px 0 0; }
	button.link { background: none; border: 0; color: var(--cyan); text-decoration: underline; padding: 0 4px; font-weight: 400; font-size: inherit; }
</style>
