<script lang="ts">
	// "Download full backup": one file with vault.age, the index and every note, all still
	// encrypted (nothing is decrypted for it). With the passphrase it brings the vault back with no
	// host at all (Recover, "Restore from a backup file").
	import { vault } from '$lib/overkill/vault.svelte';

	let busy = $state(false);
	let err = $state('');
	let saved = $state(false);

	async function save() {
		busy = true;
		err = '';
		try {
			const text = await vault.backupFile();
			const href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
			const a = document.createElement('a');
			a.href = href;
			a.download = `super-secret-notes-backup-${vault.cfg?.name ?? 'vault'}.json`;
			document.body.append(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(href), 60_000);
			saved = true;
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<div class="backup">
	<button type="button" class="secondary" onclick={save} disabled={busy} data-testid="download-backup">{busy ? 'Reading every note...' : 'Download full backup'}</button>
	<span class="muted small">Every note in one encrypted file; with your passphrase it restores the vault even if every host is gone.</span>
	{#if saved}<p class="muted small" data-testid="backup-saved">The backup went to your downloads. Keep it somewhere safe and offline; it opens only with your passphrase.</p>{/if}
	{#if err}<p class="error-box" role="alert">{err}</p>{/if}
</div>

<style>
	.backup { margin: 8px 0; }
	.small { font-size: 0.85rem; }
</style>
