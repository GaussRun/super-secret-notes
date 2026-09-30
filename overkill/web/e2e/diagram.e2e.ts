// The encryption and scatter diagram: renders on / and /how-it-works/, every logo comes from this
// site and loads, no CSP complaints, fits a 375 px phone, and reduced motion stops the packets.
import { test, expect } from '@playwright/test';
import { url, watchErrors, ORIGIN } from './helpers';
import { defaultBackends } from '../../cli/src/defaults.js';

// the defaults list is the source of every count the diagram shows
delete process.env.OVERKILL_DEFAULT_BACKENDS;
const DEFAULTS: { type: string }[] = defaultBackends({ cryptpad: true });
const count = (t: string) => DEFAULTS.filter((b) => b.type === t).length;

const PAGES = ['/', '/how-it-works/'];

for (const path of PAGES) {
	for (const [w, h] of [[1280, 900], [375, 800]]) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`diagram on ${path} at ${w} px, ${scheme}`, async ({ browser }) => {
				const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
				const page = await ctx.newPage();
				const errors = watchErrors(page);
				const logos: { url: string; status: number }[] = [];
				page.on('response', (r) => {
					if (r.url().includes('/logos/')) logos.push({ url: r.url(), status: r.status() });
				});
				page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
				await page.goto(url(path));
				const figure = page.getByTestId('diagram');
				await expect(figure).toBeVisible();
				const svg = figure.locator(w < 640 ? '.tall svg' : '.wide svg');
				await expect(svg).toBeVisible();
				await expect(svg).toHaveAttribute('role', 'img');
				await expect(svg.locator('title')).toHaveText(/our encryption, then each host's native encryption/);
				await expect(svg.locator('[data-step="ours"]')).toContainText('Our encryption');
				await expect(svg.locator('[data-step="ours"]')).toContainText('AES-256-GCM (HKDF keys)');
				await expect(svg.locator('[data-layer="privatebin"]')).toHaveText('native: AES-256-GCM, key in the link');
				// Blossom is not a default any more: only named in the "Coming soon" row
				await expect(svg.locator('[data-host="blossom"], [data-layer="blossom"]')).toHaveCount(0);
				await expect(svg.locator('[data-host="nostr"] [data-layer="nostr"]')).toHaveText('native NIP-44: ChaCha20 + HMAC-SHA256');
				await expect(svg.locator('.dg-ours, .dg-host-ours')).toHaveCount(0);
				// no text badge repeats the name next to it: neutral monograms
				// the account services: a muted "Coming soon" row, no encryption line
				const soon = svg.locator('[data-host="optin"]');
				await expect(soon).toContainText('Coming soon');
				await expect(soon).toContainText('MEGA, Proton Drive, Filen, Fileverse, Blossom');
				await expect(soon).not.toContainText('encryption');
				await expect(soon).toHaveClass(/dg-optin/);
				if (path === '/how-it-works/') await expect(page.getByTestId('cli-accounts')).toHaveText('The command line tool can already use MEGA, Proton Drive, Filen and Fileverse. Blossom servers (no encryption of their own) can be added on the Hosts page or with the command line tool.');
				// the only monogram left is the "Coming soon" group's count
				await expect(svg.locator('.dg-mono-text')).toHaveCount(1);
				await expect(svg.locator('[data-host="optin"] .dg-mono-text')).toHaveText('+5');
				await expect(svg.locator('.dg-badge')).toHaveCount(0);
				await expect(svg.locator('desc')).toContainText('any one healthy copy plus your vault name and passphrase');
				const total = svg.locator('.dg-total[data-total]');
				await expect(total).toHaveAttribute('data-total', String(DEFAULTS.length));
				await expect(total).toHaveText(`${count('privatebin')} PrivateBin + ${count('cryptpad')} CryptPad + ${count('nostr')} relays = ${DEFAULTS.length} copies`);
				await expect(svg.locator('title')).toContainText(`on ${DEFAULTS.length} hosts`);
				await expect(svg.locator('[data-host="privatebin"]')).toContainText(`${count('privatebin')} instances`);
				if (path === '/how-it-works/') await expect(page.getByTestId('default-counts')).toContainText(`goes to ${DEFAULTS.length} zero-signup hosts: ${count('privatebin')} PrivateBin instances`);
				for (const id of ['privatebin', 'cryptpad', 'nostr', 'optin']) await expect(svg.locator(`[data-host="${id}"]`)).toBeVisible();

				// every logo: same origin, loaded
				const hrefs = await svg.locator('image.dg-logo').evaluateAll((els) => els.map((e) => (e as SVGImageElement).href.baseVal));
				expect(hrefs.map((h) => h.split('/').pop()).sort()).toEqual(['cryptpad.svg', 'nostr.png', 'privatebin.svg']);
				for (const href of hrefs) {
					const abs = new URL(href, page.url());
					expect(abs.origin).toBe(ORIGIN);
					const r = await page.request.get(abs.href);
					expect(r.status(), abs.href).toBe(200);
					expect(r.headers()['content-type']).toContain(href.endsWith('.png') ? 'image/png' : 'image/svg+xml');
				}
				// the Nostr logo actually decodes and paints
				const nostrLogo = svg.locator('[data-host="nostr"] image.dg-logo');
				await expect(nostrLogo).toHaveCount(1);
				const decoded = await page.evaluate(async (src) => {
					const img = new Image();
					img.src = src;
					await img.decode();
					return [img.naturalWidth, img.naturalHeight];
				}, await nostrLogo.evaluate((e) => (e as SVGImageElement).href.baseVal));
				expect(decoded).toEqual([128, 128]);
				await expect.poll(() => logos.length).toBeGreaterThanOrEqual(3);
				expect(logos.filter((l) => l.status !== 200)).toEqual([]);

				// no horizontal scroll
				const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
				expect(overflow).toBeLessThanOrEqual(0);

				await figure.screenshot({ style: 'header { position: static !important; }', path: `test-results/diagram-${path === '/' ? 'landing' : 'how-it-works'}-${w}-${scheme}.png` });
				expect(errors).toEqual([]);
				await ctx.close();
			});
		}
	}
}

test('reduced motion stops the moving packets', async ({ browser }) => {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await ctx.newPage();
	await page.goto(url('/how-it-works/'));
	const packet = page.getByTestId('diagram').locator('.wide .dg-packet').first();
	expect(await packet.evaluate((e) => getComputedStyle(e).display)).not.toBe('none');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	expect(await packet.evaluate((e) => getComputedStyle(e).display)).toBe('none');
	await ctx.close();
});

test('the standalone diagram.svg for the READMEs is served and self-contained', async ({ request }) => {
	const r = await request.get(url('/diagram.svg'));
	expect(r.status()).toBe(200);
	const svg = await r.text();
	expect(svg).toContain('role="img"');
	expect(svg).toContain('prefers-color-scheme: dark');
	expect(svg).toContain('prefers-reduced-motion: reduce');
	// logos embedded, nothing to fetch
	expect(svg).not.toMatch(/href="(?!data:|#)/);
	expect((svg.match(/href="data:image\/svg\+xml;base64,/g) ?? []).length).toBe(2);
	expect((svg.match(/href="data:image\/png;base64,/g) ?? []).length).toBe(1);
	expect(svg).not.toContain('data-host="blossom"');
	expect(svg).toContain(`data-total="${DEFAULTS.length}"`);
});
