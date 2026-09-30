// Recovery by name does not depend on a vault's own (randomly drawn) relays: the record always
// goes to the fixed discovery relays too, and Recover asks those. Here the vault's only relay and
// the discovery relay are different servers.
import { test, expect, type BrowserContext } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, readNote } from './helpers';

let fakes: Fakes;
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

async function hosts(ctx: BrowserContext) {
	const h = { ...fakes.hosts, privatebin: [fakes.pb[0].url], cryptpad: [], blossom: [], nostr: [fakes.relays[0].url], discovery: [fakes.relays[1].url] };
	await ctx.addInitScript((json) => localStorage.setItem('overkill.hosts', json), JSON.stringify(h));
}

const dTags = (i: number) => [...fakes.relays[i].store.values()].map((e) => e.tags.find((t) => t[0] === 'd')?.[1]);

test('a vault whose own relays are disjoint from the discovery relays is found by name', async ({ browser }) => {
	const a = await browser.newContext();
	await hosts(a);
	const page = await a.newPage();
	await page.goto(url('/setup/'));
	await page.getByLabel('Vault name').fill('disjoint relays');
	const passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	await page.getByLabel('Your secret').fill('found through the discovery relay');
	await page.getByLabel(/^Note name/).fill('far away');
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });
	await expect(page.getByTestId('no-record')).toHaveCount(0);
	// the index lives on the vault's relay; the record on the discovery relay (and on the vault's own)
	expect(dTags(0)).toContain('overkill/index.ovk');
	expect(dTags(1)).not.toContain('overkill/index.ovk');
	expect(dTags(1)).toContain('overkill-discovery/bootstrap.json');
	await a.close();

	const b = await browser.newContext();
	await hosts(b);
	const p = await b.newPage();
	await p.goto(url('/recover/'));
	await p.getByLabel('Vault name').fill('disjoint relays');
	await p.getByLabel('Passphrase', { exact: true }).fill(passphrase);
	await p.getByRole('button', { name: 'Recover' }).click();
	await expect(p.getByTestId('recovered')).toBeVisible({ timeout: 90_000 });
	await expect(await readNote(p, 'far away')).toHaveValue('found through the discovery relay');
	await b.close();
});
