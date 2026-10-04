// "Send to phone": a recovery link or plain text as a QR code, generated in the page
// (qrcode-generator, bundled; no network, no eval). The link carries the vault name and the
// passphrase in the URL FRAGMENT, which browsers never send to a server; /recover/ strips it
// from the address bar and history as soon as it has read it.
import qrcode from 'qrcode-generator';

/** <recover page URL>#v=<vault name>&p=<passphrase> */
export function handoffLink(recoverUrl: string, vaultName: string, passphrase: string) {
	const u = new URL(recoverUrl);
	u.hash = `v=${encodeURIComponent(vaultName)}&p=${encodeURIComponent(passphrase)}`;
	return u.href;
}

/** <recover page URL>#v=<vault name>: the vault link, which opens nothing without the passphrase. */
export function vaultLinkFor(recoverUrl: string, vaultName: string) {
	const u = new URL(recoverUrl);
	u.hash = `v=${encodeURIComponent(vaultName)}`;
	return u.href;
}

/** The vault name from a vault link's fragment ("#v=..." without p=), or null. */
export function parseVaultName(hash: string): string | null {
	const params = new URLSearchParams(hash.replace(/^#/, ''));
	return params.get('v') && !params.get('p') ? params.get('v') : null;
}

/** The vault name and passphrase from a handoff fragment ("#v=...&p=..."), or null. */
export function parseHandoff(hash: string): { name: string; passphrase: string } | null {
	const params = new URLSearchParams(hash.replace(/^#/, ''));
	const name = params.get('v');
	const passphrase = params.get('p');
	return name && passphrase ? { name, passphrase } : null;
}

/** For password-manager or notes apps that read a scanned text as it is. */
export function plainText(vaultName: string, passphrase: string) {
	return `Super Secret Notes vault\nvault name: ${vaultName}\npassphrase: ${passphrase}`;
}

/** The QR modules for `text` (UTF-8 bytes, error correction M): matrix[row][col] = dark. */
export function qrMatrix(text: string): boolean[][] {
	// the library's byte mode keeps the low byte of each character: hand it one character per UTF-8 byte
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	const qr = qrcode(0, 'M');
	qr.addData(binary, 'Byte');
	qr.make();
	const n = qr.getModuleCount();
	return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** One SVG path for the dark modules, in module units (the caller adds a quiet zone). */
export function qrPath(matrix: boolean[][]) {
	let d = '';
	matrix.forEach((row, r) => row.forEach((dark, c) => {
		if (dark) d += `M${c} ${r}h1v1h-1z`;
	}));
	return d;
}
