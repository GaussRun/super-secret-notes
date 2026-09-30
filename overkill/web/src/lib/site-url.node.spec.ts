// SITE_URL decides every absolute URL the built site names (og:url, og:image, JSON-LD, sitemap,
// robots.txt, llms.txt): a build for https://example.org/sub must mention no other site URL.
import { describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SITE = 'https://example.org/sub';

describe('SITE_URL', () => {
	test('a build for another URL names only that URL', { timeout: 240_000 }, async () => {
		const out = path.join(await mkdtemp(path.join(os.tmpdir(), 'ssn-site-url-')), 'site');
		await new Promise<void>((resolve, reject) =>
			execFile(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'build'], { env: { ...process.env, SITE_URL: `${SITE}/`, OVERKILL_BUILD_DIR: out, BASE_PATH: '/sub' }, timeout: 230_000 }, (err, _stdout, stderr) => (err ? reject(new Error(stderr.slice(-2000))) : resolve()))
		);
		const read = (f: string) => readFile(path.join(out, f), 'utf8');
		const files = { 'index.html': await read('index.html'), '404.html': await read('404.html'), 'how-it-works/index.html': await read('how-it-works/index.html'), 'robots.txt': await read('robots.txt'), 'sitemap.xml': await read('sitemap.xml'), 'llms.txt': await read('llms.txt') };
		for (const [name, text] of Object.entries(files)) {
			expect(text, name).not.toContain('gaussrun.github.io');
			expect(text, name).not.toContain('{{SITE_URL}}');
			expect(text, name).not.toContain('%sveltekit.env');
			// every mention of the site's origin carries the path too
			for (const m of text.matchAll(/https:\/\/example\.org[^\s"<>)]*/g)) expect(m[0].startsWith(`${SITE}/`), `${name}: ${m[0]}`).toBe(true);
		}
		const html = files['index.html'];
		expect(html).toContain(`<meta property="og:url" content="${SITE}/" />`);
		expect(html).toContain(`<meta property="og:image" content="${SITE}/og.png" />`);
		expect(html).toContain(`<meta name="twitter:image" content="${SITE}/og.png" />`);
		const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
		expect(ld.url).toBe(`${SITE}/`);
		expect(ld.image).toBe(`${SITE}/og.png`);
		expect(files['robots.txt']).toContain(`Sitemap: ${SITE}/sitemap.xml`);
		expect(files['sitemap.xml']).toContain(`<loc>${SITE}/how-it-works/</loc>`);
		expect(files['llms.txt']).toContain(`Site: ${SITE}/`);
		// the og image itself ships with the build
		expect((await readFile(path.join(out, 'og.png'))).subarray(1, 4).toString()).toBe('PNG');
	});
});
