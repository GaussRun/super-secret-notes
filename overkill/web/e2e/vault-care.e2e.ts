// Keeping a vault alive: the vault name shown large where it matters (it is half of what opens the
// vault), a calendar reminder to check it every 3 months (the vault link, never the passphrase),
// and a quiet banner once the last full check is older than 30 days, which checks and restores.
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, nav, ORIGIN } from './helpers';

let fakes: Fakes;
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

const NAME = 'care vault';
const SENTENCE = 'You need this name AND your passphrase to open the vault anywhere. Your password manager saves both.';

async function setup(page: Page) {
	await page.goto(url('/setup/'));
	await page.getByLabel('Vault name', { exact: true }).fill(NAME);
	const passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	await page.getByLabel('Your secret').fill('keep me alive');
	await page.getByTestId('kit-checkbox').uncheck();
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });
	return passphrase;
}

test('the vault name, large, on the setup result and Vault access; the 3-month reminder holds no passphrase', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	const errors = watchErrors(page);
	const passphrase = await setup(page);
	const id = page.getByTestId('vault-identity');
	await expect(id.getByTestId('vault-identity-name')).toHaveText(NAME);
	await expect(id).toContainText(SENTENCE);
	const size = await id.getByTestId('vault-identity-name').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
	expect(size).toBeGreaterThanOrEqual(22);
	// the name is the username the password manager stores
	await expect(page.locator('#vault-name')).toHaveAttribute('autocomplete', 'username');
	await expect(page.locator('#vault-name')).toHaveValue(NAME);

	const downloading = page.waitForEvent('download');
	await id.getByTestId('reminder').click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(`super-secret-notes-check-${NAME}.ics`);
	const ics = (await readFile((await download.path())!, 'utf8')).replace(/\r\n /g, '');
	expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
	expect(ics).toContain('RRULE:FREQ=MONTHLY;INTERVAL=3');
	expect(ics).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
	const vaultLink = `${ORIGIN}${url('/recover/')}#v=${encodeURIComponent(NAME)}`;
	expect(ics).toContain(`URL:${vaultLink}`);
	expect(ics).not.toContain('p=');
	for (const f of [passphrase, encodeURIComponent(passphrase), passphrase.replace(/ /g, '\\ ')]) expect(ics).not.toContain(f);
	// the first one is about 3 months from now
	const start = /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(ics)!;
	const days = (Date.UTC(+start[1], +start[2] - 1, +start[3]) - Date.now()) / 86_400_000;
	expect(days).toBeGreaterThan(85);
	expect(days).toBeLessThan(95);

	await nav(page, 'Kit');
	await expect(page.getByTestId('vault-identity-name')).toHaveText(NAME);
	await expect(page.getByTestId('vault-identity')).toContainText(SENTENCE);
	await expect(page.getByTestId('vault-identity').getByTestId('reminder')).toBeVisible();
	expect(errors).toEqual([]);
	await ctx.close();
});

test('a quiet banner once the last full check is over 30 days old; Check now checks and restores', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	const passphrase = await setup(page);
	await expect(page.getByTestId('health-banner')).toHaveCount(0);

	// 31 days later (the page's clock), and one copy has gone missing meanwhile
	await page.clock.setFixedTime(new Date(Date.now() + 31 * 86_400_000));
	for (const pb of fakes.pb) pb.pastes.clear();
	await page.goto(url('/unlock/'));
	await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
	await page.getByRole('button', { name: 'Unlock' }).click();
	const banner = page.getByTestId('health-banner');
	await expect(banner).toContainText(/Last full check 3[01] days ago: Check now/, { timeout: 60_000 });
	await expect(banner).toHaveClass(/\bmuted\b/);
	await banner.getByTestId('health-check-now').click();
	await expect(banner).toContainText(/Checked; \d+ (copy|copies) restored/, { timeout: 90_000 });
	expect(fakes.pb.every((p) => p.pastes.size > 0)).toBe(true);
	// just checked: no banner after the next unlock
	await page.goto(url('/unlock/'));
	await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(url('/notes/'), { timeout: 60_000 });
	await expect(page.getByTestId('health-banner')).toHaveCount(0);
	await ctx.close();
});
