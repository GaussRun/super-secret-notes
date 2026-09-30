<script lang="ts">
	// The host's base URL as a link (new tab, no referrer); never a paste URL or its #key.
	import { baseUrl, linkHref } from '$lib/hosttype';

	let { where }: { where: string } = $props();
	const base = $derived(baseUrl(where));
</script>

{#if base}<a class="id" href={linkHref(base)} target="_blank" rel="noopener noreferrer">{base}</a>{:else}<span class="id">{where}</span>{/if}
