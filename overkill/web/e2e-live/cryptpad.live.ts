// Live CryptPad check (phase 2), reusing the vault of live.live.ts (OVERKILL_LIVE_SECRET_FILE):
// recover it by name, add the default CryptPad instances from the hosts page (at most one
// derived account per instance, the vault's own), check, put, get, and recover again in a
// fresh browser. crypt.unredacted.org locks other origins out, so the page refuses it without
// sending anything.
import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const VAULT = 'overkill-dev-web-static';
const NOTE = 'live cryptpad check';
const TEXT = `web static cryptpad live check ${new Date().toISOString()}`;

async function nav(page: Page, label: string, path: string) {
	await page.getByRole('navigation').getByRole('link', { name: label, exact: true }).click();
	await expect(page).toHaveURL(path);
}

async function recover(browser: Browser, passphrase: string) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/recover/');
	await page.getByLabel('Vault name').fill(VAULT);
	await page.getByLabel('Passphrase').fill(passphrase);
	await page.getByRole('button', { name: 'Recover' }).click();
	await expect(page.getByTestId('recovered')).toBeVisible({ timeout: 300_000 });
	return { ctx, page };
}

async function printCheck(page: Page) {
	await nav(page, 'Check', '/check/');
	await expect(page.getByTestId('check-summary')).toBeVisible({ timeout: 300_000 });
	console.log('check: ' + (await page.getByTestId('check-summary').textContent())!.trim());
	const headers = (await page.getByTestId('check-table').locator('thead th').allTextContents()).map((h) => h.trim());
	for (const r of await page.getByTestId('check-table').locator('tbody tr').all()) {
		const cells = (await r.locator('td').allTextContents()).map((x) => x.trim().replace(/\s+/g, ' '));
		const bad = headers.slice(1).map((h, i) => [h, cells[i + 1]]).filter(([, v]) => v !== 'OK' && !v.startsWith('OK ') && v !== 'n/a');
		const cp = headers.slice(1).map((h, i) => [h, cells[i + 1]]).filter(([h]) => h.startsWith('cp-'));
		console.log(`  ${cells[0]}: ${cp.map(([h, v]) => `${h}=${v}`).join(', ')}${bad.length ? `; not OK: ${bad.map(([h, v]) => `${h}=${v}`).join(', ')}` : ''}`);
	}
}

test('real CryptPad from the browser: add, register, check, put, get, recover', async ({ browser }) => {
	const file = process.env.OVERKILL_LIVE_SECRET_FILE;
	expect(file, 'OVERKILL_LIVE_SECRET_FILE from the live.live.ts run').toBeTruthy();
	const { vault, passphrase } = JSON.parse(await readFile(file!, 'utf8'));
	expect(vault).toBe(VAULT);

	const { ctx, page } = await recover(browser, passphrase);
	const errors: string[] = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	console.log('recovered: ' + (await page.getByTestId('recovered').locator('p').first().textContent()));

	await nav(page, 'Hosts', '/hosts/');
	const has = async (host: string) => (await page.locator('table').first().textContent())!.includes(host);

	await page.getByLabel('Type').selectOption('cryptpad');
	await page.getByLabel('URL').fill('https://crypt.unredacted.org');
	await page.getByRole('button', { name: 'Add and copy' }).click();
	await expect(page.getByRole('alert')).toContainText('does not let other sites use its API');
	console.log('crypt.unredacted.org: ' + (await page.getByRole('alert').textContent()));

	if (await has('cryptpad.private.coffee')) {
		console.log('cryptpad.private.coffee: already in the vault (account exists), not added again');
	} else {
		const t0 = Date.now();
		await page.getByLabel('URL').fill('https://cryptpad.private.coffee');
		await page.getByRole('button', { name: 'Add and copy' }).click();
		await expect(page.getByTestId('host-added').or(page.getByRole('alert'))).toBeVisible({ timeout: 600_000 });
		const log = (await page.getByTestId('activity').locator('li').allTextContents()).join('\n  ');
		console.log(`add cryptpad.private.coffee (${Math.round((Date.now() - t0) / 1000)} s):\n  ${log}`);
		await expect(page.getByTestId('host-added')).toBeVisible();
	}

	await printCheck(page);

	await nav(page, 'New', '/new/');
	await page.getByLabel(/^Name/).fill(NOTE);
	await page.getByLabel('Top secret contents').fill(TEXT);
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('saved')).toBeVisible({ timeout: 300_000 });
	console.log('put: ' + (await page.getByTestId('saved').locator('p').first().textContent()));
	await nav(page, 'Kit', '/recovery-kit/');
	const kit = (await page.getByTestId('kit').textContent())!;
	console.log('kit CryptPad line: ' + (kit.split('\n').find((l) => l.includes('password derived from master'))?.replace(/^\|\s*/, '').trim() ?? '(none)'));
	console.log('console errors: ' + (errors.length ? errors.join(' | ') : 'none'));
	await ctx.close();

	// another "device": the recovery record now lists the CryptPad account; read through it
	const again = await recover(browser, passphrase);
	await expect(again.page.getByTestId('recovered')).toContainText('cp-private');
	await printCheck(again.page);
	await nav(again.page, 'Notes', '/notes/');
	await again.page.getByTestId('notes-table').getByRole('link', { name: NOTE, exact: true }).click();
	await expect(again.page.getByTestId('note-text')).toHaveValue(TEXT);
	console.log('get after recover: ' + (await again.page.getByTestId('note-source').textContent()));
	await again.ctx.close();
});
