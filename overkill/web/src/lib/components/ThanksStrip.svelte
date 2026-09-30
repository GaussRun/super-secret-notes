<script lang="ts">
	// The landing page's thank-you strip: every project and every default host, with support links.
	import { PROJECTS, OPERATORS } from '$lib/credits';
	import { to } from '$lib/link';
</script>

<section class="panel thanks" data-testid="thanks-strip" aria-labelledby="thanks-title">
	<h2 id="thanks-title">Thank you</h2>
	<p class="small">
		Your notes live on hosts that volunteers run for free, with software others wrote in the open. If you rely on
		them, please <a href={to('/thanks/')}>support them</a>.
	</p>
	<p class="small">
		<strong>Software:</strong>
		{#each PROJECTS as p, i (p.name)}<a href={p.url} rel="noopener">{p.name}</a>{#if p.support} (<a href={p.support} rel="noopener">support</a>){/if}{i < PROJECTS.length - 1 ? ', ' : '.'}{/each}
	</p>
	{#each OPERATORS as g (g.kind)}
		<p class="small">
			<strong>{g.kind}:</strong>
			{#each g.hosts as h, i (h.name)}<a href={h.url} rel="noopener">{h.name}</a>{#if h.support} (<a href={h.support} rel="noopener">support</a>){/if}{i < g.hosts.length - 1 ? ', ' : '.'}{/each}
		</p>
	{/each}
</section>

<style>
	.thanks { border-color: var(--green); }
	.small { font-size: 0.88rem; margin: 6px 0; overflow-wrap: anywhere; }
</style>
