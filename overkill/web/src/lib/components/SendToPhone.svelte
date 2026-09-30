<script lang="ts">
	// Move access to a phone by scanning: a recovery link (vault name and passphrase in the URL
	// fragment, never sent to a server) or the two as plain text for a password-manager app.
	// Hidden until asked for, and hidden again after a minute.
	import { onDestroy } from 'svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { qrMatrix, qrPath } from '$lib/overkill/qr';
	import { to } from '$lib/link';

	const HIDE_AFTER_S = 60;
	let mode = $state<'link' | 'text' | null>(null);
	let size = $state(0);
	let path = $state('');
	let left = $state(0);
	let timer: ReturnType<typeof setInterval> | null = null;

	function show(m: 'link' | 'text') {
		const payload = m === 'link' ? vault.handoff(new URL(to('/recover/'), location.href).href) : vault.handoffText();
		const matrix = qrMatrix(payload);
		size = matrix.length;
		path = qrPath(matrix);
		mode = m;
		left = HIDE_AFTER_S;
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			left -= 1;
			if (left <= 0) hide();
		}, 1000);
	}

	function hide() {
		if (timer) clearInterval(timer);
		timer = null;
		mode = null;
		path = '';
		size = 0;
	}

	onDestroy(hide);
</script>

<div class="panel send" data-testid="send-to-phone">
	<h2>Send to phone</h2>
	<p class="muted">Scan with your phone's camera: the link opens the recover page there with the vault name and passphrase filled in. The part after <span class="mono">#</span> never leaves the phone; the page wipes it from the address bar right away.</p>
	{#if !mode}
		<button type="button" onclick={() => show('link')}>Show QR (recovery link)</button>
		<button type="button" class="secondary" onclick={() => show('text')}>Show QR (plain text for your password manager or notes app)</button>
	{:else}
		<div class="warning" role="alert" data-testid="qr-warning">
			ANYONE WHO SEES THIS QR CAN OPEN YOUR VAULT. Shield the screen from people and cameras.
		</div>
		<div class="qr-wrap">
			<svg data-testid="qr" data-kind={mode} viewBox="-4 -4 {size + 8} {size + 8}" width="300" height="300" role="img" aria-label="QR code with your vault name and passphrase" shape-rendering="crispEdges">
				<rect x="-4" y="-4" width={size + 8} height={size + 8} fill="#ffffff" />
				<path d={path} fill="#000000" />
			</svg>
		</div>
		<p class="mono small" data-testid="qr-countdown">{mode === 'link' ? 'Recovery link' : 'Plain text'}. Hides itself in {left} s.</p>
		<button type="button" class="danger" onclick={hide}>Hide now</button>
	{/if}
</div>

<style>
	.warning { font-family: var(--mono); font-weight: 800; font-size: 1.15rem; color: var(--on-danger); background: var(--red); padding: 12px; border-radius: 8px; margin: 10px 0; }
	.qr-wrap { background: #ffffff; padding: 8px; border-radius: 8px; display: inline-block; max-width: 100%; }
	.qr-wrap svg { display: block; max-width: 100%; height: auto; }
	.small { font-size: 0.85rem; }
</style>
