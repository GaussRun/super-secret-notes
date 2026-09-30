// The "how a note travels" diagram: one source for the inline component (Diagram.svelte) and the
// standalone static/diagram.svg (scripts/diagram.mjs). Plain SVG markup, no scripts; the moving
// "packets" are SMIL animations the stylesheet hides under prefers-reduced-motion.
// Logos only where their license clears this use (see THIRD_PARTY.md); text badges otherwise.

export type Layout = 'wide' | 'tall';

export interface HostGroup {
	id: string;
	name: string;
	count: string;
	layer: string;
	logo: string | null; // file name under static/logos/, or null for a text badge
	optIn?: boolean;
}

export const GROUPS: HostGroup[] = [
	{ id: 'privatebin', name: 'PrivateBin', count: '3 instances', layer: 'AES-256-GCM, key in the link', logo: 'privatebin.svg' },
	{ id: 'cryptpad', name: 'CryptPad', count: '2 instances', layer: 'XSalsa20-Poly1305', logo: 'cryptpad.svg' },
	{ id: 'nostr', name: 'Nostr', count: '4 relays', layer: 'NIP-44 (ChaCha20, HMAC-SHA256)', logo: null },
	{ id: 'blossom', name: 'Blossom', count: '3 servers', layer: 'none by the host: our own AES-256-GCM', logo: null },
	{ id: 'optin', name: 'Opt-in accounts', count: 'own encryption', layer: 'MEGA, Proton Drive, Filen, Fileverse', logo: null, optIn: true }
];

export const TITLE = 'How a note is encrypted twice and scattered to a dozen hosts';
export const DESC =
	'Your note exists in plaintext only in your browser or terminal. Layer 1: age encryption (X25519 and ChaCha20-Poly1305). ' +
	'Layer 2: AES-256-GCM with keys derived by HKDF-SHA256 in our code. The result is copied to independent hosts, each adding its own layer: ' +
	'3 PrivateBin instances (AES-256-GCM, key in the link), 2 CryptPad instances (XSalsa20-Poly1305), 4 Nostr relays (NIP-44), ' +
	'3 Blossom servers (no host encryption, so we add an extra AES-256-GCM layer): 12 copies. Opt-in: MEGA, Proton Drive, Filen and Fileverse with their own client-side encryption. ' +
	'Recovery: any one healthy copy plus your vault name and passphrase gives your note back.';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function box(x: number, y: number, w: number, h: number, title: string, sub: string, cls = '') {
	return `<g class="dg-step ${cls}"><rect class="dg-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>` +
		`<text class="dg-title" x="${x + w / 2}" y="${y + h / 2 - 6}" text-anchor="middle">${esc(title)}</text>` +
		`<text class="dg-sub" x="${x + w / 2}" y="${y + h / 2 + 14}" text-anchor="middle">${esc(sub)}</text></g>`;
}

function badge(x: number, y: number, size: number, g: HostGroup, logoHref: (f: string) => string) {
	const tile = `<rect class="dg-tile" x="${x}" y="${y}" width="${size}" height="${size}" rx="8"/>`;
	if (g.logo) {
		const pad = 5;
		return `${tile}<image class="dg-logo" data-logo="${g.id}" href="${esc(logoHref(g.logo))}" x="${x + pad}" y="${y + pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" preserveAspectRatio="xMidYMid meet"/>`;
	}
	const label = g.optIn ? '+4' : g.name;
	const fs = label.length > 5 ? 9 : 11;
	return `${tile}<text class="dg-badge" data-badge="${g.id}" x="${x + size / 2}" y="${y + size / 2 + fs / 3}" text-anchor="middle" font-size="${fs}">${esc(label)}</text>`;
}

function hostRow(x: number, y: number, w: number, g: HostGroup, logoHref: (f: string) => string) {
	return `<g class="dg-host${g.optIn ? ' dg-optin' : ''}" data-host="${g.id}">` +
		`<rect class="dg-row" x="${x}" y="${y}" width="${w}" height="56" rx="10"/>` +
		badge(x + 8, y + 8, 40, g, logoHref) +
		`<text class="dg-host-name" x="${x + 58}" y="${y + 24}">${esc(g.name)} <tspan class="dg-count">${esc(g.count)}</tspan></text>` +
		`<text class="dg-layer" x="${x + 58}" y="${y + 43}">${esc(g.layer)}</text></g>`;
}

const arrowHead = `<defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="dg-head"/></marker></defs>`;
// hidden until its motion starts (a delayed packet would otherwise sit at the origin)
const packet = (path: string, begin: number, dur = 3.2) =>
	`<circle class="dg-packet" r="5" visibility="hidden"><set attributeName="visibility" to="visible" begin="${begin}s"/><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${path}"/></circle>`;

/** The whole diagram as SVG markup. `style` is inlined into the <svg> (the standalone file needs it). */
export function diagramSvg(layout: Layout, { logoHref = (f: string) => `logos/${f}`, style = '', id = 'dg' } = {}) {
	const parts: string[] = [];
	let w: number;
	let h: number;
	if (layout === 'wide') {
		w = 1000;
		h = 470;
		const midY = 200;
		parts.push(box(6, midY - 45, 184, 90, 'Your note', 'plaintext, only on your device', 'dg-note'));
		parts.push(box(214, midY - 45, 172, 90, 'Layer 1: age', 'X25519 + ChaCha20-Poly1305'));
		parts.push(box(410, midY - 45, 180, 90, 'Layer 2: AES-256-GCM', 'HKDF-SHA256 keys, our code'));
		parts.push(`<path class="dg-line" d="M190 ${midY}H212" marker-end="url(#dg-arrow)"/><path class="dg-line" d="M386 ${midY}H408" marker-end="url(#dg-arrow)"/>`);
		parts.push(`<text class="dg-total" x="298" y="${midY + 80}" text-anchor="middle">3 PrivateBin + 2 CryptPad + 4 relays + 3 Blossom = 12 copies</text>`);
		const hx = 640;
		parts.push(`<text class="dg-total" x="${hx}" y="22">Layer 3: each host adds its own</text>`);
		const rows = GROUPS.map((g, i) => ({ g, y: 36 + i * 66 + (g.optIn ? 12 : 0) }));
		for (const { g, y } of rows) {
			const ty = y + 28;
			parts.push(`<path class="dg-line${g.optIn ? ' dg-dashed' : ''}" d="M590 ${midY}C615 ${midY} 615 ${ty} ${hx - 2} ${ty}" marker-end="url(#dg-arrow)"/>`);
			parts.push(hostRow(hx, y, 350, g, logoHref));
		}
		// the way back
		const ry = rows[4].y + 86;
		h = ry + 14;
		parts.push(`<path class="dg-line dg-return" d="M${hx + 175} ${rows[4].y + 58}V${ry}H98V${midY + 47}" marker-end="url(#dg-arrow)"/>`);
		parts.push(`<text class="dg-return-text" x="400" y="${ry - 10}" text-anchor="middle">recover: any one healthy copy + your vault name and passphrase = your note back</text>`);
		parts.push(packet(`M190 ${midY}H590`, 0, 2.4));
		rows.slice(0, 4).forEach(({ y }, i) => parts.push(packet(`M590 ${midY}C615 ${midY} 615 ${y + 28} ${hx - 2} ${y + 28}`, 2.4 + i * 0.15, 2.4)));
	} else {
		w = 360;
		h = 900;
		const cx = 180;
		parts.push(box(40, 10, 280, 70, 'Your note', 'plaintext, only on your device', 'dg-note'));
		parts.push(box(40, 110, 280, 70, 'Layer 1: age', 'X25519 + ChaCha20-Poly1305'));
		parts.push(box(40, 210, 280, 70, 'Layer 2: AES-256-GCM', 'HKDF-SHA256 keys, our code'));
		parts.push(`<path class="dg-line" d="M${cx} 80V108" marker-end="url(#dg-arrow)"/><path class="dg-line" d="M${cx} 180V208" marker-end="url(#dg-arrow)"/>`);
		parts.push(`<text class="dg-total" x="24" y="328">Layer 3: each host adds its own</text>`);
		const rows = GROUPS.map((g, i) => ({ g, y: 340 + i * 68 + (g.optIn ? 10 : 0) }));
		parts.push(`<path class="dg-line" d="M${cx} 280V300H10V${rows[4].y + 28}"/>`);
		for (const { g, y } of rows) parts.push(`<path class="dg-line${g.optIn ? ' dg-dashed' : ''}" d="M10 ${y + 28}H${22}" marker-end="url(#dg-arrow)"/>`, hostRow(24, y, 304, g, logoHref));
		parts.push(`<text class="dg-total" x="${cx}" y="${rows[4].y + 84}" text-anchor="middle">3 PrivateBin + 2 CryptPad + 4 relays</text>`);
		parts.push(`<text class="dg-total" x="${cx}" y="${rows[4].y + 102}" text-anchor="middle">+ 3 Blossom = 12 copies</text>`);
		const ry = rows[4].y + 128;
		parts.push(`<path class="dg-line dg-return" d="M${cx + 150} ${ry - 16}H346V45H322" marker-end="url(#dg-arrow)"/>`);
		parts.push(`<text class="dg-return-text" x="${cx}" y="${ry + 4}" text-anchor="middle">recover: any one healthy copy + your</text>`);
		parts.push(`<text class="dg-return-text" x="${cx}" y="${ry + 22}" text-anchor="middle">vault name and passphrase = your note back</text>`);
		h = ry + 36;
		parts.push(packet(`M${cx} 80V300H10V${rows[0].y + 28}H22`, 0, 3));
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="${id}-title ${id}-desc" class="dg dg-${layout}">` +
		`<title id="${id}-title">${esc(TITLE)}</title><desc id="${id}-desc">${esc(DESC)}</desc>${style ? `<style>${style}</style>` : ''}${arrowHead}${parts.join('')}</svg>`;
}

/** Colors and animation: `line`/`text`/`box` etc. as CSS values (currentColor in the page). */
export function diagramStyle(c: { text: string; muted: string; line: string; box: string; boxStroke: string; accent: string; row: string; tile: string }) {
	return `.dg{font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;}` +
		`.dg-title{font-weight:700;font-size:15px;fill:${c.text}}.dg-sub,.dg-layer{font-size:11.5px;fill:${c.muted}}` +
		`.dg-host-name{font-weight:700;font-size:13.5px;fill:${c.text}}.dg-count{font-weight:400;fill:${c.muted}}` +
		`.dg-total,.dg-return-text{font-size:12.5px;fill:${c.text}}.dg-total{font-weight:700}` +
		`.dg-box{fill:${c.box};stroke:${c.boxStroke};stroke-width:1.5}.dg-note .dg-box{stroke-dasharray:5 4}` +
		`.dg-row{fill:${c.row};stroke:${c.boxStroke};stroke-width:1}.dg-optin{opacity:.72}.dg-optin .dg-row{stroke-dasharray:4 4}` +
		`.dg-tile{fill:${c.tile};stroke:${c.boxStroke};stroke-width:1}.dg-badge{font-weight:700;fill:#1b2430}` +
		`.dg-line{fill:none;stroke:${c.line};stroke-width:1.6}.dg-dashed{stroke-dasharray:5 4}.dg-return{stroke:${c.accent};stroke-dasharray:6 4}` +
		`.dg-head{fill:${c.line}}.dg-return-text{fill:${c.accent}}.dg-packet{fill:${c.accent}}` +
		`@media (prefers-reduced-motion: reduce){.dg-packet{display:none}}`;
}
