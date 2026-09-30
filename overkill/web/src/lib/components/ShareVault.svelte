<script lang="ts">
	// Share this vault: the access link (vault name and passphrase in the URL fragment, never sent
	// to a server) copied, handed to the system share sheet, or as a QR; or the two as plain text
	// for a password-manager app. QRs are hidden until asked for, and hidden again after a minute.
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
	let copied = $state<'link' | 'text' | null>(null);
	let copyErr = $state('');
	// the system share sheet (Signal and the like), only where the browser has one
	const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

	const accessLink = () => vault.handoff(new URL(to('/recover/'), location.href).href);

	async function copy(what: 'link' | 'text') {
		copyErr = '';
		try {
			await navigator.clipboard.writeText(what === 'link' ? accessLink() : vault.handoffText());
			copied = what;
		} catch {
			copyErr = 'This browser would not copy; use the QR or the share button.';
		}
	}

	async function share() {
		try {
			await navigator.share({ url: accessLink() });
		} catch {
			// cancelled, or refused: nothing to do
		}
	}

	function show(m: 'link' | 'text') {
		const payload = m === 'link' ? accessLink() : vault.handoffText();
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

<div class="panel send" data-testid="share-vault">
	<h2>Share this vault</h2>
	<p class="warn" data-testid="share-warning">Anyone with this link can open the whole vault: all notes, and can change them. Send it only through an end-to-end encrypted chat (e.g. Signal), or to yourself.</p>
	<div class="row actions">
		<button type="button" onclick={() => copy('link')} data-testid="copy-access-link">{copied === 'link' ? 'Copied' : 'Copy access link'}</button>
		{#if canShare}<button type="button" class="secondary" onclick={share} data-testid="share-sheet">Share...</button>{/if}
	</div>
	{#if copyErr}<p class="bad small">{copyErr}</p>{/if}
	<p class="muted small">On the other device: open the link (in a private tab if the device is not yours), or paste it into the Recover page. The part after <span class="mono">#</span> never leaves the device; the page wipes it from the address bar right away.</p>
	{#if !mode}
		<button type="button" class="secondary" onclick={() => show('link')}>Show QR (recovery link)</button>
		<button type="button" class="secondary" onclick={() => show('text')}>Show QR (plain text for your password manager or notes app)</button>
		<button type="button" class="link" onclick={() => copy('text')} data-testid="copy-plain">{copied === 'text' ? 'Copied' : 'Copy as plain text (vault name and passphrase)'}</button>
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
	.actions { gap: 8px; margin-bottom: 6px; }
	button.link { background: none; border: 0; color: var(--cyan); text-decoration: underline; padding: 4px 6px; font-weight: 400; }
</style>
