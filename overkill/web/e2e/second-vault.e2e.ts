// A second vault in a browser that already holds one, locked: the landing page and the locked
// pages offer "Make a new vault instead", the new vault takes the old one's place only once it
// is made, the notes stay apart, and the first vault comes back by name + passphrase. A failed
// recovery leaves the vault that was there.
import { test, expect } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, recoverByName, readNote, nav } from './helpers';

let fakes: Fakes;
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

test('a second vault while one is stored and locked; notes stay apart; the first comes back', async ({ browser }) => {
	test.setTimeout(240_000);
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	const errors = watchErrors(page);

	// vault one, with a note, typed name (the field is plainly editable)
	await page.goto(url('/setup/'));
	const name1 = page.getByLabel('Vault name');
	await expect(name1).not.toHaveAttribute('readonly', '');
	await name1.fill('vault one');
	const pass1 = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	await page.getByLabel('Your secret').fill('first vault secret');
	await page.getByLabel(/^Note name/).fill('my first secret');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toContainText('"my first secret" is on', { timeout: 90_000 });

	// a reload locks it; the landing action leads to unlock-or-new, both visible
	await page.goto(url('/'));
	await page.getByTestId('primary-cta').click();
	await expect(page).toHaveURL(url('/unlock/'));
	await expect(page.getByTestId('unlock-form')).toBeVisible();
	await expect(page.getByLabel('Vault name')).toHaveValue('vault one');
	await expect(page.getByTestId('other-vault').getByRole('link', { name: 'Make a new vault instead' })).toBeVisible();
	await page.screenshot({ path: 'test-results/second-vault-unlock-or-new.png', fullPage: true });

	// /new/ with a locked vault: same choice, no dead end
	await page.goto(url('/new/'));
	await expect(page.getByTestId('unlock-form')).toBeVisible();
	await page.getByTestId('other-vault').getByRole('link', { name: 'Make a new vault instead' }).click();
	await expect(page).toHaveURL(url('/setup/'));
	await expect(page.getByTestId('replace-note')).toContainText('vault one');
	await page.screenshot({ path: 'test-results/second-vault-setup-replace.png', fullPage: true });

	// vault two: the name is edited directly, the passphrase stays read-only until "change passphrase"
	const name2 = page.getByLabel('Vault name');
	await expect(name2).not.toHaveAttribute('readonly', '');
	await name2.fill('vault two');
	await expect(name2).toHaveValue('vault two');
	await expect(page.getByLabel('Passphrase', { exact: true })).toHaveAttribute('readonly', '');
	const pass2 = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	expect(pass2).not.toBe(pass1);
	await page.getByLabel(/^Note name/).fill('second note');
	await page.getByLabel('Your secret').fill('second vault secret');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toContainText('"second note" is on', { timeout: 90_000 });
	await expect(page.getByTestId('done-name')).toHaveText('vault two');

	// separate notes
	await expect(await readNote(page, 'second note')).toHaveValue('second vault secret');
	await nav(page, 'Notes');
	await expect(page.getByTestId('notes-table')).toContainText('second note');
	await expect(page.getByTestId('notes-table')).not.toContainText('my first secret');

	// this browser now opens vault two
	await page.goto(url('/unlock/'));
	await expect(page.getByLabel('Vault name')).toHaveValue('vault two');

	// a failed recovery (wrong passphrase) leaves vault two in place
	await page.goto(url('/recover/'));
	await expect(page.getByTestId('replace-note')).toContainText('vault two');
	await page.getByLabel('Vault name').fill('vault one');
	await page.getByLabel('Passphrase', { exact: true }).fill(pass2);
	await page.getByRole('button', { name: 'Recover' }).click();
	await expect(page.getByRole('alert')).toBeVisible({ timeout: 90_000 });
	await page.goto(url('/unlock/'));
	await expect(page.getByLabel('Vault name')).toHaveValue('vault two');
	await page.getByLabel('Passphrase', { exact: true }).fill(pass2);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(url('/notes/'), { timeout: 60_000 });
	await expect(page.getByTestId('notes-table')).toContainText('second note');

	// vault one comes back by name + passphrase, with its own note only
	await recoverByName(page, 'vault one', pass1);
	await expect(await readNote(page, 'my first secret')).toHaveValue('first vault secret');
	await nav(page, 'Notes');
	await expect(page.getByTestId('notes-table')).toContainText('my first secret');
	await expect(page.getByTestId('notes-table')).not.toContainText('second note');

	// and after a reload it unlocks with its own passphrase
	await page.goto(url('/unlock/'));
	await expect(page.getByLabel('Vault name')).toHaveValue('vault one');
	await page.getByLabel('Passphrase', { exact: true }).fill(pass1);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(url('/notes/'), { timeout: 60_000 });
	await expect(page.getByTestId('notes-table')).toContainText('my first secret');
	expect(errors).toEqual([]);
	await ctx.close();
});
