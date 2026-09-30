// `super-secret-notes hosts ...`: find, probe, list and hand-edit the hosts behind the zero-signup backends.
import { Option } from 'commander'
import { KNOWN, TERMS_NOTES, TYPES } from './directories.js'
import { DEFAULT_COUNT as PRIVATEBIN_COUNT } from '../backends/privatebin.js'
import { DEFAULT_COUNT as RELAY_COUNT } from '../backends/nostr.js'
import { DEFAULT_COUNT as BLOSSOM_COUNT } from '../backends/blossom.js'
import { normalize } from './parse.js'
import { PROBES } from './probe.js'
import { refreshHosts } from './refresh.js'
import { findHost, isBuiltIn, knownHosts, loadCache, saveCache, typesOf, upsert } from './cache.js'
import { preferredHosts } from './pick.js'
import { ago } from '../status.js'

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
// how many hosts of each type `init` takes (defaults.js)
const INIT_COUNT = { privatebin: PRIVATEBIN_COUNT, nostr: RELAY_COUNT, blossom: BLOSSOM_COUNT, cryptpad: KNOWN.cryptpad.length }
const STATUS_PAINT = { ok: paint(32), failed: paint(31) }

function hostArg (type, url) {
  if (!TYPES.includes(type)) throw new Error(`unknown host type "${type}" (known: ${TYPES.join(', ')})`)
  const norm = normalize(type, url)
  if (!norm) throw new Error(`${url} is not a ${type} host URL (${type === 'nostr' ? 'wss://' : 'https://'} expected)`)
  return norm
}

/** Register `hosts refresh|list|add|remove` on the program. `home()` gives the state directory. */
export function registerHostsCommand (program, { home, out = (s = '') => process.stdout.write(s + '\n') }) {
  const hosts = program.command('hosts')
    .description('find hosts in public directories, probe them, and list or edit what is known')
  const typeOption = () => new Option('--type <type>', 'only this host type').choices(TYPES)

  hosts.command('refresh')
    .description('read the public directories and probe new candidates, politely, one at a time')
    .addOption(typeOption())
    .option('--directory <url>', 'read this directory instead of the built-in ones (needs --type)')
    .option('--cap <n>', 'at most this many probes per type', '10')
    .option('--max-age <hours>', 'skip hosts probed within this many hours', '24')
    .action(async (o) => {
      if (o.directory && !o.type) throw new Error('--directory needs --type')
      const summary = await refreshHosts({ home: home(), type: o.type, directory: o.directory, cap: Number(o.cap), maxAgeHours: Number(o.maxAge), say: out })
      out()
      for (const [t, s] of Object.entries(summary)) {
        out(`${t}: ${s.listed} listed, ${s.probed} probed, ${s.ok} ok`)
      }
      out('`super-secret-notes hosts list` shows everything known; new vaults prefer healthy hosts.')
    })

  hosts.command('list')
    .description('known hosts (built-in and probed): status, last probe, source directory')
    .addOption(typeOption())
    .option('--all', 'include hosts removed by hand')
    .action(async (o) => {
      const cache = await loadCache(home())
      for (const t of typesOf(o.type)) {
        const rows = knownHosts(cache, t, { includeRemoved: o.all })
        const picks = preferredHosts(cache, t).slice(0, INIT_COUNT[t])
        out(`${t} (${rows.filter((h) => h.status === 'ok').length} ok of ${rows.length})`)
        const w = Math.max(...rows.map((h) => h.url.length))
        for (const h of rows) {
          const status = h.removed ? 'removed' : h.status
          const source = [h.builtIn && 'built-in', h.source && h.source !== 'built-in' && h.source].filter(Boolean).join(', ')
          out(`  ${(STATUS_PAINT[status] ?? String)(status.padEnd(8))} ${h.url.padEnd(w)}  ${ago(h.probed ?? null).padEnd(12)}  ${source}${picks.includes(h.url) && !h.removed ? '  (new vaults use it)' : ''}`)
          if (h.reason) out(`           ${h.reason}`)
          if (TERMS_NOTES[t]?.[h.url]) out(`           info: ${TERMS_NOTES[t][h.url]}`)
        }
        out()
      }
    })

  hosts.command('add <type> <url>')
    .description('add a host by hand (probed right away unless --no-probe)')
    .option('--no-probe', 'just record it')
    .action(async (type, url, o) => {
      const u = hostArg(type, url)
      const cache = await loadCache(home())
      const fields = { source: 'manual', removed: false }
      upsert(cache, type, u, { status: findHost(cache, type, u)?.status ?? 'unprobed', ...fields })
      if (o.probe) {
        const r = await PROBES[type](u)
        upsert(cache, type, u, { status: r.status, reason: r.reason ?? null, probed: new Date().toISOString(), details: r.details ?? {} })
        out(`${type}: ${r.status} ${u}${r.reason ? ` (${r.reason})` : ''}`)
      }
      await saveCache(home(), cache)
      out(`added ${u} (${type})`)
    })

  hosts.command('remove <type> <url>')
    .description('stop offering a host (built-in ones too); `hosts add` brings it back')
    .action(async (type, url) => {
      const u = hostArg(type, url)
      const cache = await loadCache(home())
      if (!findHost(cache, type, u) && !isBuiltIn(type, u)) throw new Error(`no ${type} host ${u} known`)
      upsert(cache, type, u, { removed: true })
      await saveCache(home(), cache)
      out(`removed ${u} (${type}); new vaults will not pick it`)
    })

  return hosts
}
