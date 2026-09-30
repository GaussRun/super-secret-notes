// Glue between a vault and its Nostr discovery record (src/bootstrap.js): what goes into the
// bootstrap, when to republish it, and turning a fetched one back into a config.
// The bootstrap only lists how to reach the backends; everything else (the index, note
// locators) is found through them once vault.age is open, so it rarely changes.
// The pure parts live in discovery-core.js (shared with the web client).
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as bootstrap from './bootstrap.js'
import * as core from './discovery-core.js'
import { BACKENDS } from './backends/index.js'
import { writePrivate } from './config.js'

export const REPUBLISH_DAYS = core.REPUBLISH_DAYS

/** OVERKILL_DISCOVERY_RELAYS: comma separated, empty to turn publishing off (tests, offline). */
export function discoveryRelays () {
  const env = process.env.OVERKILL_DISCOVERY_RELAYS
  if (env === undefined) return bootstrap.DEFAULT_RELAYS
  return env.split(',').map((s) => s.trim()).filter(Boolean)
}
const relayOpts = () => (process.env.OVERKILL_NOSTR_PAUSE_MS ? { pause: Number(process.env.OVERKILL_NOSTR_PAUSE_MS) } : {})

/** The record for this vault; login backends travel with secrets.ovk where their type allows it. */
export function bootstrapRecord (cfg, backends, keys) {
  return core.bootstrapRecord(cfg, backends, keys, { travelsWithSecrets: (type) => Boolean(BACKENDS[type]?.travelsWithSecrets) })
}

const stampFile = (home) => path.join(home, 'bootstrap-published.json')

/**
 * Publish when the record changed or the last publish is older than REPUBLISH_DAYS.
 * -> null when skipped (unnamed vault, relays off, nothing to do), else [{ relay, ok, error }].
 */
export async function publishIfNeeded ({ cfg, home, passphrase, vaultBytes, backends, keys, force = false }) {
  const relays = discoveryRelays()
  if (!cfg.name || !relays.length) return null
  const record = await bootstrapRecord(cfg, backends, keys)
  const hash = await core.recordHash(record, vaultBytes)
  const last = await readFile(stampFile(home), 'utf8').then(JSON.parse, () => null)
  if (!force && !core.publishDue(last, hash)) return null
  const results = await bootstrap.publishBootstrap(passphrase, cfg.name, vaultBytes, record, { relays, ...relayOpts() })
  await writePrivate(stampFile(home), JSON.stringify({ sha256: hash, at: new Date().toISOString(), relays: results }, null, 2))
  return results
}

/** Name + passphrase -> { vaultBytes, cfg } (nothing written yet). */
export async function fetchVault ({ name, passphrase }) {
  return core.configFromBootstrap(await bootstrap.fetchBootstrap(passphrase, name, { relays: discoveryRelays(), ...relayOpts() }), name)
}
