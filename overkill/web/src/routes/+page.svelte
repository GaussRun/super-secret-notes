<script lang="ts">
	import { vault } from '$lib/overkill/vault.svelte';
	import ThanksStrip from '$lib/components/ThanksStrip.svelte';
	import Diagram from '$lib/components/Diagram.svelte';
	import { to } from '$lib/link';
	const CRYPTO_JS = 'https://github.com/GaussRun/super-secret-notes/blob/main/overkill/cli/src/crypto.js';
</script>

<section class="hero">
	<p class="stamp mono">SUPER SECRET</p>
	<h1>A note you cannot afford to lose.</h1>
	<p class="lead" data-testid="what-it-is">
		Super Secret Notes saves your note in <strong>many independent places at once</strong>: a dozen free hosts run by
		different people, none of which needs a signup. Losing any one of them, or several, loses nothing. Get it back on
		any device with just a <strong>vault name and passphrase</strong>. Recovery codes, a seed phrase backup hint, the
		wifi password: the things that must not vanish. It also moves a note <strong>from a public computer to your
		phone</strong> with a QR code.
	</p>
	<div class="row">
		{#if vault.status === 'none'}
			<a class="button" href={to('/setup/')}>Write your first secret note</a>
			<a class="button secondary" href={to('/recover/')}>I already have a vault</a>
		{:else if vault.status === 'locked'}
			<a class="button" href={to('/unlock/')}>Unlock</a>
		{:else if vault.status === 'unlocked'}
			<a class="button" href={to('/new/')}>New note</a>
			<a class="button secondary" href={to('/notes/')}>My notes</a>
			<a class="button secondary" href={to('/check/')}>Check every copy</a>
		{/if}
		<a class="button secondary" href={to('/how-it-works/')}>How it works</a>
	</div>
</section>

<Diagram />

{#if vault.status !== 'unlocked'}
	<section class="panel quick" data-testid="quick-flow">
		<h2>On a public computer?</h2>
		<p>Make a throwaway vault, write your note, scan the QR with your phone. Nothing is kept in this browser.</p>
		<a class="button" href={`${to('/setup/')}?quick=1`}>Throwaway vault for a public computer</a>
	</section>
{/if}

<section class="panel" data-testid="how-short">
	<h2>How it is protected</h2>
	<ol class="layers">
		<li>
			<strong>Many copies.</strong> PrivateBin pastebins, CryptPad, Nostr relays and Blossom servers each keep one;
			Check verifies all of them and Repair replaces any that went missing or broke.
		</li>
		<li>
			<strong>Encrypted twice before it leaves this tab.</strong>
			<a href="https://age-encryption.org/v1" rel="noopener">age</a> (X25519 and ChaCha20-Poly1305, via
			<a href="https://github.com/FiloSottile/typage" rel="noopener">typage</a>), then AES-256-GCM with keys derived by
			HKDF-SHA256 in WebCrypto (<a href={CRYPTO_JS} rel="noopener">our crypto.js</a>).
		</li>
		<li>
			<strong>Plus each host's own layer:</strong>
			<a href="https://github.com/PrivateBin/PrivateBin/wiki/Encryption-format" rel="noopener">PrivateBin</a> AES-256-GCM,
			<a href="https://blog.cryptpad.org/images/whitepaper.pdf" rel="noopener">CryptPad</a> XSalsa20-Poly1305,
			<a href="https://github.com/nostr-protocol/nips/blob/master/44.md" rel="noopener">Nostr NIP-44</a>; Blossom servers
			store bytes as they are (<a href="https://github.com/hzrd149/blossom/blob/master/buds/02.md" rel="noopener">BUD-02</a>),
			so we add our own extra AES-256-GCM layer there.
		</li>
	</ol>
	<p><a href={to('/how-it-works/')}>The full explanation, with every source</a></p>
</section>

<section class="panel">
	<h2>The fine print, in large print</h2>
	<ul>
		<li><strong>Lose your passphrase and your recovery kit, lose your notes.</strong> Nobody can reset it.</li>
		<li>The encrypted vault file sits on public hosts on purpose (that is how a name and passphrase recover it), so the passphrase is the whole security. That is why we generate one (6 random words).</li>
		<li>This page is static and talks to the hosts directly. There is no server of ours. <a href={to('/trust/')}>What that means.</a></li>
		<li>Same format as the command line tool, <span class="mono">super-secret-notes</span>: a vault made there opens here, and the other way round.</li>
	</ul>
</section>

<ThanksStrip />

<style>
	.hero { padding: 28px 0 8px; }
	.stamp { display: inline-block; color: var(--red); border: 2px solid var(--red); padding: 2px 10px; transform: rotate(-2deg); font-weight: 800; letter-spacing: 0.12em; font-size: 0.8rem; }
	.lead { max-width: 66ch; font-size: 1.08rem; line-height: 1.55; }
	.quick { border-color: var(--amber); }
	.layers li { margin: 8px 0; line-height: 1.5; }
</style>
