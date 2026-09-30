<script lang="ts">
	import { PROJECTS, OPERATORS } from '$lib/credits';
	import { to } from '$lib/link';
</script>

<h1>Thank you</h1>
<p class="lead">
	Super Secret Notes only works because people run free, open hosts for everyone, usually on their own time
	and money, and because others wrote the open software and specifications they run. Your notes live on their
	machines.
</p>

<div class="panel" data-testid="thanks-operators">
	<h2>The people who run the default hosts</h2>
	{#each OPERATORS as group (group.kind)}
		<h3>{group.kind}</h3>
		<ul>
			{#each group.hosts as h (h.name)}
				<li>
					<a href={h.url} rel="noopener">{h.name}</a> <span class="muted">({h.what})</span>
					{#if h.support}<a class="support" href={h.support} rel="noopener">support them</a>{/if}
				</li>
			{/each}
		</ul>
	{/each}
	<p class="muted small">
		And everyone else listed in the public <a href="https://privatebin.info/directory/" rel="noopener">PrivateBin</a> and
		<a href="https://cryptpad.org/instances/" rel="noopener">CryptPad</a> directories and the Nostr and Blossom lists the
		command line tool reads when it looks for new hosts.
	</p>
</div>

<div class="panel" data-testid="thanks-projects">
	<h2>The projects we build on</h2>
	<ul>
		{#each PROJECTS as p (p.name)}
			<li>
				<a href={p.url} rel="noopener">{p.name}</a>: <span class="muted">{p.what}</span>
				{#if p.support}<a class="support" href={p.support} rel="noopener">support them</a>{/if}
			</li>
		{/each}
	</ul>
</div>

<div class="panel">
	<h2>If you rely on one of these hosts, please support it</h2>
	<p>
		Where an operator has a donation page, it is linked above. For the others, their site is the place to start:
		a few euros a month, a thank-you note, or simply staying within their limits all help. Super Secret Notes is
		built for notes (a few kilobytes), not backups of a photo library, and it waits politely between uploads.
		Running your own PrivateBin, CryptPad or relay and adding it helps everyone.
	</p>
	<p><a href={to('/how-it-works/')}>How it works</a> · <a href={to('/hosts/')}>The hosts in this vault</a></p>
</div>

<style>
	.lead { max-width: 70ch; line-height: 1.5; }
	li { margin: 4px 0; overflow-wrap: anywhere; }
	.support { margin-left: 6px; font-size: 0.85rem; }
	.small { font-size: 0.85rem; }
	h3 { font-size: 1rem; margin-bottom: 4px; }
</style>
