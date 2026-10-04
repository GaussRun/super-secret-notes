<script lang="ts">
	// Pages that need the vault open. A reload locks it (keys live in memory only), so this
	// asks for the passphrase right here and the page carries on.
	import { vault } from '$lib/overkill/vault.svelte';
	import { to } from '$lib/link';
	import { rememberedName, savedCredential } from '$lib/overkill/credentials';
	import PublicComputer from '$lib/components/PublicComputer.svelte';
	import AccessPaste from '$lib/components/AccessPaste.svelte';
	import type { PastedAccess } from '$lib/overkill/access';
	import { tick } from 'svelte';
	let { children } = $props();

	// the username the password manager pairs the passphrase with
	let name = $state(rememberedName());
	let passphrase = $state('');
	let publicMode = $state(false);
	let asked = false;

	// Chromium: offer the saved credential without a prompt (mediation "optional")
	$effect(() => {
		if (vault.status !== 'locked' || asked) return;
		asked = true;
		savedCredential().then((c) => {
			if (!c || (name && c.id !== name) || passphrase) return;
			name ||= c.id;
			passphrase = c.password;
		});
	});
	let busy = $state(false);
	let err = $state('');

	// a pasted access link or kit: the passphrase goes into the field (for this vault only)
	let passField = $state<HTMLInputElement | null>(null);
	async function take(a: PastedAccess) {
		const held = rememberedName();
		if (held && a.name !== held) {
			err = `That is the access for "${a.name}"; this browser holds "${held}". Use "Recover a different vault" for it.`;
			return;
		}
		err = '';
		name = a.name;
		if (a.passphrase === undefined) {
			// a vault link: the passphrase is still needed
			await tick();
			return void passField?.focus();
		}
		passphrase = a.passphrase;
	}

	async function unlock(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		err = '';
		try {
			await vault.unlock(passphrase, { ephemeral: publicMode });
			passphrase = '';
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

{#if vault.status === 'unlocked'}
	{@render children()}
{:else if vault.status === 'locked'}
	<form class="panel unlock" method="post" action="#" onsubmit={unlock} data-testid="unlock-form">
		<h2>Locked</h2>
		<p class="muted">This browser holds your vault, encrypted. Keys live only in memory, so every reload asks again.</p>
		<AccessPaste onaccess={take} />
		<label for="unlock-name">Vault name</label>
		<!-- a normal field (not readonly): password managers skip read-only fields when filling -->
		<input id="unlock-name" name="username" type="text" autocomplete="username" bind:value={name} />
		<label for="unlock-pass">Passphrase</label>
		<input id="unlock-pass" name="password" type="password" autocomplete="current-password" required bind:value={passphrase} bind:this={passField} />
		<PublicComputer bind:checked={publicMode} />
		{#if err}<p class="error-box" role="alert">{err}</p>{/if}
		<button type="submit" disabled={busy || !passphrase}>{busy ? 'Running scrypt...' : 'Unlock'}</button>
		<p class="other" data-testid="other-vault">
			<a class="button secondary" href={to('/setup/')}>Store note in new vault</a>
			<a href={to('/recover/')}>Recover a different vault</a>
		</p>
		<p class="muted small">A new vault takes this one's place in this browser. This one stays on its hosts: its vault name and passphrase bring it back (Recover).</p>
	</form>
{:else if vault.status === 'none'}
	<div class="panel">
		<h2>No vault in this browser</h2>
		<p><a class="button" href={to('/setup/')}>Make one</a> <a class="button secondary" href={to('/recover/')}>Recover by name + passphrase</a></p>
	</div>
{:else}
	<p class="muted mono">Checking your clearance level...</p>
{/if}

<style>
	.unlock { max-width: 520px; }
	.other { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
	.small { font-size: 0.85rem; }
</style>
