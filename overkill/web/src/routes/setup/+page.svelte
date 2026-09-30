<script lang="ts">
	import ActivityLog from '$lib/components/ActivityLog.svelte';
	import SendToPhone from '$lib/components/SendToPhone.svelte';
	import PublicComputer from '$lib/components/PublicComputer.svelte';
	import { activity } from '$lib/overkill/activity.svelte';
	import { vault, MIN_COPIES } from '$lib/overkill/vault.svelte';
	import { generatePassphrase, generateVaultName, generateNoteName, estimateBits, isStrongEnough, MIN_BITS } from '$lib/overkill/passphrase';
	import { loadHosts, backendConfigs } from '$lib/overkill/settings';
	import { storeCredential, rememberedName } from '$lib/overkill/credentials';
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import { validVaultName } from '$cli/defaults-core.js';
	import { to, noteHref } from '$lib/link';

	// ?quick=1 (landing page): a throwaway vault on a public computer
	const quick = page.url.searchParams.has('quick');

	// Note first: the vault name and passphrase are made up for you. The name is a plain editable
	// field; the passphrase is shown read-only until "change passphrase". Both are real inputs
	// (username / new-password) so password managers see them.
	let noteName = $state(generateNoteName());
	// the note is what this page is for: focus it once SvelteKit has placed focus after the
	// navigation (an autofocus attribute makes the browser log "Autofocus processing was blocked")
	let noteBox = $state<HTMLTextAreaElement | null>(null);
	let navigated = $state(false);
	afterNavigate(() => (navigated = true));
	// the form appears once the vault state is known, which can be after the navigation
	// only when nothing else has focus yet: never pull the caret out of a field someone is typing in
	$effect(() => {
		if (navigated && noteBox)
			requestAnimationFrame(() => {
				const active = document.activeElement;
				if (!active || active === document.body) noteBox?.focus();
			});
	});
	let noteText = $state('');
	let name = $state(generateVaultName());
	const first = generatePassphrase();
	let generated = $state(first);
	let passphrase = $state(first);
	let editing = $state(false);
	let show = $state(false);
	let copied = $state(false);
	let publicMode = $state(quick);
	let busy = $state(false);
	let err = $state('');
	let done = $state<{
		vaultName: string;
		passphrase: string;
		hosts: { backend: string; ok: boolean; error?: string }[];
		note: string | null;
		savedToManager: boolean;
		swaps: string[];
		indexLocal: boolean;
		recordRelays: number | null;
	} | null>(null);
	let retrying = $state(false);
	let retried = $state<{ fixed: string[]; failed: string[] } | null>(null);
	const stored = $derived(done ? done.hosts.filter((h) => h.ok).length : 0);
	const failedHosts = $derived(done ? done.hosts.filter((h) => !h.ok) : []);
	const hosts = loadHosts();
	const planned = backendConfigs(hosts);

	const bits = $derived(Math.round(estimateBits(passphrase)));
	const strong = $derived(isStrongEnough(passphrase));
	const nameOk = $derived(validVaultName(name));
	// this browser already holds a vault: a new one takes its place here once it is made
	const replacing = $derived(!quick && (vault.status === 'locked' || vault.status === 'unlocked'));
	const current = $derived(vault.cfg?.name ?? rememberedName());

	function roll() {
		name = generateVaultName();
		generated = generatePassphrase();
		passphrase = generated;
		copied = false;
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			err = 'this browser would not copy; select the words and copy them yourself';
		}
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		const skip = (e.submitter as HTMLButtonElement | null)?.name === 'skip';
		if (!skip && !noteText.trim()) return (err = 'Write something first (or skip and just create the vault).');
		// the name is optional: an empty one gets a made-up name, so notes never collide
		if (!skip && !noteName.trim()) noteName = generateNoteName();
		show = false; // a password-type field when the form submits, which is what managers look for
		err = '';
		busy = true;
		activity.clear();
		try {
			const vaultName = name.normalize('NFC');
			const res = await vault.create({ name: vaultName, passphrase, generated: passphrase === generated ? generated : null, ephemeral: publicMode, replace: replacing && !publicMode });
			let note: string | null = null;
			let results: { backend: string; ok: boolean; error?: string }[] = res.hosts;
			if (!skip) {
				const put = await vault.put(noteName.trim(), noteText);
				note = noteName.trim().normalize('NFC');
				results = put.results;
			}
			// on a public computer the browser must not keep it
			const savedToManager = publicMode ? false : await storeCredential(vaultName, passphrase);
			done = { vaultName, passphrase, hosts: results.map((r) => ({ backend: r.backend, ok: r.ok, error: r.error })), note, savedToManager, swaps: res.swaps, indexLocal: res.indexLocal, recordRelays: res.recordRelays };
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}

	// copies that failed: check every copy, then repair (the ledger already lists the failures)
	async function retry() {
		retrying = true;
		retried = null;
		err = '';
		activity.clear();
		try {
			const report = await vault.check();
			retried = await vault.repair(report);
			const now = await vault.check();
			const notes = now.notes as Record<string, { backend: string; status: string; detail?: string }[]>;
			const noteCopies = done?.note ? notes[done.note] : null;
			const copies = noteCopies ?? now.vault;
			if (done) {
				done.hosts = copies.map((x: { backend: string; status: string; detail?: string }) => ({ backend: x.backend, ok: x.status === 'OK', error: x.detail }));
				done.indexLocal = !now.index.some((x: { status: string }) => x.status === 'OK');
			}
		} catch (x) {
			err = (x as Error).message;
		} finally {
			retrying = false;
		}
	}

	async function saveToManager() {
		if (done) done.savedToManager = await storeCredential(done.vaultName, done.passphrase);
	}
</script>

{#if done}
	<h1>Encrypted and scattered</h1>
	<div class="panel" data-testid="setup-done">
		{#if done.note}
			<p class="ok big">"{done.note}" is on {done.hosts.filter((h) => h.ok).length} of {done.hosts.length} hosts.</p>
		{:else}
			<p class="ok big">Your vault is on {done.hosts.filter((h) => h.ok).length} of {done.hosts.length} hosts.</p>
		{/if}
		{#if failedHosts.length}
			<p data-testid="stored-summary">Stored on {stored} hosts; {failedHosts.length} failed (will retry).</p>
		{/if}
		{#if done.swaps.length}
			<p class="muted small" data-testid="swaps">Stand-ins for hosts that failed: <span class="id">{done.swaps.join(', ')}</span></p>
		{/if}
		<ul class="host-results">
			{#each done.hosts as h (h.backend)}
				<li class={h.ok ? 'ok' : 'bad'}><span class="mono">{h.ok ? 'OK' : 'FAILED'}</span> <span class="id">{h.backend}</span>{#if !h.ok && h.error} <span class="muted small">({h.error})</span>{/if}</li>
			{/each}
		</ul>
		{#if stored < MIN_COPIES}
			<div class="warn-box" data-testid="few-copies">
				<p class="warn">Only {stored} copy so far. Everything stays encrypted in this browser; Retry copies it to the hosts that did not answer.</p>
			</div>
		{/if}
		{#if done.indexLocal}
			<p class="warn" data-testid="index-local">No host that keeps the list of your notes (CryptPad, Nostr) answered: that list stays in this browser for now and is uploaded again with the next save or Retry.</p>
		{/if}
		{#if done.recordRelays === 0}
			<p class="warn" data-testid="no-record">The recovery-by-name record reached no relay yet: keep the kit, and Retry later.</p>
		{/if}
		{#if failedHosts.length || done.indexLocal || done.recordRelays === 0}
			<button type="button" onclick={retry} disabled={retrying} data-testid="retry">{retrying ? 'Retrying...' : 'Retry now'}</button>
			{#if retried}<p class="small" data-testid="retried">Retry: {retried.fixed.length} repaired, {retried.failed.length} still failing.</p>{/if}
			{#if err}<p class="error-box" role="alert">{err}</p>{/if}
		{/if}
		{#if done.note}<a class="button secondary" href={noteHref(done.note)}>Open the note</a>{/if}
		<a class="button secondary" href={to('/new/')}>Write another</a>
	</div>

	<div class="panel save" data-testid="save-step">
		<h2>Save these in your password manager</h2>
		<p>They are all you need to get your notes back, on any device. Also keep the kit.</p>
		<dl>
			<dt>Vault name</dt>
			<dd class="id" data-testid="done-name">{done.vaultName}</dd>
			<dt>Passphrase</dt>
			<dd class="id mono">{show ? done.passphrase : '(hidden: press Show)'}</dd>
		</dl>
		<button type="button" class="secondary" onclick={() => (show = !show)}>{show ? 'Hide' : 'Show'}</button>
		<button type="button" class="secondary" onclick={() => copy(done!.passphrase)}>{copied ? 'Copied' : 'Copy passphrase'}</button>
		{#if !vault.ephemeral}
			<button type="button" onclick={saveToManager}>{done.savedToManager ? 'Saved to the password manager' : 'Save in password manager'}</button>
		{/if}
		<a class="button secondary" href={to('/recovery-kit/')}>Print the kit</a>
	</div>

	<SendToPhone />
{:else}
	<h1>{quick ? 'Throwaway vault: write your note' : 'Write your first secret note'}</h1>
	{#if quick}<p class="warn">A made-up vault name and passphrase, kept in this tab only. Write the note, then scan the QR on the next screen with your phone.</p>{/if}
	{#if vault.status === 'loading'}
		<p class="muted mono">Checking your clearance level...</p>
	{:else}
		{#if replacing}
			<p class="warn" data-testid="replace-note">
				This browser holds the vault {#if current}<strong class="id">{current}</strong>{/if}. A new vault takes its place here once it is made; the old one stays on its hosts and comes back with <a href={to('/recover/')}>Recover</a> (its vault name and passphrase).
				<a href={to(vault.status === 'unlocked' ? '/notes/' : '/unlock/')}>Open it instead</a>
			</p>
		{/if}
		<form method="post" action="#" onsubmit={create} data-testid="setup-form">
			<div class="panel">
				<label for="note-text">Your secret</label>
				<textarea id="note-text" class="big-text" bind:this={noteBox} bind:value={noteText}></textarea>
				<label for="note-name">Note name (optional; only you see it, hosts get an HMAC)</label>
				<div class="name-row">
					<input id="note-name" type="text" autocomplete="off" bind:value={noteName} />
					<button type="button" class="link" onclick={() => (noteName = generateNoteName())}>roll</button>
				</div>
				{#if err}<p class="error-box" role="alert">{err}</p>{/if}
				<button type="submit" name="scatter" class="primary" disabled={busy || !nameOk || !strong}>{busy ? 'Encrypting and scattering...' : 'Encrypt and scatter'}</button>
				<button type="submit" name="skip" class="link" disabled={busy || !nameOk || !strong}>Skip, just create the vault</button>
			</div>

			<div class="panel compact">
				<p class="muted small">Your new vault. Nothing to choose: these are made up for you (rename the vault if you like). <strong>Your password manager can save this. Also keep the kit.</strong></p>
				<div class="cred">
					<label for="vault-name">Vault name</label>
					<input id="vault-name" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" required bind:value={name} />
				</div>
				<div class="cred">
					<label for="vault-pass">Passphrase</label>
					<input id="vault-pass" name="password" type={show ? 'text' : 'password'} autocomplete="new-password" autocapitalize="off" spellcheck="false" required readonly={!editing} class="mono" bind:value={passphrase} />
				</div>
				<div class="row small-buttons">
					<button type="button" class="link" onclick={() => (show = !show)} aria-pressed={!show}>{show ? 'Hide' : 'Show'}</button>
					<button type="button" class="link" onclick={() => copy(passphrase)}>{copied ? 'Copied' : 'Copy'}</button>
					<button type="button" class="link" onclick={roll}>Roll new words</button>
					<button type="button" class="link" onclick={() => (editing = !editing)} aria-pressed={editing}>{editing ? 'done changing' : 'change passphrase'}</button>
				</div>
				{#if editing || !strong || !nameOk}
					<p class="small {strong ? 'ok' : 'bad'}">Passphrase: about {bits} bits. {strong ? 'Strong enough.' : `Needs ${MIN_BITS}+: try 6 or more random words.`}</p>
					{#if !nameOk}<p class="bad small">Vault name: letters, digits, space, dot, dash or underscore (up to 63), starting with a letter or digit.</p>{/if}
				{/if}
				<PublicComputer bind:checked={publicMode} />
				<details>
					<summary class="muted small">Where the copies go ({planned.length} hosts, no accounts)</summary>
					<ul class="hosts">
						{#each planned as b (b.name)}
							<li><span class="mono">{b.name}</span> <span class="muted">({b.type})</span> <span class="id">{b.url ?? b.origin}</span></li>
						{/each}
					</ul>
					<p class="muted small">Change the list in <a href={to('/settings/')}>Settings</a>. The recovery-by-name record goes to: <span class="id">{hosts.discovery.join(', ')}</span></p>
				</details>
			</div>
			<p><a href={to('/recover/')}>Recover an existing vault instead</a></p>
		</form>
	{/if}
{/if}

<ActivityLog title="Vault construction log" />

<style>
	.small { font-size: 0.85rem; }
	.big { font-size: 1.15rem; font-weight: 700; }
	.big-text { min-height: 260px; font-size: 1rem; }
	.primary { font-size: 1.05rem; padding: 12px 22px; }
	button.link { background: none; border: 0; color: var(--cyan); text-decoration: underline; padding: 4px 6px; font-weight: 400; }
	.compact .cred { display: grid; grid-template-columns: 9em 1fr; align-items: center; gap: 8px; }
	.compact .cred label { margin: 4px 0; }
	.compact input[readonly] { color: var(--green); border-style: dashed; }
	@media (max-width: 640px) { .compact .cred { grid-template-columns: 1fr; } }
	.small-buttons { gap: 2px; }
	.name-row { display: flex; gap: 6px; align-items: center; }
	.name-row input { flex: 1; }
	.hosts, .host-results { padding-left: 18px; }
	.hosts li, .host-results li { margin: 3px 0; }
	dl { display: grid; grid-template-columns: 9em 1fr; gap: 6px 10px; }
	dd { margin: 0; }
</style>
