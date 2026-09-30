// The note page: publish only real changes, where the note lives (and where it was read from),
// a per-note check, the guard against leaving with unpublished changes; and Sign out.
import { test, expect, type Page } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, readNote, nav } from './helpers';

let fakes: Fakes;
let page: Page;
let passphrase = '';
const NOTE = 'recovery codes';
const TEXT = 'github: 1a2b-3c4d\nbank: 5e6f-7g8h';
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
	fakes = await startAllFakes();
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	page = await ctx.newPage();
	await page.goto(url('/setup/'));
	passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	await page.getByLabel(/^Note name/).fill(NOTE);
	await page.getByLabel('Your secret').fill(TEXT);
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });
});
test.afterAll(async () => {
	await page?.context().close();
	await fakes?.close();
});

test('clean: no publish button, a saved status, every host listed with the one it was read from', async () => {
	const errors = watchErrors(page);
	await expect(await readNote(page, NOTE)).toHaveValue(TEXT);
	await expect(page.getByTestId('publish')).toHaveCount(0);
	await expect(page.getByTestId('saved-status')).toContainText('Saved');
	const rows = page.getByTestId('note-hosts').locator('tbody tr');
	await expect(rows).toHaveCount(6);
	const source = (await page.getByTestId('note-source').textContent())!;
	const from = /Read from (\S+) in \d+\.\d s/.exec(source)![1];
	await expect(page.getByTestId(`host-${from}`).getByTestId('read-from')).toBeVisible();
	await expect(page.getByTestId('read-from')).toHaveCount(1);
	// full URLs, no truncation
	for (const u of fakes.hosts.privatebin) await expect(page.getByTestId('note-hosts')).toContainText(u);

	await page.getByTestId('check-note').click();
	await expect(page.getByTestId('note-hosts').locator('tbody td.ok')).toHaveCount(6);
	await expect(page.getByTestId('saved-status')).toContainText('Saved on 6/6 hosts');
	expect(errors).toEqual([]);
});

test('dirty: "Publish changes" appears after an edit, leaving asks first, and it goes away once published', async () => {
	const body = page.getByTestId('note-text');
	await body.fill(TEXT + '\nnew line');
	await expect(page.getByTestId('publish')).toHaveText('Publish changes');
	// typing it back makes it clean again
	await body.fill(TEXT);
	await expect(page.getByTestId('publish')).toHaveCount(0);
	await body.fill(TEXT + '\nnew line');

	let asked = '';
	page.once('dialog', (d) => {
		asked = d.message();
		void d.dismiss();
	});
	await page.getByRole('navigation').getByRole('link', { name: 'Notes', exact: true }).click();
	await expect.poll(() => asked).toContain('not published');
	await expect(page).toHaveURL(url(`/notes/${encodeURIComponent(NOTE)}/`));

	await page.getByTestId('publish').click();
	await expect(page.getByTestId('publish')).toHaveCount(0);
	await expect(page.getByTestId('saved-status')).toContainText('Saved on 6/6 hosts');
	await nav(page, 'Notes');
	await expect(await readNote(page, NOTE)).toHaveValue(TEXT + '\nnew line');
});

test('Sign out clears the keys: the unlock page asks for the passphrase, also after a reload', async () => {
	await page.getByTestId('sign-out').click();
	await expect(page).toHaveURL(url('/unlock/'));
	await expect(page.getByTestId('lock-status')).toContainText('LOCKED');
	await expect(page.getByTestId('lock-status').getByRole('link', { name: 'Recover' })).toBeVisible();
	await page.reload();
	await expect(page.getByTestId('unlock-form')).toBeVisible();
	await page.getByLabel('Passphrase').fill(passphrase);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(url('/notes/'));
	await expect(page.getByTestId('notes-table')).toContainText(NOTE);
});
