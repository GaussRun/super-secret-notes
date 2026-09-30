// Replacing the stored vault keeps the old one aside in IndexedDB until the new one is in place:
// a create that fails right after the old files were cleared puts it back at once, and one that
// never finishes (tab closed, crash) is put back on the next page load, with a notice.
// The interruption uses a hook that only the test build has (VITE_OVERKILL_TEST_HOOKS).
import { test, expect, type Page } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors } from './helpers';

let fakes: Fakes;
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

/** Keys in one IndexedDB object store of the app. */
const idbKeys = (page: Page, store: 'blobs' | 'backup') =>
	page.evaluate(
		(s) =>
			new Promise<string[]>((resolve, reject) => {
				const req = indexedDB.open('overkill-notes');
				req.onerror = () => reject(req.error);
				req.onsuccess = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains(s)) return (db.close(), resolve([]));
					const r = db.transaction(s).objectStore(s).getAllKeys();
					r.onsuccess = () => (db.close(), resolve(r.result.map(String)));
					r.onerror = () => reject(r.error);
				};
			}),
		store
	);

async function startReplacement(page: Page, mode: 'throw' | 'hang') {
	await page.goto(url('/setup/'));
	await expect(page.getByTestId('replace-note')).toContainText('kept vault');
	await page.evaluate((m) => ((globalThis as { __ovkAfterClear?: string }).__ovkAfterClear = m), mode);
	await page.getByLabel('Vault name').fill('newer vault');
	await page.getByLabel('Your secret').fill('never stored');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
}

async function unlocks(page: Page, passphrase: string) {
	await page.goto(url('/unlock/'));
	await expect(page.getByLabel('Vault name')).toHaveValue('kept vault');
	await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(url('/notes/'), { timeout: 60_000 });
	await expect(page.getByTestId('notes-table')).toContainText('the kept note');
}

test('an interrupted replacement puts the old vault back: at once on failure, on the next load after a crash', async ({ browser }) => {
	test.setTimeout(180_000);
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	const errors = watchErrors(page);

	await page.goto(url('/setup/'));
	await page.getByLabel('Vault name').fill('kept vault');
	const pass = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	await page.getByLabel('Your secret').fill('keep me');
	await page.getByLabel(/^Note name/).fill('the kept note');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });

	// 1. the create throws right after clearing: the old vault is back, locked, and the backup is gone
	await startReplacement(page, 'throw');
	await expect(page.getByRole('alert')).toContainText('interrupted after clearing', { timeout: 60_000 });
	expect(await idbKeys(page, 'backup')).toEqual([]);
	await unlocks(page, pass);

	// 2. the create never finishes (the tab is closed mid-way): the backup is on disk, the next load restores it
	await startReplacement(page, 'hang');
	await expect.poll(() => idbKeys(page, 'blobs'), { timeout: 60_000 }).toEqual([]);
	expect(await idbKeys(page, 'backup')).toEqual(['previous-vault']);
	await page.goto(url('/'));
	await expect(page.getByTestId('restored-notice')).toContainText('kept vault');
	expect(await idbKeys(page, 'backup')).toEqual([]);
	await unlocks(page, pass);
	expect(errors).toEqual([]);
	await ctx.close();
});
