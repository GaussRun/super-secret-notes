// Public computer to phone: the quick throwaway flow keeps nothing in the browser, the QR
// really carries the recovery link, the "phone" recovers from it with the fragment wiped at
// once and never requested, and the QR hides itself.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, putNote, readNote, nav, expectNoLeak, ORIGIN, setupVault } from './helpers';

let fakes: Fakes;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

/** What this origin keeps: localStorage keys and the number of IndexedDB records. */
async function stored(page: Page) {
	return page.evaluate(async () => {
		const keys = Object.keys(localStorage).sort();
		const dbs = (await indexedDB.databases()).map((d) => d.name);
		let records = 0;
		if (dbs.includes('overkill-notes')) {
			records = await new Promise<number>((resolve, reject) => {
				const req = indexedDB.open('overkill-notes');
				req.onsuccess = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains('blobs')) return (db.close(), resolve(0));
					const c = db.transaction('blobs').objectStore('blobs').count();
					c.onsuccess = () => (db.close(), resolve(c.result));
					c.onerror = () => reject(c.error);
				};
				req.onerror = () => reject(req.error);
			});
		}
		return { keys, records };
	});
}

/** Decode the QR on the page the way a phone camera would (rendered pixels, jsQR). */
async function scanQr(page: Page) {
	const { w, h, px } = await page.evaluate(async () => {
		const svg = document.querySelector('[data-testid="qr"]')!;
		const img = new Image();
		img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
		await img.decode();
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 600;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0, 600, 600);
		return { w: 600, h: 600, px: Array.from(ctx.getImageData(0, 0, 600, 600).data) };
	});
	const res = jsQR(new Uint8ClampedArray(px), w, h);
	expect(res, 'the QR decodes').toBeTruthy();
	return new TextDecoder().decode(new Uint8Array(res!.binaryData));
}

let pc: BrowserContext;
let page: Page;
let vaultName = '';
let link = '';
const NOTE = 'for my phone';
const TEXT = 'the wifi password is overkill';

test('public computer: quick throwaway vault, nothing stored, a note, the QR carries the link', async ({ browser }) => {
	pc = await browser.newContext();
	await useFakes(pc, fakes);
	page = await pc.newPage();
	const errors = watchErrors(page);

	await page.goto(url('/'));
	await page.getByTestId('quick-flow').getByRole('link').click();
	await expect(page).toHaveURL(url('/setup/?quick=1'));
	vaultName = await page.getByLabel('Vault name').inputValue();
	expect(vaultName.split('-')).toHaveLength(4);
	await expect(page.getByLabel(/Public computer/)).toBeChecked();
	await expect(page.getByTestId('public-explained')).toContainText('keylogger');
	const passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	// note first: the vault and the note in one go
	await page.getByLabel(/^Note name/).fill(NOTE);
	await page.getByLabel('Your secret').fill(TEXT);
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toContainText(`"${NOTE}" is on 6 of 6 hosts`, { timeout: 90_000 });
	await expect(page.getByTestId('lock-status')).toContainText('PUBLIC COMPUTER');
	// no password-manager save on a public computer
	await expect(page.getByRole('button', { name: 'Save in password manager' })).toHaveCount(0);
	// only the test's own host list is in localStorage; IndexedDB holds nothing
	expect(await stored(page)).toEqual({ keys: ['overkill.hosts'], records: 0 });

	await nav(page, 'Kit');
	await expect(page.getByTestId('qr')).toHaveCount(0); // hidden until asked for
	await page.getByRole('button', { name: 'Show QR (recovery link)' }).click();
	await expect(page.getByTestId('qr-warning')).toContainText('ANYONE WHO SEES THIS QR CAN OPEN YOUR VAULT');
	link = await scanQr(page);
	expect(link.startsWith(`${ORIGIN}${url('/recover/')}#v=`)).toBe(true);
	const frag = new URLSearchParams(new URL(link).hash.slice(1));
	expect(frag.get('v')).toBe(vaultName);
	expect(frag.get('p')).toBe(passphrase);
	await page.getByRole('button', { name: 'Hide now' }).click();
	await expect(page.getByTestId('qr')).toHaveCount(0);

	await page.getByRole('button', { name: /Show QR \(plain text/ }).click();
	const text = await scanQr(page);
	expect(text).toBe(`Super Secret Notes vault\nvault name: ${vaultName}\npassphrase: ${passphrase}`);
	await page.getByRole('button', { name: 'Hide now' }).click();
	expect(errors).toEqual([]);
});

test('the QR hides itself after 60 seconds', async () => {
	await nav(page, 'Notes');
	await page.getByRole('button', { name: 'Share this vault' }).click();
	// fake timers from here on: the QR's countdown is the only timer the test drives
	await page.clock.install();
	await page.getByRole('button', { name: 'Show QR (recovery link)' }).click();
	await expect(page.getByTestId('qr')).toBeVisible();
	await page.clock.runFor(30_000);
	await expect(page.getByTestId('qr-countdown')).toContainText('Hides itself in 30 s');
	await page.clock.runFor(31_000);
	await expect(page.getByTestId('qr')).toHaveCount(0);
});

test('the phone opens the link: fragment wiped at once, never requested, vault recovered', async ({ browser }) => {
	const phone = await browser.newContext();
	await useFakes(phone, fakes);
	const p = await phone.newPage();
	const errors = watchErrors(p);
	const requests: string[] = [];
	p.on('request', (r) => requests.push(r.url()));
	const passphrase = new URLSearchParams(new URL(link).hash.slice(1)).get('p')!;

	await p.goto(link);
	await expect(p.getByTestId('from-link')).toContainText('Recover this vault?');
	await expect(p.getByLabel('Vault name')).toHaveValue(vaultName);
	await expect(p.getByLabel('Passphrase', { exact: true })).toHaveValue(passphrase);
	const after = await p.evaluate(() => ({ hash: location.hash, href: location.href, length: history.length }));
	expect(after.hash).toBe('');
	expect(after.href).toBe(`${ORIGIN}${url('/recover/')}`);
	await expectNoLeak(p, passphrase, { loadedFromLink: true });

	await p.getByRole('button', { name: 'Recover' }).click();
	await expect(p.getByTestId('recovered')).toBeVisible({ timeout: 90_000 });
	await expect(await readNote(p, NOTE)).toHaveValue(TEXT);
	await expectNoLeak(p, passphrase, { loadedFromLink: true });
	// the fragment never went over the network, in any form
	for (const r of requests) {
		expect(r).not.toContain('#');
		expect(r).not.toContain(encodeURIComponent(passphrase));
		expect(r).not.toContain(passphrase.split(' ')[0] + '%20');
	}
	expect(errors).toEqual([]);
	await phone.close();
});

test('Done: wipe this tab forgets everything and goes home', async () => {
	await page.clock.resume();
	await page.getByTestId('wipe').click();
	await expect(page).toHaveURL(url('/'));
	await expect(page.getByTestId('lock-status')).toContainText('NO VAULT');
	expect(await stored(page)).toEqual({ keys: ['overkill.hosts'], records: 0 });
	await pc.close();
});

test('unlock in public mode on a stored vault, then wipe: the stored copy goes too', async ({ browser }) => {
	const ctx = await browser.newContext();
	await useFakes(ctx, fakes);
	const p = await ctx.newPage();
	const passphrase = await setupVault(p, 'stored then wiped');
	expect((await stored(p)).records).toBeGreaterThan(0);

	await p.reload();
	await p.getByLabel('Passphrase').fill(passphrase);
	await p.getByLabel(/Public computer/).check();
	await p.getByRole('button', { name: 'Unlock' }).click();
	await expect(p.getByTestId('lock-status')).toContainText('PUBLIC COMPUTER');
	const before = (await stored(p)).records;
	await putNote(p, 'while public', 'not written back');
	expect((await stored(p)).records).toBe(before); // nothing new reached IndexedDB
	await p.getByTestId('wipe').click();
	await expect(p).toHaveURL(url('/'));
	expect(await stored(p)).toEqual({ keys: ['overkill.hosts'], records: 0 });
	await ctx.close();
});
