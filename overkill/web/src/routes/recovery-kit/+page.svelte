<script lang="ts">
	import Locked from '$lib/components/Locked.svelte';
	import SendToPhone from '$lib/components/SendToPhone.svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { to } from '$lib/link';

	let kit = $state('');
	let err = $state('');
	let href = $state('');

	$effect(() => {
		if (vault.status !== 'unlocked') return;
		vault.kit().then(
			(k) => {
				kit = k;
				href = URL.createObjectURL(new Blob([k + '\n'], { type: 'text/plain' }));
			},
			(x) => (err = (x as Error).message)
		);
	});
</script>

<Locked>
	<h1>Recovery kit</h1>
	<p class="muted">The same sheet the CLI prints. It holds your keys: print it, or save it somewhere offline, then close this page. <code>super-secret-notes recover --kit &lt;file&gt;</code> reads it back.</p>
	{#if err}<p class="error-box" role="alert">{err}</p>{/if}
	<SendToPhone />
	{#if kit}
		<div class="row">
			<a class="button" {href} download="super-secret-notes-recovery-kit-{vault.cfg?.name ?? 'vault'}.txt">Download as text</a>
			<button class="secondary" onclick={() => window.print()}>Print</button>
			<a class="button secondary" href={to('/new/')}>Write the first note</a>
		</div>
		<pre class="panel kit" data-testid="kit">{kit}</pre>
	{/if}
</Locked>

<style>
	.kit { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-all; font-size: 0.8rem; }
</style>
