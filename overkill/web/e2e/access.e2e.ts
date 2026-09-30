// One copy, one paste: "Copy access link" copies the recover URL with the fragment; the combined
// field on /recover/ takes every format (the link, its fragment, the kit, JSON, two lines) and
// recovers in one click; the unlock form takes the link too; a link pasted into the name field
// splits itself. Share this vault: the warning, the share sheet only where there is one, and no
// request ever carries the passphrase.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, nav, ORIGIN } from './helpers';

let fakes: Fakes;
let name = '';
let passphrase = '';
let link = '';
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

/** Every request URL a context makes, to check that none carries the passphrase or a fragment. */
function recordRequests(ctx: BrowserContext) {
	const urls: string[] = [];
	ctx.on('request', (r) => urls.push(r.url()));
	return urls;
}
const noLeak = (urls: string[]) => {
	for (const u of urls) {
		expect(u).not.toContain('#v=');
		for (const f of [passphrase, encodeURIComponent(passphrase), passphrase.replace(/ /g, '+')]) expect(u).not.toContain(f);
	}
};

async function withShare(ctx: BrowserContext, share: 'none' | 'mock') {
	await ctx.addInitScript((mode) => {
		if (mode === 'none') Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
		else
			Object.defineProperty(Navigator.prototype, 'share', {
				value: async (data: ShareData) => {
					(window as unknown as { __shared: ShareData[] }).__shared = [...((window as unknown as { __shared?: ShareData[] }).__shared ?? []), data];
				},
				configurable: true
			});
	}, share);
}

test('Copy access link copies the recover URL with the fragment; the share sheet is offered only where it exists', async ({ browser }) => {
	const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
	await useFakes(ctx, fakes);
	await withShare(ctx, 'none');
	const urls = recordRequests(ctx);
	const page = await ctx.newPage();
	const errors = watchErrors(page);
	await page.goto(url('/setup/'));
	await page.getByLabel('Vault name').fill('one paste vault');
	name = 'one paste vault';
	passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	await page.getByLabel('Your secret').fill('pasted in one go');
	await page.getByLabel(/^Note name/).fill('the note');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });

	const share = page.getByTestId('share-vault');
	await expect(share.getByTestId('share-warning')).toHaveText('Anyone with this link can open the whole vault: all notes, and can change them. Send it only through an end-to-end encrypted chat (e.g. Signal), or to yourself.');
	await expect(share.getByTestId('share-sheet')).toHaveCount(0); // no navigator.share here
	await share.getByTestId('copy-access-link').click();
	await expect(share.getByTestId('copy-access-link')).toHaveText('Copied');
	link = await page.evaluate(() => navigator.clipboard.readText());
	expect(link).toBe(`${ORIGIN}${url('/recover/')}#v=${encodeURIComponent(name)}&p=${encodeURIComponent(passphrase)}`);

	// the Vault access page (the old recovery kit page) has the same
	await nav(page, 'Kit');
	await expect(page.getByRole('heading', { name: 'Vault access', level: 1 })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Share this vault' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Recovery kit (print or save)' })).toBeVisible();
	await page.getByTestId('copy-access-link').click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
	noLeak(urls);
	expect(errors).toEqual([]);
	await ctx.close();
});

test('where the browser has a share sheet, Share... hands it the access link', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	await withShare(ctx, 'mock');
	const page = await ctx.newPage();
	await page.goto(url('/recover/'));
	await page.getByTestId('access-paste').getByLabel('Paste your access link or recovery kit').fill(link);
	await page.getByRole('button', { name: 'Recover' }).click();
	await expect(page.getByTestId('recovered')).toBeVisible({ timeout: 90_000 });
	await nav(page, 'Notes');
	await page.getByRole('button', { name: 'Share this vault' }).click();
	await page.getByTestId('share-sheet').click();
	expect(await page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared)).toEqual([{ url: link }]);
	await ctx.close();
});

const kitText = () => ['+---', '| SUPER SECRET NOTES  -  RECOVERY KIT', `|   passphrase:   ${passphrase}`, '|', `|   vault name:   ${name}`, '+---'].join('\n');
const FORMATS: [string, () => string][] = [
	['(a) the access link', () => link],
	['(b) the fragment', () => link.slice(link.indexOf('#'))],
	['(c) the recovery kit', kitText],
	['(d) JSON', () => JSON.stringify({ vault: name, passphrase })],
	['(e) two lines', () => `${name}\n${passphrase}`]
];

for (const [label, input] of FORMATS) {
	test(`paste ${label} into /recover/: both fields filled, one click recovers`, async ({ browser }) => {
		const ctx = await browser.newContext();
		await useFakes(ctx, fakes);
		const urls = recordRequests(ctx);
		const page = await ctx.newPage();
		const errors = watchErrors(page);
		await page.goto(url('/recover/'));
		await page.getByLabel('Paste your access link or recovery kit').fill(input());
		await expect(page.getByTestId('paste-ready')).toContainText(`Recover ${name}?`);
		await expect(page.getByLabel('Vault name')).toHaveValue(name);
		await expect(page.getByLabel('Passphrase', { exact: true })).toHaveValue(passphrase);
		// the box itself does not keep the passphrase
		await expect(page.getByLabel('Paste your access link or recovery kit')).toHaveValue('');
		await page.getByRole('button', { name: 'Recover' }).click();
		await expect(page.getByTestId('recovered')).toBeVisible({ timeout: 90_000 });
		noLeak(urls);
		expect(errors).toEqual([]);
		await ctx.close();
	});
}

test('garbage gets a hint; a link pasted into the name field splits itself', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page = await ctx.newPage();
	await page.goto(url('/recover/'));
	await page.getByLabel('Paste your access link or recovery kit').fill('this is not a link');
	await expect(page.getByTestId('access-paste-hint')).toContainText('not an access link');
	await expect(page.getByLabel('Vault name')).toHaveValue('');
	await page.getByLabel('Vault name').fill(link);
	await expect(page.getByLabel('Vault name')).toHaveValue(name);
	await expect(page.getByLabel('Passphrase', { exact: true })).toHaveValue(passphrase);
	await ctx.close();
});

test('the unlock form takes the access link too, and refuses one for another vault', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const page: Page = await ctx.newPage();
	await page.goto(url('/recover/'));
	await page.getByLabel('Paste your access link or recovery kit').fill(link);
	await page.getByRole('button', { name: 'Recover' }).click();
	await expect(page.getByTestId('recovered')).toBeVisible({ timeout: 90_000 });
	await page.goto(url('/unlock/'));
	const form = page.getByTestId('unlock-form');
	await expect(form.getByLabel('Vault name')).not.toHaveAttribute('readonly', '');
	const other = link.replace(/#v=[^&]+/, '#v=someone-else');
	await form.getByLabel('Paste your access link or recovery kit').fill(other);
	await expect(page.getByRole('alert')).toContainText('this browser holds "one paste vault"');
	await form.getByLabel('Paste your access link or recovery kit').fill(link);
	await expect(form.getByLabel('Passphrase', { exact: true })).toHaveValue(passphrase);
	await form.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(url('/notes/'), { timeout: 60_000 });
	await expect(page.getByTestId('notes-table')).toContainText('the note');
	await ctx.close();
});
