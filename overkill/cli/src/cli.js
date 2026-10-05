import { Command } from 'commander'
import { readFile, writeFile, access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import * as c from './crypto.js'
import { BACKENDS, sharedOperators, holdsIndex, createBackend } from './backends/index.js'
import { fallbackPicker } from './fallbacks.js'
import { DEFAULT_ROOT, files, homeDir, makeBackends, open, readConfig, writePrivate, indexCache, INDEX_SYNC_MODES, lastSynced, markSynced, unlockSecrets } from './config.js'
import { Overkill, summarize, MIN_COPIES } from './store.js'
import { ask, askSecret, askYesNo, passphrase } from './prompt.js'
import { generatePassphrase, isStrongEnough, estimateBits, MIN_BITS, generateVaultName } from './passphrase.js'
import { defaultBackends, validVaultName } from './defaults.js'
import { recover } from './recover.js'
import { parseKit, recoveryKit } from './kit.js'
import { makeBackup, openBackup } from './backup.js'
import path from 'node:path'
import { SecretStore, migrateConfig } from './vaultsecrets.js'
import { publishIfNeeded } from './discovery.js'
import { ledgerStatus, ago, retention } from './status.js'
import { registerHostsCommand } from './hosts/command.js'
import { mentions, replacementHints } from './hosts/pick.js'
import { swapDeadBackends } from './hosts/swap.js'
import { logger } from './log.js'

const out = (s = '') => process.stdout.write(s + '\n')
const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => color ? `\x1b[${code}m${s}\x1b[0m` : s
const green = paint(32)
const red = paint(31)
const yellow = paint(33)
const bold = paint(1)

async function readStdin () {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return new Uint8Array(Buffer.concat(chunks))
}

export { recoveryKit }

async function withStore (opts, fn) {
  const home = homeDir(opts.home)
  const { store, vault, cfg, passphrase: pass, vaultBytes } = await open(home, () => passphrase())
  try {
    return await fn(store, { vault, cfg, home, pass, vaultBytes })
  } finally {
    await store.close()
  }
}

async function recoverFromKit (o, home) {
  const text = o.kit === '-' ? new TextDecoder().decode(await readStdin()) : await readFile(o.kit, 'utf8')
  const { vault, cfg, others } = parseKit(text)
  await c.unlockKeys(vault) // the identity and master must be usable before anything is written
  if (!cfg.backends.length) throw new Error(`none of the kit's backends works without its own login (${others.map((b) => `${b.name} (${b.type})`).join(', ')}); set them up with init --advanced`)
  warnAboutBackends(cfg)
  out('The kit holds the keys, not the passphrase: vault.age gets a new one.')
  const { pass, generated } = await newVaultPassphrase({ strict: true })
  const vaultBytes = await c.encryptVault(vault, pass, { logN: o.scryptLogN ? Number(o.scryptLogN) : c.DEFAULT_SCRYPT_LOG_N })
  // the kit's paste locators carry paste keys: into secrets.ovk, not config.json
  const store = await new SecretStore(home).unlock(await c.unlockKeys(vault))
  if (migrateConfig(cfg, store)) await store.save()
  await writePrivate(files(home).vault, vaultBytes)
  await writePrivate(files(home).config, JSON.stringify(cfg, null, 2) + '\n')
  out(`Restored${cfg.name ? ` "${cfg.name}"` : ''} with ${cfg.backends.length} backends: ${cfg.backends.map((b) => b.name).join(', ')}.`)
  if (others.length) out(`Not restored (they need their own logins; add them with init --advanced on a spare home): ${others.map((b) => `${b.name} (${b.type})`).join(', ')}`)
  if (generated) out(`New passphrase (write it down): ${bold(generated)}`)
  out('The copies of vault.age out there still open with the OLD passphrase. Run `super-secret-notes repair` to replace them (check shows them as differing until then).')
}

async function localIndexLine (opts, store) {
  const last = await lastSynced(homeDir(opts.home))
  return `index: local only (index_sync ${store.indexSync}; last synced ${last ? `${last} (${ago(last)})` : 'never'})`
}

/** Keep the name + passphrase recovery record current; never fails the command. */
async function publishDiscovery ({ cfg, home, pass, vaultBytes, store, force = false }) {
  try {
    const res = await publishIfNeeded({ cfg, home, passphrase: pass, vaultBytes, backends: store.backends, keys: store.keys, force })
    if (res) out(`recovery by name: bootstrap on ${res.filter((r) => r.ok).length}/${res.length} relays`)
    if (res && !res.some((r) => r.ok)) logger.warn('recovery by name will not work until the bootstrap reaches a relay: run `super-secret-notes repair` later (the recovery kit works meanwhile)')
  } catch (err) {
    logger.warn(`recovery by name: bootstrap not published (${err.message}); the recovery kit still works`)
  }
}

async function collectBackendsInteractively () {
  out(bold('\nPick your clouds. Two is overkill, three is art.\n'))
  const chosen = []
  for (const [type, mod] of Object.entries(BACKENDS)) {
    out(`${bold(mod.info.title)} [${type}]`)
    out(`  ${mod.info.blurb}`)
    if (mod.info.signup) out(`  Sign up / docs: ${mod.info.signup}`)
    if (mod.promptMany) {
      if (await askYesNo('  Add it?')) chosen.push(...await mod.promptMany(ask, askYesNo, askSecret))
      out()
      continue
    }
    while (await askYesNo(chosen.some((b) => b.type === type) ? `  Add another ${type}?` : '  Add it?')) {
      const taken = new Set(chosen.map((b) => b.name))
      let name = type
      for (let i = 2; taken.has(name); i++) name = `${type}${i}`
      name = (await ask(`  Short name [${name}]: `)) || name
      chosen.push({ name, type, ...await mod.prompt(ask, askSecret) })
    }
    out()
  }
  return chosen
}

function warnAboutBackends (cfg) {
  if (!cfg.backends?.length) throw new Error('no backends chosen. Zero copies is the opposite of overkill.')
  if (cfg.backends.length === 1) logger.warn('only one backend. That is not overkill, that is just kill.')
  // PrivateBin and Blossom pick their own addresses, so the index (the map to everything) cannot live there
  const holders = cfg.backends.filter((b) => holdsIndex(b.type)).length
  if (!holders) throw new Error('none of these backends can hold the index: add at least one that is not PrivateBin or Blossom (CryptPad, Nostr, MEGA, a folder, ...)')
  if (holders === 1) logger.warn('only one backend can hold the index; two or more are safer')
  if (cfg.index_sync !== undefined && !INDEX_SYNC_MODES.includes(cfg.index_sync)) throw new Error(`index_sync must be one of ${INDEX_SYNC_MODES.join(', ')}`)
}

async function askIndexSync () {
  out(bold('\nWhere should the index (the list of your notes and where they are) live?'))
  out('  always  on the backends too, updated on every put (default; recover by name sees everything)')
  out('  manual  on this machine; `super-secret-notes sync` pushes it when you say so (less traffic)')
  out('  never   on this machine only (simplest; recovery elsewhere needs the exact note names)')
  for (;;) {
    const a = (await ask('index_sync [always]: ')) || 'always'
    if (INDEX_SYNC_MODES.includes(a)) return a
  }
}

async function vaultExists (home) {
  return access(files(home).config).then(() => true, () => false)
}

/**
 * Passphrase for a NEW vault. vault.age ends up on public hosts, so it must be strong:
 * generate one by default, accept a chosen one only if it passes the check.
 */
async function newVaultPassphrase ({ strict }) {
  const preset = process.env.OVERKILL_PASSPHRASE || (process.env.OVERKILL_PASSPHRASE_FILE && await passphrase())
  if (preset) {
    if (isStrongEnough(preset)) return { pass: preset }
    const msg = `that passphrase is about ${Math.round(estimateBits(preset))} bits; a new vault wants ${MIN_BITS}+ (6 random words). Unset it to get one generated.`
    if (strict) throw new Error(msg)
    process.stderr.write([
      '',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      `!!  WEAK PASSPHRASE: about ${Math.round(estimateBits(preset))} bits (${MIN_BITS}+ wanted).`,
      '!!  vault.age is stored on public hosts, so anyone can try to guess it',
      '!!  offline, as fast as their hardware allows. Accepted only because',
      '!!  init --from is for scripts and tests. Do not keep real notes here.',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      ''
    ].join('\n') + '\n')
    return { pass: preset }
  }
  const generated = generatePassphrase()
  out(`\nYour passphrase (6 random words, ${MIN_BITS}+ bits). Write it down, it is the only way in:\n`)
  out(`    ${bold(generated)}\n`)
  for (;;) {
    const own = await askSecret('Press Enter to use it, or type your own (hidden): ')
    if (!own) return { pass: generated, generated }
    if (!isStrongEnough(own)) { out(`About ${Math.round(estimateBits(own))} bits. Needs ${MIN_BITS}+: try 6 or more random words.`); continue }
    if (own === await askSecret('Again, for luck: ')) return { pass: own }
    out('Those did not match. Deep breath, try again.')
  }
}

/** The zero-signup path: name the vault, generate a passphrase, provision the defaults. */
async function zeroConfigInit (opts) {
  const home = homeDir(opts.home)
  if (await vaultExists(home)) throw new Error(`already initialized: ${files(home).config}`)
  out(bold('Super Secret Notes') + ': a note you cannot afford to lose, kept on many independent hosts, encrypted before it leaves.')
  out('No vault here yet, so let us make one. No accounts to sign up for, no config files.')
  const name = await askVaultName()
  // this vault's own random draw from the known-good pools; the rest of each pool is its fallbacks
  const drawn = defaultBackends({ home })
  const cfg = { v: 1, name, root: opts.root ?? DEFAULT_ROOT, backends: [...drawn] }
  out(`Copies go to: ${cfg.backends.map((b) => b.name).join(', ')}`)
  const { pass, generated } = await newVaultPassphrase({ strict: true })
  await setupVault(cfg, home, { pass, generated, scryptLogN: opts.scryptLogN, fresh: true, fallbacks: drawn.fallbacks })
}

/** The vault name: with the passphrase, it is all `recover --name` needs. */
async function askVaultName () {
  let name = process.env.OVERKILL_VAULT_NAME
  // a made-up name is the default: nothing to think up, Enter accepts it
  const suggested = generateVaultName()
  while (!validVaultName(name)) {
    if (name !== undefined) out('Letters, digits, space, dot, dash or underscore please (up to 63).')
    name = (await ask(`Vault name (with the passphrase, it is all \`super-secret-notes recover --name\` needs) [${suggested}]: `)) || suggested
  }
  return name.normalize('NFC')
}

async function init (opts) {
  if (!opts.from && !opts.advanced) return zeroConfigInit(opts)
  const home = homeDir(opts.home)
  if (await vaultExists(home)) throw new Error(`already initialized: ${files(home).config}`)
  let cfg
  if (opts.from) {
    cfg = JSON.parse(await readFile(opts.from, 'utf8'))
    cfg.v = 1
  } else {
    out(bold('Super Secret Notes') + ': a note you cannot afford to lose, kept on many independent hosts, encrypted before it leaves.')
    out('Every note gets age (X25519) + AES-256-GCM from us, then each cloud adds its own layer.')
    const name = await askVaultName()
    cfg = { v: 1, name, root: (await ask(`Root folder on each backend [${DEFAULT_ROOT}]: `)) || DEFAULT_ROOT, backends: await collectBackendsInteractively() }
    if (!opts.indexSync) cfg.index_sync = await askIndexSync()
  }
  if (opts.indexSync) cfg.index_sync = opts.indexSync
  await setupVault(cfg, home, { scryptLogN: opts.scryptLogN, root: opts.root, strict: !opts.from })
}

async function setupVault (cfg, home, { pass, generated, scryptLogN, root, strict, fresh, fallbacks }) {
  const f = files(home)
  if (root) cfg.root = root
  cfg.root ??= DEFAULT_ROOT
  warnAboutBackends(cfg)
  for (const { operator, names } of await sharedOperators(cfg.backends)) {
    logger.warn(`${names.join(' and ')} are ${names.length === 2 ? 'both' : 'all'} ${operator}. One account per provider: redundancy comes from independent operators, and these share one outage and one set of terms.`)
  }

  const backends = makeBackends(cfg, home)
  // an existing vault on a backend means this is a new device joining, not a new vault
  // (zero-config vaults are always new: joining one goes through `super-secret-notes recover`)
  let existing = null
  for (const b of fresh ? [] : backends) {
    existing = await b.get(c.paths.vault).catch((err) => { logger.warn(`${b.name}: ${err.message}`); return null })
    if (existing) { logger.info(`found an existing vault.age on ${b.name}, joining it`); break }
  }
  let vault, vaultBytes
  if (existing) {
    vaultBytes = existing
    pass = await passphrase()
    vault = await c.decryptVault(vaultBytes, pass)
  } else {
    if (!pass) ({ pass, generated } = await newVaultPassphrase({ strict }))
    vault = await c.createVault()
    logger.info('stretching your passphrase with scrypt (this takes a second on purpose)')
    vaultBytes = await c.encryptVault(vault, pass, { logN: scryptLogN ? Number(scryptLogN) : c.DEFAULT_SCRYPT_LOG_N })
  }
  await writePrivate(f.vault, vaultBytes)
  const keys = await c.unlockKeys(vault)
  // credentials typed in (or in the --from file) go into secrets.ovk, never into config.json
  await unlockSecrets({ cfg, home, backends, keys, writeConfig: false })
  await writePrivate(f.config, JSON.stringify(cfg, null, 2) + '\n')

  const store = new Overkill({ backends, keys, vaultBytes, indexCache: indexCache(home), indexSync: cfg.index_sync ?? 'always' })
  try {
    if (existing) {
      // joining: only fill in the backends that do not have vault.age yet
      await store.mergedIndex() // also teaches paste backends their locators
      for (const b of backends) {
        if (await b.exists(c.paths.vault).catch(() => false)) { out(`  ${b.name}: vault.age already there`); continue }
        await b.put(c.paths.vault, vaultBytes)
          .then(() => out(`  ${b.name}: vault.age ${green('uploaded')}`), (err) => out(`  ${b.name}: vault.age ${red('FAILED: ' + err.message)}`))
      }
    } else {
      // a zero-config vault fills in for a failed default host with the next known-good one
      const picker = fresh ? fallbackPicker(cfg, { ...(fallbacks ? { lists: fallbacks } : {}), make: (bc) => createBackend(bc, { root: cfg.root, home, secrets: backends.secrets }) }) : null
      const res = await store.uploadVault({ next: picker ? (b) => picker.next(b) : undefined })
      for (const r of res) out(`  ${r.backend.name}: vault.age ${r.ok ? green('uploaded') + (r.replaced ? ` (in place of ${r.replaced})` : '') : red('FAILED: ' + r.error.message)}`)
      const stored = res.filter((r) => r.ok).length
      if (!stored) throw new Error('vault.age could not be stored anywhere; nothing is set up remotely (local state is in ' + home + ')')
      if (picker && picker.apply(res).length) await writePrivate(f.config, JSON.stringify(cfg, null, 2) + '\n')
      const failed = res.length - stored
      if (stored < MIN_COPIES) logger.warn(`vault.age is on only ${stored} host; run \`super-secret-notes repair\` once the others answer`)
      else if (failed) out(`Stored on ${stored} hosts; ${failed} failed (\`super-secret-notes repair\` retries them)`)
      // a new vault's index is empty; with no index-holding host answering it stays on this device for now
      await store.writeIndex(c.emptyIndex())
    }
    await publishDiscovery({ cfg, home, pass, vaultBytes, store, force: !existing })
    out()
    out(await recoveryKit({ vault, cfg, backends: store.backends, generated }))
    out(`\nLocal state: ${home}`)
  } finally {
    await store.close()
  }
}

export function buildCli () {
  const program = new Command()
  program
    .name('super-secret-notes')
    .description('Double-encrypted notes, copied to several clouds. Overkill on purpose.')
    .version(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, '-V, --version')
    .option('--home <dir>', 'state directory (default $OVERKILL_HOME or ~/.overkill-notes)')
    .showHelpAfterError()

  program.command('init')
    .description('create a vault on the zero-signup defaults and print the recovery kit')
    .option('--advanced', 'guided setup with a choice of backends (MEGA, Proton, Filen, ...); also joins an existing vault')
    .option('--from <config.json>', 'non-interactive: read {root, backends} from a file')
    .option('--root <folder>', 'root folder on every backend')
    .option('--scrypt-log-n <n>', 'scrypt work factor for vault.age (default 18)')
    .option('--index-sync <mode>', 'always (default), manual or never: whether the index goes to the backends')
    .action((o) => init({ ...program.opts(), ...o }))

  program.command('put <name> [file]')
    .description('encrypt a note (from file or stdin) and upload it everywhere; makes a vault first if there is none')
    .option('--no-sample', 'skip the spot check of 3 other copies after the upload')
    .action(async (name, file, o) => {
      const data = file ? new Uint8Array(await readFile(file)) : await readStdin()
      if (!await vaultExists(homeDir(program.opts().home))) {
        await zeroConfigInit(program.opts())
        out()
      }
      await withStore(program.opts(), async (store, ctx) => {
        const { entry, results, sampled, findable } = await store.put(name, data, { sample: o.sample })
        const ok = results.filter((r) => r.ok).length
        out(`${name}: ${entry.size} bytes, ${ok}/${results.length} backends (${results.map((r) => `${r.backend} ${r.ok ? green('OK') : red('FAILED')}`).join(', ')})`)
        if (sampled.length) {
          const bad = sampled.filter((x) => x.status !== 'OK')
          const label = (x) => `${x.key} on ${x.backend}`
          if (bad.length) {
            logger.warn(`spot check: ${bad.map((x) => `${label(x)} ${x.status}`).join(', ')}. Run \`super-secret-notes repair\`.`)
          } else {
            out(`spot check: ${sampled.map(label).join(', ')} ${green('OK')}`)
          }
        }
        await publishDiscovery({ ...ctx, store })
        // not findable from other devices yet: the store has warned; the exit code says so too
        if (ok < results.length || findable === false) process.exitCode = 1
      })
    })

  program.command('get <name>')
    .description('download, decrypt and verify a note (falls back across backends)')
    .option('-o, --output <file>', 'write to a file instead of stdout')
    .option('--from <backend>', 'read the copy on this backend even if it is a version the index does not know (DIVERGED)')
    .action(async (name, o) => {
      await withStore(program.opts(), async (store) => {
        const { bytes, from, status } = await store.get(name, { from: o.from })
        if (o.from && status !== 'OK') logger.warn(`read "${name}" from ${from}: both layers verified, but it is ${status === 'STALE' ? 'an older version' : 'a version the index does not know'}; \`put\` it again to make it the current one`)
        else logger.info(`read "${name}" from ${from}, both layers and sha256 verified`)
        if (o.output) await writeFile(o.output, bytes)
        else process.stdout.write(bytes)
      })
    })

  program.command('ls')
    .description('list notes from the merged index')
    .action(async () => {
      await withStore(program.opts(), async (store) => {
        const notes = Object.entries(await store.list()).sort(([a], [b]) => a.localeCompare(b))
        if (!notes.length) return out('(no notes yet: try `echo "router admin: 7kP-2mQx" | super-secret-notes put "wifi password"`)')
        for (const [name, e] of notes) out(`${name}\t${e.size} B\t${e.updated}\t${e.id}`)
      })
    })

  program.command('check')
    .description('download every copy from every backend and verify it')
    .option('-v, --verbose', 'list every copy, not just the ones with problems (the default up to 6 backends)')
    .action(async (o) => {
      await withStore(program.opts(), async (store) => {
        const compact = !o.verbose && store.backends.length > 6
        const { lines, healthy, total } = summarize(await store.check(), { compact })
        const w = Math.max(...lines.map((l) => l.label.length))
        for (const l of lines) out(`${l.label.padEnd(w)}  ${l.ok ? l.text : red(l.text)}`)
        if (!store.remoteIndex) out(await localIndexLine(program.opts(), store))
        const all = healthy === total
        out((all ? green : red)(`${healthy}/${total} copies healthy`) + (all ? '. Gloriously redundant.' : '. Run `super-secret-notes repair`.'))
        if (!all) process.exitCode = 1
      })
    })

  program.command('sync')
    .description('push this machine\'s index to the backends (index_sync manual or never)')
    .option('--force', 'also with index_sync never')
    .action(async (o) => {
      await withStore(program.opts(), async (store, { home }) => {
        if (store.remoteIndex) return out('index_sync is "always": the index already goes out with every put.')
        if (store.indexSync === 'never' && !o.force) throw new Error('index_sync is "never"; use --force to push it anyway')
        const res = await store.sync()
        for (const r of res) out(`  ${r.backend.name}: index ${r.ok ? green('synced') : red('FAILED: ' + r.error.message)}`)
        if (res.some((r) => r.ok)) await markSynced(home)
        else process.exitCode = 1
      })
    })

  program.command('config')
    .description('change a setting: `super-secret-notes config set index_sync manual`')
    .argument('<action>', 'set')
    .argument('<key>', 'index_sync')
    .argument('<value>')
    .action(async (action, key, value) => {
      if (action !== 'set' || key !== 'index_sync') throw new Error('only `config set index_sync <always|manual|never>` for now')
      if (!INDEX_SYNC_MODES.includes(value)) throw new Error(`index_sync must be one of ${INDEX_SYNC_MODES.join(', ')}`)
      const home = homeDir(program.opts().home)
      const cfg = await readConfig(home)
      const was = cfg.index_sync ?? 'always'
      cfg.index_sync = value
      await writePrivate(files(home).config, JSON.stringify(cfg, null, 2) + '\n')
      out(`index_sync: ${was} -> ${value}`)
      if (value === 'always' && was !== 'always') out('Run any put (or `super-secret-notes repair`) once so the backends get the current index.')
    })

  const indexCmd = program.command('index').description('the index itself (the encrypted list of notes and where their copies are)')
  indexCmd.command('export')
    .description('write the index to stdout or a file: encrypted (OVK1) by default')
    .option('-o, --output <file>', 'write to a file instead of stdout')
    .option('--plaintext', 'plain JSON: reveals note names and the PrivateBin/Blossom locators (their keys too)')
    .option('--yes-reveal-note-names', 'confirm --plaintext')
    .action(async (o) => {
      await withStore(program.opts(), async (store) => {
        const index = await store.mergedIndex()
        let bytes
        if (o.plaintext) {
          if (!o.yesRevealNoteNames) throw new Error('--plaintext needs --yes-reveal-note-names: the output shows every note name and the locators of your PrivateBin/Blossom copies, including their third-layer keys. Note contents stay protected by the two Overkill layers.')
          logger.warn('plaintext index: note names and paste/Blossom locators (with their keys) are readable by whoever gets this')
          bytes = new TextEncoder().encode(JSON.stringify(index, null, 2) + '\n')
        } else {
          bytes = await c.encryptIndex(store.keys, index)
        }
        if (o.output) await writeFile(o.output, bytes, { mode: 0o600 })
        else process.stdout.write(bytes)
      })
    })

  program.command('status')
    .description('what the health ledger knows, offline: per backend copies, last verified, warnings')
    .action(async () => {
      const home = homeDir(program.opts().home)
      const cfg = await readConfig(home)
      const vaultBytes = new Uint8Array(await readFile(files(home).vault))
      const keys = await c.unlockKeys(await c.decryptVault(vaultBytes, await passphrase()))
      const cached = await readFile(files(home).indexCache).catch(() => null)
      if (!cached) throw new Error('no ledger on this machine yet: run `super-secret-notes check` once')
      const index = await c.decryptIndex(keys, new Uint8Array(cached))
      const remote = (cfg.index_sync ?? 'always') === 'always'
      const names = cfg.backends.map((b) => b.name)
      const indexOn = remote ? cfg.backends.filter((b) => holdsIndex(b.type)).map((b) => b.name) : []
      const { backends, warnings } = ledgerStatus(index, names, new Date(), { indexOn })
      const w = Math.max(...backends.map((b) => b.backend.length))
      out(`${'backend'.padEnd(w)}  healthy  oldest ok       retention`)
      for (const b of backends) {
        const h = `${b.healthy}/${b.copies}`
        // red only for copies that failed a check; unverified ones are just not known yet
        const failed = b.copies - b.unverified - b.healthy
        const paintCount = failed > 0 ? red : b.unverified ? (x) => x : green
        out(`${b.backend.padEnd(w)}  ${paintCount(h.padEnd(7))}  ${ago(b.oldestOk).padEnd(14)}  ${retention(cfg.backends.find((x) => x.name === b.backend)?.type, b.nextExpiry)}`)
      }
      out(`(ledger from ${index.written ?? 'unknown'}; \`super-secret-notes check\` verifies everything live)`)
      if (!remote) out(await localIndexLine(program.opts(), { indexSync: cfg.index_sync }))
      for (const x of warnings) out(x.startsWith('STALE CHECK') ? x : red(x))
      if (!warnings.length) out(green('No warnings. Every copy was verified recently.'))
    })

  program.command('repair')
    .description('re-upload missing, corrupt or stale copies from a healthy one; swap long-dead hosts for healthy ones')
    .option('--no-swap', 'keep long-dead PrivateBin/CryptPad/Nostr/Blossom backends instead of swapping them')
    .action(async (o) => {
      await withStore(program.opts(), async (store, ctx) => {
        let { fixed, failed, diverged } = await store.repair()
        for (const x of fixed) out(`${green('repaired')} ${x}`)
        for (const x of diverged) out(`${yellow('left alone')} ${x}: a version the index does not know (maybe newer); read it with \`get --from\` and put it again to keep it`)
        if (o.swap) {
          const s = await swapDeadBackends({ store, cfg: ctx.cfg, home: ctx.home, created: ctx.vault.created, fixed })
          for (const x of s.swaps) out(`${green('swapped')} ${x.from} (${x.fromWhere}, dead) for ${x.to} (${x.toWhere})`)
          // what failed on a swapped-out backend is moot; the second pass covers the new one
          const gone = s.swaps.map((x) => x.from)
          if (s.swaps.length) failed = [...failed.filter((x) => !gone.some((n) => mentions(n, [x]))), ...s.failed]
          for (const x of s.fixed) out(`${green('repaired')} ${x}`)
          fixed = [...fixed, ...s.fixed]
          if (s.swaps.length) {
            await publishDiscovery({ ...ctx, store, force: true })
            out('The backend list changed: reprint the recovery kit with `super-secret-notes kit`.')
          }
        }
        for (const x of failed) out(`${red('could not repair')} ${x}`)
        if (!fixed.length && !failed.length && !diverged.length) out('Nothing to repair. Everything is fine. Suspiciously fine.')
        for (const hint of await replacementHints({ index: store.lastIndex, backends: ctx.cfg.backends, home: ctx.home, fixed, created: ctx.vault.created })) out(hint)
        if (failed.length) process.exitCode = 1
      })
    })

  program.command('refresh')
    .description('re-upload copies that are missing or expire soon (run it from cron now and then)')
    .option('--days <n>', 'treat copies expiring within this many days as due', '90')
    .action(async (o) => {
      await withStore(program.opts(), async (store, ctx) => {
        const { fixed, failed } = await store.refresh({ days: Number(o.days) })
        await publishDiscovery({ ...ctx, store })
        for (const x of fixed) out(`${green('refreshed')} ${x}`)
        for (const x of failed) out(`${red('could not refresh')} ${x}`)
        if (!fixed.length && !failed.length) out(`Nothing missing, nothing expiring within ${o.days} days. Your notes will outlive us all.`)
        for (const hint of await replacementHints({ index: store.lastIndex, backends: ctx.cfg.backends, home: ctx.home, fixed, created: ctx.vault.created })) out(hint)
        if (failed.length) process.exitCode = 1
      })
    })

  program.command('chaos <backend> <name>')
    .description('flip one byte in one backend\'s copy of a note (to watch check and repair work)')
    .action(async (backendName, name) => {
      await withStore(program.opts(), async (store) => {
        const b = store.backends.find((x) => x.name === backendName)
        if (!b) throw new Error(`no backend called "${backendName}"`)
        const index = await store.mergedIndex() // paste backends need their locators first
        const p = c.paths.note(await c.blobIdForName(store.keys, name))
        const blob = await b.get(p)
        if (!blob) throw new Error(`${backendName} has no copy of "${name}"`)
        const i = Math.floor(blob.length / 2)
        blob[i] ^= 0x42
        await b.put(p, blob)
        if (b.getLocators) await store.writeIndex(index) // the damaged paste has a new address
        out(`Flipped byte ${i} of ${p} on ${backendName}. A cosmic ray, basically. Now try \`super-secret-notes check\`.`)
      })
    })

  program.command('recover')
    .description('rebuild this machine\'s vault: from its name and passphrase, or from the printed kit')
    .option('--name <vault>', 'the vault name chosen at init (asks for the passphrase)')
    .option('--kit <file>', 'the recovery kit as text (- for stdin); sets a new passphrase')
    .option('--scrypt-log-n <n>', 'scrypt work factor for the rebuilt vault.age (default 18)')
    .action(async (o) => {
      const home = homeDir(program.opts().home)
      if (await vaultExists(home)) throw new Error(`there is already a vault here: ${files(home).config}`)
      if (!o.name === !o.kit) throw new Error('say --name <vault> or --kit <file>')
      if (o.kit) return recoverFromKit(o, home)
      const { cfg, others, from } = await recover({ name: o.name, passphrase: await passphrase(), home })
      out(`Found "${cfg.name}" on ${from}. This machine now knows ${cfg.backends.length} backends: ${cfg.backends.map((b) => b.name).join(', ')}.`)
      if (others.length) out(`Not restored (they need their own logins, add them with init --advanced on a spare home): ${others.map((b) => `${b.name} (${b.type})`).join(', ')}`)
      if ((cfg.index_sync ?? 'always') !== 'always') {
        logger.warn(`this vault keeps its index locally (index_sync ${cfg.index_sync}): what came back is the index as of its last sync. Notes written after that are not listed; \`super-secret-notes get <exact name>\` still finds them.`)
      }
      out('Next: `super-secret-notes ls`, and `super-secret-notes check` to see every copy.')
    })

  program.command('backup')
    .description('write a full backup: vault.age, the index and every note, all still encrypted, in one file')
    .requiredOption('-o, --output <file>', 'where to write it (- for stdout)')
    .action(async (o) => {
      await withStore(program.opts(), async (store, { cfg, vault, vaultBytes }) => {
        const text = await makeBackup({ store, cfg, keys: await c.unlockKeys(vault), vaultBytes })
        if (o.output === '-') return void process.stdout.write(text)
        await writePrivate(o.output, text)
        out(`Backup written to ${o.output} (${JSON.parse(text).notes} notes). It opens only with your passphrase; keep it somewhere safe and offline.`)
      })
    })

  program.command('restore <file>')
    .description('rebuild a vault on this machine from a backup file, with no host needed; `repair` then copies it back to the hosts')
    .action(async (file) => {
      const home = homeDir(program.opts().home)
      if (await vaultExists(home)) throw new Error(`already initialized: ${files(home).config}`)
      const text = await readFile(file, 'utf8')
      const pass = await passphrase()
      const { keys, vaultBytes, cfg, index, files: blobs } = await openBackup(text, pass)
      // the backup's blobs become a folder backend of this machine: readable now, and the source for `repair`
      const copy = { name: 'backup-copy', type: 'local', path: path.join(home, 'backup-copy') }
      cfg.backends = [...(cfg.backends ?? []).filter((b) => b.name !== copy.name), copy]
      cfg.root ??= DEFAULT_ROOT
      const local = createBackend(copy, { root: cfg.root, home })
      for (const [rel, bytes] of Object.entries(blobs)) await local.put(rel, bytes)
      await writePrivate(files(home).vault, vaultBytes)
      await writePrivate(files(home).config, JSON.stringify(cfg, null, 2) + '\n')
      await indexCache(home).write(await c.encryptIndex(keys, index))
      out(`Restored${cfg.name ? ` "${cfg.name}"` : ''} with ${Object.keys(index.notes).length} notes; they read from ${copy.path} right away.`)
      out('Run `super-secret-notes repair` to copy everything back to the hosts.')
    })

  program.command('kit')
    .description('print the recovery kit again')
    .action(async () => {
      const home = homeDir(program.opts().home)
      const cfg = await readConfig(home)
      await withStore(program.opts(), async (store, { vault }) => out(await recoveryKit({ vault, cfg, backends: store.backends })))
    })

  registerHostsCommand(program, { home: () => homeDir(program.opts().home), out })

  return program
}
