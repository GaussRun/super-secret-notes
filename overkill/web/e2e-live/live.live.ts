// Live check against the real zero-signup defaults, from headless Chromium: setup (vault
// "overkill-dev-web-static"), put, check, get, then recover by name in a fresh browser and read
// again. Prints per-host results only; the passphrase goes to OVERKILL_LIVE_SECRET_FILE (0600)
// so a later run can reuse the vault, and is never printed.
import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const VAULT = 'overkill-dev-web-static';
const NOTE = 'live check';
const TEXT = `web static live check ${new Date().toISOString()}`;
const SECRET_FILE = process.env.OVERKILL_LIVE_SECRET_FILE;

async function nav(page: Page, label: string, path: string) {
	await page.getByRole('navigation').getByRole('link', { name: label, exact: true }).click();
	await expect(page).toHaveURL(path);
}

async function checkTable(page: Page) {
	await nav(page, 'Check', '/check/');
	await expect(page.getByTestId('check-summary')).toBeVisible({ timeout: 300_000 });
	const headers = await page.getByTestId('check-table').locator('thead th').allTextContents();
	const rows = await page.getByTestId('check-table').locator('tbody tr').all();
	const out: Record<string, Record<string, string>> = {};
	for (const r of rows) {
		const cells = await r.locator('td').allTextContents();
		const item = cells[0].trim();
		headers.slice(1).forEach((h, i) => ((out[h.trim()] ??= {})[item] = cells[i + 1].trim().replace(/\s+/g, ' ')));
	}
	return { summary: (await page.getByTestId('check-summary').textContent())!.trim(), perHost: out };
}

test('real hosts: setup, put, check, get, recover by name in a fresh browser', async ({ browser }) => {
	expect(SECRET_FILE, 'set OVERKILL_LIVE_SECRET_FILE to a path outside the repository').toBeTruthy();
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const log: string[] = [];
	page.on('console', (m) => m.type() === 'error' && log.push(m.text()));

	let passphrase: string;
	const saved = await readFile(SECRET_FILE!, 'utf8').then(JSON.parse, () => null);
	if (saved?.vault === VAULT) {
		passphrase = saved.passphrase;
		await page.goto('/recover/');
		await page.getByLabel('Vault name').fill(VAULT);
		await page.getByLabel('Passphrase').fill(passphrase);
		await page.getByRole('button', { name: 'Recover' }).click();
		await expect(page.getByTestId('recovered')).toBeVisible({ timeout: 300_000 });
		console.log('reused the existing live vault (recovered by name)');
	} else {
		await page.goto('/setup/');
		await page.getByTestId('setup-form').getByRole('button', { name: 'change', exact: true }).click();
		await page.getByLabel('Vault name').fill(VAULT);
		passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
		await writeFile(SECRET_FILE!, JSON.stringify({ vault: VAULT, passphrase }), { mode: 0o600 });
		await page.getByRole('button', { name: 'Skip, just create the vault' }).click();
		await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 300_000 });
		console.log('setup log:\n  ' + (await page.getByTestId('activity').locator('li').allTextContents()).join('\n  '));
	}

	await nav(page, 'New', '/new/');
	await page.getByLabel(/^Name/).fill(NOTE);
	await page.getByLabel('Top secret contents').fill(TEXT);
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('saved')).toBeVisible({ timeout: 300_000 });
	console.log('put: ' + (await page.getByTestId('saved').locator('p').first().textContent()));
	console.log('put log:\n  ' + (await page.getByTestId('activity').locator('li').allTextContents()).join('\n  '));

	const check = await checkTable(page);
	console.log('check: ' + check.summary);
	for (const [host, items] of Object.entries(check.perHost)) console.log(`  ${host}: ${Object.entries(items).map(([k, v]) => `${k}=${v}`).join(', ')}`);

	await nav(page, 'Notes', '/notes/');
	await page.getByTestId('notes-table').getByRole('link', { name: NOTE, exact: true }).click();
	await expect(page.getByTestId('note-text')).toHaveValue(TEXT);
	console.log('get: ' + (await page.getByTestId('note-source').textContent()));
	await ctx.close();

	const fresh = await browser.newContext();
	const p2 = await fresh.newPage();
	await p2.goto('/recover/');
	await p2.getByLabel('Vault name').fill(VAULT);
	await p2.getByLabel('Passphrase').fill(passphrase);
	await p2.getByRole('button', { name: 'Recover' }).click();
	await expect(p2.getByTestId('recovered')).toBeVisible({ timeout: 300_000 });
	console.log('recover (fresh browser): ' + (await p2.getByTestId('recovered').locator('h2').textContent()));
	await nav(p2, 'Notes', '/notes/');
	await p2.getByTestId('notes-table').getByRole('link', { name: NOTE, exact: true }).click();
	await expect(p2.getByTestId('note-text')).toHaveValue(TEXT);
	console.log('get after recover: ' + (await p2.getByTestId('note-source').textContent()));
	console.log('console errors: ' + (log.length ? log.join(' | ') : 'none'));
	await fresh.close();
});
