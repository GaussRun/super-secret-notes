// Using the host cache: which hosts `init` offers, and which configured backends look dead.
import { knownHosts, loadCache } from './cache.js'
import { site } from '../defaults-core.js'

const DAY = 86_400_000
export const DEAD_AFTER_DAYS = 7
// OVERKILL_DEAD_AFTER_DAYS changes it (0 in tests: any backend failing right now counts)
export const deadAfterDays = () => (process.env.OVERKILL_DEAD_AFTER_DAYS !== undefined ? Number(process.env.OVERKILL_DEAD_AFTER_DAYS) : DEAD_AFTER_DAYS)

export { site }

/**
 * Hosts of one type in the order `init` should use them: healthy built-in ones (in the built-in
 * order), then other healthy ones (hosts that serve old data first, then the most recently
 * probed), then built-in ones never probed, and built-in ones whose last probe failed last.
 * Hosts removed by hand and a second host of an operator
 * already picked are left out. With an empty cache this is the built-in list as it is.
 */
export function preferredHosts (cache, type) {
  const hosts = knownHosts(cache, type)
  const ok = (h) => h.status === 'ok'
  const byQuality = (a, b) => (b.details?.servesOld === true) - (a.details?.servesOld === true) || String(b.probed).localeCompare(String(a.probed))
  const ordered = [
    ...hosts.filter((h) => h.builtIn && ok(h)),
    ...hosts.filter((h) => !h.builtIn && ok(h)).sort(byQuality),
    ...hosts.filter((h) => h.builtIn && h.status === 'unprobed'),
    ...hosts.filter((h) => h.builtIn && h.status === 'failed')
  ]
  const sites = new Set()
  return ordered.filter((h) => !sites.has(site(h.url)) && sites.add(site(h.url))).map((h) => h.url)
}

export const hostKey = (cfg) => (cfg.type === 'cryptpad' ? cfg.origin : cfg.url)?.replace(/\/+$/, '')

/**
 * Configured backends of a directory-backed type that have not served a good copy for a long
 * time, going by the health ledger: every copy failed its last check, and the last good one is
 * `days` old. A backend that never served a good copy counts once the vault (`created`) is that old.
 * -> [{ name, type, lastOk, alternatives }]
 */
export function deadBackends ({ index, backends, cache, created = null, now = new Date(), days = deadAfterDays() }) {
  const health = index?.health ?? {}
  const out = []
  for (const cfg of backends) {
    if (!['privatebin', 'cryptpad', 'nostr', 'blossom'].includes(cfg.type)) continue
    const entries = Object.values(health).map((perBackend) => perBackend?.[cfg.name]).filter(Boolean)
    // a host that serves a readable copy of any version is alive (a DIVERGED copy must stay reachable)
    if (!entries.length || entries.some((e) => ['ok', 'stale', 'diverged'].includes(e.status))) continue
    const lastOk = entries.map((e) => e.last_ok).filter(Boolean).sort().at(-1) ?? null
    if (lastOk && now - Date.parse(lastOk) < days * DAY) continue
    if (!lastOk && created && now - Date.parse(created) < days * DAY) continue
    const configured = new Set(backends.filter((b) => b.type === cfg.type).map(hostKey))
    const alternatives = knownHosts(cache, cfg.type)
      .filter((h) => h.status === 'ok' && !configured.has(h.url)).length
    out.push({ name: cfg.name, type: cfg.type, lastOk, alternatives })
  }
  return out
}

/**
 * One line per dead backend for `repair` and `refresh`. Suggestions only: nothing migrates.
 * `fixed` are the run's "<what> on <backend>" lines: a backend that just took a copy is alive.
 */
export async function replacementHints ({ index, backends, home, fixed = [], created = null, now = new Date() }) {
  const cache = await loadCache(home).catch(() => null)
  if (!cache) return []
  return deadBackends({ index, backends, cache, created, now }).filter((d) => !mentions(d.name, fixed)).map(({ name, type, lastOk, alternatives }) => {
    const since = lastOk ? `no good copy in ${Math.floor((now - Date.parse(lastOk)) / DAY)} days` : 'never served a good copy'
    return alternatives
      ? `${name} looks dead (${since}); \`super-secret-notes hosts list --type ${type}\` shows ${alternatives} healthy ${alternatives === 1 ? 'alternative' : 'alternatives'}`
      : `${name} looks dead (${since}); \`super-secret-notes hosts refresh --type ${type}\` looks for alternatives`
  })
}

/** Whether one of a repair run's "<what> on <backend>[: why]" lines is about this backend. */
export const mentions = (name, fixed) =>
  fixed.some((x) => new RegExp(` on ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([ :]|$)`).test(x))
