<script lang="ts">
	import { activity } from '$lib/overkill/activity.svelte';
	let { title = 'Live log' }: { title?: string } = $props();
	const icon = { step: '[ .. ]', ok: '[ OK ]', info: '[INFO]', warn: '[WARN]', error: '[FAIL]' };
</script>

{#if activity.lines.length}
	<div class="log panel" data-testid="activity">
		<div class="title">{title}</div>
		<ol>
			{#each activity.lines as l, i (i)}
				<li class={l.level}>
					<span class="icon">{icon[l.level]}</span>
					<span class="msg">{l.message}</span>
				</li>
			{/each}
		</ol>
	</div>
{/if}

<style>
	.log { font-family: var(--mono); font-size: 0.82rem; background: #070a0e; }
	.title { color: var(--amber); text-transform: uppercase; letter-spacing: 0.15em; font-size: 0.75rem; margin-bottom: 8px; }
	ol { list-style: none; margin: 0; padding: 0; }
	li { display: grid; grid-template-columns: 4.2em 1fr; gap: 2px 10px; padding: 2px 0; }
	.msg { word-break: break-all; overflow-wrap: anywhere; }
	.icon { font-weight: 700; }
	.step .icon { color: var(--amber); }
	.ok .icon { color: var(--green); }
	.info .icon { color: var(--cyan); }
	.warn .icon, .warn .msg { color: var(--amber); }
	.error .icon, .error .msg { color: var(--red); }
</style>
