// Zero-signup default backends (docs/OVERKILL.md, "Defaults: zero-signup first"): hosts one
// command can use with no email, no captcha and no manual signup, and that each add their own
// encryption. Each new vault draws its own at random from known-good pools (pools.js): 4
// PrivateBin instances, 2 CryptPad instances, 4 Nostr relays. Blossom servers do not encrypt, so
// they are opt-in (init --advanced, hosts add); vaults that have them keep them.
import { isVendored } from './backends/cryptpad.js'
import { loadCacheSync, knownHosts, isBuiltIn } from './hosts/cache.js'
import { preferredHosts } from './hosts/pick.js'
import { logger } from './log.js'
import { backendConfig, validVaultName } from './defaults-core.js'
import { pools, drawHosts, TARGETS } from './pools.js'

export { backendConfig, validVaultName }

/**
 * A new vault's backends, drawn at random. With a host cache (`super-secret-notes hosts refresh`)
 * the pools are its hosts not known to be failing (directory finds included); without one, the
 * built-in pools. The configs carry `fallbacks`: the rest of each pool, for setup to try when a
 * drawn host fails.
 */
export function defaultBackends ({ cryptpad = isVendored(), home = null } = {}) {
  // tests and self-hosters can swap the defaults: a JSON array of backend configs
  if (process.env.OVERKILL_DEFAULT_BACKENDS) return JSON.parse(process.env.OVERKILL_DEFAULT_BACKENDS)
  if (!cryptpad) logger.warn('CryptPad left out: its client modules are missing (run overkill/cli/scripts/vendor-cryptpad.sh, then add it with init --advanced)')
  const cache = home ? loadCacheSync(home) : null
  const base = pools()
  const pool = (type) => {
    if (!cache) return base[type]
    const failed = new Set(knownHosts(cache, type).filter((h) => h.status === 'failed').map((h) => h.url))
    // built-in hosts left out of the pools (a broken instance, a relay that bans) stay out
    return preferredHosts(cache, type).filter((u) => !failed.has(u) && (base[type].includes(u) || !isBuiltIn(type, u)))
  }
  const p = { privatebin: pool('privatebin'), cryptpad: cryptpad ? pool('cryptpad') : [], nostr: pool('nostr') }
  const { chosen, rest } = drawHosts(p, { ...TARGETS, cryptpad: cryptpad ? TARGETS.cryptpad : 0 })
  const taken = new Set()
  const configs = [
    ...chosen.privatebin.map((url) => backendConfig('privatebin', url, taken)),
    ...chosen.cryptpad.map((url) => backendConfig('cryptpad', url, taken)),
    // experimental: relays promise no retention, `refresh` keeps them fed
    ...chosen.nostr.map((url) => backendConfig('nostr', url, taken))
  ]
  Object.defineProperty(configs, 'fallbacks', { value: rest, enumerable: false })
  return configs
}
