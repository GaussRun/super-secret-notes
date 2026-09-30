// Backend registry. A backend module exports:
//   info   { title, blurb, signup }        shown by `super-secret-notes init`
//   prompt (ask, askSecret) => config       interactive setup questions
//   create (config, ctx) => adapter         ctx = { root, home }
//   operator (config) => string | null      who runs it; two backends must not share one
// and an adapter implements, with paths relative to the root folder:
//   put(path, bytes)  get(path) => bytes | null (null = missing)  exists(path)  list(dir) => names  close()
// Backends whose server picks the IDs (paste sites) also implement getLocators() and
// learnLocators(map); their locators travel in the index (see docs/OVERKILL.md).
// Backends that sign with a key derived from the vault (Nostr, Blossom) implement unlock(keys), and
// kitLines() for extra recovery kit lines.
// To add a backend (PrivateBin, Filen, ...), write one module and register it here.
import * as local from './local.js'
import * as mega from './mega.js'
import * as rclone from './rclone.js'
import * as protonCli from './proton-cli.js'
import * as privatebin from './privatebin.js'
import * as filen from './filen.js'
import * as cryptpad from './cryptpad.js'
import * as fileverse from './fileverse.js'
import * as nostr from './nostr.js'
import * as blossom from './blossom.js'

export const BACKENDS = {
  mega,
  'proton-cli': protonCli,
  filen,
  rclone,
  privatebin,
  cryptpad,
  fileverse,
  nostr,
  blossom,
  local
}

/** Groups of backend names that share an operator (one account per provider). */
export async function sharedOperators (cfgs) {
  const byOp = new Map()
  for (const cfg of cfgs) {
    const op = await BACKENDS[cfg.type]?.operator?.(cfg)
    if (op) byOp.set(op, [...(byOp.get(op) ?? []), cfg.name])
  }
  return [...byOp].filter(([, names]) => names.length > 1).map(([op, names]) => ({ operator: op, names }))
}

/** Backends at server-chosen addresses (pastes, Blossom) hold notes and vault.age but not the index. */
export const holdsIndex = (type) => BACKENDS[type]?.addressing !== 'locator'

export function createBackend (cfg, ctx) {
  const mod = BACKENDS[cfg.type]
  if (!mod) throw new Error(`unknown backend type "${cfg.type}" (known: ${Object.keys(BACKENDS).join(', ')})`)
  // tests point Nostr backends at an in-process relay and skip the 3 s spacing between publishes
  const opts = cfg.type === 'nostr' && process.env.OVERKILL_NOSTR_PAUSE_MS ? { pause: Number(process.env.OVERKILL_NOSTR_PAUSE_MS) } : undefined
  return mod.create(cfg, ctx, opts)
}
