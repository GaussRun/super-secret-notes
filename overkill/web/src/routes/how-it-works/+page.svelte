<script lang="ts">
	import { to } from '$lib/link';
	import Diagram from '$lib/components/Diagram.svelte';
	import { defaultCounts, defaultHosts } from '$lib/overkill/settings';
	import { total } from '$lib/diagram';

	// counts from the defaults list, so changing the defaults never means editing this page
	const counts = defaultCounts();
	const inBrowser = defaultHosts().cryptpad.length;
	// the code on GitHub (same file the web app bundles)
	const CRYPTO_JS = 'https://github.com/GaussRun/super-secret-notes/blob/main/overkill/cli/src/crypto.js';
</script>

<h1>How it works</h1>
<p class="lead">
	A note you cannot afford to lose is copied to many independent hosts, run by different people in different
	places, none of which needs an account. Losing one host, or several, loses nothing. A vault name plus your
	passphrase brings everything back on any device. Before a note leaves your device it gets our encryption
	(age + AES-256-GCM), then each host's native encryption on top.
</p>

<Diagram size="large" />
<p class="muted small" data-testid="cli-accounts">The command line tool can already use MEGA, Proton Drive, Filen and Fileverse. Blossom servers (no encryption of their own) can be added on the Hosts page or with the command line tool.</p>

<div class="panel">
	<h2>Redundancy first</h2>
	<ul>
		<li data-testid="default-counts">By default every note goes to {total(counts)} zero-signup hosts: {counts.privatebin} PrivateBin instances, CryptPad accounts made for your vault ({counts.cryptpad} instances from the command line; {inBrowser} in the browser, because the others only let their own pages use them) and {counts.nostr} Nostr relays. Blossom servers are opt-in, because they add no encryption of their own; MEGA, Proton Drive, Filen and Fileverse are opt-in in the command line tool.</li>
		<li data-testid="failure-handling">Every host is tried on its own with a deadline: one that fails or does not answer is marked failed and retried later, a default that fails at setup gets a known-good stand-in, and a note counts as stored once 2 hosts hold it.</li>
		<li>Reading takes the first copy that passes every check and falls back to the next one if a copy is missing, damaged or out of date.</li>
		<li>An encrypted index lists your notes, where each copy lives and when each was last verified (the health ledger). <a href={to('/check/')}>Check</a> downloads and verifies every copy; Repair re-uploads broken ones from a healthy copy.</li>
		<li>Free hosts promise little: PrivateBin keeps pastes with "never" expiry, but Nostr relays (and Blossom servers, if you add them) promise no retention, so we treat their copies as possibly gone 120 days after publishing and republish them (our policy, not theirs).</li>
	</ul>
</div>

<div class="panel" data-testid="layers">
	<h2>Our encryption, then each host's native encryption</h2>
	<p class="muted small">A new CryptPad account shows up as one "404" in the browser console: that is the check for an existing login block, which the browser logs whatever the page does with the answer.</p>
	<p>Our encryption has two layers and runs on your device (here: in this browser tab) before anything leaves it. Then each host applies its own native scheme, except Blossom (opt-in, not a default), which has none, so we add one there.</p>

	<h3>Our encryption, part 1: age</h3>
	<p>
		Every note is encrypted to the vault's own age X25519 identity, in age's binary format
		(<a href="https://age-encryption.org/v1" rel="noopener">age v1 specification</a>, implemented by the
		<a href="https://github.com/FiloSottile/typage" rel="noopener">typage</a> library, npm package <span class="mono">age-encryption</span>).
		A fresh file key is wrapped with an X25519 key agreement, HKDF-SHA-256 and ChaCha20-Poly1305; the note itself
		is encrypted with ChaCha20-Poly1305 in 64 KiB chunks.
	</p>

	<h3>Our encryption, part 2: AES-256-GCM</h3>
	<p>
		The age output is encrypted again: <span class="mono">"OVK1" || nonce (12 random bytes) || AES-256-GCM(K_aes, nonce, age output, AAD = "OVK1" || blob id)</span>.
		The AAD binds each blob to its name, so a host cannot swap two notes. All keys come from the vault's random
		32-byte master key through HKDF-SHA256 (WebCrypto) with distinct labels. The code is short and uses only
		WebCrypto and age: <a href={CRYPTO_JS} rel="noopener" data-testid="crypto-js-link">overkill/cli/src/crypto.js on GitHub</a>
		(the web app runs the same file).
	</p>

	<h3>Then each host's native encryption</h3>
	<div class="table-scroll">
		<table>
			<thead><tr><th>Host</th><th>Its encryption (primary source)</th></tr></thead>
			<tbody>
				<tr>
					<td>PrivateBin</td>
					<td>AES-256-GCM, with the key derived by PBKDF2-HMAC-SHA256 (100,000 iterations) from a random 32-byte paste key that lives only in the URL fragment (<a href="https://github.com/PrivateBin/PrivateBin/wiki/Encryption-format" rel="noopener">PrivateBin encryption format</a>). The paste URLs, keys included, stay in our encrypted index.</td>
				</tr>
				<tr>
					<td>CryptPad</td>
					<td>XSalsa20-Poly1305 (NaCl secretbox) for document content and Ed25519 signatures (<a href="https://blog.cryptpad.org/images/whitepaper.pdf" rel="noopener">CryptPad white paper</a>), through CryptPad's own client modules.</td>
				</tr>
				<tr>
					<td>Nostr relays</td>
					<td>NIP-44 v2 to a key derived from the vault: secp256k1 ECDH, HKDF-SHA256, ChaCha20, HMAC-SHA256 and length padding (<a href="https://github.com/nostr-protocol/nips/blob/master/44.md" rel="noopener">NIP-44</a>).</td>
				</tr>
				<tr>
					<td>Blossom servers (opt-in)</td>
					<td>None: a Blossom server stores exactly the bytes it receives (<a href="https://github.com/hzrd149/blossom/blob/master/buds/02.md" rel="noopener">BUD-02</a>: "The server MUST NOT modify the blob"). So we add our own extra layer: <span class="mono">"OVKB" || nonce || AES-256-GCM(K_blossom, nonce, blob)</span>, under a separate key.</td>
				</tr>
				<tr>
					<td>MEGA, Proton Drive, Filen, Fileverse (opt-in, command line)</td>
					<td>Their client-side encryption, done by their official SDK or tool (<a href="https://mega.io/security" rel="noopener">MEGA</a>, <a href="https://proton.me/drive/security" rel="noopener">Proton Drive</a>, <a href="https://filen.io/" rel="noopener">Filen</a>, <a href="https://fileverse.io/" rel="noopener">Fileverse</a>).</td>
				</tr>
			</tbody>
		</table>
	</div>
	<p class="muted small">
		Everything the zero-signup hosts' layer uses (paste keys, the NIP-44 key, the Blossom key, the CryptPad logins)
		comes from your own vault, so the hosts' layer protects against a host leaking what it stores, not against someone who
		has your vault.
	</p>
</div>

<div class="panel">
	<h2>Keys, names and recovery</h2>
	<ul>
		<li><strong>Passphrase.</strong> <span class="mono">vault.age</span> holds the age identity and the master key, encrypted with your passphrase through age's scrypt recipient (work factor 2^18). It is stored on the hosts on purpose, so the passphrase is the whole security: new vaults get six random words (about 77 bits).</li>
		<li><strong>Names.</strong> Hosts see <span class="mono">notes/&lt;64 hex chars&gt;.ovk</span>, an HMAC-SHA256 of the note name, plus sizes and timestamps. Never the note names, never the contents.</li>
		<li><strong>Integrity.</strong> Every read checks every layer's authentication tag and the sha256 recorded in the index.</li>
		<li><strong>Recovery by name.</strong> scrypt(passphrase, salt "overkill v1 discovery:" + vault name, N = 2^18) gives a Nostr key. Under it the relays hold a copy of vault.age and a small encrypted record of your hosts, so a vault name plus passphrase finds everything. The printed <a href={to('/recovery-kit/')}>recovery kit</a> is the second way back.</li>
		<li><strong>This page.</strong> Keys and plaintext stay in the tab's memory. Whoever serves the page could change it: see <a href={to('/trust/')}>the trust model</a>.</li>
	</ul>
	<p class="muted small">The format is specified in docs/OVERKILL.md in the repository, with known-answer test vectors for anyone writing a second implementation.</p>
</div>

<style>
	.lead { max-width: 72ch; line-height: 1.5; }
	h3 { font-size: 1rem; margin: 18px 0 4px; }
	td, li, p { overflow-wrap: anywhere; }
	.small { font-size: 0.85rem; }
</style>
