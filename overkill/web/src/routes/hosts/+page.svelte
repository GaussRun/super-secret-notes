<script lang="ts">
	import { vault } from '$lib/overkill/vault.svelte';
	import ActivityLog from '$lib/components/ActivityLog.svelte';
	import { activity } from '$lib/overkill/activity.svelte';
	import { loadHosts } from '$lib/overkill/settings';
	import { to } from '$lib/link';

	const hosts = loadHosts();

	let addType = $state<'privatebin' | 'cryptpad' | 'nostr' | 'blossom'>('cryptpad');
	let addUrl = $state('');
	let busy = $state(false);
	let err = $state('');
	let added = $state<{ name: string; fixed: string[]; failed: string[] } | null>(null);

	async function add(e: SubmitEvent) {
		e.preventDefault();
		err = '';
		added = null;
		busy = true;
		activity.clear();
		try {
			added = await vault.addHost(addType, addUrl);
			addUrl = '';
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}
	const blurb: Record<string, string> = {
		privatebin: 'Volunteer pastebins with "never" expiry. Their own AES-256-GCM layer, the key stays in the URL fragment. Holds notes and vault.age, never the index.',
		nostr: 'Public relays: NIP-78 events, NIP-44 encrypted to a key derived from your vault. They hold the index. No retention promised, so check and repair now and then.',
		cryptpad: 'An end-to-end encrypted office suite. The vault owns one account per instance, with a username and password derived from the master key, registered on first use. Holds the index too.',
		blossom: 'Nostr blob servers: an extra AES-GCM layer, addressed by sha256, uploads signed with your vault key. No retention promised.'
	};
</script>

<h1>Hosts</h1>
<p class="muted">Every host is run by someone else and none needs an account. Redundancy comes from independent operators.</p>

{#if vault.status === 'unlocked' && vault.cfg}
	<div class="panel">
		<h2>This vault</h2>
		<p>Name <strong class="mono">{vault.cfg.name}</strong>, root folder <span class="mono">{vault.cfg.root ?? 'overkill'}</span></p>
		<p class="muted small">Nostr public key (not a secret): <span class="id" data-testid="npub">{vault.npub}</span></p>
		<table>
			<thead><tr><th>Name</th><th>Type</th><th>Where</th></tr></thead>
			<tbody>
				{#each vault.backends as b (b.name)}
					<tr><td class="mono">{b.name}</td><td>{b.type}</td><td class="id">{b.where}</td></tr>
				{/each}
				{#each vault.unsupported as b (b.name)}
					<tr class="muted"><td class="mono">{b.name}</td><td>{b.type}</td><td class="id">{b.url ?? b.origin ?? ''} (CLI only)</td></tr>
				{/each}
			</tbody>
		</table>
	</div>

	<form class="panel" onsubmit={add}>
		<h2>Add a host to this vault</h2>
		<p class="muted">One more independent copy: everything (vault.age, the index, every note) is copied there right away. A CryptPad account is made for this vault on first use.</p>
		<label for="add-type">Type</label>
		<select id="add-type" bind:value={addType}>
			<option value="cryptpad">CryptPad</option>
			<option value="privatebin">PrivateBin</option>
			<option value="nostr">Nostr relay</option>
			<option value="blossom">Blossom server</option>
		</select>
		<label for="add-url">URL</label>
		<input id="add-url" type="text" autocomplete="off" placeholder="https://cryptpad.example.org" bind:value={addUrl} />
		{#if err}<p class="error-box" role="alert">{err}</p>{/if}
		{#if added}
			<div data-testid="host-added">
				<p class="ok">Added {added.name}.</p>
				{#each added.fixed as x (x)}<div class="ok mono small">copied {x}</div>{/each}
				{#each added.failed as x (x)}<div class="bad mono small">could not copy {x}</div>{/each}
			</div>
		{/if}
		<button type="submit" disabled={busy || !addUrl.trim()}>{busy ? 'Copying everything...' : 'Add and copy'}</button>
	</form>
	<ActivityLog title="Copy log" />
{:else}
	<p class="muted">Unlock (or <a href={to('/setup/')}>create</a>) a vault to see its hosts.</p>
{/if}

<div class="panel">
	<h2>Defaults for a new vault</h2>
	{#each [['privatebin', hosts.privatebin], ['cryptpad', hosts.cryptpad], ['nostr', hosts.nostr], ['blossom', hosts.blossom]] as [type, list] (type)}
		<h3>{type}</h3>
		<p class="muted small">{blurb[type as string]}</p>
		<ul>{#each list as u (u)}<li class="id">{u}</li>{/each}</ul>
	{/each}
	<h3>recovery by name</h3>
	<ul>{#each hosts.discovery as u (u)}<li class="id">{u}</li>{/each}</ul>
	<p><a href={to('/settings/')}>Change them in Settings.</a> crypt.unredacted.org (a CLI default) only lets its own pages use its API, so a vault using it keeps that copy for the CLI.</p>
</div>

<style>
	.small { font-size: 0.85rem; }
	h3 { font-size: 1rem; margin-bottom: 4px; }
</style>
