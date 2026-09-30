// A plain static file server for the built site, the way GitHub Pages serves it: under a base
// path, <dir>/index.html for directory URLs, and 404.html (the SPA fallback) for anything else.
// Usage: node e2e/serve.mjs <build dir> <base path> <port>
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const [dir = 'build', base = '', port = '4173'] = process.argv.slice(2);
const root = path.resolve(dir);
const types = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
	'.json': 'application/json',
	'.xml': 'application/xml',
	'.txt': 'text/plain',
	'.png': 'image/png',
	'.woff2': 'font/woff2'
};

async function file(p) {
	const s = await stat(p).catch(() => null);
	if (s?.isFile()) return p;
	if (s?.isDirectory()) return file(path.join(p, 'index.html'));
	return null;
}

http
	.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		let rel = decodeURIComponent(url.pathname);
		if (base && rel === base) {
			res.writeHead(301, { Location: `${base}/` });
			return res.end();
		}
		if (base && !rel.startsWith(`${base}/`)) {
			res.writeHead(404);
			return res.end('not under the base path');
		}
		rel = rel.slice(base.length);
		const target = path.join(root, rel);
		const found = target.startsWith(root) ? await file(target) : null;
		// a directory without its trailing slash: redirect, like GitHub Pages
		if (found && !rel.endsWith('/') && found === path.join(target, 'index.html')) {
			res.writeHead(301, { Location: `${base}${rel}/` });
			return res.end();
		}
		const out = found ?? path.join(root, '404.html');
		res.writeHead(found ? 200 : 404, { 'Content-Type': types[path.extname(out)] ?? 'application/octet-stream' });
		res.end(await readFile(out));
	})
	.listen(Number(port), '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}${base}/`));
