// Setup extras: the recovery kit downloads itself when the vault is made (on by default, off on a
// public computer), the result screen offers it again plus "Copy recovery link", the note about a
// vault already in this browser is a quiet grey line, typed notes are not lost to a misclick, the
// login form stays in the page for the browser's save prompt, and "Save in password manager"
// only shows where the browser can do it.
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, ORIGIN, nav } from './helpers';
import { parseKit } from '../../cli/src/kit.js';

let fakes: Fakes;
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

async function fillSetup(page: Page, name: string) {
	await page.goto(url('/setup/'));
	await page.getByLabel('Vault name').fill(name);
	await page.getByLabel('Your secret').fill('kit test');
	return page.getByLabel('Passphrase', { exact: true }).inputValue();
}

test('the kit downloads itself when the vault is made, with the name, the passphrase and the access link; the CLI can read it', async ({ browser }) => {
	const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	const errors = watchErrors(page);
	const passphrase = await fillSetup(page, 'kit vault');
	await expect(page.getByTestId('kit-checkbox')).toBeChecked();
	const downloading = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe('super-secret-notes-recovery-kit-kit vault.txt');
	const text = await readFile((await download.path())!, 'utf8');
	const link = `${ORIGIN}${url('/recover/')}#v=${encodeURIComponent('kit vault')}&p=${encodeURIComponent(passphrase)}`;
	expect(text).toContain('vault name:   kit vault');
	expect(text).toContain(`passphrase:   ${passphrase}`);
	expect(text).toContain(`access link:  ${link}`);
	expect(text).toContain(`vault link:   ${ORIGIN}${url('/recover/')}#v=${encodeURIComponent('kit vault')}`);
	expect(text).toContain('It contains your passphrase');
	expect(text).toContain('anyone with it can open your');
	// the command line tool's recover --kit reads the same file
	const kit = parseKit(text);
	expect(kit.vault.age_identity).toMatch(/^AGE-SECRET-KEY-1/);
	expect(kit.cfg.name).toBe('kit vault');
	await expect(page.getByTestId('setup-done')).toBeVisible();
	await expect(page.getByTestId('kit-downloaded')).toBeVisible();

	// again from the result screen, and the recovery link to the clipboard
	const again = page.waitForEvent('download');
	await page.getByTestId('download-kit').click();
	expect((await again).suggestedFilename()).toBe('super-secret-notes-recovery-kit-kit vault.txt');
	// the result screen's copy button gives the vault link (no passphrase)
	await page.getByTestId('copy-recovery-link').click();
	const vaultLink = `${ORIGIN}${url('/recover/')}#v=${encodeURIComponent('kit vault')}`;
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(vaultLink);
	await expect(page.getByTestId('done-vault-link')).toContainText(vaultLink);
	// the login form stays in the page (hidden), for the browser's password-save prompt
	await expect(page.getByTestId('setup-form')).toHaveCount(1);
	await expect(page.getByTestId('setup-form')).toBeHidden();
	// Chromium can store the login from the page
	await expect(page.getByRole('button', { name: 'Save in password manager' })).toBeVisible();
	expect(errors).toEqual([]);

	// with that vault in the browser, the note about it is one quiet grey line
	await page.goto(url('/setup/'));
	const line = page.getByTestId('replace-note');
	await expect(line).toContainText('This browser currently remembers kit vault. It stays safe on its hosts');
	await expect(line).toHaveClass(/\bmuted\b/);
	await expect(line).not.toHaveClass(/\bwarn\b/);
	expect(await line.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
	await ctx.close();
});

test('unchecked: no download; on a public computer it starts unchecked, with the reason', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	let downloads = 0;
	page.on('download', () => downloads++);
	await fillSetup(page, 'no kit vault');
	await page.getByTestId('kit-checkbox').uncheck();
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });
	await page.waitForTimeout(1500);
	expect(downloads).toBe(0);

	const pub = await browser.newContext();
	await useFakes(pub, fakes);
	const p = await pub.newPage();
	await p.goto(url('/setup/?quick=1'));
	await expect(p.getByTestId('kit-checkbox')).not.toBeChecked();
	await expect(p.getByTestId('kit-public-note')).toContainText('public computer');
	await pub.close();
	await ctx.close();
});

test('no PasswordCredential (Firefox, Safari): no dead "Save in password manager" button', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	await ctx.addInitScript(() => {
		delete (window as unknown as { PasswordCredential?: unknown }).PasswordCredential;
	});
	const page = await ctx.newPage();
	await fillSetup(page, 'firefox vault');
	await page.getByTestId('kit-checkbox').uncheck();
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });
	await expect(page.getByRole('button', { name: 'Save in password manager' })).toHaveCount(0);
	await ctx.close();
});

test('a typed note is not lost to a misclick on /setup/ or /new/', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	await page.goto(url('/setup/'));
	await page.getByLabel('Your secret').fill('half written');
	let asked = '';
	page.once('dialog', (d) => ((asked = d.message()), d.dismiss()));
	await page.locator('header a').first().click();
	await expect.poll(() => asked).toContain('not stored yet');
	await expect(page).toHaveURL(url('/setup/'));
	await expect(page.getByLabel('Your secret')).toHaveValue('half written');
	// made: the guard is gone
	await page.getByTestId('kit-checkbox').uncheck();
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });

	await nav(page, 'New');
	await page.getByLabel('Top secret contents').fill('also half written');
	asked = '';
	page.once('dialog', (d) => ((asked = d.message()), d.dismiss()));
	await page.locator('header a').first().click();
	await expect.poll(() => asked).toContain('not stored yet');
	await expect(page).toHaveURL(url('/new/'));
	await expect(page.getByLabel('Top secret contents')).toHaveValue('also half written');
	await ctx.close();
});
