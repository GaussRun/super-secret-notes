// The note-first setup: one click makes the vault (made-up name and passphrase), puts it on the
// hosts, stores the note and publishes the recovery record; a fresh browser recovers it by name.
import { test, expect } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, recoverByName, readNote, expectNoLeak, WORDLIST } from './helpers';

let fakes: Fakes;
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

test('write a note, one click: vault, hosts, note, recovery record; then recover it elsewhere', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	const errors = watchErrors(page);
	await page.goto(url('/setup/'));
	const vaultName = await page.getByLabel('Vault name').inputValue();
	const passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	expect(vaultName.split('-').every((w) => WORDLIST.has(w))).toBe(true);
	await page.getByLabel('Your secret').fill('the spare key is under the third flowerpot');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();

	const done = page.getByTestId('setup-done');
	await expect(done).toContainText('"my first secret" is on 6 of 6 hosts', { timeout: 90_000 });
	await expect(page.getByTestId('done-name')).toHaveText(vaultName);
	await expect(page.getByTestId('save-step')).toContainText('Save these in your password manager');
	await expect(page.getByTestId('save-step').getByRole('button', { name: /password manager/ })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Print the kit' })).toBeVisible();
	await expect(page.getByTestId('send-to-phone')).toBeVisible();
	await expectNoLeak(page, passphrase);
	for (const r of fakes.relays) {
		const tags = [...r.store.values()].map((e) => e.tags.find((t) => t[0] === 'd')?.[1]);
		expect(tags).toContain('overkill-discovery/bootstrap.json');
	}
	await done.getByRole('link', { name: 'Open the note' }).click();
	await expect(page.getByTestId('note-text')).toHaveValue('the spare key is under the third flowerpot');
	expect(errors).toEqual([]);
	await ctx.close();

	const phone = await browser.newContext();
	await useFakes(phone, fakes);
	const p = await phone.newPage();
	await recoverByName(p, vaultName, passphrase);
	await expect(await readNote(p, 'my first secret')).toHaveValue('the spare key is under the third flowerpot');
	await phone.close();
});

test('an empty note is refused; the skip path makes just the vault', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	await page.goto(url('/setup/'));
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByRole('alert')).toContainText('Write something first');
	await page.getByRole('button', { name: 'Skip, just create the vault' }).click();
	await expect(page.getByTestId('setup-done')).toContainText('Your vault is on 6 of 6 hosts', { timeout: 90_000 });
	await ctx.close();
});
