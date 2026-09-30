// The landing page has one thing to do, and the header one menu.
import { test, expect, type Page } from '@playwright/test';
import { url, watchErrors } from './helpers';

/** Buttons and button-styled links that are at least partly inside the viewport, except the menu button. */
async function actionsAboveTheFold(page: Page) {
	return page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('a.button, button')]
			.filter((el) => !el.closest('#site-menu') && !el.classList.contains('menu-button'))
			.filter((el) => {
				const r = el.getBoundingClientRect();
				const style = getComputedStyle(el);
				return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && r.top < innerHeight && r.bottom > 0;
			})
			.map((el) => el.textContent!.trim())
	);
}

for (const [w, h] of [[1280, 800], [375, 740]]) {
	for (const scheme of ['light', 'dark'] as const) {
		test(`landing at ${w}x${h}, ${scheme}: one primary action, a secondary one, nothing else`, async ({ browser }) => {
			const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
			const page = await ctx.newPage();
			const errors = watchErrors(page);
			await page.goto(url('/'));
			const primary = page.getByTestId('primary-cta');
			await expect(primary).toHaveText('Store note in new vault');
			await expect(primary).toBeInViewport({ ratio: 1 });
			await expect(primary).toHaveAttribute('href', url('/setup/'));
			const secondary = page.getByTestId('secondary-cta');
			await expect(secondary).toHaveText('Open my vault');
			await expect(secondary).toBeInViewport({ ratio: 1 });
			await expect(secondary).toHaveAttribute('href', url('/recover/'));
			expect(await actionsAboveTheFold(page)).toEqual(['Store note in new vault']);
			// the first screen is only the hero: the diagram starts below the fold
			expect((await page.getByTestId('diagram').boundingBox())!.y).toBeGreaterThanOrEqual(h);
			// the old uppercase feature line and the row of header links are gone
			const body = (await page.locator('body').textContent())!;
			for (const gone of ['COPIES ON A DOZEN INDEPENDENT HOSTS', 'NO SERVER OF OURS', 'THREAT LEVEL']) expect(body).not.toContain(gone);
			await expect(page.locator('header a:visible')).toHaveCount(1); // the brand; everything else is in the menu
			await expect(page.locator('#site-menu')).toBeHidden();
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
			expect(overflow).toBeLessThanOrEqual(0);
			await page.screenshot({ path: `test-results/landing-${w}-${scheme}.png` });
			await page.getByTestId('menu-button').click();
			await page.screenshot({ path: `test-results/landing-${w}-${scheme}-menu.png` });
			expect(errors).toEqual([]);
			await ctx.close();
		});
	}
}

test('the menu: keyboard open and close with focus handling, every link works, no layout shift', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 740 });
	await page.goto(url('/'));
	const button = page.getByTestId('menu-button');
	const menu = page.locator('#site-menu');
	const before = await page.getByTestId('hero').boundingBox();

	await button.focus();
	await page.keyboard.press('Enter');
	await expect(button).toHaveAttribute('aria-expanded', 'true');
	await expect(menu).toBeVisible();
	// focus moved into the menu
	expect(await page.evaluate(() => document.activeElement?.closest('#site-menu') !== null)).toBe(true);
	expect(await page.getByTestId('hero').boundingBox()).toEqual(before);
	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();
	await expect(button).toHaveAttribute('aria-expanded', 'false');
	await expect(button).toBeFocused();

	// clicking outside closes it too
	await button.click();
	await expect(menu).toBeVisible();
	await page.getByTestId('hero').click({ position: { x: 5, y: 5 } });
	await expect(menu).toBeHidden();

	const expected: [string, string][] = [
		['My notes', '/notes/'], ['New note', '/new/'], ['Check copies', '/check/'], ['Status', '/status/'], ['Hosts', '/hosts/'],
		['Settings', '/settings/'], ['Vault access', '/recovery-kit/'], ['How it works', '/how-it-works/'], ['Thanks', '/thanks/'], ['Trust model', '/trust/'], ['About', '/about/']
	];
	for (const [label, path] of expected) {
		await button.click();
		await menu.getByRole('link', { name: label, exact: true }).click();
		await expect(page).toHaveURL(url(path));
		await expect(menu).toBeHidden(); // it closes after navigating
		await expect(page.locator('main')).not.toBeEmpty();
	}
});
