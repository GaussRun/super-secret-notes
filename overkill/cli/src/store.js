// The replication layer: every blob goes to every backend, reads fall back across them.
import * as c from './crypto.js'
import { logger as defaultLogger } from './log.js'

export const STATUS = { OK: 'OK', MISSING: 'MISSING', CORRUPT: 'CORRUPT', STALE: 'STALE', ERROR: 'ERROR' }

const bytesEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Failure handling (docs/OVERKILL.md): best effort, every host on its own. An operation succeeds
// once MIN_COPIES hosts hold the copy; fewer is kept and flagged for `repair`.
export const MIN_COPIES = 2
// how long one host may take for one call before it counts as FAILED (an adapter's own
// `timeoutMs` wins; the web app sets shorter ones)
export const DEFAULT_HOST_TIMEOUT_MS = 120_000

function withTimeout (promise, ms, what) {
  let timer
  const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${what}: no answer in ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`}`), { timedOut: true })), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

/**
 * Give every call on this adapter a deadline, so one silent host never blocks the rest. The call
 * itself keeps running: a put that succeeds after its deadline is handed to `onLate(b, path, done)`
 * (`done` settles when it does), so its copy is neither lost track of nor orphaned.
 */
export function bounded (b, ms = DEFAULT_HOST_TIMEOUT_MS, onLate = null) {
  if (b.bounded) return b
  const limit = b.timeoutMs ?? ms
  for (const m of ['put', 'get', 'exists', 'list', 'raw']) {
    const f = b[m]
    if (typeof f !== 'function' || !limit) continue
    b[m] = (...args) => {
      const call = f.apply(b, args)
      return withTimeout(call, limit, b.name).catch((err) => {
        if (err.timedOut && m === 'put' && onLate) onLate(b, args[0], call)
        throw err
      })
    }
  }
  b.bounded = true
  return b
}
const { vault: VAULT_KEY, index: INDEX_KEY } = c.HEALTH_KEYS

export class Overkill {
  /**
   * @param {object} o
   * @param {any[]} o.backends adapters from backends/index.js, in read-preference order
   * @param {any} o.keys from crypto.unlockKeys
   * @param {Uint8Array} [o.vaultBytes] local vault.age, uploaded and checked as is
   * @param {{write(blob: Uint8Array), read(): Promise<Uint8Array|null>}} [o.indexCache] the
   *   encrypted local copy of the index (for `status`, and the only copy unless indexSync is "always")
   * @param {'always'|'manual'|'never'} [o.indexSync] whether index writes go to the backends
   * @param {{debug: Function, info: Function, warn: Function}} [o.logger] default: the winston logger
   * @param {() => Date} [o.now] clock for the health ledger (tests)
   * @param {number} [o.hostTimeoutMs] deadline for one call on one host (adapters' own `timeoutMs` wins)
   */
  constructor ({ backends, keys, vaultBytes, logger = defaultLogger, indexCache = null, now = () => new Date(), indexSync = 'always', hostTimeoutMs = DEFAULT_HOST_TIMEOUT_MS }) {
    if (!backends.length) throw new Error('no backends configured')
    this.hostTimeoutMs = hostTimeoutMs
    this.late = new Set() // puts that missed their deadline and are still running
    this.onLate = (b, rel, call) => this.lateWrite(b, rel, call)
    for (const b of backends) bounded(b, hostTimeoutMs, this.onLate)
    if (!['always', 'manual', 'never'].includes(indexSync)) throw new Error(`index_sync must be always, manual or never (got ${indexSync})`)
    this.backends = backends
    // backends at server-chosen addresses (pastes, Blossom) never hold the index
    this.indexHolders = backends.filter((b) => b.addressing !== 'locator')
    this.indexSync = indexSync
    this.remoteIndex = indexSync === 'always'
    this.keys = keys
    if (keys) for (const b of backends) b.unlock?.(keys)
    this.vaultBytes = vaultBytes
    this.log = logger
    this.indexCache = indexCache
    this.now = now
    this.pending = [] // health ledger results not yet written to the index
  }

  /** Remember a verification result for the health ledger (written with the next index). */
  record (key, backend, status, expires = null) {
    const at = this.now().toISOString()
    const entry = { last_checked: at, status: status.toLowerCase(), expires: expires ? expires.toISOString() : null }
    if (status === STATUS.OK) entry.last_ok = at
    this.pending.push([key, backend, entry])
  }

  withHealth (index) {
    if (!this.pending.length) return index
    const updates = {}
    for (const [key, backend, entry] of this.pending) (updates[key] ??= {})[backend] = entry
    this.pending = []
    return { ...index, health: c.mergeHealth([index.health, updates]) }
  }

  async cache (index) {
    if (this.indexCache) await this.indexCache.write(await c.encryptIndex(this.keys, index)).catch((err) => this.log.debug(`index cache: ${err.message}`))
  }

  // Runs fn on every backend in parallel (different providers), never rejects.
  async each (fn) {
    return Promise.all(this.backends.map(async (b) => {
      try {
        return { backend: b, ok: true, value: await fn(b) }
      } catch (err) {
        return { backend: b, ok: false, error: err }
      }
    }))
  }

  /**
   * vault.age to every backend. `next(failed)` (setup only) offers a substitute adapter for a
   * backend that failed, or null; the first one that takes vault.age replaces it here and the
   * result says so (`replaced`: the failed backend's name), so the caller can update its config.
   */
  async uploadVault ({ next } = {}) {
    const res = await this.each((b) => b.put(c.paths.vault, this.vaultBytes))
    for (const r of res) if (!r.ok) this.log.warn(`${r.backend.name}: vault.age upload FAILED: ${r.error.message}`)
    if (next) {
      await Promise.all(res.filter((r) => !r.ok).map(async (r) => {
        for (let cand = await next(r.backend); cand; cand = await next(r.backend)) {
          bounded(cand, this.hostTimeoutMs, this.onLate)
          if (this.keys) cand.unlock?.(this.keys)
          this.log.info(`${r.backend.name} failed; trying ${cand.name} instead`)
          try {
            await cand.put(c.paths.vault, this.vaultBytes)
          } catch (err) {
            this.log.warn(`${cand.name}: vault.age upload FAILED: ${err.message}`)
            await cand.close?.().catch(() => {})
            continue
          }
          this.log.info(`${cand.name}: vault.age stored (in place of ${r.backend.name})`)
          this.replaceBackend(r.backend, cand)
          Object.assign(r, { backend: cand, ok: true, replaced: r.backend.name, error: undefined })
          break
        }
      }))
    }
    return res
  }

  /**
   * A put that answered after its deadline. On a backend still in use the copy stays: the adapter
   * has recorded its locator (and delete token), and the next check marks it OK. On a backend that
   * is no longer used (replaced by a setup fallback) the copy is deleted again, so no paste or blob
   * is left behind on a volunteer host that nobody can find or remove.
   */
  lateWrite (b, rel, call) {
    const handled = call.then(async () => {
      if (this.backends.includes(b)) {
        this.log.info(`${b.name}: ${rel} arrived after the deadline; kept (the next check confirms it)`)
        return
      }
      const gone = await b.dropPath?.(rel).catch((err) => { this.log.debug(`${b.name}: ${err.message}`); return false })
      this.log.info(`${b.name}: ${rel} arrived after the deadline on a host this vault no longer uses; ${gone ? 'deleted it again' : 'nothing to delete'}`)
    }, () => {}).finally(() => this.late.delete(handled))
    this.late.add(handled)
  }

  /** Swap one adapter for another (a setup fallback), keeping the read order. */
  replaceBackend (old, next) {
    // in place: callers keep the same list (it also carries the shared secret store)
    this.backends[this.backends.indexOf(old)] = next
    this.indexHolders = this.backends.filter((b) => b.addressing !== 'locator')
    old.close?.().catch(() => {})
  }

  async readIndexes (holders = this.indexHolders) {
    return Promise.all(holders.map(async (b) => {
      try {
        const blob = await b.get(c.paths.index)
        return { backend: b, ok: true, value: blob ? await c.decryptIndex(this.keys, blob) : null }
      } catch (err) {
        return { backend: b, ok: false, error: err }
      }
    }))
  }

  /** The local encrypted copy, or null. */
  async localIndex () {
    const blob = await this.indexCache?.read?.()
    return blob ? c.decryptIndex(this.keys, blob) : null
  }

  async mergedIndex () {
    if (!this.remoteIndex) {
      // index_sync manual/never: this machine's copy is the index. A machine without one yet
      // (just recovered) starts from whatever was last synced to the backends.
      let merged = await this.localIndex()
      if (!merged) {
        const good = (await this.readIndexes()).filter((r) => r.ok && r.value)
        merged = good.length ? c.mergeIndexes(...good.map((r) => r.value)) : c.emptyIndex()
        await this.cache(merged)
      }
      await this.learnLocators(merged)
      return merged
    }
    if (!this.indexHolders.length) throw new Error('no backend can hold the index: add one that is not PrivateBin or Blossom')
    const res = await this.readIndexes()
    for (const r of res) if (!r.ok) this.log.warn(`${r.backend.name}: index unreadable (${r.error.message})`)
    const good = res.filter((r) => r.ok)
    if (!good.length) {
      // no index holder answered: carry on with this machine's copy; the next write uploads it again
      const local = await this.localIndex().catch(() => null)
      if (!local) throw new Error('could not read the index from any backend')
      this.log.warn('no index-holding host answered; using the index kept on this device (uploaded again with the next write)')
      await this.learnLocators(local)
      return local
    }
    const merged = c.mergeIndexes(...good.map((r) => r.value))
    // ledger results kept only on this device so far (reads record them without a remote write)
    const local = await this.localIndex().catch(() => null)
    if (local?.health) merged.health = c.mergeHealth([merged.health, local.health])
    await this.learnLocators(merged)
    await this.cache(merged)
    return merged
  }

  /** Put the pending ledger results into the local index copy now; the next index write uploads them. */
  async keepLedger (index) {
    if (!this.pending.length) return
    await this.cache(this.withHealth(index))
  }

  // Locator-addressed backends (PrivateBin) learn where other devices put things, once per run.
  async learnLocators (index) {
    if (this.learned) return
    this.learned = true
    for (const b of this.backends) {
      if (b.learnLocators) await b.learnLocators(index.locators?.[b.name])
      if (b.adoptPastes) await b.adoptPastes(index.pastes?.[b.name])
    }
  }

  async withLocators (index) {
    const out = { ...index, written: new Date().toISOString(), locators: { ...index.locators } }
    for (const b of this.backends) {
      if (!b.getLocators) continue
      const map = await b.getLocators()
      delete map[c.paths.index] // the index cannot point to itself; that one lives in the recovery kit
      out.locators[b.name] = { ...out.locators[b.name], ...map }
    }
    if (!Object.keys(out.locators).length) delete out.locators
    out.pastes = { ...index.pastes }
    for (const b of this.backends) {
      if (!b.ownedPastes) continue
      out.pastes[b.name] = { ...out.pastes[b.name], ...await b.ownedPastes() }
      await this.prunePastes(b, out)
    }
    if (!Object.keys(out.pastes).length) delete out.pastes
    return out
  }

  /**
   * Delete pastes nobody needs any more, whoever created them (the tokens are in the index):
   * note and vault.age pastes that a newer one replaced, and index pastes beyond the newest
   * two that are also older than a week (left behind by other machines, e.g. after a recover).
   */
  async prunePastes (b, index, { maxPerRun = 5 } = {}) {
    const mine = index.pastes[b.name]
    const idOf = (url) => (url ? new URL(url).search.slice(1) : null)
    const doomed = []
    // the index no longer lives on paste backends: every index paste left over is doomed
    for (const [id, e] of Object.entries(mine)) if (e.path === c.paths.index) doomed.push(id)
    for (const [id, e] of Object.entries(mine)) {
      if (e.path === c.paths.index) continue
      const current = idOf(index.locators?.[b.name]?.[e.path])
      if (current && current !== id && mine[current] && Date.parse(e.at) < Date.parse(mine[current].at)) doomed.push(id)
    }
    for (const id of doomed.slice(0, maxPerRun)) {
      const gone = await b.deletePaste(id, mine[id].token).catch((err) => { this.log.debug(`${b.name}: prune ${id}: ${err.message}`); return false })
      if (gone) delete mine[id]
    }
  }

  /**
   * Record the index (plus locators and pending ledger results): always in the local cache, and
   * with index_sync "always" also on the index-holding backends (all of them, or `only`).
   */
  async writeIndex (index, { only } = {}) {
    // index copies from before the index left the paste backends: delete them (once)
    for (const b of this.backends) {
      if (b.dropPath && (await b.getLocators?.())?.[c.paths.index]) await b.dropPath(c.paths.index)
    }
    index = this.withHealth(await this.withLocators(index))
    this.lastIndex = index
    await this.cache(index)
    if (!this.remoteIndex) return []
    return this.uploadIndex(index, only)
  }

  async uploadIndex (index, only) {
    const targets = only ? this.indexHolders.filter((b) => only.includes(b.name)) : this.indexHolders
    const blob = await c.encryptIndex(this.keys, index)
    const res = await Promise.all(targets.map((b) => b.put(c.paths.index, blob).then(
      () => ({ backend: b, ok: true }), (error) => ({ backend: b, ok: false, error }))))
    for (const r of res) if (!r.ok) this.log.warn(`${r.backend.name}: index upload failed: ${r.error.message}`)
    if (targets.length && !res.some((r) => r.ok)) this.log.warn('the index is kept on this device only for now (no index-holding host took it); it is uploaded again with the next write')
    return res
  }

  /** index_sync manual/never: push this machine's index to the index-holding backends. */
  async sync () {
    const index = await this.localIndex()
    if (!index) throw new Error('no local index yet: put a note first')
    await this.learnLocators(index)
    return this.uploadIndex(await this.withLocators(index))
  }

  /** Verify one copy for the ledger: a note, vault.age or the index on one backend. */
  async verify (key, b, index) {
    let status, expires
    try {
      if (key === VAULT_KEY) {
        const bytes = await b.get(c.paths.vault)
        status = !bytes ? STATUS.MISSING : this.vaultBytes && !bytesEqual(bytes, this.vaultBytes) ? STATUS.CORRUPT : STATUS.OK
        expires = b.expiresAt?.(c.paths.vault)
      } else if (key === INDEX_KEY) {
        const blob = await b.get(c.paths.index)
        status = !blob ? STATUS.MISSING : await c.decryptIndex(this.keys, blob).then(() => STATUS.OK, () => STATUS.CORRUPT)
        expires = b.expiresAt?.(c.paths.index)
      } else {
        const entry = index.notes[key]
        status = (await this.readCopy(b, entry.id, entry)).status
        expires = b.expiresAt?.(c.paths.note(entry.id))
      }
    } catch {
      status = STATUS.ERROR
    }
    this.record(key, b.name, status, expires)
    return { key, backend: b.name, status }
  }

  /**
   * Spot-check other copies after a write: least recently verified first (never verified before
   * anything else, ties in random order), up to `max` copies or `budgetMs`, whichever comes first.
   * At least one copy is always verified, however small the budget.
   */
  async sample (index, { exclude, max = 3, budgetMs = 10_000 } = {}) {
    const candidates = []
    for (const b of this.backends) {
      const indexHere = this.remoteIndex && b.addressing !== 'locator'
      for (const key of [VAULT_KEY, ...(indexHere ? [INDEX_KEY] : []), ...Object.keys(index.notes)]) {
        if (key !== exclude) candidates.push({ key, b, r: Math.random() })
      }
    }
    const lastChecked = (x) => Date.parse(index.health?.[x.key]?.[x.b.name]?.last_checked ?? '') || 0
    candidates.sort((x, y) => lastChecked(x) - lastChecked(y) || x.r - y.r)
    const deadline = Date.now() + budgetMs
    const results = []
    for (const x of candidates) {
      if (results.length >= max) break
      // the budget limits further reads; the first one always runs to the end
      if (!results.length) { results.push(await this.verify(x.key, x.b, index)); continue }
      const left = deadline - Date.now()
      if (left <= 0) break
      const r = await Promise.race([this.verify(x.key, x.b, index), sleep(left).then(() => null)])
      if (!r) break // out of time; that copy just stays unverified this round
      results.push(r)
    }
    return results
  }

  /** Encrypt, upload to ALL backends, then update the index on all backends. */
  async put (name, data, { sample = true } = {}) {
    name = c.normalizeName(name)
    const bytes = c.toBytes(data)
    const id = await c.blobIdForName(this.keys, name)
    const entry = { id, sha256: await c.sha256Hex(bytes), size: bytes.length, updated: new Date().toISOString() }
    const blob = await c.encryptBlob(this.keys, id, bytes)
    const index = await this.mergedIndex()
    const res = await this.each((b) => b.put(c.paths.note(id), blob))
    for (const r of res) {
      if (r.ok) this.log.debug(`${r.backend.name}: stored ${c.paths.note(id)} (${blob.length} bytes)`)
      else this.log.warn(`${r.backend.name}: upload failed: ${r.error.message}`)
    }
    const stored = res.filter((r) => r.ok).length
    if (!stored) throw new Error('upload failed on every backend, nothing was stored')
    for (const r of res) if (!r.ok) this.record(name, r.backend.name, STATUS.ERROR)
    if (stored < MIN_COPIES) this.log.warn(`"${name}" is on only ${stored} host; repair copies it to the others once they answer`)
    // a spot check of other copies rides along with this index write; it never fails the put
    const sampled = sample ? await this.sample(index, { exclude: name }).catch((err) => { this.log.debug(`sample: ${err.message}`); return [] }) : []
    index.notes[name] = entry
    await this.writeIndex(index)
    return { entry, sampled, stored, results: res.map((r) => ({ backend: r.backend.name, ok: r.ok, error: r.error?.message })) }
  }

  /** Read from the first healthy backend; fall back to the next on any failure. */
  async get (name) {
    name = c.normalizeName(name)
    const index = await this.mergedIndex()
    const entry = index.notes[name]
    const id = entry?.id ?? await c.blobIdForName(this.keys, name)
    // not in the index: still try, a note put after the last index sync is found by its name
    if (!entry) this.log.debug(`"${name}" is not in the index; trying anyway, sha256 cannot be verified`)
    const problems = []
    // every copy read here was fully verified (or failed): that goes into the health ledger, like a check
    const note = (b, status) => { if (entry) this.record(name, b.name, status, b.expiresAt?.(c.paths.note(id))) }
    for (const b of this.backends) {
      const status = await this.readCopy(b, id, entry)
      note(b, status.status)
      if (status.status === STATUS.OK) {
        if (!entry) this.log.warn(`"${name}" is not in the index (written after the last index sync?); read it by name, its sha256 cannot be checked`)
        for (const p of problems) this.log.warn(`${p.backend}: ${p.status}${p.detail ? ` (${p.detail})` : ''}, used ${b.name} instead`)
        await this.keepLedger(index).catch((err) => this.log.debug(`ledger: ${err.message}`))
        return { bytes: status.plaintext, from: b.name, entry, problems }
      }
      problems.push({ backend: b.name, status: status.status, detail: status.detail })
    }
    await this.keepLedger(index).catch((err) => this.log.debug(`ledger: ${err.message}`))
    const why = problems.map((p) => `${p.backend} ${p.status}`).join(', ')
    if (entry) throw new Error(`no healthy copy of "${name}" (${why})`)
    if (problems.every((p) => p.status === STATUS.MISSING)) throw new Error(`no note called "${name}". \`super-secret-notes ls\` lists your notes.`)
    throw new Error(`no note called "${name}" in the index, and no backend had a readable copy (${why})`)
  }

  /**
   * What one backend stores for a note, exactly as it serves it (nothing decrypted), for showing
   * what the host sees: { text, format: 'json' | 'base64', link? }. Null when not there.
   */
  async rawCopy (name, backendName) {
    name = c.normalizeName(name)
    const b = this.backends.find((x) => x.name === backendName)
    if (!b) throw new Error(`no backend called ${backendName}`)
    if (!b.raw) throw new Error(`${backendName} (${b.type}) cannot show its raw copy`)
    const index = await this.localIndex().catch(() => null) ?? await this.mergedIndex()
    const id = index.notes[name]?.id ?? await c.blobIdForName(this.keys, name)
    return b.raw(c.paths.note(id))
  }

  /** Download and fully verify one copy of a note. */
  async readCopy (b, id, entry) {
    let blob
    try {
      blob = await b.get(c.paths.note(id))
    } catch (err) {
      return { status: err.corrupt ? STATUS.CORRUPT : STATUS.ERROR, detail: err.message }
    }
    if (!blob) return { status: STATUS.MISSING }
    let plaintext
    try {
      plaintext = await c.decryptBlob(this.keys, id, blob)
    } catch (err) {
      if (err instanceof c.CorruptBlobError) return { status: STATUS.CORRUPT, detail: `${err.layer} layer` }
      throw err
    }
    if (entry && await c.sha256Hex(plaintext) !== entry.sha256) {
      return { status: STATUS.STALE, detail: 'decrypts fine but is not the latest version' }
    }
    return { status: STATUS.OK, plaintext, blob }
  }

  async list () {
    return (await this.mergedIndex()).notes
  }

  /** Download every copy from every backend and verify it. */
  async check ({ updateLedger = true } = {}) {
    // with index_sync manual/never the remote index copies are not expected to be current
    const indexRes = this.remoteIndex ? await this.readIndexes() : []
    const good = indexRes.filter((r) => r.ok && r.value)
    const merged = this.remoteIndex ? c.mergeIndexes(...good.map((r) => r.value)) : await this.mergedIndex()
    await this.learnLocators(merged)
    const mergedJson = JSON.stringify(sortNotes(merged))

    const report = { vault: [], index: [], notes: {} }
    for (const r of indexRes) {
      let status
      if (!r.ok) status = r.error instanceof c.CorruptBlobError ? { status: STATUS.CORRUPT, detail: r.error.message } : { status: STATUS.ERROR, detail: r.error.message }
      else if (!r.value) status = { status: STATUS.MISSING }
      else if (JSON.stringify(sortNotes(r.value)) !== mergedJson) status = { status: STATUS.STALE, detail: 'missing or older entries' }
      else status = { status: STATUS.OK }
      report.index.push({ backend: r.backend.name, ...status })
    }

    const vaultRes = await this.each((b) => b.get(c.paths.vault))
    for (const r of vaultRes) {
      let status
      if (!r.ok) status = { status: STATUS.ERROR, detail: r.error.message }
      else if (!r.value) status = { status: STATUS.MISSING }
      else if (this.vaultBytes && !bytesEqual(r.value, this.vaultBytes)) status = { status: STATUS.CORRUPT, detail: 'differs from the local vault.age' }
      else status = { status: STATUS.OK }
      report.vault.push({ backend: r.backend.name, ...status })
    }

    for (const [name, entry] of Object.entries(merged.notes).sort(([a], [b]) => a.localeCompare(b))) {
      const copies = await this.each((b) => this.readCopy(b, entry.id, entry))
      report.notes[name] = copies.map((r) => {
        const s = r.ok ? r.value : { status: STATUS.ERROR, detail: r.error.message }
        return { backend: r.backend.name, status: s.status, detail: s.detail, blob: s.blob }
      })
    }
    // backends that know about expiry (PrivateBin) report it for what was just read; Nostr and
    // Blossom report an assumed one (`assumed`: our republish policy, not the host's promise)
    const byName = (name) => this.backends.find((b) => b.name === name)
    const expires = (name, path) => byName(name)?.expiresAt?.(path) ?? null
    const stamp = (x, path) => { x.expires = expires(x.backend, path); if (byName(x.backend)?.assumedRetention) x.assumed = true }
    for (const x of report.vault) stamp(x, c.paths.vault)
    for (const x of report.index) stamp(x, c.paths.index)
    for (const [name, copies] of Object.entries(report.notes)) {
      for (const x of copies) stamp(x, c.paths.note(merged.notes[name].id))
    }
    // refresh the health ledger: every copy was just verified
    const lower = (x) => [x.backend, x.status, x.expires]
    for (const x of report.vault) this.record(VAULT_KEY, ...lower(x))
    for (const x of report.index) this.record(INDEX_KEY, ...lower(x))
    for (const [name, copies] of Object.entries(report.notes)) for (const x of copies) this.record(name, ...lower(x))
    // written only where the index was readable; missing or corrupt copies are left for repair
    const readable = report.index.filter((x) => x.status === STATUS.OK || x.status === STATUS.STALE).map((x) => x.backend)
    if (updateLedger && (readable.length || !this.remoteIndex)) {
      await this.writeIndex(merged, { only: readable })
      report.merged = this.lastIndex
    } else {
      report.merged = merged
    }
    return report
  }

  /** Re-upload missing, corrupt or stale copies from a healthy one. */
  async repair (report) {
    return this.reupload(report ?? await this.check(), (x) => x.status !== STATUS.OK)
  }

  /**
   * Re-upload copies that are missing or expire within `days` (volunteer pastes can get capped).
   * @param {{days?: number, report?: any}} [o]
   */
  async refresh ({ days = 90, report } = {}) {
    const soon = Date.now() + days * 86_400_000
    return this.reupload(report ?? await this.check(), (x) =>
      x.status === STATUS.MISSING || (x.status === STATUS.OK && x.expires !== null && x.expires.getTime() < soon))
  }

  async reupload (report, want) {
    const fixed = []
    const failed = []
    const byName = new Map(this.backends.map((b) => [b.name, b]))
    // re-uploads of healthy copies only happen for `refresh`, when they are about to expire
    const why = (x) => x.status === STATUS.OK && x.expires ? ` (was expiring ${x.expires.toISOString().slice(0, 10)})` : ''
    const fix = async (what, x, path, bytes) => {
      try {
        await byName.get(x.backend).put(path, bytes)
        fixed.push(`${what} on ${x.backend}${why(x)}`)
        return true
      } catch (err) {
        failed.push(`${what} on ${x.backend}: ${err.message}`)
        return false
      }
    }
    let moved = false // re-uploads to locator-addressed backends change where things live
    const done = (ok, x) => { if (ok && byName.get(x.backend)?.getLocators) moved = true }
    for (const [name, copies] of Object.entries(report.notes)) {
      const healthy = copies.find((x) => x.status === STATUS.OK)
      for (const x of copies.filter(want)) {
        if (!healthy) { failed.push(`${name} on ${x.backend}: no healthy copy anywhere`); continue }
        done(await fix(name, x, c.paths.note(report.merged.notes[name].id), healthy.blob), x)
      }
    }
    for (const x of report.vault.filter(want)) {
      if (this.vaultBytes) done(await fix('vault.age', x, c.paths.vault, this.vaultBytes), x)
    }
    // then every index must learn the new locators, not just the ones that needed fixing
    // with a local-only index, new locators just go into this machine's copy
    if (!this.remoteIndex && fixed.length) await this.writeIndex(report.merged)
    const targets = moved ? report.index : report.index.filter(want)
    if (targets.length) {
      const blob = await c.encryptIndex(this.keys, await this.withLocators(report.merged))
      // copies that were fine only get the new locators: one line for all of them
      const refreshed = []
      for (const x of targets) {
        if (want(x)) { await fix('index', x, c.paths.index, blob); continue }
        try {
          await byName.get(x.backend).put(c.paths.index, blob)
          refreshed.push(x.backend)
        } catch (err) {
          failed.push(`index on ${x.backend}: ${err.message}`)
        }
      }
      if (refreshed.length) fixed.push(`index (refreshed with new paste locators) on ${refreshed.join(', ')}`)
    }
    return { fixed, failed }
  }

  /** `lateGraceMs`: how long to wait for puts that missed their deadline (they record or clean up). */
  async close ({ lateGraceMs = 10_000 } = {}) {
    if (this.late.size) {
      let timer
      await Promise.race([Promise.allSettled([...this.late]), new Promise((resolve) => { timer = setTimeout(resolve, lateGraceMs) })])
      clearTimeout(timer)
    }
    await Promise.all(this.backends.map((b) => b.close?.().catch(() => {})))
  }
}

function sortNotes (index) {
  return Object.fromEntries(Object.entries(index.notes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v]))
}

/**
 * Human summary lines for a check report, plus totals. `compact` lists only the copies that
 * are not OK (a dozen backends make the full rows unreadable).
 */
export function summarize (report, { compact = false } = {}) {
  const lines = []
  let healthy = 0
  let total = 0
  const row = (label, copies) => {
    const ok = copies.filter((x) => x.status === STATUS.OK).length
    healthy += ok
    total += copies.length
    const shown = compact ? copies.filter((x) => x.status !== STATUS.OK) : copies
    const parts = shown.map((x) => {
      const date = x.expires?.toISOString().slice(0, 10)
      const note = x.status !== STATUS.OK ? x.detail : date ? (x.assumed ? `republish by ${date}` : `expires ${date}`) : null
      return `${x.backend} ${x.status}${note ? ` (${note})` : ''}`
    })
    const count = `${ok}/${copies.length} healthy`
    const text = !parts.length ? `all ${count}` : compact ? `${parts.join(', ')} (${count}, the rest OK)` : `${parts.join(', ')} (${count})`
    lines.push({ label, text, ok: ok === copies.length })
  }
  row('vault.age', report.vault)
  if (report.index.length) row('index', report.index)
  for (const [name, copies] of Object.entries(report.notes)) row(name, copies)
  return { lines, healthy, total }
}
