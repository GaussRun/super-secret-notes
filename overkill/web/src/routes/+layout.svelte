<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { goto, afterNavigate } from '$app/navigation';
	import { tick } from 'svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { to } from '$lib/link';

	let { children } = $props();
	vault.load();

	// everything but the brand lives in one menu
	const links = [
		['/notes/', 'My notes'],
		['/new/', 'New note'],
		['/check/', 'Check copies'],
		['/status/', 'Status'],
		['/hosts/', 'Hosts'],
		['/settings/', 'Settings'],
		['/recovery-kit/', 'Vault access'],
		['/how-it-works/', 'How it works'],
		['/thanks/', 'Thanks'],
		['/trust/', 'Trust model'],
		['/about/', 'About']
	];
	const active = (href: string) => page.url.pathname.startsWith(to(href));

	let open = $state(false);
	let menuButton: HTMLButtonElement | undefined = $state();
	let panel: HTMLElement | undefined = $state();

	async function openMenu() {
		open = true;
		await tick();
		panel?.querySelector<HTMLElement>('a, button')?.focus();
	}
	function closeMenu(refocus = true) {
		if (!open) return;
		open = false;
		if (refocus) menuButton?.focus();
	}
	const toggle = () => (open ? closeMenu() : openMenu());
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.preventDefault();
			closeMenu();
		}
	}
	function onClickOutside(e: MouseEvent) {
		if (open && !panel?.contains(e.target as Node) && !menuButton?.contains(e.target as Node)) closeMenu(false);
	}
	afterNavigate(() => closeMenu(false));

	// Sign out: the keys leave memory; the encrypted vault stays in this browser for the next unlock
	async function signOut() {
		closeMenu(false);
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
<svelte:window onkeydown={onKey} onclick={onClickOutside} />

<header>
	<div class="wrap bar">
		<a class="brand" href={to('/')}>Super Secret Notes</a>
		<div class="right">
			{#if vault.ephemeral}
				<!-- on a public computer the way out stays in sight -->
				<button class="danger small" onclick={wipe} data-testid="wipe">Done: wipe this tab</button>
			{/if}
			<button class="menu-button" bind:this={menuButton} onclick={toggle} aria-expanded={open} aria-controls="site-menu" data-testid="menu-button">
				<span class="bars" aria-hidden="true"><span></span><span></span><span></span></span>
				Menu
			</button>
		</div>
	</div>
	<nav id="site-menu" class="menu" bind:this={panel} hidden={!open} aria-label="Site">
		<div class="state" data-testid="lock-status">
			{#if vault.ephemeral}
				<span class="warn">PUBLIC COMPUTER</span>
			{:else if vault.status === 'unlocked'}
				<span class="ok">UNLOCKED</span>
			{:else if vault.status === 'locked'}
				<span class="warn">LOCKED</span>
				<a href={to('/unlock/')}>Unlock</a>
				<a href={to('/recover/')}>Recover</a>
			{:else if vault.status === 'none'}
				<span class="muted">NO VAULT</span>
				<a href={to('/setup/')}>Set up</a>
				<a href={to('/recover/')}>Recover</a>
			{/if}
		</div>
		<ul>
			{#each links as [href, label] (href)}
				<li><a href={to(href)} class:active={active(href)} aria-current={active(href) ? 'page' : undefined}>{label}</a></li>
			{/each}
		</ul>
		{#if vault.ephemeral}
			<button class="danger" onclick={wipe}>Done: wipe this tab</button>
		{:else if vault.status === 'unlocked'}
			<button class="secondary" onclick={signOut} data-testid="sign-out">Sign out</button>
		{/if}
	</nav>
</header>

<main class="wrap">
	{#if vault.restored !== null}
		<p class="warn" data-testid="restored-notice">Making a new vault was interrupted, so this browser went back to the vault it held before{vault.restored ? ` (${vault.restored})` : ''}.</p>
	{/if}
	{@render children()}
</main>


<style>
	header { border-bottom: 1px solid var(--line); background: var(--header-bg); position: sticky; top: 0; z-index: 5; backdrop-filter: blur(6px); }
	.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; padding-bottom: 12px; }
	.brand { font-family: var(--mono); font-weight: 800; color: var(--text); text-decoration: none; letter-spacing: 0.03em; font-size: 1.05rem; }
	.right { display: flex; gap: 8px; align-items: center; }
	.small { padding: 6px 10px; font-size: 0.78rem; margin: 0; }
	.menu-button { display: inline-flex; align-items: center; gap: 8px; margin: 0; background: var(--panel); color: var(--text); border: 1px solid var(--line); padding: 8px 12px; }
	.menu-button[aria-expanded='true'] { border-color: var(--green); }
	.bars { display: inline-grid; gap: 3px; }
	.bars span { display: block; width: 16px; height: 2px; background: currentColor; border-radius: 1px; }
	/* an overlay: opening it moves nothing else on the page */
	.menu { position: absolute; right: max(16px, calc((100vw - 980px) / 2 + 16px)); top: calc(100% + 6px); width: min(300px, calc(100vw - 32px)); background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35); }
	.menu[hidden] { display: none; }
	.menu ul { list-style: none; margin: 6px 0 8px; padding: 0; }
	.menu li a { display: block; padding: 9px 10px; border-radius: 8px; color: var(--text); text-decoration: none; }
	.menu li a:hover, .menu li a:focus-visible { background: var(--panel-2); }
	.menu li a.active { color: var(--green); }
	.menu button { width: 100%; margin: 4px 0 0; }
	.state { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-family: var(--mono); font-size: 0.75rem; font-weight: 700; padding: 4px 10px 8px; border-bottom: 1px solid var(--line); }
</style>
