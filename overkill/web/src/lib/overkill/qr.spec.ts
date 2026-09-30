// The QR codes decode back to exactly what was encoded (jsQR, test only), unicode included.
import { describe, expect, test } from 'vitest';
import jsQR from 'jsqr';
import { qrMatrix, handoffLink, parseHandoff, plainText } from './qr';
import { generatePassphrase } from './passphrase';

function decode(text: string) {
	const m = qrMatrix(text);
	const scale = 4;
	const quiet = 4;
	const size = (m.length + 2 * quiet) * scale;
	const px = new Uint8ClampedArray(size * size * 4).fill(255);
	m.forEach((row, r) => row.forEach((dark, c) => {
		if (!dark) return;
		for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
			const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
			px[i] = px[i + 1] = px[i + 2] = 0;
		}
	}));
	const res = jsQR(px, size, size);
	expect(res, 'decodable').toBeTruthy();
	return new TextDecoder().decode(new Uint8Array(res!.binaryData));
}

describe('send to phone', () => {
	const names = ['groceries', 'Einkaufsliste für Oma', 'Café'.normalize('NFD'), '日記 2026', 'emoji 🔐 vault'];

	test('the recovery link round-trips through the QR and the fragment parser', () => {
		for (const name of names) {
			const passphrase = generatePassphrase();
			const link = handoffLink('https://notes.example.org/sub/recover/', name, passphrase);
			expect(link.startsWith('https://notes.example.org/sub/recover/#v=')).toBe(true);
			expect(new URL(link).search).toBe(''); // nothing outside the fragment
			const back = decode(link);
			expect(back).toBe(link);
			expect(parseHandoff(new URL(back).hash)).toEqual({ name, passphrase });
		}
	});

	test('plain text for a password manager round-trips, unicode included', () => {
		for (const name of names) {
			const text = plainText(name, 'abacus zealous quilt mahogany ripcord unloved');
			expect(decode(text)).toBe(text);
			expect(text).toContain(`vault name: ${name}`);
		}
	});

	test('a fragment without both parts is ignored', () => {
		expect(parseHandoff('')).toBeNull();
		expect(parseHandoff('#v=x')).toBeNull();
		expect(parseHandoff('#p=y')).toBeNull();
	});
});
