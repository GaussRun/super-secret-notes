// How a host is shown to people: its product name, a logo where one is cleared for use
// (THIRD_PARTY.md), and its base URL. Internal backend names (pb-envs, cp-private) stay in tooltips.

export const TYPE_NAMES: Record<string, string> = {
	privatebin: 'PrivateBin',
	cryptpad: 'CryptPad',
	nostr: 'Nostr relay',
	blossom: 'Blossom',
	mega: 'MEGA',
	proton: 'Proton Drive',
	filen: 'Filen',
	fileverse: 'Fileverse',
	rclone: 'rclone',
	local: 'Folder'
};

export const TYPE_LOGOS: Record<string, string> = { privatebin: 'privatebin.svg', cryptpad: 'cryptpad.svg', nostr: 'nostr.png' };

export const typeName = (type: string) => TYPE_NAMES[type] ?? type;

/**
 * The host's base URL from an adapter's `where` ("https://x.org drive:/root" for CryptPad): scheme,
 * host and path, never a query or a fragment (a paste URL's #key must never show up here).
 */
export function baseUrl(where: string): string | null {
	try {
		const u = new URL(where.split(' ')[0]);
		return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
	} catch {
		return null;
	}
}

/** Where a link to the host goes: relays (wss://) have their web page on https://. */
export const linkHref = (base: string) => base.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
