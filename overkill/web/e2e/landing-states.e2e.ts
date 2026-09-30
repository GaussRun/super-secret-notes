// The landing actions in each state of this browser: no vault (store a note in a new one), a
// stored locked vault (a new note in it: unlock, then /new/; "Open my vault" beside it; a new
// vault only as a small link), an open vault (the next note). "Store note in new vault" always
// leads to the note-first setup, never to an unlock form. ?next= only takes in-app pages.
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
	const pass = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	await page.getByLabel('Your secret').fill('landing states');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });

	// 2. open: in-app back to the landing page (the brand link), the vault stays open
	await page.locator('header a').first().click();
	await expect(page).toHaveURL(url('/'));
	await expectActions(page, ['New note', '/new/'], ['My notes', '/notes/']);

	// 3. stored and locked (a reload locks it): a new note in it is the big green action, with its name
	await page.goto(url('/'));
	const stored = await expectActions(page, ['New note in my vault', '/unlock/?next=%2Fnew%2F'], ['Open my vault', '/unlock/']);
	expect(await bg(stored.p)).toBe(green);
	await expect(stored.s).toHaveClass(/\bbutton\b/); // a regular button, not a link, not green
	await expect(page.getByTestId('stored-vault-name')).toHaveText('velvet-otter-harbor-lantern');
	const newVault = page.getByTestId('new-vault-link');
	await expect(newVault).toHaveText('Store note in new vault');
	await expect(newVault).toHaveAttribute('href', url('/setup/'));
	await expect(newVault).not.toHaveClass(/\bbutton\b/);
	for (const [w, h] of [[1280, 800], [375, 740]]) {
		await page.setViewportSize({ width: w, height: h });
		for (const l of [stored.p, stored.s, newVault]) await expect(l).toBeInViewport({ ratio: 1 });
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
		expect(overflow).toBeLessThanOrEqual(0);
		await page.screenshot({ path: `test-results/landing-stored-${w}.png` });
	}
	await page.setViewportSize({ width: 1280, height: 800 });
	// the primary: unlock, then straight to a new note
	await stored.p.click();
	await expect(page).toHaveURL(url('/unlock/?next=%2Fnew%2F'));
	await page.getByLabel('Passphrase', { exact: true }).fill(pass);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(url('/new/'), { timeout: 60_000 });
	await expect(page.getByLabel('Top secret contents')).toBeVisible();
	// "Open my vault": unlock, then the notes
	await page.goto(url('/'));
	await page.getByTestId('secondary-cta').click();
	await expect(page).toHaveURL(url('/unlock/'));
	await page.getByLabel('Passphrase', { exact: true }).fill(pass);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(url('/notes/'), { timeout: 60_000 });
	// ?next= is never an open redirect: anything but an allowed in-app page goes to the notes
	for (const bad of ['https://evil.example/', '//evil.example/', '/unlock/', 'javascript:alert(1)', '/new/../../x']) {
		await page.goto(url(`/unlock/?next=${encodeURIComponent(bad)}`));
		await page.getByLabel('Passphrase', { exact: true }).fill(pass);
		await page.getByRole('button', { name: 'Unlock' }).click();
		await expect(page).toHaveURL(url('/notes/'), { timeout: 60_000 });
	}
	// "Store note in new vault" goes to the setup, never to an unlock form
	await page.goto(url('/'));
	await page.getByTestId('new-vault-link').click();
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
