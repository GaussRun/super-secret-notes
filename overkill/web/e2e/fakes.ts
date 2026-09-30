// In-process fake hosts for the browser tests, with CORS behaving like the real ones:
// - PrivateBin answers JSON (with Access-Control-Allow-Origin: *) only to requests it detects
//   as JSON clients (X-Requested-With or Accept: application/json), parses any POST body as
//   JSON whatever its Content-Type, and answers no preflight (the real ones serve their HTML
//   page to OPTIONS, without CORS headers). So only CORS simple requests work from a page.
// - Blossom answers preflights (BUD-01: any origin, Authorization and X-SHA-256 allowed) and
//   checks the kind 24242 authorization of uploads and deletes.
// - The Nostr relay keeps addressable events (newest created_at wins, tie to the lowest id) and
//   refuses events over 64 KiB, like strfry.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { startFakeCryptpad } from './fake-cryptpad';

async function listen(server: http.Server) {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address();
	if (!addr || typeof addr === 'string') throw new Error('no port');
	return `http://127.0.0.1:${addr.port}`;
}

async function body(req: http.IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const ch of req) chunks.push(ch as Buffer);
	return Buffer.concat(chunks);
}

const close = (server: http.Server) =>
	new Promise<void>((resolve) => {
		server.closeAllConnections();
		server.close(() => resolve());
	});

export interface FakePrivatebin {
	url: string;
	pastes: Map<string, { adata: unknown; ct: string; deletetoken: string }>;
	requests: string[];
	close(): Promise<void>;
}

export async function startFakePrivatebin(): Promise<FakePrivatebin> {
	const pastes: FakePrivatebin['pastes'] = new Map();
	const requests: string[] = [];
	const server = http.createServer(async (req, res) => {
		const raw = await body(req);
		requests.push(`${req.method} ${req.url}`);
		const json = req.headers['x-requested-with'] === 'JSONHttpRequest' || /application\/json/.test(req.headers.accept ?? '');
		if (req.method === 'OPTIONS' || !json) {
			res.setHeader('Content-Type', 'text/html');
			return res.end('<html><title>PrivateBin</title><select id="pasteExpiration"><option value="never">Never</option></select></html>');
		}
		const send = (o: unknown) => {
			res.setHeader('Content-Type', 'application/json');
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.end(JSON.stringify(o));
		};
		if (req.method === 'POST') {
			let b: Record<string, unknown>;
			try {
				b = JSON.parse(raw.toString());
			} catch {
				return send({ status: 1, message: 'Invalid data.' });
			}
			if (b.pasteid) {
				const p = pastes.get(String(b.pasteid));
				if (!p) return send({ status: 1, message: 'Document does not exist, has expired or has been deleted.' });
				if (p.deletetoken !== b.deletetoken) return send({ status: 1, message: 'Wrong deletion token. Document was not deleted.' });
				pastes.delete(String(b.pasteid));
				return send({ status: 0, id: b.pasteid });
			}
			const id = randomBytes(8).toString('hex');
			const deletetoken = randomBytes(32).toString('hex');
			pastes.set(id, { adata: b.adata, ct: String(b.ct), deletetoken });
			return send({ status: 0, id, url: `/?${id}`, deletetoken });
		}
		const id = new URL(req.url ?? '/', 'http://x').searchParams.get('pasteid');
		const p = id ? pastes.get(id) : null;
		if (!p) return send({ status: 1, message: 'Document does not exist, has expired or has been deleted.' });
		return send({ status: 0, id, v: 2, adata: p.adata, ct: p.ct, meta: {} });
	});
	const url = await listen(server);
	return { url, pastes, requests, close: () => close(server) };
}

export interface FakeBlossom {
	url: string;
	blobs: Map<string, Buffer>;
	requests: string[];
	close(): Promise<void>;
}

function blossomAuth(header: string | undefined, verb: string, sha?: string): string | null {
	if (!header?.startsWith('Nostr ')) return 'missing authorization';
	let ev: Event;
	try {
		ev = JSON.parse(Buffer.from(header.slice(6), 'base64').toString());
	} catch {
		return 'bad authorization';
	}
	if (ev.kind !== 24242 || !verifyEvent(ev)) return 'invalid kind or signature';
	if (!ev.tags.some((t) => t[0] === 't' && t[1] === verb)) return `not a ${verb} authorization`;
	if (sha && !ev.tags.some((t) => t[0] === 'x' && t[1] === sha)) return 'authorization is for another blob';
	const exp = Number(ev.tags.find((t) => t[0] === 'expiration')?.[1] ?? 0);
	if (exp < Date.now() / 1000) return 'authorization expired';
	return null;
}

export async function startFakeBlossom(): Promise<FakeBlossom> {
	const blobs = new Map<string, Buffer>();
	const requests: string[] = [];
	const server = http.createServer(async (req, res) => {
		const raw = await body(req);
		requests.push(`${req.method} ${req.url}`);
		res.setHeader('Access-Control-Allow-Origin', '*');
		if (req.method === 'OPTIONS') {
			res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-SHA-256, X-Content-Type, X-Content-Length');
			res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE');
			res.statusCode = 204;
			return res.end();
		}
		const fail = (code: number, reason: string) => {
			res.statusCode = code;
			res.setHeader('X-Reason', reason);
			res.end();
		};
		if (req.method === 'PUT' && req.url === '/upload') {
			const sha = createHash('sha256').update(raw).digest('hex');
			const why = blossomAuth(req.headers.authorization, 'upload', sha);
			if (why) return fail(401, why);
			blobs.set(sha, raw);
			res.setHeader('Content-Type', 'application/json');
			return res.end(JSON.stringify({ sha256: sha, size: raw.length, url: `http://x/${sha}`, uploaded: Math.floor(Date.now() / 1000) }));
		}
		const sha = (req.url ?? '/').slice(1).replace(/\..*$/, '');
		if (req.method === 'DELETE') {
			const why = blossomAuth(req.headers.authorization, 'delete');
			if (why) return fail(401, why);
			blobs.delete(sha);
			res.statusCode = 204;
			return res.end();
		}
		const blob = blobs.get(sha);
		if (!blob) return fail(404, 'not found');
		res.setHeader('Content-Type', 'application/octet-stream');
		res.end(blob);
	});
	const url = await listen(server);
	return { url, blobs, requests, close: () => close(server) };
}

export interface FakeRelay {
	url: string;
	store: Map<string, Event>;
	close(): Promise<void>;
}

const dOf = (ev: Event) => ev.tags.find((t) => t[0] === 'd')?.[1];
type Filter = { kinds?: number[]; authors?: string[]; ids?: string[]; '#d'?: string[]; limit?: number };
const matches = (ev: Event, f: Filter) =>
	(!f.kinds || f.kinds.includes(ev.kind)) &&
	(!f.authors || f.authors.includes(ev.pubkey)) &&
	(!f.ids || f.ids.includes(ev.id)) &&
	(!f['#d'] || f['#d'].includes(dOf(ev) ?? ''));

export async function startFakeRelay(): Promise<FakeRelay> {
	const store = new Map<string, Event>();
	const server = http.createServer((_req, res) => {
		res.setHeader('Content-Type', 'application/nostr+json');
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.end(JSON.stringify({ name: 'fake relay', software: 'overkill-e2e' }));
	});
	const wss = new WebSocketServer({ server });
	wss.on('connection', (ws) => {
		const send = (m: unknown) => ws.send(JSON.stringify(m));
		ws.on('message', (raw: Buffer) => {
			let msg: unknown[];
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return send(['NOTICE', 'bad json']);
			}
			if (msg[0] === 'EVENT') {
				const ev = msg[1] as Event;
				if (raw.length > 65536) return send(['OK', ev.id, false, `invalid: event too large: ${raw.length}`]);
				if (!verifyEvent(ev)) return send(['OK', ev.id, false, 'invalid: bad signature']);
				const key = ev.kind >= 30000 && ev.kind < 40000 ? `${ev.kind}:${ev.pubkey}:${dOf(ev)}` : ev.id;
				const cur = store.get(key);
				if (cur && (cur.created_at > ev.created_at || (cur.created_at === ev.created_at && cur.id <= ev.id))) {
					return send(['OK', ev.id, true, 'duplicate: have a newer event']);
				}
				store.set(key, ev);
				return send(['OK', ev.id, true, '']);
			}
			if (msg[0] === 'REQ') {
				const [, id, ...filters] = msg as [string, string, ...Filter[]];
				const hits = [...store.values()].filter((ev) => filters.some((f) => matches(ev, f))).sort((a, b) => b.created_at - a.created_at);
				const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
				for (const ev of hits.slice(0, limit)) send(['EVENT', id, ev]);
				send(['EOSE', id]);
			}
		});
	});
	const url = (await listen(server)).replace(/^http/, 'ws');
	return {
		url,
		store,
		close: () =>
			new Promise<void>((resolve) => {
				for (const c of wss.clients) c.terminate();
				wss.close();
				server.close(() => resolve());
			})
	};
}

export type Fakes = Awaited<ReturnType<typeof startAllFakes>>;

/** Two PrivateBin instances, a CryptPad instance, two relays (they also hold the recovery records), one Blossom server. */
export async function startAllFakes() {
	const pb = [await startFakePrivatebin(), await startFakePrivatebin()];
	const cryptpad = [await startFakeCryptpad()];
	const relays = [await startFakeRelay(), await startFakeRelay()];
	const blossom = [await startFakeBlossom()];
	const hosts = {
		privatebin: pb.map((x) => x.url),
		nostr: relays.map((x) => x.url),
		blossom: blossom.map((x) => x.url),
		cryptpad: cryptpad.map((x) => x.url),
		discovery: relays.map((x) => x.url),
		nostrPauseMs: 0
	};
	return {
		pb,
		cryptpad,
		relays,
		blossom,
		hosts,
		close: () => Promise.all([...pb, ...cryptpad, ...relays, ...blossom].map((x) => x.close()))
	};
}
