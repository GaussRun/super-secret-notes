// Restoring from the printed recovery kit (Option B): the age identity and the master are the
// keys; the backend lines tell where the copies are. vault.age is rebuilt under a new
// passphrase, because the old one is often exactly what got lost. Also prints the kit.
import { paths } from './crypto.js'
import { DEFAULT_ROOT } from './defaults-core.js'

const field = (lines, label) => lines.find((l) => l.startsWith(label))?.slice(label.length).trim()

/** Kit text (as printed, with or without its "| " frame) -> what can be restored. */
export function parseKit (text) {
  const lines = text.split('\n').map((l) => l.replace(/^\|\s?/, '').replace(/\s+$/, ''))
  const t = lines.map((l) => l.trim())
  const vault = {
    v: 1,
    age_identity: field(t, 'age identity:'),
    master: field(t, 'master (b64):'),
    created: field(t, 'created:') ?? new Date().toISOString()
  }
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(vault.age_identity ?? '') || !vault.master) {
    throw new Error('this does not look like an Overkill recovery kit (no "age identity:" and "master (b64):" lines)')
  }
  const name = field(t, 'vault name:')
  const root = field(t, 'root folder:') ?? 'overkill'
  const indexSync = /index_sync: (manual|never)\./.exec(text)?.[1]
  // "cp-private: ovk-0123456789abcdef (password derived from master)"
  const derived = new Set(t.filter((l) => /\(password derived from master\)$/.test(l)).map((l) => l.split(':')[0]))
  // "vault.age" locators of paste backends: "pb-envs:" followed by "vault.age: <url>"
  const locators = {}
  for (let i = 0; i < t.length - 1; i++) {
    const m = /^([\w.-]+):$/.exec(t[i])
    const v = /^vault\.age: (https?:\/\/\S+)$/.exec(t[i + 1])
    if (m && v) locators[m[1]] = v[1]
  }
  const backends = []
  const others = []
  for (const l of t) {
    const m = /^- ([\w.-]+) \(([\w-]+)\) at (.+)$/.exec(l)
    if (!m) continue
    const [, bname, type, where] = m
    const cfg = restoreBackend(bname, type, where, root, derived)
    if (cfg) {
      if (locators[bname]) cfg.locators = { 'vault.age': locators[bname] }
      backends.push(cfg)
    } else {
      others.push({ name: bname, type })
    }
  }
  return { vault, cfg: { v: 1, ...(name ? { name } : {}), root, ...(indexSync ? { index_sync: indexSync } : {}), backends }, others }
}

// Only backends that need no login of their own can come back from the sheet alone.
function restoreBackend (name, type, where, root, derived) {
  switch (type) {
    case 'privatebin':
    case 'blossom':
    case 'nostr':
      return { name, type, url: where }
    case 'cryptpad': {
      if (!derived.has(name)) return null // its own login: not on the sheet
      return { name, type, origin: where.split(' ')[0], derived: true }
    }
    case 'local':
      return where.endsWith(`/${root}`) ? { name, type, path: where.slice(0, -root.length - 1) } : null
    default:
      return null
  }
}

/** The printed recovery kit (shared with the web client, which must print the same sheet). */
export async function recoveryKit ({ vault, cfg, backends, generated }) {
  const accounts = []
  for (const b of backends.filter((x) => x.accountName)) {
    const name = await b.accountName().catch(() => null)
    if (name) accounts.push(`    ${b.name}: ${name} (password derived from master)`)
  }
  const located = []
  for (const b of backends.filter((x) => x.getLocators)) {
    const map = await b.getLocators()
    located.push(`    ${b.name}:`)
    located.push(`      ${paths.vault}: ${map[paths.vault] ?? '(not uploaded yet)'}`)
  }
  // every relay carries the same key: list it once
  const relays = backends.filter((b) => b.kitLines && b.kitLines().length)
  const kit = relays.length
    ? [`    ${relays[0].kitLines()[0].replace(/^[^:]+: /, '')}`, `    on: ${relays.map((b) => b.name).join(', ')}`]
    : []
  const lines = [
    'SUPER SECRET NOTES  -  RECOVERY KIT',
    '',
    'Print this and keep it somewhere safe and offline. With your passphrase or',
    'with this sheet, anyone can open your vault; without both, nobody can.',
    '',
    'Option A: vault.age (on every backend below) + your passphrase.',
    'Option B: this sheet. The two lines below ARE your keys; save the sheet as a',
    'text file and run `super-secret-notes recover --kit <file>`:',
    '',
    `  age identity: ${vault.age_identity}`,
    `  master (b64): ${vault.master}`,
    ...(generated ? ['', `  passphrase:   ${generated}`] : []),
    '',
    ...(cfg.name ? [`  vault name:   ${cfg.name}`] : []),
    `  created:      ${vault.created}`,
    `  root folder:  ${cfg.root ?? DEFAULT_ROOT}`,
    '  backends:',
    ...backends.map((b) => `    - ${b.name} (${b.type}) at ${b.where}`),
    ...(accounts.length ? ['', '  CryptPad accounts this vault created:', ...accounts] : []),
    ...((cfg.index_sync ?? 'always') !== 'always'
      ? ['', `  index_sync: ${cfg.index_sync}. The index (the list of your notes) lives on this`, '  machine and reaches the backends only with `super-secret-notes sync`. Recovering elsewhere', '  sees the notes as of the last sync; later ones are only found by exact name.']
      : []),
    ...(kit.length ? ['', '  nostr (public key, not a secret; the kit keys above derive its secret):', ...kit] : []),
    ...(located.length
      ? ['', '  vault.age on paste backends (the #key part is a key, keep it secret):', ...located]
      : []),
    '',
    'Lose the passphrase AND this sheet and your notes are gone forever.',
    'No support hotline, no "forgot password" link. That is the point.'
  ]
  const bar = '+' + '-'.repeat(72)
  return [bar, ...lines.map((l) => `| ${l}`.trimEnd()), bar].join('\n')
}
