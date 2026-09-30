// Directory parsers: text or Nostr events in, candidate host URLs out. Pure functions, no network.
// Every parser returns normalized URLs in directory order (best first where the directory ranks).

const HTML_ENTITIES = { '&amp;': '&', '&#x2F;': '/', '&#47;': '/', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }
const unescapeHtml = (s) => s.replace(/&(?:amp|#x2F|#47|quot|#39|lt|gt);/g, (m) => HTML_ENTITIES[m])

// IPv4 ranges that are not the public internet: this host, private networks, carrier NAT,
// link-local (cloud metadata at 169.254.169.254), benchmarking, multicast and reserved
const v4 = (dotted) => dotted.split('.').reduce((acc, x) => acc * 256 + Number(x), 0)
const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3']
  .map((cidr) => { const [net, bits] = cidr.split('/'); return { size: 2 ** (32 - Number(bits)), net: v4(net) } })
// names that only resolve inside a local network (RFC 6761, 6762, 8375, and common private suffixes)
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa|localdomain|intranet|corp)$/i

/**
 * True for a host a directory must never send us to. The URL parser has already turned every
 * IPv4 spelling (decimal, hex, octal) into dotted form. IPv6 literals are refused outright:
 * public hosts are listed by name. Names are checked as written only: one that resolves to a
 * private address (DNS rebinding) is out of scope for a CLI that probes public hosts.
 */
function internalHost (hostname) {
  const h = hostname.replace(/\.$/, '')
  if (h.startsWith('[')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const ip = v4(h)
    return PRIVATE_V4.some(({ net, size }) => Math.floor(ip / size) === net / size)
  }
  return LOCAL_NAME.test(h)
}

/** Canonical form of a host URL for one backend type, or null when it cannot be one. */
export function normalize (type, raw) {
  let u
  try { u = new URL(String(raw).trim()) } catch { return null }
  // plain http/ws and 127.0.0.1 only for tests (OVERKILL_HOSTS_ALLOW_LOOPBACK=1), only on this machine
  const local = process.env.OVERKILL_HOSTS_ALLOW_LOOPBACK === '1' && u.hostname === '127.0.0.1'
  // query strings and fragments are dropped: they are never part of a host address here
  if (u.username || u.password || /\.(onion|i2p)$/i.test(u.hostname) || !u.hostname.includes('.')) return null
  if (!local && internalHost(u.hostname)) return null
  if (type === 'nostr') {
    if (u.protocol !== 'wss:' && !(local && u.protocol === 'ws:')) return null
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
  }
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null
  // CryptPad is identified by its origin; PrivateBin and Blossom can live under a path
  if (type === 'cryptpad') return u.origin.toLowerCase()
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
}

const unique = (type, urls) => [...new Set(urls.map((x) => normalize(type, x)).filter(Boolean))]

/** privatebin.info/directory/api: [{ url, https, ... }] */
export function privatebinJson (text) {
  const list = JSON.parse(text)
  if (!Array.isArray(list)) throw new Error('expected a JSON array')
  return unique('privatebin', list.filter((x) => x && x.https !== false).map((x) => (typeof x === 'string' ? x : x.url)))
}

/** privatebin.info/directory/: the first link in each table row */
export function privatebinHtml (text) {
  const urls = [...text.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*<a[^>]*href="([^"]+)"/g)].map((m) => unescapeHtml(m[1]))
  return unique('privatebin', urls)
}

/** cryptpad.org/instances/: <section class="instance" data-url="..."> */
export function cryptpadHtml (text) {
  const urls = [...text.matchAll(/<section[^>]*class="instance"[^>]*data-url="([^"]+)"/g)].map((m) => unescapeHtml(m[1]))
  return unique('cryptpad', urls)
}

const tagValues = (ev, name) => ev.tags.filter((t) => t[0] === name).map((t) => t[1])

// NIP-66 "R" requirements that rule a relay out: auth, payment, proof of work, restricted writes
const BLOCKING = new Set(['auth', 'payment', 'pow', 'writes'])

/** NIP-66 kind 30166 events: relays with no blocking requirement, most monitors first. */
export function nip66 (events) {
  const seen = new Map() // url -> { monitors, blocked }
  for (const ev of events) {
    if (ev?.kind !== 30166) continue
    const url = normalize('nostr', tagValues(ev, 'd')[0])
    if (!url) continue
    const cur = seen.get(url) ?? { monitors: new Set(), blocked: false }
    cur.monitors.add(ev.pubkey)
    if (tagValues(ev, 'R').some((r) => BLOCKING.has(r))) cur.blocked = true
    seen.set(url, cur)
  }
  return [...seen].filter(([, v]) => !v.blocked).sort((a, b) => b[1].monitors.size - a[1].monitors.size).map(([url]) => url)
}

/** CSV with relay host names in the first column (georelays): wss://<host> */
export function hostCsv (text) {
  const hosts = text.split(/\r?\n/).slice(1).map((line) => line.split(',')[0].trim()).filter(Boolean)
  return unique('nostr', hosts.map((h) => (h.includes('://') ? h : `wss://${h.replace(/:443$/, '')}`)))
}

/** Kind 36363 Blossom server announcements; servers that announce a whitelist or payment are skipped. */
export function blossom36363 (events) {
  const urls = events
    .filter((ev) => ev?.kind === 36363 && !ev.tags.some((t) => t[0] === 'whitelist' || t[0] === 'paid'))
    .map((ev) => tagValues(ev, 'd')[0])
  return unique('blossom', urls)
}

/** Kind 10063 user server lists: every "server" tag, most used first. */
export function blossom10063 (events) {
  const users = new Map()
  for (const ev of events) {
    if (ev?.kind !== 10063) continue
    for (const s of new Set(tagValues(ev, 'server').map((x) => normalize('blossom', x)).filter(Boolean))) {
      users.set(s, (users.get(s) ?? 0) + 1)
    }
  }
  return [...users].sort((a, b) => b[1] - a[1]).map(([url]) => url)
}

/** Markdown or plain text: every link of the right scheme, optionally only under one heading. */
export function links (type, text, section = null) {
  if (section) {
    const start = text.search(new RegExp(`^#+\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im'))
    if (start < 0) return []
    const rest = text.slice(start).split('\n').slice(1).join('\n')
    text = rest.slice(0, rest.search(/^#/m) >= 0 ? rest.search(/^#/m) : undefined)
  }
  // plain http/ws links are matched too, so normalize() can refuse them with the same rules
  const scheme = type === 'nostr' ? 'wss?' : 'https?'
  const urls = [...text.matchAll(new RegExp(`${scheme}://[^\\s"'<>()\\[\\]]+`, 'g'))].map((m) => unescapeHtml(m[0]).replace(/[.,;:]+$/, ''))
  return unique(type, urls)
}

export const PARSERS = {
  'privatebin-json': (type, text) => privatebinJson(text),
  'privatebin-html': (type, text) => privatebinHtml(text),
  'cryptpad-html': (type, text) => cryptpadHtml(text),
  'host-csv': (type, text) => hostCsv(text),
  markdown: (type, text, entry) => links(type, text, entry?.section),
  nip66: (type, events) => nip66(events),
  'blossom-36363': (type, events) => blossom36363(events),
  'blossom-10063': (type, events) => blossom10063(events)
}

/** Formats read from a Nostr relay, and the event kinds each one asks for. */
export const EVENT_KINDS = { nip66: [30166], 'blossom-36363': [36363], 'blossom-10063': [10063] }

/**
 * Format for a directory given with --directory: wss:// URLs are relays holding the type's
 * directory events; for web pages the content decides, with a plain link scan as the last resort.
 */
export function guessFormat (type, url, text = null) {
  if (/^wss?:\/\//.test(url)) return type === 'nostr' ? 'nip66' : type === 'blossom' ? 'blossom-36363' : null
  if (text === null) return null
  const t = text.trimStart()
  if (type === 'privatebin' && t.startsWith('[')) return 'privatebin-json'
  if (type === 'privatebin' && /<tr[^>]*>\s*<td[^>]*>\s*<a[^>]*href=/.test(text)) return 'privatebin-html'
  if (type === 'cryptpad' && /class="instance"[^>]*data-url=/.test(text)) return 'cryptpad-html'
  if (type === 'nostr' && /^[^\n<]*,/.test(t) && !/wss:\/\//.test(t.split('\n', 2)[1] ?? '')) return 'host-csv'
  return 'markdown'
}
