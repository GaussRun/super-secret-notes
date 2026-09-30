// The landing actions in each state of this browser: no vault (store a note in a new one), a
// stored locked vault (open it; a new vault is the smaller second action), an open vault (the next
// note). "Store note in new vault" always leads to the note-first setup, never to an unlock form.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors } from './helpers';

let fakes: Fakes;
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);

async function expectActions(page: Page, primary: [string, string], secondary: [string, string]) {
	const p = page.getByTestId('primary-cta');
	const s = page.getByTestId('secondary-cta');
	await expect(p).toHaveText(primary[0]);
	await expect(p).toHaveAttribute('href', url(primary[1]));
	await expect(s).toHaveText(secondary[0]);
	await expect(s).toHaveAttribute('href', url(secondary[1]));
	// the primary is the big green one; the secondary never is
	await expect(p).toHaveClass(/\bcta\b/);
	await expect(s).not.toHaveClass(/\bcta\b/);
	expect(await bg(s)).not.toBe(await bg(p));
	return { p, s };
}

test('landing: no vault, a stored locked vault, an open vault', async ({ browser }) => {
	test.setTimeout(180_000);
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	const errors = watchErrors(page);

	// 1. nothing stored
	await page.goto(url('/'));
	const none = await expectActions(page, ['Store note in new vault', '/setup/'], ['Open my vault', '/recover/']);
	const green = await bg(none.p);
	await expect(page.getByTestId('stored-vault-name')).toHaveCount(0);

	// make a vault
	await none.p.click();
	await expect(page).toHaveURL(url('/setup/'));
	await page.getByLabel('Vault name').fill('velvet-otter-harbor-lantern');
	await page.getByLabel('Your secret').fill('landing states');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });

	// 2. open: in-app back to the landing page (the brand link), the vault stays open
	await page.locator('header a').first().click();
	await expect(page).toHaveURL(url('/'));
	await expectActions(page, ['New note', '/new/'], ['My notes', '/notes/']);

	// 3. stored and locked (a reload locks it): open it is the big green action, with its name
	await page.goto(url('/'));
	const stored = await expectActions(page, ['Open my vault', '/unlock/'], ['Store note in new vault', '/setup/']);
	expect(await bg(stored.p)).toBe(green);
	await expect(page.getByTestId('stored-vault-name')).toHaveText('velvet-otter-harbor-lantern');
	for (const [w, h] of [[1280, 800], [375, 740]]) {
		await page.setViewportSize({ width: w, height: h });
		await expect(stored.p).toBeInViewport({ ratio: 1 });
		await expect(stored.s).toBeInViewport({ ratio: 1 });
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
		expect(overflow).toBeLessThanOrEqual(0);
		await page.screenshot({ path: `test-results/landing-stored-${w}.png` });
	}
	// "Store note in new vault" goes to the setup, never to an unlock form
	await stored.s.click();
	await expect(page).toHaveURL(url('/setup/'));
	await expect(page.getByTestId('replace-note')).toContainText('velvet-otter-harbor-lantern');
	await expect(page.getByTestId('setup-form')).toBeVisible();
	await expect(page.getByTestId('unlock-form')).toHaveCount(0);

	// the Locked form offers the same action, to the same place
	await page.goto(url('/new/'));
	await expect(page.getByTestId('unlock-form')).toBeVisible();
	await page.getByTestId('other-vault').getByRole('link', { name: 'Store note in new vault' }).click();
	await expect(page).toHaveURL(url('/setup/'));
	await expect(page.getByTestId('unlock-form')).toHaveCount(0);
	expect(errors).toEqual([]);
	await ctx.close();
});
