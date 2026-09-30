<script lang="ts">
	import { goto } from '$app/navigation';
	import { vault } from '$lib/overkill/vault.svelte';
	import { loadHosts, saveHosts, defaultHosts, type Hosts } from '$lib/overkill/settings';
	import { to } from '$lib/link';

	const lines = (list: string[]) => list.join('\n');
	const parse = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

	let h = loadHosts();
	let privatebin = $state(lines(h.privatebin));
	let nostr = $state(lines(h.nostr));
	let blossom = $state(lines(h.blossom));
	let cryptpad = $state(lines(h.cryptpad));
	let discovery = $state(lines(h.discovery));
	let pause = $state(h.nostrPauseMs);
	let msg = $state('');
	let err = $state('');
	let confirmForget = $state(false);

	function save(e: SubmitEvent) {
		e.preventDefault();
		err = '';
		msg = '';
		const next: Hosts = { draw: false, privatebin: parse(privatebin), nostr: parse(nostr), blossom: parse(blossom), cryptpad: parse(cryptpad), discovery: parse(discovery), nostrPauseMs: Number(pause) || 0, fallbacks: h.fallbacks, timeouts: h.timeouts };
		// all three lists empty: keep drawing new vaults' hosts at random from the pools
		const draw = !next.privatebin.length && !next.nostr.length && !next.cryptpad.length;
		for (const u of [...next.privatebin, ...next.blossom, ...next.cryptpad]) if (!/^https:\/\//.test(u) && !/^http:\/\/127\.0\.0\.1[:/]/.test(u)) return (err = `not an https URL: ${u}`);
		for (const u of [...next.nostr, ...next.discovery]) if (!/^wss:\/\//.test(u) && !/^ws:\/\/127\.0\.0\.1[:/]/.test(u)) return (err = `not a wss URL: ${u}`);
		if (!draw && !next.nostr.length && !next.cryptpad.length) return (err = 'at least one Nostr relay or CryptPad instance: the index lives there');
		try {
			saveHosts(draw ? ({ ...next, privatebin: undefined, nostr: undefined, cryptpad: undefined } as unknown as Hosts) : next);
			msg = 'Saved. New vaults use these hosts; recovery by name asks these relays.';
		} catch (x) {
			err = (x as Error).message;
		}
	}

	function reset() {
		const d = defaultHosts();
		privatebin = lines(d.privatebin);
		nostr = lines(d.nostr);
		blossom = lines(d.blossom);
		cryptpad = lines(d.cryptpad);
		discovery = lines(d.discovery);
		pause = d.nostrPauseMs;
	}

	async function forget() {
		await vault.forget();
		goto(to('/'));
	}
</script>

<h1>Settings</h1>
<form class="panel" onsubmit={save}>
	<h2>Hosts for a new vault</h2>
	<p class="muted">One URL per line. An existing vault keeps the hosts it was made with. Leave PrivateBin, Nostr and CryptPad empty to let each new vault draw its own hosts at random from the <a href={to('/hosts/')}>known-good pools</a> (the default).</p>
	<label for="s-pb">PrivateBin instances</label>
	<textarea id="s-pb" class="short" bind:value={privatebin}></textarea>
	<label for="s-nostr">Nostr relays (they hold the index)</label>
	<textarea id="s-nostr" class="short" bind:value={nostr}></textarea>
	<label for="s-blossom">Blossom servers</label>
	<textarea id="s-blossom" class="short" bind:value={blossom}></textarea>
	<label for="s-cp">CryptPad instances (an account per vault is made on first use; they hold the index too)</label>
	<textarea id="s-cp" class="short" bind:value={cryptpad}></textarea>
	<h2>Recovery by name</h2>
	<label for="s-disc">Relays for the recovery record (the CLI uses the same four by default)</label>
	<textarea id="s-disc" class="short" bind:value={discovery}></textarea>
	<label for="s-pause">Pause between two events to one relay, in ms (relays rate-limit)</label>
	<input id="s-pause" type="text" inputmode="numeric" bind:value={pause} />
	{#if err}<p class="error-box" role="alert">{err}</p>{/if}
	{#if msg}<p class="ok">{msg}</p>{/if}
	<button type="submit">Save</button>
	<button type="button" class="secondary" onclick={reset}>Back to the defaults</button>
</form>

{#if vault.status !== 'none' && vault.status !== 'loading'}
	<div class="panel">
		<h2>This device</h2>
		<p class="muted">Forgetting removes this browser's encrypted copy of the vault. The copies on the hosts stay, and recovery by name brings it back.</p>
		{#if !confirmForget}
			<button class="danger" onclick={() => (confirmForget = true)}>Forget this vault on this device</button>
		{:else}
			<p class="warn">Sure? Have your vault name and passphrase (or the recovery kit) at hand.</p>
			<button class="danger" onclick={forget} data-testid="forget-confirm">Yes, forget it here</button>
			<button class="secondary" onclick={() => (confirmForget = false)}>Keep it</button>
		{/if}
	</div>
{/if}

<style>
	textarea.short { min-height: 90px; }
</style>
