<script lang="ts">
	// How a note is encrypted twice and scattered to the hosts: a wide layout for desktops and a
	// tall one for phones, swapped by CSS at 640 px. Markup from $lib/diagram (shared with the
	// standalone static/diagram.svg); colors follow the page (CSS variables), logos keep theirs.
	import { diagramSvg, diagramStyle } from '$lib/diagram';
	import { to } from '$lib/link';
	import { defaultCounts } from '$lib/overkill/settings';

	let { size = 'normal' }: { size?: 'normal' | 'large' } = $props();
	const style = diagramStyle({
		text: 'var(--text)',
		muted: 'var(--muted)',
		line: 'var(--muted)',
		box: 'var(--panel)',
		boxStroke: 'var(--line)',
		accent: 'var(--green)',
		row: 'var(--panel-2)',
		tile: '#ffffff'
	});
	const logoHref = (f: string) => to(`/logos/${f}`);
	const counts = defaultCounts();
	const wide = $derived(diagramSvg('wide', counts, { logoHref, style, id: `dg-wide-${size}` }));
	const tall = $derived(diagramSvg('tall', counts, { logoHref, style, id: `dg-tall-${size}` }));
</script>

<figure class="diagram {size}" data-testid="diagram">
	<div class="wide">{@html wide}</div>
	<div class="tall">{@html tall}</div>
	<figcaption class="muted">
		Logos: PrivateBin icon by rugk (CC BY 4.0), CryptPad logo by the XWiki CryptPad Team (AGPL-3.0-or-later), Nostr ostrich icon by SovrynMatt (free to use, as its author states). No endorsement implied.
	</figcaption>
</figure>

<style>
	.diagram { margin: 18px 0; }
	.diagram :global(svg) { display: block; width: 100%; height: auto; }
	.wide { max-width: 1000px; }
	.normal .wide { max-width: 900px; }
	.tall { display: none; max-width: 420px; margin: 0 auto; }
	@media (max-width: 640px) {
		.wide { display: none; }
		.tall { display: block; }
	}
	figcaption { font-size: 0.72rem; margin-top: 6px; }
</style>
