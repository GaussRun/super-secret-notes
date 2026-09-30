// Failure handling (docs/OVERKILL.md, "Failure handling"): best effort, every host on its own
// deadline, success at 2 copies, known-good stand-ins for failed defaults, the index kept in the
// browser when no index holder answers, and a Retry that copies what is missing later.
// Dead hosts are loopback ports nobody listens on (connection refused at once).
import { test, expect, type BrowserContext } from '@playwright/test';
import { startFakePrivatebin, startFakeRelay, type FakePrivatebin, type FakeRelay } from './fakes';
import { startFakeCryptpad, type FakeCryptpad } from './fake-cryptpad';
import { url, watchErrors } from './helpers';

const TIMEOUTS = { host: 3000, cryptpad: 4000, nostr: 5000 };
let port = 1;
const deadHttp = () => `http://127.0.0.1:${port++}`;
const deadWs = () => `ws://127.0.0.1:${port++}`;

type Hosts = { privatebin: string[]; cryptpad: string[]; nostr: string[]; discovery: string[]; fallbacks?: { privatebin?: string[]; nostr?: string[] } };

async function withHosts(ctx: BrowserContext, h: Hosts) {
	const hosts = {
		privatebin: h.privatebin,
		cryptpad: h.cryptpad,
		nostr: h.nostr,
		blossom: [],
		discovery: h.discovery,
		nostrPauseMs: 0,
		fallbacks: { privatebin: h.fallbacks?.privatebin ?? [], nostr: h.fallbacks?.nostr ?? [], cryptpad: [], blossom: [] },
		timeouts: TIMEOUTS
	};
	await ctx.addInitScript((json) => localStorage.setItem('overkill.hosts', json), JSON.stringify(hosts));
}

async function setup(ctx: BrowserContext, secret: string) {
	const page = await ctx.newPage();
	const errors = watchErrors(page);
	await page.goto(url('/setup/'));
	await page.getByLabel('Your secret').fill(secret);
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });
	return { page, errors };
}

const hostRow = (page: import('@playwright/test').Page, status: 'OK' | 'FAILED') => page.getByTestId('setup-done').locator('li', { hasText: status });

let pb: FakePrivatebin[] = [];
let relays: FakeRelay[] = [];
let cps: FakeCryptpad[] = [];
test.beforeAll(async () => {
	pb = [await startFakePrivatebin(), await startFakePrivatebin(), await startFakePrivatebin()];
	relays = [await startFakeRelay(), await startFakeRelay(), await startFakeRelay()];
	cps = [await startFakeCryptpad({ hangAuth: true })];
});
test.afterAll(async () => {
	await Promise.all([...pb, ...relays, ...cps].map((x) => x.close()));
});
test.beforeEach(() => {
	for (const p of pb) p.down = false;
});

test('a CryptPad instance that never answers registration: setup finishes, CryptPad marked FAILED', async ({ browser }) => {
	const ctx = await browser.newContext();
	await withHosts(ctx, { privatebin: [pb[0].url, pb[1].url], cryptpad: [cps[0].url], nostr: [relays[0].url, relays[1].url], discovery: [relays[0].url] });
	const t0 = Date.now();
	const { page, errors } = await setup(ctx, 'cryptpad hangs');
	expect(Date.now() - t0).toBeLessThan(60_000);
	await expect(page.getByTestId('setup-done')).toContainText('is on 4 of 5 hosts');
	await expect(hostRow(page, 'FAILED')).toHaveCount(1);
	await expect(hostRow(page, 'FAILED')).toContainText('cp-127');
	await expect(hostRow(page, 'FAILED')).toContainText('no answer in 4 s');
	await expect(page.getByTestId('stored-summary')).toHaveText('Stored on 4 hosts; 1 failed (will retry).');
	await expect(page.getByTestId('few-copies')).toHaveCount(0);
	expect(errors).toEqual([]);
	await ctx.close();
});

test('8 of 10 hosts dead: known-good stand-ins fill in and setup succeeds', async ({ browser }) => {
	const ctx = await browser.newContext();
	await withHosts(ctx, {
		privatebin: [pb[0].url, deadHttp(), deadHttp(), deadHttp()],
		cryptpad: [deadHttp(), deadHttp()],
		nostr: [relays[0].url, deadWs(), deadWs(), deadWs()],
		discovery: [relays[0].url],
		fallbacks: { privatebin: [pb[1].url, pb[2].url], nostr: [relays[1].url, relays[2].url] }
	});
	const { page, errors } = await setup(ctx, 'mostly dead');
	// 2 alive + 2 PrivateBin and 2 relay stand-ins; 1 PrivateBin, 1 relay and both CryptPads still failed
	await expect(page.getByTestId('setup-done')).toContainText('is on 6 of 10 hosts');
	await expect(page.getByTestId('swaps')).toContainText(pb[1].url);
	await expect(page.getByTestId('swaps')).toContainText(pb[2].url);
	await expect(page.getByTestId('swaps')).toContainText(relays[1].url);
	await expect(page.getByTestId('swaps')).toContainText(relays[2].url);
	await expect(page.getByTestId('stored-summary')).toHaveText('Stored on 6 hosts; 4 failed (will retry).');
	await expect(page.getByTestId('few-copies')).toHaveCount(0);
	await expect(page.getByTestId('index-local')).toHaveCount(0);
	// the stand-ins hold real copies
	for (const p of [pb[1], pb[2]]) expect(p.pastes.size).toBeGreaterThanOrEqual(2);
	expect(errors).toEqual([]);
	await ctx.close();
});

test('exactly 2 hosts alive: success, with the failures listed', async ({ browser }) => {
	const ctx = await browser.newContext();
	await withHosts(ctx, { privatebin: [pb[0].url, deadHttp(), deadHttp(), deadHttp()], cryptpad: [deadHttp(), deadHttp()], nostr: [relays[0].url, deadWs(), deadWs(), deadWs()], discovery: [relays[0].url] });
	const { page, errors } = await setup(ctx, 'two copies');
	await expect(page.getByTestId('setup-done')).toContainText('is on 2 of 10 hosts');
	await expect(page.getByTestId('stored-summary')).toHaveText('Stored on 2 hosts; 8 failed (will retry).');
	await expect(page.getByTestId('few-copies')).toHaveCount(0);
	await expect(page.getByTestId('retry')).toBeVisible();
	expect(errors).toEqual([]);
	await ctx.close();
});

test('1 host alive: a clear warning, and Retry copies it once another host is back', async ({ browser }) => {
	const ctx = await browser.newContext();
	pb[0].down = true;
	await withHosts(ctx, { privatebin: [pb[0].url, deadHttp()], cryptpad: [deadHttp()], nostr: [relays[0].url, deadWs()], discovery: [relays[0].url] });
	const { page, errors } = await setup(ctx, 'one copy');
	await expect(page.getByTestId('setup-done')).toContainText('is on 1 of 5 hosts');
	await expect(page.getByTestId('few-copies')).toContainText('Only 1 copy so far');
	pb[0].down = false;
	await page.getByTestId('retry').click();
	await expect(page.getByTestId('retried')).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId('few-copies')).toHaveCount(0);
	await expect(hostRow(page, 'OK')).toHaveCount(2);
	expect(pb[0].pastes.size).toBeGreaterThanOrEqual(2); // vault.age and the note
	expect(errors).toEqual([]);
	await ctx.close();
});

test('every CryptPad and Nostr host dead: the index stays in the browser, with warnings', async ({ browser }) => {
	const ctx = await browser.newContext();
	const deadRelay = deadWs();
	await withHosts(ctx, { privatebin: [pb[0].url, pb[1].url], cryptpad: [deadHttp(), deadHttp()], nostr: [deadRelay, deadWs()], discovery: [deadRelay] });
	const { page, errors } = await setup(ctx, 'no index holder');
	await expect(page.getByTestId('setup-done')).toContainText('is on 2 of 6 hosts');
	await expect(page.getByTestId('index-local')).toBeVisible();
	await expect(page.getByTestId('no-record')).toBeVisible();
	await expect(page.getByTestId('few-copies')).toHaveCount(0);
	// the note is listed from this browser's copy of the index
	await page.getByTestId('setup-done').getByRole('link', { name: 'Open the note' }).click();
	await expect(page.getByTestId('note-text')).toHaveValue('no index holder', { timeout: 30_000 });
	expect(errors).toEqual([]);
	await ctx.close();
});
