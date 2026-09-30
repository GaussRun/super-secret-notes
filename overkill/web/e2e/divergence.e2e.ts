// Two devices, one vault. Device B writes a new version while every host that keeps the index is
// down: its note is stored but not findable (and says so). Device A then finds copies that differ
// from its index: the note page offers to view the other version and keep one, and the check
// page calls them "differs" calmly instead of damage.
import { test, expect } from '@playwright/test';
import { startAllFakes, type Fakes } from './fakes';
import { url, useFakes, watchErrors, recoverByName, readNote, nav } from './helpers';

let fakes: Fakes;
test.beforeAll(async () => {
	fakes = await startAllFakes();
});
test.afterAll(async () => {
	await fakes?.close();
});

const NOTE = 'shared note';
const V1 = 'version one';
const V2 = 'version two, written while the index hosts were down';

// the relays keep taking notes but refuse the index; CryptPad is down: the note lands, the index does not
const indexHostsDown = (down: boolean) => {
	for (const r of fakes.relays) r.refuseIndex = down;
	for (const c of fakes.cryptpad) c.down = down;
};

test('a version the index does not know: not findable on the writer, "another version" and "differs" on the reader', async ({ browser }) => {
	test.setTimeout(240_000);
	const a = await browser.newContext();
	await useFakes(a, fakes);
	const pa = await a.newPage();
	const errors = watchErrors(pa);
	await pa.goto(url('/setup/'));
	await pa.getByLabel('Vault name').fill('two devices');
	const passphrase = await pa.getByLabel('Passphrase', { exact: true }).inputValue();
	await pa.getByLabel('Your secret').fill(V1);
	await pa.getByLabel(/^Note name/).fill(NOTE);
	await pa.getByTestId('kit-checkbox').uncheck();
	await pa.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(pa.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });
	await expect(pa.getByTestId('not-findable')).toHaveCount(0);

	// device B writes version two while the relays and CryptPad are down
	const b = await browser.newContext();
	await useFakes(b, fakes);
	const pb = await b.newPage();
	await recoverByName(pb, 'two devices', passphrase);
	// B has read the index once (so it keeps a copy of its own)
	await nav(pb, 'Notes');
	await expect(pb.getByTestId('notes-table')).toContainText(NOTE);
	indexHostsDown(true);
	try {
		await nav(pb, 'New');
		await pb.getByLabel('Top secret contents').fill(V2);
		await pb.getByLabel(/^Name/).fill(NOTE);
		await pb.getByRole('button', { name: 'Encrypt and scatter' }).click();
		await expect(pb.getByTestId('not-findable')).toContainText('not yet findable from other devices', { timeout: 90_000 });
		await expect(pb.getByTestId('retry')).toBeVisible();
	} finally {
		indexHostsDown(false);
	}
	await b.close();

	// device A: its index says version one; the PrivateBin and Blossom copies are version two
	await pa.goto(url('/unlock/'));
	await pa.getByLabel('Passphrase', { exact: true }).fill(passphrase);
	await pa.getByRole('button', { name: 'Unlock' }).click();
	await expect(pa).toHaveURL(url('/notes/'), { timeout: 60_000 });
	// the check page first: the relay copies are a version the index does not know; calm "differs"
	await nav(pa, 'Check');
	const summary = pa.getByTestId('check-summary');
	await expect(summary).toBeVisible({ timeout: 60_000 });
	await expect(pa.getByTestId('check-differs')).toContainText('a version the index does not know');
	await expect(summary).not.toHaveClass(/bad-panel/);
	await expect(pa.getByTestId(`row-${NOTE}`).locator('td', { hasText: 'DIFFERS' }).first()).toHaveClass(/\bwarn\b/);
	await expect(pa.getByTestId(`row-${NOTE}`)).not.toContainText('DIVERGED');
	await summary.screenshot({ path: 'test-results/check-differs.png' });

	// the note page: the index's version, and "another version exists" with a way to see it
	await expect(await readNote(pa, NOTE)).toHaveValue(V1, { timeout: 60_000 });
	const box = pa.getByTestId('diverged');
	await expect(box).toContainText('Another version exists on Nostr relay');
	await box.getByTestId('view-other').first().click();
	await expect(box.getByTestId('other-text')).toHaveText(V2);
	await box.screenshot({ path: 'test-results/diverged.png' });

	// keep version two: stored everywhere again, the note page is calm
	await pa.getByTestId('keep-other').click();
	await expect(pa.getByTestId('diverged')).toHaveCount(0, { timeout: 90_000 });
	await expect(pa.getByTestId('note-text')).toHaveValue(V2);
	await nav(pa, 'Check');
	await expect(pa.getByTestId('check-summary')).toContainText('ALL COPIES HEALTHY', { timeout: 60_000 });
	expect(errors).toEqual([]);
	await a.close();
});
