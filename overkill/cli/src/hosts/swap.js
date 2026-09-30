// Self-healing for `repair`: a zero-signup backend that has been dead for a long time (see
// pick.js deadBackends) is swapped for a healthy host of the same type from the host cache, and
// the copies are re-uploaded there. config.json is rewritten first, so an interrupted run
// finishes on the next `repair`. CryptPad accounts are derived from the vault, so the account
// on the new instance is registered the first time a copy goes there.
import { createBackend } from '../backends/index.js'
import { DEFAULT_ROOT, files, writePrivate } from '../config.js'
import { backendConfig } from '../defaults.js'
import { knownHosts, loadCache } from './cache.js'
import { deadBackends, hostKey, preferredHosts, site, mentions } from './pick.js'

/**
 * The backend config that should replace `dead`: the first healthy cached host of its type (in
 * init's order) that no backend uses yet and whose operator is not already configured. Names
 * never reuse one the vault used before (the ledger keeps them, and local locator files are
 * keyed by name). -> config or null
 */
export function replacementFor (dead, backends, cache, index = null) {
  const sameType = backends.filter((b) => b.type === dead.type)
  const used = new Set(sameType.map(hostKey))
  const sites = new Set(sameType.map((b) => site(hostKey(b))))
  const healthy = new Set(knownHosts(cache, dead.type).filter((h) => h.status === 'ok').map((h) => h.url))
  const url = preferredHosts(cache, dead.type).find((u) => healthy.has(u) && !used.has(u) && !sites.has(site(u)))
  if (!url) return null
  const taken = new Set(backends.map((b) => b.name))
  for (const perBackend of Object.values(index?.health ?? {})) for (const name of Object.keys(perBackend ?? {})) taken.add(name)
  return backendConfig(dead.type, url, taken)
}

/**
 * After store.repair(): swap every long-dead backend that has a replacement, then repair again
 * so the new backends get every copy. Mutates cfg.backends and store.backends in place.
 * -> { swaps: [{ from, to, fromWhere, toWhere }], stuck: [dead backends without a replacement], fixed, failed }
 */
export async function swapDeadBackends ({ store, cfg, home, created = null, fixed = [], now = new Date() }) {
  const cache = await loadCache(home)
  const dead = deadBackends({ index: store.lastIndex, backends: cfg.backends, cache, created, now })
    .filter((d) => !mentions(d.name, fixed))
  const swaps = []
  const stuck = []
  for (const d of dead) {
    const i = cfg.backends.findIndex((b) => b.name === d.name)
    const next = replacementFor(cfg.backends[i], cfg.backends, cache, store.lastIndex)
    if (!next) { stuck.push(d); continue }
    const j = store.backends.findIndex((b) => b.name === d.name)
    const old = store.backends[j]
    await old?.close?.().catch(() => {})
    // the same secret store as the other backends: the new host's locators go into secrets.ovk
    const secrets = store.backends.secrets
    const adapter = createBackend(next, { root: cfg.root ?? DEFAULT_ROOT, home, secrets })
    if (secrets?.unlocked && secrets.data.locators[d.name]) {
      delete secrets.data.locators[d.name] // the dead host's paste keys and tokens are of no use now
      await secrets.save()
    }
    adapter.unlock?.(store.keys)
    if (j >= 0) store.backends[j] = adapter
    else store.backends.push(adapter)
    swaps.push({ from: d.name, to: next.name, fromWhere: hostKey(cfg.backends[i]), toWhere: hostKey(next) })
    cfg.backends[i] = next
  }
  if (!swaps.length) return { swaps, stuck, fixed: [], failed: [] }
  await writePrivate(files(home).config, JSON.stringify(cfg, null, 2) + '\n')
  return { swaps, stuck, ...await store.repair() }
}
