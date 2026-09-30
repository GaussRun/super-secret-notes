<script lang="ts">
	// The unlock page: where Sign out lands. Once the passphrase opens the vault, on to the notes.
	import { goto } from '$app/navigation';
	import Locked from '$lib/components/Locked.svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { to, safeNext } from '$lib/link';
	import { page } from '$app/state';

	// ?next=/new/ (the landing page's "New note in my vault"): in-app paths from a fixed list only
	const next = safeNext(page.url.searchParams.get('next'));
	$effect(() => {
		if (vault.status === 'unlocked') goto(to(next));
	});
</script>

<h1>Unlock</h1>
<Locked>
	<p class="ok">Unlocked. On to your notes...</p>
</Locked>
