// One paste into /recover/ or the unlock form: every format people copy gives the name and passphrase.
import { describe, expect, test } from 'vitest';
import { parseAccess, looksLikeAccess, parsePasted } from './access';
import { handoffLink, plainText, vaultLinkFor } from './qr';

const NAME = 'velvet-otter-harbor-lantern';
const PASS = 'correct horse battery staple jump over';
const want = { name: NAME, passphrase: PASS };

describe('parseAccess', () => {
	const link = handoffLink('https://gaussrun.github.io/super-secret-notes/recover/', NAME, PASS);
	test('(a) the access link', () => expect(parseAccess(link)).toEqual(want));
	test('(a) the link with spaces around it', () => expect(parseAccess(`  ${link}\n`)).toEqual(want));
	test('(b) just the fragment, with or without #', () => {
		const frag = link.slice(link.indexOf('#'));
		expect(parseAccess(frag)).toEqual(want);
		expect(parseAccess(frag.slice(1))).toEqual(want);
	});
	test('(c) the recovery kit (the CLI sheet, framed) and the QR plain text', () => {
		const kit = ['+----', '| SUPER SECRET NOTES  -  RECOVERY KIT', '|   age identity: AGE-SECRET-KEY-1XYZ', '|   passphrase:   ' + PASS, '|', '|   vault name:   ' + NAME, '+----'].join('\n');
		expect(parseAccess(kit)).toEqual(want);
		expect(parseAccess(plainText(NAME, PASS))).toEqual(want);
	});
	test('(c) a kit with only the access link', () => {
		expect(parseAccess(`vault name: ${NAME}\naccess link: ${link}`)).toEqual(want);
	});
	test('(d) JSON', () => {
		expect(parseAccess(JSON.stringify({ vault: NAME, passphrase: PASS }))).toEqual(want);
		expect(parseAccess(JSON.stringify({ name: NAME, passphrase: PASS }))).toEqual(want);
	});
	test('(e) name and passphrase on two lines', () => expect(parseAccess(`${NAME}\n${PASS}\n`)).toEqual(want));
	test('garbage and half an access give null', () => {
		for (const bad of ['', 'hello', 'https://example.org/', '#v=only-a-name', '{"vault": "x"}', 'one\ntwo\nthree', '{not json', `bad name!\n${PASS}`]) expect(parseAccess(bad), bad).toBeNull();
	});
	test('a plain vault name is not mistaken for a link', () => {
		expect(looksLikeAccess(NAME)).toBe(false);
		expect(looksLikeAccess(link)).toBe(true);
		expect(looksLikeAccess(`${NAME}\n${PASS}`)).toBe(true);
	});
});

describe('parsePasted', () => {
	test('a vault link gives only the name', () => {
		const vl = vaultLinkFor('https://gaussrun.github.io/super-secret-notes/recover/', NAME);
		expect(vl).not.toContain('p=');
		expect(parsePasted(vl)).toEqual({ name: NAME });
		expect(parsePasted(`#v=${NAME}`)).toEqual({ name: NAME });
		expect(parseAccess(vl)).toBeNull();
	});
	test('the full access still gives both', () => {
		expect(parsePasted(handoffLink('https://x.example/recover/', NAME, PASS))).toEqual({ name: NAME, passphrase: PASS });
	});
});
