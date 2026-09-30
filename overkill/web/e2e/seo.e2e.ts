// What crawlers and link previews see: the head tags in the static HTML of every page, the
// JSON-LD block, robots/sitemap/llms.txt and the og image, and that the CSP still holds with
// all of it (no violations, still no 'unsafe-inline' for scripts).
import { test, expect } from '@playwright/test';
import { url, watchErrors } from './helpers';

const TITLE = 'Super Secret Notes by GaussRun: double-encrypted notes stored redundantly across a dozen free, no-signup hosts';

for (const path of ['/', '/setup/', '/recover/', '/trust/', '/how-it-works/', '/thanks/', '/notes/some%20note/']) {
	test(`head tags in the served HTML of ${path}`, async ({ request }) => {
		const res = await request.get(url(path));
		const html = await res.text();
		expect(html).toContain(`<title>${TITLE}</title>`);
		expect(html).toMatch(/<meta name="description" content="Super Secret Notes by GaussRun: a secret note you cannot afford to lose, stored redundantly across a dozen free, no-signup hosts/);
		for (const tag of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) expect(html).toContain(`property="${tag}"`);
		for (const tag of ['twitter:card', 'twitter:title', 'twitter:image']) expect(html).toContain(`name="${tag}"`);
		const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
		expect(ld, 'JSON-LD block').toBeTruthy();
		const data = JSON.parse(ld![1]);
		expect(data['@type']).toBe('SoftwareApplication');
		expect(data.name).toBe('Super Secret Notes by GaussRun');
		expect(data.codeRepository).toBe('https://github.com/GaussRun/super-secret-notes');
		const csp = /http-equiv="content-security-policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
		expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'(;|$)/);
		expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
		expect(csp).toContain("connect-src 'self' https: wss:");
		expect(csp).toContain("default-src 'none'");
	});
}

test('the page runs with the new head: no CSP violations, the JSON-LD is there, the intro says what it is', async ({ page }) => {
	const errors = watchErrors(page);
	await page.goto(url('/'));
	await expect(page).toHaveTitle(TITLE);
	await expect(page.getByTestId('what-it-is')).toContainText('public computer');
	const ld = await page.locator('script[type="application/ld+json"]').textContent();
	expect(JSON.parse(ld!).offers.price).toBe('0');
	expect(errors).toEqual([]);
});

test('robots.txt, sitemap.xml, llms.txt and og.png are served', async ({ request }) => {
	const robots = await request.get(url('/robots.txt'));
	expect(await robots.text()).toContain('Sitemap: https://gaussrun.github.io/super-secret-notes/sitemap.xml');
	const sitemap = await (await request.get(url('/sitemap.xml'))).text();
	expect(sitemap).toContain('<loc>https://gaussrun.github.io/super-secret-notes/recover/</loc>');
	const llms = await request.get(url('/llms.txt'));
	expect(llms.headers()['content-type']).toMatch(/text\/plain/);
	const text = await llms.text();
	for (const s of ['# Super Secret Notes by GaussRun', 'https://github.com/GaussRun/super-secret-notes', 'PrivateBin', 'Nostr', 'Recovery', 'Security caveats']) expect(text).toContain(s);
	const og = await request.get(url('/og.png'));
	expect(og.headers()['content-type']).toBe('image/png');
	const png = await og.body();
	expect(png.subarray(1, 4).toString()).toBe('PNG');
	expect(png.readUInt32BE(16)).toBe(1200);
	expect(png.readUInt32BE(20)).toBe(630);
});

test('/how-it-works/ explains every layer with its primary source, including our crypto.js on GitHub', async ({ page }) => {
	const errors = watchErrors(page);
	await page.goto(url('/how-it-works/'));
	await expect(page.getByRole('heading', { name: 'How it works', level: 1 })).toBeVisible();
	await expect(page.getByTestId('crypto-js-link')).toHaveAttribute('href', 'https://github.com/GaussRun/super-secret-notes/blob/main/overkill/cli/src/crypto.js');
	const layers = page.getByTestId('layers');
	for (const href of ['https://age-encryption.org/v1', 'https://github.com/FiloSottile/typage', 'https://github.com/PrivateBin/PrivateBin/wiki/Encryption-format', 'https://blog.cryptpad.org/images/whitepaper.pdf', 'https://github.com/nostr-protocol/nips/blob/master/44.md', 'https://github.com/hzrd149/blossom/blob/master/buds/02.md']) {
		await expect(layers.locator(`a[href="${href}"]`).first()).toBeVisible();
	}
	await expect(layers).toContainText('The server MUST NOT modify the blob');
	expect(errors).toEqual([]);
});

test('/thanks/ and the landing strip thank the hosts and projects, with support links', async ({ page }) => {
	await page.goto(url('/thanks/'));
	const ops = page.getByTestId('thanks-operators');
	for (const h of ['pb.envs.net', 'paste.systemli.org', 'extrait.facil.services', 'cryptpad.private.coffee', 'nos.lol', 'nostr.download', 'blossom.ditto.pub']) await expect(ops.getByRole('link', { name: h })).toBeVisible();
	await expect(page.locator('a[href="https://envs.net/donate/"]')).toBeVisible();
	await expect(page.getByTestId('thanks-projects').locator('a[href="https://opencollective.com/cryptpad"]')).toBeVisible();
	await page.goto(url('/'));
	const strip = page.getByTestId('thanks-strip');
	await expect(strip.getByRole('link', { name: 'PrivateBin' })).toBeVisible();
	await expect(strip.getByRole('link', { name: 'nostr.mom' })).toBeVisible();
	await expect(page.locator('footer a', { hasText: 'thank you' })).toHaveAttribute('href', /\/thanks\/$/);
	await expect(page.getByTestId('what-it-is')).toContainText('many independent places');
	await expect(page.locator('body')).not.toContainText(/grocer/i);
});

