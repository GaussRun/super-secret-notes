<script lang="ts">
	// The "public computer mode" switch for setup, recover and unlock (off by default).
	let { checked = $bindable(false) }: { checked?: boolean } = $props();
</script>

<div class="public">
	<label class="check"><input type="checkbox" name="public-computer" bind:checked /> Public computer: keep nothing in this browser</label>
	{#if checked}
		<p class="small" data-testid="public-explained">
			The vault stays in this tab's memory only: nothing goes into this browser's storage, and
			the password manager is not asked to save anything. When you are done, press "Done: wipe
			this tab". A public computer may still have a keylogger or record the screen, so use a
			throwaway vault for one-off transfers, and change anything important afterwards.
		</p>
	{/if}
</div>

<style>
	.public { margin: 10px 0; }
	.check { display: flex; gap: 8px; align-items: center; color: var(--text); }
	.small { font-size: 0.85rem; color: var(--amber); }
</style>
