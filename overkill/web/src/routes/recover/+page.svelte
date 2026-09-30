<script lang="ts">
	import { goto } from '$app/navigation';
	import ActivityLog from '$lib/components/ActivityLog.svelte';
	import { activity } from '$lib/overkill/activity.svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { loadHosts } from '$lib/overkill/settings';
	import { to } from '$lib/link';
	import { storeCredential, rememberedName } from '$lib/overkill/credentials';
	import { parseHandoff } from '$lib/overkill/qr';
	import PublicComputer from '$lib/components/PublicComputer.svelte';

	let name = $state('');
	let passphrase = $state('');
	let busy = $state(false);
	let err = $state('');
	let result = $state<{ from: string; names: string[]; others: string[]; unsupported: string[] } | null>(null);
	const hosts = loadHosts();
	let publicMode = $state(false);
	let fromLink = $state(false);
	// this browser already holds a vault: the recovered one takes its place once it is found
	const replacing = $derived(vault.status === 'locked' || vault.status === 'unlocked');
	const current = $derived(vault.cfg?.name ?? rememberedName());

	// A "send to phone" link: take the vault name and passphrase from the fragment, then wipe
	// the fragment from the address bar and this history entry right away (SvelteKit's own
	// history state is passed through unchanged). The fragment never reaches a server anyway.
	const handoff = parseHandoff(location.hash);
	if (location.hash) {
		try {
			history.replaceState(history.state, '', location.pathname + location.search);
		} catch {
			location.hash = '';
		}
	}
	if (handoff) {
		name = handoff.name;
		passphrase = handoff.passphrase;
		fromLink = true;
	}

	async function recover(e: SubmitEvent) {
		e.preventDefault();
		err = '';
		busy = true;
		activity.clear();
		try {
			const r = await vault.recover(name.trim(), passphrase, { ephemeral: publicMode, replace: replacing && !publicMode });
			if (!publicMode) await storeCredential(r.cfg.name ?? name.trim().normalize('NFC'), passphrase);
			passphrase = '';
			result = {
				from: r.from,
				names: r.cfg.backends.map((b: { name: string }) => b.name),
				others: r.others.map((b: { name: string; type: string }) => `${b.name} (${b.type})`),
				unsupported: r.unsupported.map((b) => `${b.name} (${b.type})`)
			};
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<h1>Recover by name + passphrase</h1>
{#if result}
	<div class="panel" data-testid="recovered">
		<h2 class="ok">Found it on {result.from}.</h2>
		<p>This browser now knows {result.names.length} hosts: <span class="id">{result.names.join(', ')}</span></p>
		{#if result.unsupported.length}<p class="warn">Kept in the vault but not usable from a browser: {result.unsupported.join(', ')}. The CLI still uses them.</p>{/if}
		{#if result.others.length}<p class="warn">Hosts that need their own login (add them with the CLI): {result.others.join(', ')}</p>{/if}
		<a class="button" href={to('/notes/')}>My notes</a>
		<a class="button secondary" href={to('/check/')}>Check every copy</a>
	</div>
{:else}
	{#if replacing}
		<p class="warn" data-testid="replace-note">
			This browser holds the vault {#if current}<strong class="id">{current}</strong>{/if}. The recovered vault takes its place here once it is found; the old one stays on its hosts and comes back the same way (its vault name and passphrase).
			<a href={to(vault.status === 'unlocked' ? '/notes/' : '/unlock/')}>Open it instead</a>
		</p>
	{/if}
	<form class="panel" method="post" action="#" onsubmit={recover} data-testid="recover-form">
		{#if fromLink}
			<p class="ok" data-testid="from-link"><strong>Recover this vault?</strong> The link filled in the vault name and passphrase (and has already been wiped from the address bar). Press Recover to go on; your password manager can save it afterwards.</p>
		{/if}
		<p class="muted">No kit, no files: the vault name and passphrase find a small encrypted record on the Nostr relays, which leads to vault.age and from there to everything else.</p>
		<label for="rec-name">Vault name</label>
		<input id="rec-name" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" required bind:value={name} />
		<label for="rec-pass">Passphrase</label>
		<input id="rec-pass" name="password" type="password" autocomplete="current-password" required bind:value={passphrase} />
		<PublicComputer bind:checked={publicMode} />
		{#if err}<p class="error-box" role="alert">{err}</p>{/if}
		<button type="submit" disabled={busy || !name.trim() || !passphrase}>{busy ? 'Searching the relays...' : 'Recover'}</button>
		<p class="muted small">Asks: <span class="id">{hosts.discovery.join(', ')}</span></p>
	</form>
{/if}

<ActivityLog title="Recovery log" />

<style>
	.small { font-size: 0.85rem; }
</style>
