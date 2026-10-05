// The note-first setup: one click makes the vault (made-up name and passphrase), puts it on the
// hosts, stores the note and publishes the recovery record; a fresh browser recovers it by name.
import { test, expect } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, recoverByName, readNote, expectNoLeak, nav, WORDLIST } from './helpers';
import { discoveryIdentity } from '../../cli/src/bootstrap.js';
import { deriveDiscoveryTags } from '../../cli/src/crypto.js';

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
	const noteName = await page.getByLabel(/^Note name/).inputValue();
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();

	const done = page.getByTestId('setup-done');
	await expect(done).toContainText(`"${noteName}" is on 6 of 6 hosts`, { timeout: 90_000 });
	await expect(page.getByTestId('done-name')).toHaveText(vaultName);
	await expect(page.getByTestId('save-step')).toContainText('Save these in your password manager');
	await expect(page.getByTestId('save-step').getByRole('button', { name: /password manager/ })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Print the kit' })).toBeVisible();
	await expect(page.getByTestId('share-vault')).toBeVisible();
	await expectNoLeak(page, passphrase);
	// the recovery record under the vault's own d tags (format history 17)
	const own = await deriveDiscoveryTags((await discoveryIdentity(passphrase, vaultName)).secret);
	for (const r of fakes.relays) {
		const tags = [...r.store.values()].map((e) => e.tags.find((t) => t[0] === 'd')?.[1]);
		expect(tags).toEqual(expect.arrayContaining([own['vault.age'], own['bootstrap.json']]));
	}
	await done.getByRole('link', { name: 'Open the note' }).click();
	await expect(page.getByTestId('note-text')).toHaveValue('the spare key is under the third flowerpot');
	expect(errors).toEqual([]);
	await ctx.close();

	const phone = await browser.newContext();
	await useFakes(phone, fakes);
	const p = await phone.newPage();
	await recoverByName(p, vaultName, passphrase);
	await expect(await readNote(p, noteName)).toHaveValue('the spare key is under the third flowerpot');
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

test('note names: an empty one gets a made-up name; two notes in a row never share one', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	await page.goto(url('/setup/'));
	await page.getByLabel('Your secret').fill('first');
	await page.getByLabel(/^Note name/).fill('');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	const done = page.getByTestId('setup-done');
	await expect(done).toContainText('is on 6 of 6 hosts', { timeout: 90_000 });
	const first = /"([^"]+)" is on/.exec((await done.textContent())!)![1];
	expect(first.split('-')).toHaveLength(3);
	for (const w of first.split('-')) expect(WORDLIST.has(w)).toBe(true);

	// the next note, name left as offered
	await nav(page, 'New');
	const name = page.getByLabel(/^Name \(optional/);
	const offered = await name.inputValue();
	expect(offered.split('-')).toHaveLength(3);
	expect(await page.evaluate(() => [...document.querySelectorAll('#note-text, #note-name')].map((e) => e.id))).toEqual(['note-text', 'note-name']);
	await page.getByLabel('Top secret contents').fill('second');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('saved')).toContainText(`Saved "${offered}"`);
	expect(offered).not.toBe(first);

	// and a cleared name on /new/ gets one too
	await nav(page, 'New');
	await page.getByLabel('Top secret contents').fill('third');
	await page.getByLabel(/^Name \(optional/).fill('');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	const saved = page.getByTestId('saved');
	await expect(saved).toContainText('Saved "');
	// the line may still show the second save for a moment; wait for this one
	await expect(saved).not.toContainText(`Saved "${offered}"`);
	const third = /Saved "([^"]+)"/.exec((await saved.textContent())!)![1];
	expect(third.split('-')).toHaveLength(3);
	expect(new Set([first, offered, third]).size).toBe(3);
	await ctx.close();
});

test('the setup page focuses the note box, but never takes focus from a field someone is already in', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	// a slow frame: the page's own focus call comes after the user has started typing
	await ctx.addInitScript(() => {
		window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 400) as unknown as number;
	});
	const page = await ctx.newPage();
	await page.goto(url('/setup/'));
	const name = page.getByLabel('Vault name');
	await name.fill('typed right away');
	await page.waitForTimeout(800);
	await expect(name).toBeFocused();
	await expect(name).toHaveValue('typed right away');
	await expect(page.getByLabel('Your secret')).toHaveValue('');
	// with nothing focused, the note box gets it
	await page.goto(url('/setup/'));
	await expect(page.getByLabel('Your secret')).toBeFocused();
	await ctx.close();
});
