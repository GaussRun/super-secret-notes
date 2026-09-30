<script lang="ts">
	import { vault } from '$lib/overkill/vault.svelte';
	import ThanksStrip from '$lib/components/ThanksStrip.svelte';
	import Diagram from '$lib/components/Diagram.svelte';
	import { to } from '$lib/link';

	// one thing to do: store a note (or, with a vault open, write the next one)
	const unlocked = $derived(vault.status === 'unlocked');
	const primary = $derived(unlocked ? { href: to('/new/'), label: 'New note' } : vault.status === 'locked' ? { href: to('/new/'), label: 'Store a secret note' } : { href: to('/setup/'), label: 'Store a secret note' });
	const secondary = $derived(unlocked ? { href: to('/notes/'), label: 'My notes' } : { href: to(vault.status === 'locked' ? '/unlock/' : '/recover/'), label: 'Open my vault' });
</script>

<section class="hero" data-testid="hero">
	<h1>Super Secret Notes</h1>
	<p class="sub" data-testid="what-it-is">
		Write a note. Your browser encrypts it, then it's copied to many free hosts that encrypt it again.
	</p>
	<p class="paranoid" data-testid="paranoid">For the extra paranoid.</p>
	<a class="button cta" href={primary.href} data-testid="primary-cta">{primary.label}</a>
	<a class="second" href={secondary.href} data-testid="secondary-cta">{secondary.label}</a>
</section>

<Diagram />

<section class="panel steps" data-testid="steps">
	<h2>How it works</h2>
	<ol>
		<li><strong>Write your note.</strong> It stays readable only here, on your device.</li>
		<li><strong>Your browser encrypts it, then it spreads out.</strong> Our encryption (age + AES-256-GCM) runs first, in your browser; then each host's native encryption on top. Copies go to many independent free hosts, which need no signup. Losing any one of them, or several, loses nothing.</li>
		<li><strong>Get it back anywhere.</strong> Your vault name and passphrase are all you need, on any device. Your password manager can keep them.</li>
	</ol>
	<p><a href={to('/how-it-works/')}>The details, with every source</a></p>
</section>

<p class="oneliner" data-testid="quick-flow">
	On a public computer? <a href={`${to('/setup/')}?quick=1`}>Make a throwaway vault and scan the note to your phone with a QR code.</a>
</p>

<ThanksStrip />

<style>
	.hero { min-height: max(440px, calc(100svh - 70px)); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 32px 0; }
	h1 { font-size: clamp(2.2rem, 7vw, 3.6rem); margin: 0 0 14px; letter-spacing: 0.01em; }
	.sub { max-width: 40ch; font-size: clamp(1.05rem, 2.6vw, 1.3rem); line-height: 1.5; margin: 0 0 6px; color: var(--muted); }
	.paranoid { margin: 0 0 30px; font-size: 0.9rem; color: var(--muted); font-style: italic; }
	.cta { font-size: clamp(1.15rem, 3.2vw, 1.4rem); padding: 18px 36px; border-radius: 12px; margin: 0; }
	.second { margin-top: 18px; font-size: 1rem; }
	.steps ol { padding-left: 22px; line-height: 1.55; }
	.steps li { margin: 8px 0; }
	.oneliner { text-align: center; margin: 22px 0; }
</style>
