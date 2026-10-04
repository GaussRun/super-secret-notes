<script lang="ts">
	// One paste instead of two copies: the access link, its #fragment, the recovery kit file, the
	// QR's plain text, {"vault": ..., "passphrase": ...} or name and passphrase on two lines.
	// The passphrase only goes into the form (memory); nothing is stored, sent or logged here.
	import { parsePasted, type PastedAccess } from '$lib/overkill/access';

	// a vault link gives only the name: the passphrase is asked for next
	let { onaccess }: { onaccess: (a: PastedAccess) => void } = $props();
	let value = $state('');
	let hint = $state('');

	function take() {
		const a = parsePasted(value);
		if (!value.trim()) return void (hint = '');
		if (!a) return void (hint = 'That is not a vault link, an access link or a recovery kit. Paste the whole link (with the part after #) or the kit file, or type the name and passphrase below.');
		hint = '';
		value = ''; // the passphrase does not stay in this box
		onaccess(a);
	}
</script>

<div class="paste" data-testid="access-paste">
	<label for="access-paste-input">Paste your access link or recovery kit</label>
	<textarea id="access-paste-input" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value oninput={take}></textarea>
	{#if hint}<p class="bad small" data-testid="access-paste-hint">{hint}</p>{/if}
	<p class="muted small">Opening the access link itself in the address bar works too.</p>
</div>

<style>
	.paste textarea { min-height: 3em; font-family: var(--mono); font-size: 0.85rem; }
	.small { font-size: 0.85rem; }
</style>
