<script lang="ts">
	// Share this vault. First the vault link (only the vault name in the URL fragment: it opens
	// nothing without the passphrase, so it can sit in notes or bookmarks). Then, clearly marked,
	// the link WITH the passphrase (never sent to a server either, but it opens the vault), and the
	// two as plain text for a password-manager app. Copy, the system share sheet, or a QR; QRs are
	// hidden until asked for, and hidden again after a minute.
	import { onDestroy } from 'svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { qrMatrix, qrPath } from '$lib/overkill/qr';
	import { to } from '$lib/link';

	type What = 'vault' | 'link' | 'text';
	const HIDE_AFTER_S = 60;
	let mode = $state<What | null>(null);
	let size = $state(0);
	let path = $state('');
	let left = $state(0);
	let timer: ReturnType<typeof setInterval> | null = null;
	let copied = $state<What | null>(null);
	let copyErr = $state('');
	// the system share sheet (Signal and the like), only where the browser has one
	const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

	const recoverUrl = () => new URL(to('/recover/'), location.href).href;
	const payload = (w: What) => (w === 'vault' ? vault.vaultLink(recoverUrl()) : w === 'link' ? vault.handoff(recoverUrl()) : vault.handoffText());

	async function copy(what: What) {
		copyErr = '';
		try {
			await navigator.clipboard.writeText(payload(what));
			copied = what;
		} catch {
			copyErr = 'This browser would not copy; use the QR or the share button.';
		}
	}

	async function share(what: 'vault' | 'link') {
		try {
			await navigator.share({ url: payload(what) });
		} catch {
			// cancelled, or refused: nothing to do
		}
	}

	function show(m: What) {
		const matrix = qrMatrix(payload(m));
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
	<div class="row actions">
		<button type="button" onclick={() => copy('vault')} data-testid="copy-vault-link">{copied === 'vault' ? 'Copied' : 'Copy vault link'}</button>
		{#if canShare}<button type="button" class="secondary" onclick={() => share('vault')} data-testid="share-vault-link">Share vault link...</button>{/if}
	</div>
	<p class="muted small" data-testid="vault-link-safe">Safe to keep in notes or bookmarks: it cannot open anything without your passphrase.</p>

	<div class="secret">
		<p class="warn" data-testid="share-warning">Anyone with the link WITH passphrase can open the whole vault: all notes, and can change them. Send it only through an end-to-end encrypted chat (e.g. Signal), or to yourself.</p>
		<div class="row actions">
			<button type="button" class="secondary" onclick={() => copy('link')} data-testid="copy-access-link">{copied === 'link' ? 'Copied' : 'Copy link WITH passphrase'}</button>
			{#if canShare}<button type="button" class="secondary" onclick={() => share('link')} data-testid="share-sheet">Share link with passphrase...</button>{/if}
		</div>
	</div>
	{#if copyErr}<p class="bad small">{copyErr}</p>{/if}
	<p class="muted small">On the other device: open the link (in a private tab if the device is not yours), or paste it into the Recover page. The part after <span class="mono">#</span> never leaves the device; the page wipes it from the address bar right away.</p>
	{#if !mode}
		<button type="button" class="secondary" onclick={() => show('vault')}>Show QR (vault link)</button>
		<button type="button" class="secondary" onclick={() => show('link')}>Show QR (link with passphrase)</button>
		<button type="button" class="secondary" onclick={() => show('text')}>Show QR (plain text for your password manager or notes app)</button>
		<button type="button" class="link" onclick={() => copy('text')} data-testid="copy-plain">{copied === 'text' ? 'Copied' : 'Copy as plain text (vault name and passphrase)'}</button>
	{:else}
		{#if mode === 'vault'}
			<p class="muted" data-testid="qr-note">This QR holds only the vault name: the passphrase is still needed.</p>
		{:else}
			<div class="warning" role="alert" data-testid="qr-warning">
				ANYONE WHO SEES THIS QR CAN OPEN YOUR VAULT. Shield the screen from people and cameras.
			</div>
		{/if}
		<div class="qr-wrap">
			<svg data-testid="qr" data-kind={mode} viewBox="-4 -4 {size + 8} {size + 8}" width="300" height="300" role="img" aria-label={mode === 'vault' ? 'QR code with your vault link' : 'QR code with your vault name and passphrase'} shape-rendering="crispEdges">
				<rect x="-4" y="-4" width={size + 8} height={size + 8} fill="#ffffff" />
				<path d={path} fill="#000000" />
			</svg>
		</div>
		<p class="mono small" data-testid="qr-countdown">{mode === 'vault' ? 'Vault link' : mode === 'link' ? 'Link with passphrase' : 'Plain text'}. Hides itself in {left} s.</p>
		<button type="button" class="danger" onclick={hide}>Hide now</button>
	{/if}
</div>

<style>
	.warning { font-family: var(--mono); font-weight: 800; font-size: 1.15rem; color: var(--on-danger); background: var(--red); padding: 12px; border-radius: 8px; margin: 10px 0; }
	.qr-wrap { background: #ffffff; padding: 8px; border-radius: 8px; display: inline-block; max-width: 100%; }
	.qr-wrap svg { display: block; max-width: 100%; height: auto; }
	.small { font-size: 0.85rem; }
	.actions { gap: 8px; margin-bottom: 6px; }
	.secret { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 8px; }
	button.link { background: none; border: 0; color: var(--cyan); text-decoration: underline; padding: 4px 6px; font-weight: 400; }
</style>
