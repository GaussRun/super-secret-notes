import { expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { BASE, ORIGIN } from '../playwright.config';

export { ORIGIN };
import type { Fakes } from './fakes';

export const url = (path: string) => `${BASE}${path}`;

/** Point the page at the fake hosts (the Settings page stores the same JSON). */
export async function useFakes(context: BrowserContext, fakes: Fakes) {
	await context.addInitScript((hosts) => localStorage.setItem('overkill.hosts', hosts), JSON.stringify(fakes.hosts));
}

/** Fail the test on CSP violations and uncaught page errors. */
export function watchErrors(page: Page) {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) errors.push(m.text());
	});
	page.on('pageerror', (e) => errors.push(e.message));
	return errors;
}

/** Create an empty vault through /setup/ (the skip path), named `name`; ends on the kit page. */
export async function setupVault(page: Page, name: string) {
	await page.goto(url('/setup/'));
	await page.getByLabel('Vault name').fill(name);
	const passphrase = await page.getByLabel('Passphrase', { exact: true }).inputValue();
	expect(passphrase.split(' ')).toHaveLength(6);
	await page.getByRole('button', { name: 'Skip, just create the vault' }).click();
	await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 90_000 });
	await nav(page, 'Kit');
	await expect(page.getByTestId('kit')).toContainText(`vault name:   ${name}`);
	return passphrase;
}

/** The EFF wordlist the vault names and passphrases come from. */
export const WORDLIST = new Set(readFileSync(new URL('../../cli/src/wordlist/eff_large_wordlist.txt', import.meta.url), 'utf8').split('\n').filter(Boolean));

/** In-app navigation through the header (a page load would lock the vault, by design). */
const PATHS = { Notes: '/notes/', New: '/new/', Check: '/check/', Status: '/status/', Hosts: '/hosts/', Kit: '/recovery-kit/', Settings: '/settings/', Trust: '/trust/' };
// the menu's own labels for them
export const MENU = { Notes: 'My notes', New: 'New note', Check: 'Check copies', Status: 'Status', Hosts: 'Hosts', Kit: 'Vault access', Settings: 'Settings', Trust: 'Trust model' };

/** Open the header menu (if closed). */
export async function openMenu(page: Page) {
	const button = page.getByTestId('menu-button');
	if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
	await expect(page.locator('#site-menu')).toBeVisible();
}

export async function nav(page: Page, label: keyof typeof PATHS) {
	await openMenu(page);
	await page.locator('#site-menu').getByRole('link', { name: MENU[label], exact: true }).click();
	await expect(page).toHaveURL(url(PATHS[label]));
}

/**
 * The passphrase never ends up in the URL, the history entries or the navigation timing entries.
 * `loadedFromLink`: the page was opened from a handoff link, whose navigation timing entry keeps
 * the URL it was loaded with (fragment included) for as long as that page lives; no API clears
 * it. Only that entry is exempt, and only in that case.
 */
export async function expectNoLeak(page: Page, passphrase: string, { loadedFromLink = false } = {}) {
	const forms = [passphrase, encodeURIComponent(passphrase), passphrase.replace(/ /g, '+'), passphrase.replace(/ /g, '%20')];
	const seen = await page.evaluate(() => ({
		href: location.href,
		state: JSON.stringify(history.state ?? null),
		length: history.length,
		entries: performance.getEntriesByType('navigation').map((e) => e.name)
	}));
	for (const text of [seen.href, decodeURIComponent(seen.href), seen.state, ...(loadedFromLink ? [] : seen.entries)]) {
		for (const f of forms) expect(text).not.toContain(f);
	}
	expect(seen.href).not.toContain('?');
	return seen;
}

export async function putNote(page: Page, name: string, text: string) {
	await nav(page, 'New');
	await page.getByLabel(/^Name/).fill(name);
	await page.getByLabel('Top secret contents').fill(text);
	await page.getByRole('button', { name: 'Encrypt and scatter' }).click();
	await expect(page.getByTestId('saved')).toContainText(`Saved "${name}"`);
}

export async function recoverByName(page: Page, name: string, passphrase: string) {
	await page.goto(url('/recover/'));
	await page.getByLabel('Vault name').fill(name);
	await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
	await page.getByRole('button', { name: 'Recover' }).click();
	await expect(page.getByTestId('recovered')).toBeVisible({ timeout: 90_000 });
}

export async function readNote(page: Page, name: string) {
	await nav(page, 'Notes');
	await page.getByTestId('notes-table').getByRole('link', { name, exact: true }).click();
	await expect(page).toHaveURL(url(`/notes/${encodeURIComponent(name)}/`));
	return page.getByTestId('note-text');
}
