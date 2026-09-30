// Local host cache: $OVERKILL_HOME/hosts.json (default ~/.overkill-notes/hosts.json). Holds every
// probe result (with its time and the directory that listed the host), manual additions and
// removals, and when each directory was last read. Nothing in it is secret.
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { KNOWN, TYPES } from './directories.js'

export const cacheFile = (home) => path.join(home, 'hosts.json')

const empty = () => ({ v: 1, updated: null, hosts: [], directories: {} })

function check (cache) {
  if (cache?.v !== 1 || !Array.isArray(cache.hosts)) throw new Error('hosts.json has an unexpected shape')
  cache.directories ??= {}
  return cache
}

export async function loadCache (home) {
  const text = await readFile(cacheFile(home), 'utf8').catch((err) => { if (err.code === 'ENOENT') return null; throw err })
  return text === null ? empty() : check(JSON.parse(text))
}

/** For `init`, which picks its defaults synchronously. A missing or broken cache is just empty. */
export function loadCacheSync (home) {
  try {
    return check(JSON.parse(readFileSync(cacheFile(home), 'utf8')))
  } catch {
    return empty()
  }
}

export async function saveCache (home, cache) {
  cache.updated = new Date().toISOString()
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(cacheFile(home), JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 })
}

export const findHost = (cache, type, url) => cache.hosts.find((h) => h.type === type && h.url === url)

/** Merge fields into the entry for (type, url), creating it if needed. */
export function upsert (cache, type, url, fields) {
  let h = findHost(cache, type, url)
  if (!h) cache.hosts.push(h = { type, url })
  Object.assign(h, fields)
  return h
}

export const isBuiltIn = (type, url) => (KNOWN[type] ?? []).some((u) => u.replace(/\/+$/, '') === url)

/**
 * Every host of a type that we know of: the built-in list (in its order) first, then cached ones.
 * Built-in hosts that were never probed show up as { status: 'unprobed' }.
 */
export function knownHosts (cache, type, { includeRemoved = false } = {}) {
  const out = []
  for (const url of (KNOWN[type] ?? []).map((u) => u.replace(/\/+$/, ''))) {
    out.push({ type, url, status: 'unprobed', ...findHost(cache, type, url), builtIn: true })
  }
  for (const h of cache.hosts) {
    if (h.type === type && !isBuiltIn(type, h.url)) out.push({ status: 'unprobed', ...h, builtIn: false })
  }
  return includeRemoved ? out : out.filter((h) => !h.removed)
}

export const typesOf = (type) => (type ? [type] : TYPES)
