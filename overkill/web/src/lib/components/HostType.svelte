<script lang="ts">
	// A host's product name with its logo (or a monogram); the internal backend name in the tooltip.
	import { to } from '$lib/link';
	import { TYPE_LOGOS, typeName } from '$lib/hosttype';

	let { type, name = '' }: { type: string; name?: string } = $props();
	const logo = $derived(TYPE_LOGOS[type]);
	const label = $derived(typeName(type));
</script>

<span class="host-type" title={name ? `${label} (${name})` : label}>
	{#if logo}<img src={to(`/logos/${logo}`)} alt="" width="16" height="16" />{:else}<span class="mono-badge" aria-hidden="true">{label[0]}</span>{/if}
	{label}
</span>

<style>
	.host-type { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
	img { width: 16px; height: 16px; border-radius: 3px; background: #fff; }
	.mono-badge { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: var(--line); font-size: 0.7rem; font-weight: 700; }
</style>
