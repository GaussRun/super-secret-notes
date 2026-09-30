// Zero-signup default backends (docs/OVERKILL.md, "Defaults: zero-signup first"): hosts one
// command can use with no email, no captcha and no manual signup, and that each add their own
// encryption: 4 PrivateBin instances, 2 CryptPad instances, 4 Nostr relays. Blossom servers do
// not encrypt, so they are opt-in (init --advanced, hosts add); vaults that have them keep them.
import { INSTANCES as PRIVATEBIN, DEFAULT_COUNT as PRIVATEBIN_COUNT } from './backends/privatebin.js'
import { SIGNUP_INSTANCES as CRYPTPAD, isVendored } from './backends/cryptpad.js'
import { RELAYS, DEFAULT_COUNT as RELAY_COUNT } from './backends/nostr.js'
import { loadCacheSync } from './hosts/cache.js'
import { preferredHosts } from './hosts/pick.js'
import { logger } from './log.js'
import { backendConfig, validVaultName } from './defaults-core.js'

export { backendConfig, validVaultName }

// with a host cache (`super-secret-notes hosts refresh`), healthy hosts first; without one, the built-in lists
function pick (cache, type, builtIn, count) {
  return (cache ? preferredHosts(cache, type) : builtIn).slice(0, count)
}

export function defaultBackends ({ cryptpad = isVendored(), home = null } = {}) {
  // tests and self-hosters can swap the defaults: a JSON array of backend configs
  if (process.env.OVERKILL_DEFAULT_BACKENDS) return JSON.parse(process.env.OVERKILL_DEFAULT_BACKENDS)
  if (!cryptpad) logger.warn('CryptPad left out: its client modules are missing (run overkill/cli/scripts/vendor-cryptpad.sh, then add it with init --advanced)')
  const cache = home ? loadCacheSync(home) : null
  const taken = new Set()
  return [
    ...pick(cache, 'privatebin', PRIVATEBIN, PRIVATEBIN_COUNT).map((url) => backendConfig('privatebin', url, taken)),
    ...(cryptpad ? pick(cache, 'cryptpad', CRYPTPAD, CRYPTPAD.length) : []).map((url) => backendConfig('cryptpad', url, taken)),
    // experimental: relays promise no retention, `refresh` keeps them fed
    ...pick(cache, 'nostr', RELAYS, RELAY_COUNT).map((url) => backendConfig('nostr', url, taken))
  ]
}
