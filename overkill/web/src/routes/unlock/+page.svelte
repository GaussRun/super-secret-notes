<script lang="ts">
	// The unlock page: where Sign out lands. Once the passphrase opens the vault, on to the notes.
	import { goto } from '$app/navigation';
	import Locked from '$lib/components/Locked.svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { to } from '$lib/link';

	$effect(() => {
		if (vault.status === 'unlocked') goto(to('/notes/'));
	});
</script>

<h1>Unlock</h1>
<Locked>
	<p class="ok">Unlocked. On to your notes...</p>
</Locked>
