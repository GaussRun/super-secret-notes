<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { vault } from '$lib/overkill/vault.svelte';
	import { to } from '$lib/link';

	let { children } = $props();
	vault.load();

	const links = [
		['/notes/', 'Notes'],
		['/new/', 'New'],
		['/check/', 'Check'],
		['/status/', 'Status'],
		['/hosts/', 'Hosts'],
		['/recovery-kit/', 'Kit'],
		['/settings/', 'Settings'],
		['/trust/', 'Trust']
	];
	const active = (href: string) => page.url.pathname.startsWith(to(href));

	// Sign out: the keys leave memory; the encrypted vault stays in this browser for the next unlock
	async function signOut() {
		await vault.lock();
		goto(to('/unlock/'));
	}

	// public computer: forget everything, then a full page load so no memory survives
	async function wipe() {
		await vault.wipe();
		location.replace(new URL(to('/'), location.href).href);
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header>
	<div class="wrap bar">
		<a class="brand" href={to('/')}>SUPER SECRET<span>NOTES</span></a>
		<nav>
			{#each links as [href, label] (href)}
				<a href={to(href)} class:active={active(href)}>{label}</a>
			{/each}
		</nav>
		<div class="status" data-testid="lock-status">
			{#if vault.ephemeral}
				<span class="warn">PUBLIC COMPUTER</span>
				<button class="danger small" onclick={wipe} data-testid="wipe">Done: wipe this tab</button>
			{:else if vault.status === 'unlocked'}
				<span class="ok">UNLOCKED</span>
				<button class="secondary small" onclick={signOut} data-testid="sign-out">Sign out</button>
			{:else if vault.status === 'locked'}
				<span class="warn">LOCKED</span>
				<a href={to('/unlock/')}>Unlock</a>
				<a href={to('/recover/')}>Recover</a>
			{:else if vault.status === 'none'}
				<span class="warn">NO VAULT</span>
				<a href={to('/setup/')}>Set up</a>
				<a href={to('/recover/')}>Recover</a>
			{/if}
		</div>
	</div>
	<div class="ticker mono">COPIES ON A DOZEN INDEPENDENT HOSTS / ENCRYPTED TWICE IN THIS TAB, PLUS EACH HOST'S LAYER / NO SIGNUP / NO SERVER OF OURS</div>
</header>

<main class="wrap">
	{@render children()}
</main>

<footer class="wrap muted">
	Super Secret Notes by GaussRun (command line: <span class="mono">super-secret-notes</span>), AGPL-3.0-or-later, <a href="https://github.com/GaussRun/super-secret-notes">source</a>, <a href={to('/how-it-works/')}>how it works</a>, <a href={to('/thanks/')}>thank you</a>. A static page: whoever serves it could change it, so read <a href={to('/trust/')}>the trust model</a>.
</footer>

<style>
	header { border-bottom: 1px solid var(--line); background: rgba(11, 15, 20, 0.9); position: sticky; top: 0; z-index: 5; backdrop-filter: blur(6px); }
	.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; padding-top: 10px; padding-bottom: 10px; }
	.brand { font-family: var(--mono); font-weight: 800; color: var(--green); text-decoration: none; letter-spacing: 0.08em; }
	.brand span { color: var(--amber); margin-left: 4px; }
	nav { display: flex; flex-wrap: wrap; gap: 4px 14px; flex: 1; }
	nav a { color: var(--muted); text-decoration: none; font-family: var(--mono); font-size: 0.9rem; }
	nav a.active, nav a:hover { color: var(--text); text-decoration: underline; text-decoration-color: var(--green); }
	.status { font-family: var(--mono); font-size: 0.8rem; font-weight: 700; display: flex; gap: 8px; align-items: center; }
	.status a { text-decoration: none; }
	.small { padding: 4px 10px; font-size: 0.75rem; margin: 0; }
	.ticker { font-size: 0.68rem; color: #04110a; background: var(--amber); padding: 3px 16px; letter-spacing: 0.12em; overflow-wrap: anywhere; }
	footer { font-size: 0.8rem; padding-bottom: 32px; }
</style>
