// CryptPad. Speaks CryptPad's own protocol headlessly, reusing its AGPL client modules
// (committed under cryptpad/vendor, see THIRD_PARTY.md; scripts/vendor-cryptpad.sh updates them).
// Each file becomes an owned, pinned code pad in drive folder <root>/<dirs>, body = base64.
// Caveats: accounts with 2FA cannot log in headlessly, and overwriting a pad in place is slow, so
// every write is a fresh pad (see cryptpad/drive.js).
// Everything CryptPad-specific is loaded lazily, so the rest of the CLI never depends on it.
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveSecret } from '../secrets.js'
import { SIGNUP_INSTANCES, createCryptpad } from './cryptpad-adapter.js'

export { SIGNUP_INSTANCES, travelsWithSecrets, operator } from './cryptpad-adapter.js'

export const info = {
  title: 'CryptPad',
  blurb: 'Collaborative office suite, end-to-end encrypted. Either accounts made for you on instances that allow automated signup (username and password derived from your vault, nothing to keep), or your own account (no 2FA; experimental).',
  signup: 'https://cryptpad.fr/register/'
}

/** init --advanced: the derived accounts (like the zero-signup defaults), or your own account. */
export async function promptMany (ask, askYesNo, askSecret) {
  const hosts = SIGNUP_INSTANCES.map((o) => new URL(o).host)
  if (await askYesNo(`  Accounts made for you on ${hosts.join(' and ')}, derived from your vault?`, true)) {
    return SIGNUP_INSTANCES.map((origin) => ({
      name: 'cp-' + new URL(origin).host.replace(/^(cryptpad|crypt|pad)\./, '').split('.')[0], type: 'cryptpad', origin, derived: true
    }))
  }
  return [{ name: 'cryptpad', type: 'cryptpad', ...await prompt(ask, askSecret) }]
}

export async function prompt (ask, askSecret) {
  const origin = (await ask('  CryptPad instance [https://cryptpad.fr]: ')) || 'https://cryptpad.fr'
  const user = await ask('  CryptPad username: ')
  const password = await askSecret('  CryptPad password (stored encrypted in secrets.ovk; or type env:VARNAME to keep it outside): ')
  return { origin, user, password: password.startsWith('env:') ? { env: password.slice(4) } : password }
}

const VENDOR = fileURLToPath(new URL('./cryptpad/vendor/cryptpad/common-hash.js', import.meta.url))
export const isVendored = () => existsSync(VENDOR)

async function loadDrive () {
  if (!await access(VENDOR).then(() => true, () => false)) {
    throw new Error('the cryptpad backend is missing CryptPad\'s client modules: run overkill/cli/scripts/vendor-cryptpad.sh')
  }
  try {
    return await import('./cryptpad/drive.js')
  } catch (err) {
    throw new Error(`the cryptpad backend could not load its dependencies (${err.message}); run pnpm install`)
  }
}

export function create (cfg, ctx) {
  return createCryptpad(cfg, ctx, { loadDrive, resolveSecret })
}
