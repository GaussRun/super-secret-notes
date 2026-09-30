// The note page: publish only real changes, where the note lives (and where it was read from),
// a per-note check, the guard against leaving with unpublished changes; and Sign out.
import { test, expect, type Page } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, readNote, nav, openMenu } from './helpers';

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
	// collapsed into one line; expanding shows the table
	const lives = page.getByTestId('note-lives');
	await expect(lives).not.toHaveAttribute('open', '');
	await expect(page.getByTestId('note-hosts')).toBeHidden();
	await lives.locator('summary').click();
	const rows = page.getByTestId('note-hosts').locator('tbody tr');
	await expect(rows).toHaveCount(6);
	const from = (await page.getByTestId('note-source').getAttribute('data-backend'))!;
	await expect(page.getByTestId('note-source')).toContainText(/Read from (PrivateBin|CryptPad|Nostr relay|Blossom) \(http/);
	const fromRow = page.getByTestId(`host-${from}`);
	await expect(fromRow.getByTestId('read-from')).toBeVisible();
	await expect(page.getByTestId('read-from')).toHaveCount(1);
	// the copy it was just read from is verified: OK, just now (the ledger records reads)
	await expect(fromRow.locator('td').nth(2)).toHaveText('OK');
	await expect(fromRow.locator('td').nth(3)).toHaveText('just now');
	// Type and Where: product names and base URLs as links, no internal names, no paste keys
	const table = page.getByTestId('note-hosts');
	for (const u of fakes.hosts.privatebin) {
		const link = table.locator(`a[href="${u}"]`);
		await expect(link).toHaveText(u);
		await expect(link).toHaveAttribute('target', '_blank');
		await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
	}
	await expect(table).toContainText('PrivateBin');
	await expect(table).toContainText('Nostr relay');
	expect(await table.innerText()).not.toMatch(/\b(pb|cp|nostr|blossom)-\d|#/);
	expect(await page.getByTestId('note-source').innerText()).not.toMatch(/\b(pb|cp|nostr|blossom)-\d/);

	await page.getByTestId('check-note').click();
	await expect(page.getByTestId('note-hosts').locator('tbody td.ok')).toHaveCount(6);
	await expect(page.getByTestId('saved-status')).toContainText('Saved on 6/6 hosts');
	await expect(page.getByTestId('lives-summary')).toHaveText(/^Stored on 6 of 6 hosts, all OK, checked \d\d:\d\d UTC$/);
	await expect(page.getByTestId('lives-summary')).toHaveClass(/\bok\b/);
	await page.screenshot({ path: 'test-results/note-lives.png', fullPage: true });
	expect(errors).toEqual([]);
});

test('a missing copy: the summary says how many need repair, in the warning color', async () => {
	// one PrivateBin instance loses its pastes
	fakes.pb[0].pastes.clear();
	await page.getByTestId('check-note').click();
	await expect(page.getByTestId('lives-summary')).toHaveText(/^5 of 6 OK, 1 need repair, checked \d\d:\d\d UTC$/, { timeout: 30_000 });
	await expect(page.getByTestId('lives-summary')).toHaveClass(/\bwarn\b/);
});

test('View raw copy: exactly what each host stores, nothing decrypted, keys only in the external links', async () => {
	const secretLines = TEXT.split('\n');
	const table = page.getByTestId('note-hosts');
	const names = await table.locator('tbody tr[data-backend]').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.backend!));
	const seen = new Set<string>();
	for (const n of names) {
		const row = page.getByTestId(`host-${n}`);
		const type = await row.locator('.host-type').innerText();
		await page.getByTestId(`raw-${n}`).click();
		const view = page.getByTestId(`raw-view-${n}`);
		// pb[0] lost its copy above
		if (n === 'pb-127' && fakes.pb[0].pastes.size === 0) {
			await expect(view).toContainText(/no copy|does not exist/i);
			await page.getByTestId(`raw-${n}`).click();
			continue;
		}
		const text = await view.getByTestId('raw-text').innerText();
		expect(text.length).toBeGreaterThan(40);
		for (const l of secretLines) expect(text).not.toContain(l);
		if (/PrivateBin/.test(type)) {
			const paste = JSON.parse(text);
			expect(paste.ct).toBeTruthy();
			expect(paste.adata).toBeTruthy();
			const link = view.getByTestId('raw-link');
			await expect(link).toHaveText('Open in PrivateBin');
			await expect(link).toHaveAttribute('href', /\?[0-9a-f]+#\w+/);
			await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
			await expect(link).toHaveAttribute('target', '_blank');
			if (!seen.has('privatebin')) await page.screenshot({ path: 'test-results/note-raw-privatebin.png', fullPage: true });
			seen.add('privatebin');
		} else if (/Nostr/.test(type)) {
			const events = JSON.parse(text);
			expect(events.length).toBeGreaterThan(0);
			for (const ev of events) {
				expect(ev.kind).toBe(30078);
				expect(ev.sig).toMatch(/^[0-9a-f]{128}$/);
				expect(ev.tags[0][0]).toBe('d');
			}
			await expect(view.getByTestId('raw-link')).toHaveCount(0);
			seen.add('nostr');
		} else if (/CryptPad/.test(type)) {
			const pad = JSON.parse(text);
			expect(typeof pad.content).toBe('string');
			await expect(view.getByTestId('raw-link')).toHaveText('Open in CryptPad');
			seen.add('cryptpad');
		} else if (/Blossom/.test(type)) {
			expect(text).toMatch(/^[A-Za-z0-9+/=]+$/);
			seen.add('blossom');
		}
		await page.getByTestId(`raw-${n}`).click();
		await expect(view).toHaveCount(0);
	}
	expect([...seen].sort()).toEqual(['blossom', 'cryptpad', 'nostr', 'privatebin']);
	// our page never sent a paste key: fragments stay in the external links
	for (const pb of fakes.pb) for (const r of pb.requests) expect(r).not.toContain('#');
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
	await openMenu(page);
	await page.locator('#site-menu').getByRole('link', { name: 'My notes', exact: true }).click();
	await expect.poll(() => asked).toContain('not published');
	await expect(page).toHaveURL(url(`/notes/${encodeURIComponent(NOTE)}/`));

	await page.getByTestId('publish').click();
	await expect(page.getByTestId('publish')).toHaveCount(0);
	await expect(page.getByTestId('saved-status')).toContainText('Saved on 6/6 hosts');
	await nav(page, 'Notes');
	await expect(await readNote(page, NOTE)).toHaveValue(TEXT + '\nnew line');
});

test('Sign out clears the keys: the unlock page asks for the passphrase, also after a reload', async () => {
	await openMenu(page);
	await page.getByTestId('sign-out').click();
	await expect(page).toHaveURL(url('/unlock/'));
	await expect(page.getByTestId('lock-status')).toContainText('LOCKED');
	await openMenu(page);
	await expect(page.getByTestId('lock-status').getByRole('link', { name: 'Recover' })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.reload();
	await expect(page.getByTestId('unlock-form')).toBeVisible();
	await page.getByLabel('Passphrase').fill(passphrase);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(url('/notes/'));
	await expect(page.getByTestId('notes-table')).toContainText(NOTE);
});
