// The whole web flow against in-process fake hosts: setup, new note, list, open, check with a
// corrupted copy flagged, repair, reload + unlock, and recover by name in a fresh browser.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { startFakeCryptpad } from './fake-cryptpad';
import { url, useFakes, watchErrors, setupVault, putNote, recoverByName, readNote, nav, expectNoLeak, WORDLIST } from './helpers';

let fakes: Fakes;
let context: BrowserContext;
let page: Page;
let errors: string[];
let passphrase = '';
const VAULT = 'e2e Einkäufe';
const NOTE = 'Einkaufsliste für Oma';
const TEXT = 'milk, eggs, 3x more encryption\nline two';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	fakes = await startAllFakes();
	context = await browser.newContext();
	await useFakes(context, fakes);
	page = await context.newPage();
	errors = watchErrors(page);
});

test.afterAll(async () => {
	await context?.close();
	await fakes?.close();
});

test.afterEach(() => {
	expect(errors, 'no CSP violations or page errors').toEqual([]);
});

test('setup form: note first, made-up 4-word vault name, password-manager fields', async () => {
	await page.goto(url('/setup/'));
	const form = page.getByTestId('setup-form');
	await expect(form).toHaveAttribute('method', 'post');
	await expect(form).toHaveAttribute('action', '#');
	await expect(page.getByLabel('Your secret')).toBeFocused();
	await expect(page.getByLabel(/^Note name/)).toHaveValue('my first secret');
	const user = form.getByLabel('Vault name');
	await expect(user).toHaveAttribute('name', 'username');
	await expect(user).toHaveAttribute('autocomplete', 'username');
	await expect(user).toHaveAttribute('readonly', '');
	const words = (await user.inputValue()).split('-');
	expect(words).toHaveLength(4);
	for (const w of words) expect(WORDLIST.has(w), `${w} is an EFF list word`).toBe(true);
	const pass = form.getByLabel('Passphrase', { exact: true });
	await expect(pass).toHaveAttribute('name', 'password');
	await expect(pass).toHaveAttribute('type', 'password');
	await expect(pass).toHaveAttribute('autocomplete', 'new-password');
	expect((await pass.inputValue()).split(' ')).toHaveLength(6);
	const before = await user.inputValue();
	await form.getByRole('button', { name: 'Roll new words' }).click();
	expect(await user.inputValue()).not.toBe(before);
	await form.getByRole('button', { name: 'change', exact: true }).click();
	await expect(user).not.toHaveAttribute('readonly', '');
	await user.fill(VAULT);
	await expect(user).toHaveValue(VAULT);
	await form.getByRole('button', { name: 'Show' }).click();
	await expect(pass).toHaveAttribute('type', 'text');
	await expect(form.getByRole('button', { name: 'Encrypt and scatter' })).toHaveAttribute('type', 'submit');
	await expect(form.getByRole('button', { name: 'Skip, just create the vault' })).toHaveAttribute('type', 'submit');
	await expect(form).toContainText('Your password manager can save this. Also keep the kit.');
});

test('setup: generated passphrase, vault.age on every host, the kit, the recovery record', async () => {
	const before = await page.evaluate(() => history.length);
	passphrase = await setupVault(page, VAULT);
	// the form submitted in JS: no request carried it, nothing in the URL or history
	const seen = await expectNoLeak(page, passphrase);
	expect(seen.length).toBeLessThanOrEqual(before + 1); // only the in-app move to /recovery-kit/
	const kit = (await page.getByTestId('kit').textContent())!;
	expect(kit).toContain(`passphrase:   ${passphrase}`);
	expect(kit).toMatch(/age identity: AGE-SECRET-KEY-1[0-9A-Z]+/);
	for (const pb of fakes.pb) expect(pb.pastes.size).toBe(1); // vault.age
	expect(fakes.blossom[0].blobs.size).toBe(1);
	// the derived CryptPad account, registered through form posts (no preflight)
	expect(fakes.cryptpad[0].blocks.size).toBe(1);
	expect(fakes.cryptpad[0].authRequests.every((t) => t.startsWith('application/x-www-form-urlencoded'))).toBe(true);
	await expect(page.getByTestId('kit')).toContainText('(password derived from master)');
	for (const r of fakes.relays) {
		const tags = [...r.store.values()].map((e) => e.tags.find((t) => t[0] === 'd')?.[1]);
		expect(tags).toEqual(expect.arrayContaining(['overkill/vault.age', 'overkill/index.ovk', 'overkill-discovery/vault.age', 'overkill-discovery/bootstrap.json']));
	}
	// PrivateBin only ever saw CORS simple requests that it answered as JSON
	expect(fakes.pb[0].requests.filter((r) => r.startsWith('OPTIONS'))).toEqual([]);
});

test('new note, list, open', async () => {
	await putNote(page, NOTE, TEXT);
	await expect(page.getByTestId('saved')).toContainText('to 6/6 hosts');
	await expect(await readNote(page, NOTE)).toHaveValue(TEXT);
	await expect(page.getByTestId('note-source')).toContainText('both layers and the sha256 verified');
});

test('check flags a corrupted copy, repair fixes it', async () => {
	await nav(page, 'Check');
	await expect(page.getByTestId('check-summary')).toContainText('ALL COPIES HEALTHY');
	await expect(page.getByTestId('check-summary')).toContainText('15/15 copies healthy');

	// flip the ciphertext of the note's paste on the first PrivateBin instance
	const [id, paste] = [...fakes.pb[0].pastes].at(-1)!;
	const ct = Buffer.from(paste.ct, 'base64');
	ct[ct.length >> 1] ^= 0x42;
	fakes.pb[0].pastes.set(id, { ...paste, ct: ct.toString('base64') });

	await page.getByRole('button', { name: 'Run full check' }).click();
	await expect(page.getByTestId('check-summary')).toContainText('DAMAGE DETECTED');
	await expect(page.getByTestId('check-summary')).toContainText('14/15 copies healthy');
	const bad = page.getByTestId(`row-${NOTE}`).locator('td.bad');
	await expect(bad).toHaveCount(1);
	await expect(bad).toContainText('CORRUPT');

	await page.getByTestId('repair').click();
	await expect(page.getByTestId('repaired')).toContainText(`repaired ${NOTE} on`);
	await expect(page.getByTestId('check-summary')).toContainText('ALL COPIES HEALTHY');
	// the damaged paste was replaced; the old one was deleted with its token
	expect(fakes.pb[0].pastes.has(id)).toBe(false);
	// nothing is due yet: fresh Nostr and Blossom copies count as good for 120 days
	await page.getByTestId('refresh').click();
	await expect(page.getByTestId('repaired')).toContainText('Nothing needed doing.');
	await expect(page.getByTestId('check-summary')).toContainText('ALL COPIES HEALTHY');
});

test('status reads the ledger offline', async () => {
	await nav(page, 'Status');
	await expect(page.getByTestId('status-table')).toContainText('pb-127');
	const table = page.getByTestId('status-table');
	await expect(table.locator('tr', { hasText: 'pb-127' }).first()).toContainText('never (host-confirmed)');
	await expect(table.locator('tr', { hasText: 'nostr-127' }).first()).toContainText(/none promised; republish by \d{4}-\d{2}-\d{2}$/);
	await expect(table.locator('tr', { hasText: 'cp-127' }).first()).toContainText('while the account is active');
	await expect(page.getByText('No warnings.')).toBeVisible();
});

test('add a host: a second CryptPad instance gets every copy, the recovery record learns it', async () => {
	const extra = await startFakeCryptpad();
	try {
		await nav(page, 'Hosts');
		await page.getByLabel('Type').selectOption('cryptpad');
		await page.getByLabel('URL').fill(extra.url);
		await page.getByRole('button', { name: 'Add and copy' }).click();
		await expect(page.getByTestId('host-added')).toContainText('Added cp-127-2', { timeout: 60_000 });
		await expect(page.getByTestId('host-added')).toContainText(`copied ${NOTE} on cp-127-2`);
		expect(extra.blocks.size).toBe(1);
		// the same host twice is refused (one account per operator)
		await page.getByLabel('URL').fill(extra.url);
		await page.getByRole('button', { name: 'Add and copy' }).click();
		await expect(page.getByRole('alert')).toContainText('already in this vault');
		await nav(page, 'Check');
		await expect(page.getByTestId('check-summary')).toContainText('18/18 copies healthy');
	} finally {
		fakes.cryptpad.push(extra); // closed with the others; the next tests still use it
	}
});

test('reload locks; the passphrase unlocks', async () => {
	await nav(page, 'Notes');
	await page.reload();
	await expect(page.getByTestId('lock-status')).toContainText('LOCKED');
	const unlock = page.getByTestId('unlock-form');
	await expect(unlock).toHaveAttribute('method', 'post');
	await expect(unlock.getByLabel('Vault name')).toHaveAttribute('autocomplete', 'username');
	await expect(unlock.getByLabel('Vault name')).toHaveValue(VAULT);
	await expect(unlock.getByLabel('Passphrase')).toHaveAttribute('autocomplete', 'current-password');
	await page.getByLabel('Passphrase').fill('wrong words here');
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByRole('alert')).toContainText('wrong passphrase');
	await page.getByLabel('Passphrase').fill(passphrase);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByTestId('notes-table')).toContainText(NOTE);
	await expectNoLeak(page, passphrase);
	// a note page opened directly (the SPA fallback) unlocks the same way
	await page.goto(url(`/notes/${encodeURIComponent(NOTE)}/`));
	await page.getByLabel('Passphrase').fill(passphrase);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByTestId('note-text')).toHaveValue(TEXT);
});

test('recover by name + passphrase in a fresh browser', async ({ browser }) => {
	const fresh = await browser.newContext();
	await useFakes(fresh, fakes);
	const p = await fresh.newPage();
	const errs = watchErrors(p);
	await p.goto(url('/recover/'));
	const form = p.getByTestId('recover-form');
	await expect(form).toHaveAttribute('method', 'post');
	await expect(form.getByLabel('Vault name')).toHaveAttribute('autocomplete', 'username');
	await expect(form.getByLabel('Passphrase')).toHaveAttribute('autocomplete', 'current-password');
	await recoverByName(p, VAULT.normalize('NFD'), passphrase);
	await expectNoLeak(p, passphrase);
	// the host added above travelled in the republished recovery record
	await expect(p.getByTestId('recovered')).toContainText('cp-127-2');
	await expect(await readNote(p, NOTE)).toHaveValue(TEXT);
	await nav(p, 'Check');
	await expect(p.getByTestId('check-summary')).toContainText('ALL COPIES HEALTHY');
	expect(errs).toEqual([]);
	await fresh.close();
});

test('a wrong passphrase finds nothing and stores nothing', async ({ browser }) => {
	const fresh = await browser.newContext();
	await useFakes(fresh, fakes);
	const p = await fresh.newPage();
	await p.goto(url('/recover/'));
	await p.getByLabel('Vault name').fill(VAULT);
	await p.getByLabel('Passphrase').fill('not the right passphrase at all');
	await p.getByRole('button', { name: 'Recover' }).click();
	await expect(p.getByRole('alert')).toContainText('no bootstrap for this vault name and passphrase');
	await expect(p.getByTestId('lock-status')).toContainText('NO VAULT');
	await fresh.close();
});
