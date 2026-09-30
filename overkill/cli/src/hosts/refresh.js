// `super-secret-notes hosts refresh`: read the directories, then probe candidates one at a time.
import { RelayConn } from '../backends/nostr.js'
import { DIRECTORIES, KNOWN, staleHint } from './directories.js'
import { PARSERS, EVENT_KINDS, guessFormat, normalize } from './parse.js'
import { PROBES } from './probe.js'
import { findHost, loadCache, saveCache, upsert, typesOf } from './cache.js'

const TIMEOUT = 30_000
const UA = 'overkill-notes/0.1 (hosts refresh)'
// NIP-66 monitors republish every few hours; three days of events covers every live relay
const NIP66_WINDOW = 3 * 86_400

/** Candidate host URLs listed by one directory. Throws when it cannot be read. */
export async function readDirectory (type, dir) {
  if (/^wss?:\/\//.test(dir.url)) {
    const format = dir.format ?? guessFormat(type, dir.url)
    if (!EVENT_KINDS[format]) throw new Error(`a relay is not a ${type} directory`)
    const conn = new RelayConn(dir.url, { timeout: TIMEOUT })
    try {
      const filter = { kinds: EVENT_KINDS[format], limit: 500 } // purplepag.es refuses more than 500
      if (format === 'nip66') filter.since = Math.floor(Date.now() / 1000) - NIP66_WINDOW
      return PARSERS[format](type, await conn.query(filter), dir)
    } finally {
      conn.close()
    }
  }
  const res = await fetch(dir.url, {
    headers: { 'User-Agent': UA, Accept: dir.format === 'privatebin-json' ? 'application/json' : 'text/html, text/plain, */*' },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return PARSERS[dir.format ?? guessFormat(type, dir.url, text)](type, text, dir)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Refresh one type or all of them.
 * @param {object} o
 * @param {string} o.home        state directory holding hosts.json
 * @param {string} [o.type]      one of TYPES, all when left out
 * @param {string} [o.directory] read this URL instead of the built-in directories
 * @param {object} [o.directories] per type, like DIRECTORIES (tests)
 * @param {number} [o.cap]       at most this many probes per type and run
 * @param {number} [o.maxAgeHours] skip hosts probed more recently than this
 * @param {number} [o.pauseMs]   pause between two probes (politeness)
 * @param {(line: string) => void} [o.say]
 */
export async function refreshHosts ({ home, type, directory, directories = DIRECTORIES, cap = 10, maxAgeHours = 24, pauseMs = 1000, probeOpts = {}, say = () => {}, probes = PROBES }) {
  const cache = await loadCache(home)
  const summary = {}
  const recent = (h) => h?.probed && Date.now() - Date.parse(h.probed) < maxAgeHours * 3_600_000
  for (const t of typesOf(type)) {
    const dirs = directory ? [{ url: directory }] : directories[t] ?? []
    const candidates = new Map() // url -> source
    const add = (url, source) => {
      const h = findHost(cache, t, url)
      if (!candidates.has(url) && !h?.removed && !recent(h)) candidates.set(url, source)
    }
    let listed = 0
    for (const dir of dirs) {
      if (candidates.size >= cap) break
      let urls
      try {
        urls = await readDirectory(t, dir)
      } catch (err) {
        const reason = err.cause?.code ?? err.cause?.message ?? err.message
        cache.directories[dir.url] = { type: t, fetched: new Date().toISOString(), count: 0, error: reason }
        say(`${t}: ${staleHint(dir.url)} (${reason})`)
        continue
      }
      cache.directories[dir.url] = { type: t, fetched: new Date().toISOString(), count: urls.length }
      if (!urls.length) { say(`${t}: ${staleHint(dir.url)} (no ${t} hosts in it)`); continue }
      listed += urls.length
      say(`${t}: ${dir.url} lists ${urls.length}`)
      for (const url of urls) add(url, dir.url)
    }
    if (!listed && !directory) {
      say(`${t}: every directory failed; probing the built-in list instead`)
      for (const url of KNOWN[t]) add(normalize(t, url), 'built-in')
    }
    const picked = [...candidates].slice(0, cap)
    if (!picked.length) say(`${t}: nothing new to probe (every listed host was probed in the last ${maxAgeHours} h; --max-age 0 probes again)`)
    const results = []
    for (const [i, [url, source]] of picked.entries()) {
      if (i) await sleep(pauseMs)
      const started = Date.now()
      const prev = findHost(cache, t, url)
      const r = await probes[t](url, probeOpts)
      const entry = upsert(cache, t, url, {
        status: r.status,
        reason: r.reason ?? null,
        probed: new Date().toISOString(),
        ms: Date.now() - started,
        source: prev?.source === 'manual' ? 'manual' : source,
        details: r.details ?? {}
      })
      results.push(entry)
      say(`${t}: ${r.status.padEnd(6)} ${url}${r.reason ? ` (${r.reason})` : ''}`)
      await saveCache(home, cache) // after every probe, so an interrupted run keeps what it learned
    }
    summary[t] = { listed, probed: results.length, ok: results.filter((r) => r.status === 'ok').length }
  }
  await saveCache(home, cache)
  return summary
}
