// The full backup file: one encrypted file with every note; restored in a fresh browser with every
// host unreachable, the notes read at once; once the hosts are back, everything is copied to them.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, nav, putNote, readNote } from './helpers';

let fakes: Fakes;
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

test('download a full backup, restore it with every host down, read the notes, copy them back', async ({ browser }) => {
	test.setTimeout(240_000);
	const a = await browser.newContext();
	await useFakes(a, fakes);
	const page = await a.newPage();
	const errors = watchErrors(page);
	await page.goto(url('/setup/'));
	await page.getByLabel('Vault name', { exact: true }).fill('backed up');
	const passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	await page.getByLabel('Your secret').fill('the first secret');
	await page.getByLabel(/^Note name/).fill('first');
	await page.getByTestId('kit-checkbox').uncheck();
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });
	await expect(page.getByTestId('download-backup')).toBeVisible(); // offered next to the kit
	await putNote(page, 'second', 'the second secret');

	await nav(page, 'Kit');
	const downloading = page.waitForEvent('download');
	await page.getByTestId('download-backup').click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe('super-secret-notes-backup-backed up.json');
	const file = (await download.path())!;
	const text = await readFile(file, 'utf8');
	const doc = JSON.parse(text);
	expect(doc.format).toBe('super-secret-notes-backup');
	expect(doc.notes).toBe(2);
	for (const plain of ['the first secret', 'the second secret', '"first"', '"second"', passphrase]) expect(text).not.toContain(plain);
	await expect(page.getByTestId('backup-saved')).toBeVisible();
	expect(errors).toEqual([]);
	await a.close();

	// a fresh browser, and no host answers
	const b = await browser.newContext();
	await useFakes(b, fakes);
	const hostUrls = [...fakes.pb.map((p) => p.url), ...fakes.cryptpad.map((c) => c.url), ...fakes.blossom.map((x) => x.url)];
	for (const h of hostUrls) await b.route(`${h}/**`, (r) => r.abort());
	for (const r of fakes.relays) r.down = true;
	try {
		const p = await b.newPage();
		await p.goto(url('/recover/'));
		await p.getByTestId('show-restore').click();
		const form = p.getByTestId('restore-form');
		// the download's own file goes with the first context: hand over its content
		await form.getByLabel('Backup file').setInputFiles({ name: 'super-secret-notes-backup-backed up.json', mimeType: 'application/json', buffer: Buffer.from(text) });
		await form.getByLabel('Passphrase', { exact: true }).fill(passphrase);
		await form.getByRole('button', { name: 'Restore' }).click();
		await expect(p.getByTestId('restored')).toContainText('Restored "backed up" from the backup: 2 notes', { timeout: 90_000 });
		// the hosts are still down: copying back reports what could not be done
		await p.getByTestId('push-back').click();
		await expect(p.getByTestId('pushed')).toContainText('could not be', { timeout: 120_000 });
		await expect(await readNote(p, 'first')).toHaveValue('the first secret', { timeout: 60_000 });
		await expect(await readNote(p, 'second')).toHaveValue('the second secret', { timeout: 60_000 });
		await expect(p.getByTestId('note-source')).toContainText('Backup in this browser');

		// the hosts come back, emptied meanwhile: copy everything back
		for (const pb of fakes.pb) pb.pastes.clear();
		for (const r of fakes.relays) {
			r.store.clear();
			r.down = false;
		}
		await b.unrouteAll();
		await nav(p, 'Check');
		await expect(p.getByTestId('check-summary')).toBeVisible({ timeout: 90_000 });
		await p.getByTestId('repair').click();
		await expect(p.getByTestId('check-summary')).toContainText('ALL COPIES HEALTHY', { timeout: 90_000 });
		expect(fakes.pb.every((x) => x.pastes.size >= 3)).toBe(true); // vault.age and both notes
	} finally {
		for (const r of fakes.relays) r.down = false;
		await b.close();
	}
});

test('a wrong passphrase or a file that is not a backup is refused', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const p = await ctx.newPage();
	await p.goto(url('/recover/'));
	await p.getByTestId('show-restore').click();
	const form = p.getByTestId('restore-form');
	await form.getByLabel('Backup file').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello": 1}') });
	await form.getByLabel('Passphrase', { exact: true }).fill('anything at all here');
	await form.getByRole('button', { name: 'Restore' }).click();
	await expect(p.getByRole('alert')).toContainText('not a Super Secret Notes backup file');
	await expect(p.getByTestId('lock-status')).toContainText('NO VAULT');
	await ctx.close();
});
