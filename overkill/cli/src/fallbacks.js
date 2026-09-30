// Setup fallbacks (docs/OVERKILL.md, "Failure handling"): when a default host fails while a new
// vault is set up, the next known-good host of the same type takes its place, one operator per
// host as always. Shared with the web client.
import { INSTANCES, DEFAULT_COUNT as PB_COUNT, NO_FALLBACK } from './backends/privatebin.js'
import { RELAYS, DEFAULT_COUNT as RELAY_COUNT } from './backends/nostr.js'
import { SERVERS } from './backends/blossom.js'
import { SIGNUP_INSTANCES } from './backends/cryptpad-adapter.js'
import { backendConfig, site } from './defaults-core.js'

// relay.damus.io bans an IP for a while after a few quick writes (docs/NOSTR.md): never a fallback
const NOSTR_SKIP = ['wss://relay.damus.io']

/** Known-good hosts per type, in the order to try them (the defaults come first; used ones are skipped). */
export const FALLBACKS = {
  privatebin: INSTANCES.slice(PB_COUNT).filter((u) => !NO_FALLBACK.includes(u)),
  nostr: RELAYS.slice(RELAY_COUNT).filter((u) => !NOSTR_SKIP.includes(u)),
  cryptpad: SIGNUP_INSTANCES,
  blossom: SERVERS
}

/**
 * Hands out substitutes for failed backends of `cfg` (for Overkill.uploadVault's `next`) and,
 * afterwards, puts the ones that worked into `cfg.backends` in place of the failed ones.
 * @param {{backends: any[]}} cfg the new vault's config (changed in place by apply)
 * @param {object} o
 * @param {(bc: any) => any} o.make an adapter for a backend config
 * @param {Record<string, string[]>} [o.lists] fallback URLs per type
 * @param {string[]} [o.exclude] URLs never to use (e.g. ones a browser cannot reach)
 */
export function fallbackPicker (cfg, { make, lists = FALLBACKS, exclude = [] }) {
  const names = new Set(cfg.backends.map((b) => b.name))
  const sites = new Set(cfg.backends.map((b) => b.url ?? b.origin).filter(Boolean).map(site))
  const made = new Map()
  return {
    next (failed) {
      const bc = cfg.backends.find((b) => b.name === failed.name)
      if (!bc) return null
      for (const url of lists[bc.type] ?? []) {
        if (exclude.includes(url) || sites.has(site(url))) continue
        sites.add(site(url))
        const nb = backendConfig(bc.type, url, names)
        const adapter = make(nb)
        made.set(adapter, nb)
        return adapter
      }
      return null
    },
    /** Swap the configs; returns "old -> new" lines. */
    apply (results) {
      const swaps = new Map(results.filter((r) => r.replaced).map((r) => [r.replaced, made.get(r.backend)]))
      cfg.backends = cfg.backends.map((b) => swaps.get(b.name) ?? b)
      return [...swaps].map(([old, nb]) => `${old} -> ${nb.name} (${nb.url ?? nb.origin})`)
    }
  }
}
