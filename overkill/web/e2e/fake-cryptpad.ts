// An in-process fake CryptPad instance, enough for Overkill's client (CLI and web):
// - HTTP: /api/config, /customize/application_config.js (with a loginSalt, like both default
//   instances), login blocks under /block/, and the /api/auth challenge protocol for
//   WRITE_BLOCK with real signature checks. Bodies are parsed as JSON or as urlencoded forms
//   (extended), like the real server. CORS like cryptpad.private.coffee: every response has
//   Access-Control-Allow-Origin, but OPTIONS gets a 404 without Allow-Headers, so a browser can
//   only POST forms. `corsOrigin` pins the allowed origin (like crypt.unredacted.org, which
//   only allows its own sandbox), which locks browsers out entirely.
// - WebSocket (/cryptpad_websocket): the netflux protocol (IDENT, JOIN/JACK, MSG, LEAVE, PING),
//   a history keeper (16-char id) that stores channel messages and answers GET_HISTORY with
//   metadata, the messages and {state: 1}, and the RPCs the client uses (COOKIE, PIN, UNPIN,
//   REMOVE_OWNED_CHANNEL, GET_FILE_LIST_SIZE, GET_LIMIT).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import nacl from 'tweetnacl';

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const hex = (n: number) => randomBytes(n).toString('hex');

/** body-parser urlencoded({ extended: true }) for what the client sends: a[b]=c nesting, strings only. */
function parseForm(text: string) {
	const out: Record<string, unknown> = {};
	for (const [key, value] of new URLSearchParams(text)) {
		const path = key.split(/\[|\]\[|\]/).filter(Boolean);
		let o = out as Record<string, unknown>;
		for (const p of path.slice(0, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
		o[path.at(-1)!] = value;
	}
	return out;
}

interface Channel {
	messages: { sender: string; content: string }[];
	metadata: Record<string, unknown> | null;
	members: Set<string>;
	deleted?: boolean;
}

export interface FakeCryptpad {
	url: string;
	blocks: Map<string, Uint8Array>;
	channels: Map<string, Channel>;
	pins: Map<string, Set<string>>;
	authRequests: string[];
	close(): Promise<void>;
}

export async function startFakeCryptpad({ loginSalt = 'fake-instance-salt', corsOrigin = '*' } = {}): Promise<FakeCryptpad> {
	const blocks = new Map<string, Uint8Array>();
	const challenges = new Map<string, string>();
	const channels = new Map<string, Channel>();
	const pins = new Map<string, Set<string>>();
	const authRequests: string[] = [];
	const HK = hex(8); // 16 characters: how clients recognise the history keeper
	let origin = '';

	const server = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const raw = Buffer.concat(chunks).toString();
		res.setHeader('Access-Control-Allow-Origin', corsOrigin);
		const url = new URL(req.url ?? '/', origin);
		const json = (code: number, o: unknown) => {
			res.statusCode = code;
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify(o));
		};
		if (req.method === 'OPTIONS') {
			res.statusCode = 404;
			return res.end();
		}
		if (url.pathname === '/api/config') {
			res.setHeader('Content-Type', 'text/javascript');
			const cfg = { httpUnsafeOrigin: origin, websocketPath: '/cryptpad_websocket', restrictRegistration: false, enforceMFA: false, defaultStorageLimit: 1073741824 };
			return res.end(`define(function(){\nreturn ${JSON.stringify(cfg)};\n});`);
		}
		if (url.pathname === '/customize/application_config.js') {
			res.setHeader('Content-Type', 'text/javascript');
			return res.end(`define(['/common/application_config_internal.js'], function (AppConfig) {\n    AppConfig.loginSalt = '${loginSalt}';\n    AppConfig.minimumPasswordLength = 8;\n    return AppConfig;\n});`);
		}
		const block = /^\/block\/[\w+-]{2}\/([\w+-]{43}=)$/.exec(decodeURIComponent(url.pathname));
		if (block && req.method === 'GET') {
			const bytes = blocks.get(block[1]);
			if (!bytes) return json(404, { error: 'ENOENT' });
			res.setHeader('Content-Type', 'application/octet-stream');
			return res.end(Buffer.from(bytes));
		}
		if (url.pathname.replace(/\/$/, '') === '/api/auth' && req.method === 'POST') {
			const type = req.headers['content-type'] ?? '';
			authRequests.push(type);
			let body: Record<string, unknown>;
			if (/application\/json/.test(type)) body = JSON.parse(raw || '{}');
			else if (/application\/x-www-form-urlencoded/.test(type)) body = parseForm(raw);
			else return json(500, { error: 'invalid request' });
			if (body.txid) {
				const text = challenges.get(String(body.txid));
				if (!text) return json(500, { error: 'Unexpected response' });
				challenges.delete(String(body.txid));
				const ch = JSON.parse(text);
				const ok = nacl.sign.detached.verify(new TextEncoder().encode(text), unb64(String(body.sig)), unb64(ch.publicKey));
				if (!ok) return json(401, { error: 'Invalid signature' });
				const { publicKey, signature, ciphertext } = ch.content;
				const cipher = unb64(ciphertext);
				if (!nacl.sign.detached.verify(nacl.hash(cipher), unb64(signature), unb64(publicKey))) return json(500, { error: 'E_INVALID_BLOCK_SIGNATURE' });
				blocks.set(publicKey.replace(/\//g, '-'), cipher);
				return json(200, {});
			}
			if (body.command !== 'WRITE_BLOCK') return json(500, { error: 'invalid command' });
			const content = body.content as Record<string, string> | undefined;
			if (typeof body.publicKey !== 'string' || body.publicKey.length !== 44 || content?.publicKey !== body.publicKey) return json(500, { error: 'INVALID_KEY' });
			const txid = b64(randomBytes(24));
			const date = new Date().toISOString();
			challenges.set(txid, JSON.stringify({ ...body, txid, date }));
			return json(200, { txid, date });
		}
		json(404, { error: 'not found' });
	});

	const sockets = new Map<string, WebSocket>();
	const send = (id: string, msg: unknown) => sockets.get(id)?.send(JSON.stringify(msg));
	const fromHk = (id: string, content: unknown) => send(id, [0, HK, 'MSG', id, typeof content === 'string' ? content : JSON.stringify(content)]);
	const channel = (id: string) => {
		let c = channels.get(id);
		if (!c) channels.set(id, (c = { messages: [], metadata: null, members: new Set() }));
		return c;
	};

	function historyKeeper(user: string, text: string) {
		let msg: unknown;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (!Array.isArray(msg)) return;
		if (msg[0] === 'GET_HISTORY') {
			const [, chan, cfg] = msg as [string, string, { metadata?: Record<string, unknown> }];
			const c = channel(chan);
			if (c.deleted) return fromHk(user, { error: 'EDELETED', channel: chan });
			if (!c.metadata && !c.messages.length && cfg?.metadata?.validateKey) c.metadata = { ...cfg.metadata, channel: chan };
			if (c.metadata) fromHk(user, c.metadata);
			for (const m of c.messages) fromHk(user, [0, m.sender, 'MSG', chan, m.content]);
			return fromHk(user, { state: 1, channel: chan });
		}
		// RPC: [txid, [sig, edPublic, cookie, type, arg]]
		const [txid, data] = msg as [string, unknown[]];
		if (typeof txid !== 'string' || !Array.isArray(data)) return;
		const [, edPublic, , type, arg] = data as [string, string, string, string, unknown];
		const cookie = `${hex(4)}|${hex(4)}|${hex(4)}`;
		const reply = (...r: unknown[]) => fromHk(user, [txid, cookie, ...r]);
		const pinned = pins.get(edPublic) ?? new Set<string>();
		pins.set(edPublic, pinned);
		switch (type) {
			case 'PIN':
				for (const ch of arg as string[]) pinned.add(ch);
				return reply(hex(16));
			case 'UNPIN':
				for (const ch of arg as string[]) pinned.delete(ch);
				return reply(hex(16));
			case 'REMOVE_OWNED_CHANNEL': {
				const ch = (arg as { channel: string }).channel;
				const c = channels.get(ch);
				const owners = (c?.metadata?.owners as string[] | undefined) ?? [];
				if (!c || !owners.includes(edPublic)) return fromHk(user, [txid, 'ERROR', 'INSUFFICIENT_PERMISSIONS']);
				c.deleted = true;
				c.messages = [];
				return reply('OK');
			}
			case 'GET_FILE_LIST_SIZE':
				return reply(0);
			case 'GET_LIMIT':
				return reply([1073741824, 'fake', 'fake']);
			default:
				return reply();
		}
	}

	const wss = new WebSocketServer({ server, path: '/cryptpad_websocket' });
	wss.on('connection', (ws) => {
		const uid = hex(16);
		sockets.set(uid, ws);
		ws.send(JSON.stringify([0, '', 'IDENT', uid]));
		ws.on('close', () => {
			sockets.delete(uid);
			for (const [id, c] of channels) if (c.members.delete(uid)) for (const m of c.members) send(m, [0, uid, 'LEAVE', id, 'Quit']);
		});
		ws.on('message', (raw: Buffer) => {
			let msg: unknown[];
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			const [seq, cmd] = msg as [number, string];
			if (cmd === 'PING') return send(uid, [seq, 'ACK']);
			if (cmd === 'JOIN') {
				const id = (msg[2] as string) || hex(16);
				const c = channel(id);
				send(uid, [seq, 'JACK', id]);
				send(uid, [0, HK, 'JOIN', id]);
				for (const m of c.members) send(uid, [0, m, 'JOIN', id]);
				c.members.add(uid);
				for (const m of c.members) send(m, [0, uid, 'JOIN', id]);
				return;
			}
			if (cmd === 'LEAVE') {
				const c = channels.get(msg[2] as string);
				send(uid, [seq, 'ACK']);
				if (c?.members.delete(uid)) for (const m of c.members) send(m, [0, uid, 'LEAVE', msg[2], msg[3]]);
				return;
			}
			if (cmd === 'MSG') {
				const [, , target, content] = msg as [number, string, string, string];
				if (target === HK) {
					send(uid, [seq, 'ACK']);
					return historyKeeper(uid, content);
				}
				const c = channels.get(target);
				if (c) {
					if (c.deleted) return send(uid, [seq, 'ERROR', 'EDELETED', target]);
					c.messages.push({ sender: uid, content });
					send(uid, [seq, 'ACK']);
					for (const m of c.members) if (m !== uid) send(m, [0, uid, 'MSG', target, content]);
					return;
				}
				send(uid, [seq, 'ACK']);
				send(target, [0, uid, 'MSG', target, content]);
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address();
	if (!addr || typeof addr === 'string') throw new Error('no port');
	origin = `http://127.0.0.1:${addr.port}`;
	return {
		url: origin,
		blocks,
		channels,
		pins,
		authRequests,
		close: () =>
			new Promise<void>((resolve) => {
				for (const c of wss.clients) c.terminate();
				wss.close();
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}
