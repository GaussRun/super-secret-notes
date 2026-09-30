// The "how a note travels" diagram: one source for the inline component (Diagram.svelte) and the
// standalone static/diagram.svg (scripts/diagram.mjs). Plain SVG markup, no scripts; the moving
// "packets" are SMIL animations the stylesheet hides under prefers-reduced-motion.
// Logos only where their license clears this use (see THIRD_PARTY.md); text badges otherwise.
// The story: our encryption (age + AES-256-GCM) on your device, then each host's native one.
// Host counts are never written here: callers pass them in, derived from the defaults list
// (Diagram.svelte from the web settings, scripts/diagram.mjs from the CLI's defaultBackends).

export type Layout = 'wide' | 'tall';

/** How many default hosts of each kind a new vault gets. */
export interface Counts {
	privatebin: number;
	cryptpad: number;
	nostr: number;
}

export const total = (c: Counts) => c.privatebin + c.cryptpad + c.nostr;
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

export interface HostGroup {
	id: string;
	name: string;
	/** the default count, as shown next to the name */
	count: (c: Counts) => string;
	/** the host's own (native) encryption, or what it does with our copy */
	layer: string;
	logo: string | null; // file name under static/logos/, or null for a text badge
	optIn?: boolean;
}

export const GROUPS: HostGroup[] = [
	{ id: 'privatebin', name: 'PrivateBin', count: (c) => n(c.privatebin, 'instance', 'instances'), layer: 'native: AES-256-GCM, key in the link', logo: 'privatebin.svg' },
	{ id: 'cryptpad', name: 'CryptPad', count: (c) => n(c.cryptpad, 'instance', 'instances'), layer: 'native: XSalsa20-Poly1305', logo: 'cryptpad.svg' },
	{ id: 'nostr', name: 'Nostr', count: (c) => n(c.nostr, 'relay', 'relays'), layer: 'native NIP-44: ChaCha20 + HMAC-SHA256', logo: 'nostr.png' },
	// not defaults: the account services (command line only so far) and Blossom (no encryption of its own)
	{ id: 'optin', name: 'Coming soon', count: () => '', layer: 'MEGA, Proton Drive, Filen, Fileverse, Blossom', logo: null, optIn: true }
];

export const diagramTitle = (c: Counts) => `How a note gets our encryption, then each host's native encryption, on ${n(total(c), 'host', 'hosts')}`;
export const totalLine = (c: Counts) =>
	`${c.privatebin} PrivateBin + ${c.cryptpad} CryptPad + ${n(c.nostr, 'relay', 'relays')} = ${n(total(c), 'copy', 'copies')}`;
export const diagramDesc = (c: Counts) =>
	'Your note exists in plaintext only in your browser or terminal. Our encryption comes first, on your device: age (X25519 and ChaCha20-Poly1305), ' +
	'then AES-256-GCM with keys derived by HKDF, in open-source code (crypto.js). Then copies go to independent hosts, each with its own native encryption: ' +
	`${n(c.privatebin, 'PrivateBin instance', 'PrivateBin instances')} (native AES-256-GCM, key in the link), ${n(c.cryptpad, 'CryptPad instance', 'CryptPad instances')} (native XSalsa20-Poly1305) ` +
	`and ${n(c.nostr, 'Nostr relay', 'Nostr relays')} (native NIP-44: ChaCha20 and HMAC-SHA256): ${n(total(c), 'copy', 'copies')}. ` +
	'Coming soon: MEGA, Proton Drive, Filen, Fileverse and Blossom. ' +
	'Recovery: any one healthy copy plus your vault name and passphrase gives your note back.';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function noteBox(x: number, y: number, w: number, h: number) {
	return `<g class="dg-step dg-note"><rect class="dg-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>` +
		`<text class="dg-title" x="${x + w / 2}" y="${y + h / 2 - 6}" text-anchor="middle">Your note</text>` +
		`<text class="dg-sub" x="${x + w / 2}" y="${y + h / 2 + 14}" text-anchor="middle">plaintext, only on your device</text></g>`;
}

/** Our two layers in one box, clearly applied on the device before anything leaves it. */
function oursBox(x: number, y: number, w: number, h: number) {
	const cx = x + w / 2;
	const top = y + h / 2 - 34;
	return `<g class="dg-step dg-ours-box" data-step="ours"><rect class="dg-box dg-box-ours" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>` +
		`<text class="dg-title" x="${cx}" y="${top}" text-anchor="middle">Our encryption</text>` +
		`<text class="dg-sub" x="${cx}" y="${top + 22}" text-anchor="middle">age (X25519 + ChaCha20-Poly1305)</text>` +
		`<text class="dg-sub" x="${cx}" y="${top + 40}" text-anchor="middle">AES-256-GCM (HKDF keys)</text>` +
		`<text class="dg-hint" x="${cx}" y="${top + 60}" text-anchor="middle">on your device · open source: crypto.js</text></g>`;
}

function badge(x: number, y: number, size: number, g: HostGroup, logoHref: (f: string) => string) {
	const tile = `<rect class="dg-tile" x="${x}" y="${y}" width="${size}" height="${size}" rx="8"/>`;
	if (g.logo) {
		const pad = 5;
		return `${tile}<image class="dg-logo" data-logo="${g.id}" href="${esc(logoHref(g.logo))}" x="${x + pad}" y="${y + pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" preserveAspectRatio="xMidYMid meet"/>`;
	}
	// no cleared logo: a neutral monogram (the name is right next to it), "+N" for the opt-in group
	const label = g.optIn ? `+${g.layer.split(',').length}` : g.name[0];
	const c = size / 2;
	return `${tile}<circle class="dg-mono" data-badge="${g.id}" cx="${x + c}" cy="${y + c}" r="${c - 6}"/>` +
		`<text class="dg-mono-text" x="${x + c}" y="${y + c + 5}" text-anchor="middle">${esc(label)}</text>`;
}

const rowHeight = (_g: HostGroup) => 56;

function hostRow(x: number, y: number, w: number, g: HostGroup, logoHref: (f: string) => string, counts: Counts) {
	const h = rowHeight(g);
	const count = g.count(counts);
	const lines = [`<text class="dg-host-name" x="${x + 58}" y="${y + 24}">${esc(g.name)}${count ? ` <tspan class="dg-count">${esc(count)}</tspan>` : ''}</text>`];
	lines.push(`<text class="dg-layer" data-layer="${g.id}" x="${x + 58}" y="${y + 43}">${esc(g.layer)}</text>`);
	return `<g class="dg-host${g.optIn ? ' dg-optin' : ''}" data-host="${g.id}">` +
		`<rect class="dg-row" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>` +
		badge(x + 8, y + 8, 40, g, logoHref) + lines.join('') + `</g>`;
}

const arrowHead = `<defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="dg-head"/></marker></defs>`;
// hidden until its motion starts (a delayed packet would otherwise sit at the origin)
const packet = (path: string, begin: number, dur = 3.2) =>
	`<circle class="dg-packet" r="5" visibility="hidden"><set attributeName="visibility" to="visible" begin="${begin}s"/><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${path}"/></circle>`;

/** Rows stacked from `top`, `gap` apart, the opt-in group a little further down. */
function stack(top: number, gap: number) {
	let y = top;
	return GROUPS.map((g) => {
		if (g.optIn) y += 10;
		const row = { g, y };
		y += rowHeight(g) + gap;
		return row;
	});
}

/** The whole diagram as SVG markup. `style` is inlined into the <svg> (the standalone file needs it). */
export function diagramSvg(layout: Layout, counts: Counts, { logoHref = (f: string) => `logos/${f}`, style = '', id = 'dg' } = {}) {
	const totalText = `<text class="dg-total" data-total="${total(counts)}"`;
	const parts: string[] = [];
	let w: number;
	let h: number;
	if (layout === 'wide') {
		w = 1000;
		const midY = 200;
		parts.push(noteBox(6, midY - 45, 184, 90));
		parts.push(oursBox(214, midY - 62, 340, 124));
		parts.push(`<path class="dg-line" d="M190 ${midY}H212" marker-end="url(#dg-arrow)"/>`);
		parts.push(`${totalText} x="384" y="${midY + 92}" text-anchor="middle">${esc(totalLine(counts))}</text>`);
		const hx = 640;
		parts.push(`<text class="dg-total" x="${hx}" y="22">Then each product's own (native) encryption</text>`);
		const rows = stack(36, 10);
		for (const { g, y } of rows) {
			const ty = y + 28;
			parts.push(`<path class="dg-line${g.optIn ? ' dg-dashed' : ''}" d="M554 ${midY}C600 ${midY} 600 ${ty} ${hx - 2} ${ty}" marker-end="url(#dg-arrow)"/>`);
			parts.push(hostRow(hx, y, 350, g, logoHref, counts));
		}
		const last = rows[rows.length - 1];
		const ry = last.y + rowHeight(last.g) + 30;
		h = ry + 14;
		parts.push(`<path class="dg-line dg-return" d="M${hx + 175} ${last.y + rowHeight(last.g)}V${ry}H98V${midY + 47}" marker-end="url(#dg-arrow)"/>`);
		parts.push(`<text class="dg-return-text" x="400" y="${ry - 10}" text-anchor="middle">recover: any one healthy copy + your vault name and passphrase = your note back</text>`);
		parts.push(packet(`M190 ${midY}H554`, 0, 2.4));
		rows.slice(0, 4).forEach(({ y }, i) => parts.push(packet(`M554 ${midY}C600 ${midY} 600 ${y + 28} ${hx - 2} ${y + 28}`, 2.4 + i * 0.15, 2.4)));
	} else {
		w = 360;
		const cx = 180;
		parts.push(noteBox(40, 10, 280, 70));
		parts.push(oursBox(40, 108, 280, 124));
		parts.push(`<path class="dg-line" d="M${cx} 80V106" marker-end="url(#dg-arrow)"/>`);
		parts.push(`<text class="dg-total" x="24" y="276">Then each product's native encryption</text>`);
		const rows = stack(288, 12);
		const last = rows[rows.length - 1];
		parts.push(`<path class="dg-line" d="M${cx} 232V252H10V${last.y + 28}"/>`);
		for (const { g, y } of rows) parts.push(`<path class="dg-line${g.optIn ? ' dg-dashed' : ''}" d="M10 ${y + 28}H${22}" marker-end="url(#dg-arrow)"/>`, hostRow(24, y, 304, g, logoHref, counts));
		const bottom = last.y + rowHeight(last.g);
		parts.push(`${totalText} x="${cx}" y="${bottom + 28}" text-anchor="middle">${esc(totalLine(counts))}</text>`);
		const ry = bottom + 54;
		parts.push(`<path class="dg-line dg-return" d="M${cx + 150} ${ry - 16}H346V45H322" marker-end="url(#dg-arrow)"/>`);
		parts.push(`<text class="dg-return-text" x="${cx}" y="${ry + 4}" text-anchor="middle">recover: any one healthy copy + your</text>`);
		parts.push(`<text class="dg-return-text" x="${cx}" y="${ry + 22}" text-anchor="middle">vault name and passphrase = your note back</text>`);
		h = ry + 36;
		parts.push(packet(`M${cx} 80V252H10V${rows[0].y + 28}H22`, 0, 3));
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="${id}-title ${id}-desc" class="dg dg-${layout}">` +
		`<title id="${id}-title">${esc(diagramTitle(counts))}</title><desc id="${id}-desc">${esc(diagramDesc(counts))}</desc>${style ? `<style>${style}</style>` : ''}${arrowHead}${parts.join('')}</svg>`;
}

/** Colors and animation as CSS values (CSS variables in the page, fixed colors in the file). */
export function diagramStyle(c: { text: string; muted: string; line: string; box: string; boxStroke: string; accent: string; row: string; tile: string }) {
	return `.dg{font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;}` +
		`.dg-title{font-weight:700;font-size:15px;fill:${c.text}}.dg-sub,.dg-layer{font-size:11.5px;fill:${c.muted}}.dg-hint{font-size:10.5px;fill:${c.accent}}` +
		`.dg-host-name{font-weight:700;font-size:13.5px;fill:${c.text}}.dg-count{font-weight:400;fill:${c.muted}}` +
		`.dg-total,.dg-return-text{font-size:12.5px;fill:${c.text}}.dg-total{font-weight:700}` +
		`.dg-box{fill:${c.box};stroke:${c.boxStroke};stroke-width:1.5}.dg-note .dg-box{stroke-dasharray:5 4}.dg-box-ours{stroke:${c.accent};stroke-width:2}` +
		`.dg-row{fill:${c.row};stroke:${c.boxStroke};stroke-width:1}.dg-optin{opacity:.72}.dg-optin .dg-layer{font-size:10.5px}.dg-optin .dg-row{stroke-dasharray:4 4}` +
				`.dg-tile{fill:${c.tile};stroke:${c.boxStroke};stroke-width:1}.dg-mono{fill:#e6ebf0}.dg-mono-text{font-weight:700;font-size:14px;fill:#4a5866}` +
		`.dg-line{fill:none;stroke:${c.line};stroke-width:1.6}.dg-dashed{stroke-dasharray:5 4}.dg-return{stroke:${c.accent};stroke-dasharray:6 4}` +
		`.dg-head{fill:${c.line}}.dg-return-text{fill:${c.accent}}.dg-packet{fill:${c.accent}}` +
		`@media (prefers-reduced-motion: reduce){.dg-packet{display:none}}`;
}
