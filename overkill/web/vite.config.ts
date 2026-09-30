import { defineConfig, type Plugin } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { playwright } from '@vitest/browser-playwright';
import path from 'node:path';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

// The web client runs the CLI's own modules (overkill/cli/src). A few of them touch Node APIs;
// for those the browser build gets a thin shim with the same exports (src/lib/overkill/shims).
const CLI_SRC = path.resolve('../cli/src');
const SHIMS: Record<string, string> = {
	[path.join(CLI_SRC, 'log.js')]: path.resolve('src/lib/overkill/shims/log.js'),
	[path.join(CLI_SRC, 'vaultsecrets.js')]: path.resolve('src/lib/overkill/shims/vaultsecrets.js'),
	[path.join(CLI_SRC, 'backends/cryptpad/client.js')]: path.resolve('src/lib/overkill/shims/cryptpad-client.js')
};
const CRYPTPAD_VENDOR = path.join(CLI_SRC, 'backends/cryptpad/vendor/cryptpad') + path.sep;
const HERE = path.resolve('package.json');

function cliModules(): Plugin {
	return {
		name: 'shared-cli-modules',
		enforce: 'pre',
		async resolveId(source, importer, options) {
			const from = importer?.split('?')[0];
			if (!from?.startsWith(CLI_SRC + path.sep)) return null;
			if (source.startsWith('node:')) {
				// the vendored CryptPad files have a Node branch the browser never runs (cryptpadVendor drops it)
				if (from.startsWith(CRYPTPAD_VENDOR)) return { id: source, external: true };
				throw new Error(`${path.relative(CLI_SRC, from)} imports ${source}: give it a browser shim in vite.config.ts`);
			}
			if (source.startsWith('.')) return SHIMS[path.resolve(path.dirname(from), source)] ?? null;
			// bare imports (age-encryption, nostr-tools, ...) come from this package, so the CLI
			// needs no install of its own for the web build and every library is bundled once
			if (!source.startsWith('/') && !source.startsWith('\0')) {
				return this.resolve(source, HERE, { ...options, skipSelf: true });
			}
			return null;
		}
	};
}

// CryptPad's client modules (vendored in the CLI) are UMD files that pick CommonJS when
// `module` exists. Give each one a local `module` and turn its require() calls into static
// imports, so the dev server, vitest and the build all load them the same way. The Node-only
// branch in common-util (require('node:http')) never runs in a browser and gets nothing.
function cryptpadVendor(): Plugin {
	return {
		name: 'shared-cryptpad-vendor',
		enforce: 'pre',
		transform(code, id) {
			const file = id.split('?')[0];
			if (!file.startsWith(CRYPTPAD_VENDOR) || !file.endsWith('.js')) return null;
			const ids = [...new Set([...code.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]))].filter((x) => !x.startsWith('node:'));
			const imports = ids.map((x, i) => `import __req${i} from ${JSON.stringify(x.startsWith('.') && !x.endsWith('.js') ? `${x}.js` : x)};`).join('\n');
			const table = ids.map((x, i) => `${JSON.stringify(x)}: __req${i}`).join(', ');
			return {
				code: `${imports}\nconst module = { exports: {} };\nconst require = (id) => ({ ${table} })[id];\n${code}\nexport default module.exports;\n`,
				map: null
			};
		}
	};
}

// Content-Security-Policy for the static pages (a meta tag; SvelteKit adds the hash of its one
// inline boot script). connect-src stays on https: and wss:; the test build also allows the
// loopback fakes.
const loopback = process.env.OVERKILL_CSP_LOOPBACK === '1' ? ['http://127.0.0.1:*', 'ws://127.0.0.1:*'] : [];
const base = (process.env.BASE_PATH ?? '').replace(/\/+$/, '') as '' | `/${string}`;
const out = process.env.OVERKILL_BUILD_DIR ?? 'build';

// Where the site is served (canonical absolute URLs: og:url, og:image, JSON-LD, sitemap.xml,
// robots.txt, llms.txt). app.html reads it as %sveltekit.env.PUBLIC_SITE_URL%; the text files
// are rendered from site/*.txt|xml templates ({{SITE_URL}}) into this build's own assets
// folder next to a copy of static/, so builds for different URLs never share output.
const SITE_URL = (process.env.SITE_URL ?? 'https://gaussrun.github.io/super-secret-notes').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+(\/[^?#]*)?$/.test(SITE_URL)) throw new Error(`SITE_URL must be an absolute http(s) URL without query or fragment (got ${SITE_URL})`);
process.env.PUBLIC_SITE_URL = SITE_URL;
const assets = path.resolve('.site-assets', path.basename(path.resolve(out)));
mkdirSync(assets, { recursive: true });
cpSync('static', assets, { recursive: true });
for (const f of readdirSync('site')) writeFileSync(path.join(assets, f), readFileSync(path.join('site', f), 'utf8').replaceAll('{{SITE_URL}}', SITE_URL));

export default defineConfig({
	plugins: [
		cliModules(),
		cryptpadVendor(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			adapter: adapter({ pages: out, assets: out, fallback: '404.html', strict: true }),
			paths: { base, relative: true },
			files: { assets },
			alias: { $cli: '../cli/src' },
			csp: {
				mode: 'hash',
				directives: {
					'default-src': ['none'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:'],
					'font-src': ['self'],
					'connect-src': ['self', 'https:', 'wss:', ...loopback] as never[],
					'worker-src': ['self'],
					'manifest-src': ['self'],
					'base-uri': ['none'],
					// 'self' and action="#": forms submit in JS, but some password managers only save
					// credentials from a form that could really submit
					'form-action': ['self'],
					'object-src': ['none']
				}
			}
		})
	],
	server: { fs: { allow: ['..'] } },
	optimizeDeps: {
		include: [
			'@noble/hashes/scrypt.js', '@scure/base', 'age-encryption', 'nostr-tools/nip19', 'nostr-tools/nip44', 'nostr-tools/pure',
			'tweetnacl', 'tweetnacl/nacl-fast', 'tweetnacl-util', 'chainpad', 'chainpad-crypto', 'chainpad-netflux', 'chainpad-listmap', 'netflux-websocket', 'json.sortify', 'nthen'
		]
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: { name: 'node', environment: 'node', include: ['src/**/*.spec.{js,ts}'] }
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'chromium',
					include: ['src/**/*.spec.{js,ts}'],
					// *.node.spec.ts start in-process fake servers
					exclude: ['src/**/*.node.spec.{js,ts}'],
					browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }] }
				}
			}
		]
	}
});
