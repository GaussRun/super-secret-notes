// End to end against a deployed site (OVERKILL_SITE, default the GitHub Pages site) and the real
// hosts, with ONE throwaway vault (its generated random name; at most one new CryptPad account).
// Every step is timed and recorded; the run ends with a PASS/FAIL table and the per-host results,
// and fails if any step failed. The passphrase is never printed; it only lives in this process.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseKit } from '../../cli/src/kit.js';

const SITE = (process.env.OVERKILL_SITE ?? 'https://gaussrun.github.io/super-secret-notes').replace(/\/+$/, '');
const u = (path: string) => `${SITE}${path}`;
const LONG = 300_000;

interface Step {
	name: string;
	ok: boolean;
	ms: number;
	note: string;
}
const steps: Step[] = [];
const hostLines: string[] = [];
let failed = false;
let shotPage: Page | null = null;

// Each step builds on the ones before: after the first failure the rest are listed as NOT RUN.
async function step(name: string, fn: () => Promise<string | void>) {
	if (failed) return void steps.push({ name, ok: false, ms: 0, note: 'NOT RUN (an earlier step failed)' });
	const t0 = Date.now();
	try {
		const note = (await fn()) ?? '';
		steps.push({ name, ok: true, ms: Date.now() - t0, note });
	} catch (err) {
		// recorded for the table, and the run still fails at the end (see the last expect)
		failed = true;
		const lines = (err as Error).message.split('\n').map((l) => l.trim()).filter(Boolean);
		steps.push({ name, ok: false, ms: Date.now() - t0, note: lines.slice(0, 4).join(' / ').slice(0, 400) });
		await shotPage?.screenshot({ path: `test-results/site-failed-step.png`, fullPage: true }).catch(() => {});
	}
}

/** Everything a context requests, to prove no URL ever carries the passphrase or the access fragment. */
function watch(ctx: BrowserContext, requests: string[], problems: string[]) {
	ctx.on('request', (r) => requests.push(r.url()));
	ctx.on('page', (p) => {
		p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
		p.on('console', (m) => {
			if (m.type() !== 'error') return;
			// a new CryptPad account's existence check is a 404 the browser logs (see /how-it-works/)
			if (/Failed to load resource: the server responded with a status of 404/.test(m.text())) return;
			problems.push(`console: ${m.text().slice(0, 200)}`);
		});
	});
}

async function menu(page: Page, label: string) {
	await page.getByTestId('menu-button').click();
	await page.locator('#site-menu').getByRole('link', { name: label, exact: true }).click();
}

async function unlockWithPassword(page: Page, passphrase: string) {
	const form = page.getByTestId('unlock-form');
	await expect(form).toBeVisible({ timeout: LONG });
	await form.getByLabel('Passphrase', { exact: true }).fill(passphrase);
	await form.getByRole('button', { name: 'Unlock' }).click();
}

test('the deployed site end to end with the real hosts', async ({ browser }: { browser: Browser }) => {
	const requests: string[] = [];
	const problems: string[] = [];
	const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
	watch(ctx, requests, problems);
	const page = await ctx.newPage();
	shotPage = page;
	let vaultName = '';
	let passphrase = '';
	let noteName = '';
	let link = '';
	const text = `live run ${new Date().toISOString()}`;
	const edited = `${text}\nedited once`;

	await step('1a landing, no vault: "Store note in new vault" to the setup', async () => {
		await page.goto(u('/'));
		await expect(page.getByTestId('primary-cta')).toHaveText('Store note in new vault');
		await expect(page.getByTestId('primary-cta')).toHaveAttribute('href', /\/setup\/$/);
		await expect(page.getByTestId('secondary-cta')).toHaveText('Open my vault');
	});

	await step('2 note-first setup: generated names, kit download, stored on 2+ hosts', async () => {
		await page.getByTestId('primary-cta').click();
		await expect(page).toHaveURL(u('/setup/'));
		// exact: the diagram's description (on the page just left) also mentions the vault name
		const nameField = page.getByLabel('Vault name', { exact: true });
		await expect(nameField).toBeVisible({ timeout: LONG });
		vaultName = await nameField.inputValue();
		noteName = await page.getByLabel(/^Note name/).inputValue();
		passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
		await page.getByLabel('Your secret').fill(text);
		await expect(page.getByTestId('kit-checkbox')).toBeChecked();
		const downloading = page.waitForEvent('download', { timeout: LONG * 2 });
		await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
		const download = await downloading;
		const kit = await readFile((await download.path())!, 'utf8');
		expect(download.suggestedFilename()).toBe(`super-secret-notes-recovery-kit-${vaultName}.txt`);
		expect(kit).toContain(`vault name:   ${vaultName}`);
		expect(kit.includes(`passphrase:   ${passphrase}`)).toBe(true);
		const linkLine = /^access link: {2}(\S+)$/m.exec(kit)?.[1] ?? '';
		expect(linkLine.startsWith(u('/recover/#v='))).toBe(true);
		expect(parseKit(kit).cfg.name).toBe(vaultName);
		const done = page.getByTestId('setup-done');
		await expect(done).toBeVisible({ timeout: LONG });
		const m = /is on (\d+) of (\d+) hosts/.exec((await done.textContent()) ?? '');
		const stored = Number(m?.[1] ?? 0);
		for (const li of await done.locator('.host-results li').allTextContents()) hostLines.push(`setup: ${li.trim().replace(/\s+/g, ' ')}`);
		expect(stored).toBeGreaterThanOrEqual(2);
		return `vault ${vaultName}, note ${noteName}: on ${m?.[1]} of ${m?.[2]} hosts`;
	});

	await step('1b landing, vault open: "New note" and "My notes"', async () => {
		await page.locator('header a').first().click();
		await expect(page.getByTestId('primary-cta')).toHaveText('New note');
		await expect(page.getByTestId('secondary-cta')).toHaveText('My notes');
	});

	await step('1c landing, vault stored and locked: "New note in my vault" with its name', async () => {
		await page.goto(u('/'));
		await expect(page.getByTestId('primary-cta')).toHaveText('New note in my vault');
		await expect(page.getByTestId('stored-vault-name')).toHaveText(vaultName);
		await expect(page.getByTestId('secondary-cta')).toHaveText('Open my vault');
		await expect(page.getByTestId('new-vault-link')).toHaveText('Store note in new vault');
	});

	await step('3 open the note: read-from host OK, quiet hosts section, raw copies without plaintext', async () => {
		await page.getByTestId('secondary-cta').click();
		await unlockWithPassword(page, passphrase);
		await expect(page).toHaveURL(u('/notes/'), { timeout: LONG });
		await page.getByTestId('notes-table').getByRole('link', { name: noteName, exact: true }).click();
		await expect(page.getByTestId('note-text')).toHaveValue(text, { timeout: LONG });
		const from = (await page.getByTestId('note-source').getAttribute('data-backend'))!;
		const summary = (await page.getByTestId('lives-summary').textContent())!.trim();
		await expect(page.getByTestId('note-hosts')).toHaveCount(0);
		await page.getByTestId('show-all').click();
		const fromRow = page.getByTestId(`host-${from}`);
		await expect(fromRow.locator('td').nth(2)).toHaveText('OK');
		const rows = page.getByTestId('note-hosts').locator('tbody tr[data-backend]');
		const names = await rows.evaluateAll((els) => els.map((e) => [(e as HTMLElement).dataset.backend!, e.querySelector('.host-type')?.textContent?.trim() ?? '']));
		for (const kind of ['PrivateBin', 'Nostr relay']) {
			const hit = names.find(([, type]) => type === kind);
			if (!hit) throw new Error(`no ${kind} row to show a raw copy of`);
			await page.getByTestId(`raw-${hit[0]}`).click();
			const raw = page.getByTestId(`raw-view-${hit[0]}`).getByTestId('raw-text');
			await expect(raw).toBeVisible({ timeout: LONG });
			const body = await raw.innerText();
			expect(body.length).toBeGreaterThan(40);
			expect(body.includes(text)).toBe(false);
			await page.getByTestId(`raw-${hit[0]}`).click();
		}
		return `read from a ${names.find(([n]) => n === from)?.[1] ?? 'host'}; ${summary}`;
	});

	await step('4 edit: "Publish changes" only when dirty, then published', async () => {
		await expect(page.getByTestId('publish')).toHaveCount(0);
		await page.getByTestId('note-text').fill(edited);
		await expect(page.getByTestId('publish')).toBeVisible();
		await page.getByTestId('publish').click();
		await expect(page.getByTestId('publish')).toHaveCount(0, { timeout: LONG });
		return (await page.getByTestId('saved-status').textContent())!.trim();
	});

	await step('5 reload: unlock with the password form, and with the access link pasted', async () => {
		await page.reload();
		await unlockWithPassword(page, passphrase);
		await expect(page.getByTestId('note-text')).toHaveValue(edited, { timeout: LONG });
		await page.getByTestId('menu-button').click();
		await page.locator('#site-menu').getByRole('link', { name: 'Vault access', exact: true }).click();
		await page.getByTestId('copy-access-link').click();
		link = await page.evaluate(() => navigator.clipboard.readText());
		expect(link.startsWith(u('/recover/#v='))).toBe(true);
		await page.reload();
		const form = page.getByTestId('unlock-form');
		await expect(form).toBeVisible({ timeout: LONG });
		await form.getByLabel('Paste your access link or recovery kit').fill(link);
		await expect(form.getByLabel('Passphrase', { exact: true })).not.toHaveValue('');
		await form.getByRole('button', { name: 'Unlock' }).click();
		await expect(page.getByTestId('share-vault')).toBeVisible({ timeout: LONG });
	});

	await step('6 a fresh browser pastes the access link into /recover/, recovers in one click, reads the edit', async () => {
		const fresh = await browser.newContext();
		watch(fresh, requests, problems);
		const p = await fresh.newPage();
		try {
			await p.goto(u('/recover/'));
			await p.getByLabel('Paste your access link or recovery kit').fill(link);
			await expect(p.getByTestId('paste-ready')).toContainText(`Recover ${vaultName}?`);
			await p.getByRole('button', { name: 'Recover' }).click();
			await expect(p.getByTestId('recovered')).toBeVisible({ timeout: LONG });
			await menu(p, 'My notes');
			await p.getByTestId('notes-table').getByRole('link', { name: noteName, exact: true }).click();
			await expect(p.getByTestId('note-text')).toHaveValue(edited, { timeout: LONG });
			return 'recovered in one click and read the edit';
		} finally {
			await fresh.close();
		}
	});

	await step('7 "Check all copies now" on the note: per-host status', async () => {
		await menu(page, 'My notes');
		await page.getByTestId('notes-table').getByRole('link', { name: noteName, exact: true }).click();
		await expect(page.getByTestId('note-text')).toHaveValue(edited, { timeout: LONG });
		await page.getByTestId('show-all').click();
		await page.getByTestId('check-note').click();
		await expect(page.getByTestId('check-note')).toBeEnabled({ timeout: LONG });
		const rows = await page.getByTestId('note-hosts').locator('tbody tr[data-backend]').all();
		for (const r of rows) {
			const cells = (await r.locator('td').allTextContents()).map((c) => c.trim().replace(/\s+/g, ' '));
			hostLines.push(`check: ${cells[0]} | ${cells[1]} | ${cells[2]} | ${cells[3]}`);
		}
		return (await page.getByTestId('lives-summary').textContent())!.trim();
	});

	await step('8 /about/, /how-it-works/, /thanks/ render; the site info only on / and /about/', async () => {
		for (const path of ['/about/', '/how-it-works/', '/thanks/']) {
			await page.goto(u(path));
			await expect(page.locator('main h1')).toBeVisible();
			await expect(page.getByTestId('site-info')).toHaveCount(path === '/about/' ? 1 : 0);
		}
		await page.goto(u('/'));
		await expect(page.getByTestId('site-info')).toHaveCount(1);
	});

	await step('8b no console errors, no CSP violations, no request with the passphrase or the fragment', async () => {
		const leaks = requests.filter((r) => r.includes('#v=') || [passphrase, encodeURIComponent(passphrase), passphrase.replace(/ /g, '+')].some((f) => f && r.includes(f)));
		if (leaks.length) throw new Error(`${leaks.length} request(s) carried the passphrase or the fragment`);
		if (problems.length) throw new Error(problems.join(' | '));
		return `${requests.length} requests checked`;
	});

	await ctx.close();

	const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
	console.log(`\nsite: ${SITE}`);
	console.log(pad('step', 92) + pad('result', 8) + 'time');
	for (const s of steps) console.log(pad(s.name, 92) + pad(s.ok ? 'PASS' : s.note.startsWith('NOT RUN') ? '-' : 'FAIL', 8) + `${(s.ms / 1000).toFixed(1)} s${s.note ? `  (${s.note})` : ''}`);
	console.log('\nper host:');
	for (const l of hostLines) console.log(`  ${l}`);
	expect(steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.note}`)).toEqual([]);
});
