<script lang="ts">
	// The vault name, large: with the passphrase it is all it takes to open the vault anywhere. Plus
	// the calendar reminder to check the vault every 3 months.
	import { vault } from '$lib/overkill/vault.svelte';
	import { reminderIcs } from '$lib/overkill/reminder';
	import { to } from '$lib/link';

	function saveReminder() {
		const name = vault.cfg!.name!;
		const ics = reminderIcs(name, vault.vaultLink(new URL(to('/recover/'), location.href).href));
		const href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
		const a = document.createElement('a');
		a.href = href;
		a.download = `super-secret-notes-check-${name}.ics`;
		document.body.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(href), 60_000);
	}
</script>

{#if vault.cfg?.name}
	<div class="identity" data-testid="vault-identity">
		<div class="label muted">Vault name</div>
		<div class="name id" data-testid="vault-identity-name">{vault.cfg.name}</div>
		<p class="small">You need this name AND your passphrase to open the vault anywhere. Your password manager saves both.</p>
		<button type="button" class="secondary" onclick={saveReminder} data-testid="reminder">Add a reminder to check your vault every 3 months</button>
	</div>
{/if}

<style>
	.identity { margin: 10px 0 16px; }
	.label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; }
	.name { font-family: var(--mono); font-size: clamp(1.4rem, 4.5vw, 2rem); font-weight: 800; word-break: break-all; }
	.small { font-size: 0.9rem; margin: 4px 0 8px; }
</style>
