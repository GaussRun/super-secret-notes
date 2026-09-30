// What crawlers and link previews see: the head tags in the static HTML of every page, the
// JSON-LD block, robots/sitemap/llms.txt and the og image, and that the CSP still holds with
// all of it (no violations, still no 'unsafe-inline' for scripts).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { url, watchErrors } from './helpers';

// landing and preview copy names no host count: the defaults can change without touching it
// ("one" is allowed: "losing one host loses nothing" is not a count of the defaults)
const COUNT_WORDS = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozens?|a dozen)\s+(free|independent|zero-signup|no-signup|hosts?|copies|places)\b|\bdozen\b|\b(ten|twelve)\b/i;

const TITLE = 'Super Secret Notes by GaussRun: double-encrypted notes stored redundantly across many free, no-signup hosts';

for (const path of ['/', '/setup/', '/recover/', '/trust/', '/how-it-works/', '/thanks/', '/notes/some%20note/']) {
	test(`head tags in the served HTML of ${path}`, async ({ request }) => {
		const res = await request.get(url(path));
		const html = await res.text();
		expect(html).toContain(`<title>${TITLE}</title>`);
		expect(html).toMatch(/<meta name="description" content="Super Secret Notes by GaussRun: write a note, your browser encrypts it \(age, then AES-256-GCM\), then it is copied to many free, no-signup hosts that encrypt it again/);
		expect(html).toContain('<meta property="og:description" content="Write a note. Your browser encrypts it, then it is copied to many free hosts that encrypt it again.');
		// Blossom is not a default host any more, and no "we encrypt" in what previews show
		const head = /<head>[\s\S]*<\/head>/.exec(html)![0];
		expect(head).not.toMatch(/Blossom|[Ww]e encrypt/);
		// title, description, og, twitter and JSON-LD: no host count
		expect(head.replace(/<style[\s\S]*?<\/style>|<script(?! type="application\/ld\+json")[\s\S]*?<\/script>|http-equiv="content-security-policy" content="[^"]+"/g, '')).not.toMatch(COUNT_WORDS);
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
	await expect(page.getByTestId('what-it-is')).toHaveText("Write a note. Your browser encrypts it, then it's copied to many free hosts that encrypt it again.");
	// no digits and no number words in the hero
	const hero = await page.getByTestId('hero').innerText();
	expect(hero).not.toMatch(/\d/);
	expect(hero).not.toMatch(COUNT_WORDS);
	expect(await page.getByTestId('steps').innerText()).not.toMatch(COUNT_WORDS);
	await expect(page.getByTestId('paranoid')).toHaveText('For the extra paranoid.');
	await expect(page.locator('main')).not.toContainText(/we encrypt/i);
	await expect(page.getByTestId('quick-flow')).toContainText('public computer');
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

test('the og image text, llms.txt summary and the landing copy name no host count', async ({ request }) => {
	const og = readFileSync(new URL('../scripts/og-image.mjs', import.meta.url), 'utf8');
	const line = /A note you cannot afford to lose\.[^<]*/.exec(og)![0];
	expect(line).toContain('many independent hosts');
	expect(line).not.toMatch(/\d/);
	expect(line).not.toMatch(COUNT_WORDS);
	const llms = await (await request.get(url('/llms.txt'))).text();
	const summary = llms.split('\n').filter((l) => l.startsWith('>')).join('\n');
	expect(summary.length).toBeGreaterThan(100);
	expect(summary).not.toMatch(COUNT_WORDS);
	expect(llms).not.toMatch(/PrivateBin pastebins \(\d|relays \(\d|\d+ copies/);
});

test('/thanks/ and the landing strip thank the hosts and projects, with support links', async ({ page }) => {
	await page.goto(url('/thanks/'));
	const ops = page.getByTestId('thanks-operators');
	for (const h of ['pb.envs.net', 'paste.systemli.org', 'extrait.facil.services', 'bin.disroot.org', 'cryptpad.private.coffee', 'nos.lol', 'nostr.download', 'blossom.ditto.pub']) await expect(ops.getByRole('link', { name: h })).toBeVisible();
	await expect(page.locator('a[href="https://envs.net/donate/"]')).toBeVisible();
	await expect(page.locator('a[href="https://disroot.org/donate"]')).toBeVisible();
	// alternatives that are not defaults are not "hosts we use"
	for (const h of ['cryptostorm.is/paste', 'paste.d-ku.de']) await expect(ops).not.toContainText(h);
	await expect(page.getByTestId('thanks-projects').locator('a[href="https://opencollective.com/cryptpad"]')).toBeVisible();
	await page.goto(url('/'));
	const strip = page.getByTestId('thanks-strip');
	await expect(strip.getByRole('link', { name: 'PrivateBin' })).toBeVisible();
	await expect(strip.getByRole('link', { name: 'nostr.mom' })).toBeVisible();
	await expect(page.locator('footer a', { hasText: 'thank you' })).toHaveAttribute('href', /\/thanks\/$/);
	await expect(page.getByTestId('steps')).toContainText('Losing any one of them');
	await expect(page.locator('body')).not.toContainText(/grocer/i);
});


test('the site info (author, license, source, trust model) is on the landing page and /about/ only', async ({ page }) => {
	for (const path of ['/', '/about/']) {
		await page.goto(url(path));
		const info = page.getByTestId('site-info');
		await expect(info).toContainText('AGPL-3.0-or-later');
		await expect(info.getByRole('link', { name: 'source' })).toHaveAttribute('href', 'https://github.com/GaussRun/super-secret-notes');
		await expect(info.getByRole('link', { name: 'the trust model' })).toHaveAttribute('href', /\/trust\/$/);
	}
	await expect(page.getByRole('heading', { name: 'About', level: 1 })).toBeVisible();
	for (const path of ['/how-it-works/', '/thanks/', '/trust/', '/hosts/', '/setup/', '/recover/', '/settings/']) {
		await page.goto(url(path));
		await expect(page.locator('main')).toBeVisible();
		await expect(page.getByTestId('site-info')).toHaveCount(0);
		await expect(page.locator('body')).not.toContainText('whoever serves it could change it');
	}
});
