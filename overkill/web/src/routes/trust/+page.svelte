<script lang="ts">
	import { to } from '$lib/link';
</script>

<h1>The trust model</h1>
<div class="panel">
	<h2>What stays in this tab</h2>
	<ul>
		<li>Your passphrase, the vault keys and every note in plaintext exist only in this tab's memory. A reload forgets them.</li>
		<li>This browser stores only encrypted files (IndexedDB): vault.age, the config, an index copy and the locators. Host lists in Settings are not secret and sit in localStorage.</li>
		<li>Hosts get ciphertext, twice or three times over, under names that are random-looking HMACs.</li>
	</ul>
</div>
<div class="panel">
	<h2>What you have to trust</h2>
	<ul>
		<li><strong>Whoever serves this page.</strong> It is plain HTML and JavaScript. The server that delivers it could deliver a changed version that sends your passphrase somewhere, and you would not notice. That is true of every web app, encrypted or not.</li>
		<li>So for anything that matters, run a copy you control: build it yourself (<code>pnpm build</code> in <code>overkill/web</code>) or download a release and serve it from your own machine (<code>npx serve build</code>, or any static server). The CLI is the same format and avoids the browser entirely.</li>
		<li>Your browser, its extensions and your machine. A keylogger beats every layer.</li>
	</ul>
</div>
<div class="panel">
	<h2>What the page does to limit the damage</h2>
	<ul>
		<li>No server of ours: the page talks straight to PrivateBin, Nostr relays and Blossom servers. Nobody in the middle sees your traffic but them.</li>
		<li>A strict Content-Security-Policy: scripts only from this site (plus the hash of one boot script), network only over https: and wss:, no frames, no plugins, no forms posting elsewhere.</li>
		<li>No third-party scripts, no CDNs, no analytics, no fonts from elsewhere. Everything is in the bundle.</li>
		<li>Send to phone puts the passphrase in a QR code and, for the link kind, in the URL fragment, which browsers never send to a server; the recover page strips it at once. Anyone who sees the QR can open the vault, hence the warning and the one-minute auto-hide.</li>
		<li>vault.age is public on purpose (so a name and passphrase can recover it), which makes the passphrase the whole security. Hence six random words by default.</li>
	</ul>
</div>
<p><a href={to('/')}>Back</a></p>
