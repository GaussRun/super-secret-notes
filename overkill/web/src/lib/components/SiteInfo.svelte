<script lang="ts">
	// Who makes this, the license and where the source is: on the landing page (bottom) and /about/ only.
	import { to } from '$lib/link';
</script>

<footer class="site-info muted" data-testid="site-info">
	Super Secret Notes by GaussRun (command line: <span class="mono">super-secret-notes</span>), AGPL-3.0-or-later, <a href="https://github.com/GaussRun/super-secret-notes">source</a>, <a href={to('/how-it-works/')}>how it works</a>, <a href={to('/thanks/')}>thank you</a>. A static page: whoever serves it could change it, so read <a href={to('/trust/')}>the trust model</a>.
</footer>

<style>
	.site-info { font-size: 0.8rem; padding: 24px 0 32px; }
</style>
