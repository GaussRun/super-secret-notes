// New vaults do not all sit on the same hosts (docs/OVERKILL.md, "Defaults"): each one draws its
// hosts at random from known-good pools, per type, one operator per host, with at least one of
// each type and at least one host that keeps the index. The recovery record does not depend on
// the draw: it always goes to the fixed DISCOVERY_RELAYS (bootstrap.js) as well. Shared with the
// web client, which passes browser-only pools.
import { INSTANCES, NO_FALLBACK, NO_BROWSER } from './backends/privatebin.js'
import { RELAYS } from './backends/nostr.js'
import { SIGNUP_INSTANCES } from './backends/cryptpad-adapter.js'
import { site } from './defaults-core.js'

// relay.damus.io bans an IP for a while after a few quick writes (docs/NOSTR.md): never drawn
const NOSTR_SKIP = ['wss://relay.damus.io']

/** @typedef {{ privatebin: string[], cryptpad: string[], nostr: string[] }} Pools */

/** How many hosts of each type a new vault gets (fewer when the pool is smaller). */
export const TARGETS = { privatebin: 4, cryptpad: 2, nostr: 4 }

/** Types whose hosts keep the index (paste hosts never do). */
export const INDEX_TYPES = ['cryptpad', 'nostr']

/**
 * The known-good pools. `browser`: only hosts a web page can use (PrivateBin instances that take
 * posts from a page; CryptPad instances whose API allows other origins, `cryptpadNoBrowser`).
 */
/** @returns {Pools} */
export function pools ({ browser = false, cryptpadNoBrowser = /** @type {string[]} */ ([]) } = {}) {
  return {
    privatebin: INSTANCES.filter((u) => !NO_FALLBACK.includes(u) && !(browser && NO_BROWSER.includes(u))),
    cryptpad: SIGNUP_INSTANCES.filter((u) => !(browser && cryptpadNoBrowser.includes(new URL(u).host))),
    nostr: RELAYS.filter((u) => !NOSTR_SKIP.includes(u))
  }
}

/** A uniform integer in [0, n) from crypto.getRandomValues (rejection sampling, no modulo bias). */
export function randomBelow (n) {
  if (n <= 1) return 0
  const limit = Math.floor(0x100000000 / n) * n
  for (;;) {
    const [x] = globalThis.crypto.getRandomValues(new Uint32Array(1))
    if (x < limit) return x % n
  }
}

/** A shuffled copy (Fisher-Yates). */
export function shuffled (list, random = randomBelow) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * How many of each type a draw from these pools gives (the targets, capped by the pool).
 * @param {Pools} p
 * @returns {{ privatebin: number, cryptpad: number, nostr: number }}
 */
export function targetCounts (p, targets = TARGETS) {
  return { privatebin: Math.min(targets.privatebin, p.privatebin.length), cryptpad: Math.min(targets.cryptpad, p.cryptpad.length), nostr: Math.min(targets.nostr, p.nostr.length) }
}

/**
 * Draw a new vault's hosts: per type, the target count from its pool in random order, skipping a
 * second host of an operator already drawn. -> { chosen: {type: urls}, rest: {type: urls} }, where
 * `rest` (the unused part of each pool, in random order) feeds the setup fallbacks.
 * @param {Pools} p
 * @returns {{ chosen: Pools, rest: Pools }}
 */
export function drawHosts (p, targets = TARGETS, random = randomBelow) {
  const sites = new Set()
  /** @type {any} */
  const chosen = {}
  /** @type {any} */
  const rest = {}
  // the smallest pool first: it has the fewest choices, so it must not lose its only operator
  // to a host of another type (paste.unredacted.org and crypt.unredacted.org are one operator)
  const order = Object.entries(targets).sort(([a], [b]) => (p[a]?.length ?? 0) - (p[b]?.length ?? 0))
  for (const type of Object.keys(targets)) { chosen[type] = []; rest[type] = [] }
  for (const [type, want] of order) {
    chosen[type] = []
    rest[type] = []
    for (const url of shuffled(p[type] ?? [], random)) {
      if (chosen[type].length < want && !sites.has(site(url))) {
        sites.add(site(url))
        chosen[type].push(url)
      } else if (!sites.has(site(url))) {
        rest[type].push(url)
      }
    }
    if (want > 0 && !chosen[type].length) throw new Error(`no ${type} host to draw from`)
  }
  if (!INDEX_TYPES.some((t) => chosen[t]?.length)) throw new Error('no host that can keep the index (CryptPad or Nostr) to draw from')
  return { chosen, rest }
}
