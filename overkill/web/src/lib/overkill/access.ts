// One paste to get into a vault: whatever the user copied (the access link, its fragment, the
// recovery kit file, the plain text of the QR, a small JSON, or name and passphrase on two lines)
// becomes the vault name and passphrase. Nothing here logs or sends anything.
import { parseHandoff } from './qr';
import { validVaultName } from '$cli/defaults-core.js';

export interface Access {
	name: string;
	passphrase: string;
}

const clean = (a: { name?: unknown; passphrase?: unknown } | null): Access | null => {
	const name = typeof a?.name === 'string' ? a.name.trim() : '';
	const passphrase = typeof a?.passphrase === 'string' ? a.passphrase.trim() : '';
	return name && passphrase && validVaultName(name) ? { name: name.normalize('NFC'), passphrase } : null;
};

/** The vault name and passphrase in `input`, or null. */
export function parseAccess(input: string): Access | null {
	const text = (input ?? '').trim();
	if (!text) return null;
	// (a) and (b): the access link, or just its fragment ("#v=...&p=..." or "v=...&p=...")
	const hashAt = text.indexOf('#');
	const frag = hashAt >= 0 ? text.slice(hashAt) : /^v=.+&p=/.test(text) ? text : null;
	if (frag && !text.includes('\n')) {
		const h = parseHandoff(frag);
		if (h) return clean(h);
	}
	// (d): {"vault": "...", "passphrase": "..."} (or "name")
	if (text.startsWith('{')) {
		try {
			const o = JSON.parse(text) as Record<string, unknown>;
			return clean({ name: o.vault ?? o.name ?? o.vaultName, passphrase: o.passphrase });
		} catch {
			return null;
		}
	}
	// (c): the recovery kit (CLI or web) or the QR's plain text: "vault name: ..." and "passphrase: ..." lines
	const line = (label: string) => new RegExp(`^[\\s|]*${label}:[ \\t]*(.+?)[ \\t]*$`, 'mi').exec(text)?.[1];
	const kitName = line('vault name');
	const kitPass = line('passphrase');
	if (kitName || kitPass) {
		const fromKit = clean({ name: kitName, passphrase: kitPass });
		if (fromKit) return fromKit;
		// a kit with an access link but no passphrase line
		const link = /https?:\/\/\S+#v=\S+/.exec(text)?.[0];
		return link ? parseAccess(link) : null;
	}
	// (e): name on the first line, passphrase on the second
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (lines.length === 2) return clean({ name: lines[0], passphrase: lines[1] });
	return null;
}

/** True when `value` looks like more than a vault name (a link, a kit, JSON), so a name field should split it. */
export const looksLikeAccess = (value: string) => /#v=|^v=.+&p=|\n|^\s*\{/.test(value);
