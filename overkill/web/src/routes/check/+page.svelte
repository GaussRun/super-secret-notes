<script lang="ts">
	import Locked from '$lib/components/Locked.svelte';
	import ActivityLog from '$lib/components/ActivityLog.svelte';
	import { activity } from '$lib/overkill/activity.svelte';
	import { vault } from '$lib/overkill/vault.svelte';
	import { summarize } from '$cli/store.js';

	type Copy = { backend: string; status: string; detail?: string; expires: Date | null; assumed?: boolean };
	type Report = { vault: Copy[]; index: Copy[]; notes: Record<string, Copy[]> };
	let report = $state<Report | null>(null);
	let busy = $state(false);
	let err = $state('');
	let repaired = $state<{ fixed: string[]; failed: string[] } | null>(null);
	let started = false;

	const backends = $derived(vault.backends.map((b) => b.name as string));
	const rows = $derived(report ? [['vault.age', report.vault], ...(report.index.length ? [['index', report.index]] : []), ...Object.entries(report.notes)] as [string, Copy[]][] : []);
	const totals = $derived(report ? summarize(report) : null);
	const allGood = $derived(totals ? totals.healthy === totals.total : false);

	async function run(clear = true) {
		busy = true;
		err = '';
		if (clear) activity.clear();
		try {
			report = await vault.check();
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
	}

	async function refresh() {
		if (!report) return;
		busy = true;
		err = '';
		activity.clear();
		try {
			repaired = await vault.refresh(report as never);
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
		await run(false);
	}

	async function repair() {
		if (!report) return;
		busy = true;
		err = '';
		activity.clear();
		try {
			repaired = await vault.repair(report as never);
		} catch (x) {
			err = (x as Error).message;
		} finally {
			busy = false;
		}
		await run(false);
	}

	$effect(() => {
		if (vault.status === 'unlocked' && !started) {
			started = true;
			run();
		}
	});

	const cls = (s: string) => (s === 'OK' ? 'ok' : s === 'STALE' ? 'warn' : 'bad');
	const cell = (copies: Copy[], b: string) => copies.find((x) => x.backend === b);
</script>

<Locked>
	<div class="row">
		<h1>Copy health</h1>
		<button onclick={() => run()} disabled={busy}>{busy ? 'Auditing...' : 'Run full check'}</button>
		{#if report && !allGood}
			<button class="danger" onclick={repair} disabled={busy} data-testid="repair">Repair from healthy copies</button>
		{/if}
		{#if report}
			<button class="secondary" onclick={refresh} disabled={busy} data-testid="refresh" title="Republish copies that are missing or due within 90 days (Nostr and Blossom promise no retention)">Refresh</button>
		{/if}
	</div>
	<p class="muted">Downloads every copy from every host, peels every layer and compares the sha256 with the index.</p>
	{#if err}<p class="error-box" role="alert">{err}</p>{/if}
	{#if repaired}
		<div class="panel" data-testid="repaired">
			{#each repaired.fixed as x (x)}<div class="ok mono small">repaired {x}</div>{/each}
			{#each repaired.failed as x (x)}<div class="bad mono small">could not repair {x}</div>{/each}
			{#if !repaired.fixed.length && !repaired.failed.length}<div class="muted">Nothing needed doing.</div>{/if}
		</div>
	{/if}

	{#if report && totals}
		<div class="panel verdict {allGood ? 'good' : 'bad-panel'}" data-testid="check-summary">
			<div class="big mono">{allGood ? 'ALL COPIES HEALTHY' : 'DAMAGE DETECTED'}</div>
			<div class="mono">{totals.healthy}/{totals.total} copies healthy{allGood ? '. Gloriously redundant.' : '. Repair re-uploads from a healthy copy.'}</div>
		</div>
		<div class="panel table-scroll">
			<table data-testid="check-table">
				<thead>
					<tr><th>Item</th>{#each backends as b (b)}<th class="id">{b}</th>{/each}</tr>
				</thead>
				<tbody>
					{#each rows as [label, copies] (label)}
						<tr data-testid="row-{label}">
							<td><strong class="label">{label}</strong></td>
							{#each backends as b (b)}
								{@const x = cell(copies, b)}
								<td class={x ? cls(x.status) : 'muted'} data-testid="cell-{label}-{b}">
									{#if x}
										<span class="mono state">{x.status}</span>
										{#if x.detail}<div class="detail">{x.detail}</div>{/if}
										{#if x.expires}<div class="detail">{x.assumed ? 'republish by' : 'expires'} {x.expires.toISOString().slice(0, 10)}</div>{/if}
									{:else}
										<span class="mono small">n/a</span>
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="muted small">n/a: PrivateBin and Blossom pick their own addresses, so they never hold the index.</p>
	{/if}
	<ActivityLog title="Audit log" />
</Locked>

<style>
	.verdict { border-width: 2px; }
	.good { border-color: var(--green); }
	.bad-panel { border-color: var(--red); }
	.big { font-size: 1.4rem; font-weight: 800; }
	.good .big { color: var(--green); }
	.bad-panel .big { color: var(--red); }
	.small { font-size: 0.8rem; }
	.state { font-weight: 700; }
	.label { overflow-wrap: anywhere; }
	.detail { font-size: 0.72rem; color: var(--muted); overflow-wrap: anywhere; }
</style>
