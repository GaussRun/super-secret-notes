// Password managers: the vault name is the username, the passphrase the password. Forms carry
// the usual autocomplete hints for every manager; where the Credential Management API exists
// (Chromium) the page also stores and offers the credential explicitly. All of it is optional:
// any failure here is ignored, the recovery kit stays the backstop.

const NAME_KEY = 'overkill.vaultName';

/** The vault name this browser holds (not secret: it is the username in the password manager). */
export function rememberedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? '';
	} catch {
		return '';
	}
}

export function rememberName(name: string | null) {
	try {
		if (name) localStorage.setItem(NAME_KEY, name);
		else localStorage.removeItem(NAME_KEY);
	} catch {
		// storage blocked: the unlock form just starts empty
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PasswordCredentialCtor = (): any => (globalThis as any).PasswordCredential;

/** Ask the browser to save (vault name, passphrase), after a setup or recovery that worked. */
export async function storeCredential(vaultName: string, passphrase: string) {
	try {
		const Ctor = PasswordCredentialCtor();
		if (!Ctor || !navigator.credentials?.store) return false;
		await navigator.credentials.store(new Ctor({ id: vaultName, password: passphrase, name: `Super Secret Notes: ${vaultName}` }));
		return true;
	} catch {
		return false;
	}
}

/** A saved credential for this site, if the browser offers one without a prompt; else null. */
export async function savedCredential(): Promise<{ id: string; password: string } | null> {
	try {
		if (!PasswordCredentialCtor() || !navigator.credentials?.get) return null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const c = (await navigator.credentials.get({ password: true, mediation: 'optional' } as any)) as any;
		return c && typeof c.password === 'string' ? { id: String(c.id), password: c.password } : null;
	} catch {
		return null;
	}
}

/** Whether this browser can store a login from the page (PasswordCredential: Chromium only). */
export const canStoreCredential = () => Boolean(PasswordCredentialCtor()) && Boolean(globalThis.navigator?.credentials?.store);
