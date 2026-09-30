<script lang="ts">
	import SiteInfo from '$lib/components/SiteInfo.svelte';
	import { to } from '$lib/link';
</script>

<h1>About</h1>
<div class="panel">
	<p>Super Secret Notes by GaussRun: write a note, your browser encrypts it, then it is copied to many free hosts that encrypt it again. The same vaults work with the command line tool, <span class="mono">super-secret-notes</span>.</p>
	<h2>License</h2>
	<p>Open source under the GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later). Third-party parts and logos are listed with their licenses in the source (THIRD_PARTY.md).</p>
	<h2>Source</h2>
	<p><a href="https://github.com/GaussRun/super-secret-notes" rel="noopener">github.com/GaussRun/super-secret-notes</a></p>
	<h2>Trust</h2>
	<p>This is a static page: whoever serves it could change it. Read <a href={to('/trust/')}>the trust model</a> for what that means and how to check.</p>
</div>
<SiteInfo />
