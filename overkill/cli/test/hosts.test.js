// `super-secret-notes hosts`: directory parsers, probes, refresh, the host cache and how init and repair use
// it. Everything runs against in-process fakes (test/fake-hosts.js), no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rename, writeFile, access } from 'node:fs/promises'
import * as c from '../src/crypto.js'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import * as parse from '../src/hosts/parse.js'
import { probePrivatebin, probeBlossom, probeCryptpad, probeNostr } from '../src/hosts/probe.js'
import { refreshHosts } from '../src/hosts/refresh.js'
import { loadCache, saveCache, knownHosts } from '../src/hosts/cache.js'
import { preferredHosts, deadBackends, replacementHints, site } from '../src/hosts/pick.js'
import { replacementFor } from '../src/hosts/swap.js'
import { KNOWN, staleHint } from '../src/hosts/directories.js'
import { defaultBackends } from '../src/defaults.js'
import { startFakePrivatebin, startFakeBlossom, startFakeCryptpad, startFakeRelayWithInfo, startFakeWeb } from './fake-hosts.js'

process.env.OVERKILL_HOSTS_ALLOW_LOOPBACK = '1'
const BIN = fileURLToPath(new URL('../bin/super-secret-notes.js', import.meta.url))
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'ssn-hosts-'))
const now = () => Math.floor(Date.now() / 1000)
const DAY = 86_400_000

// a port nothing listens on (port 1 and friends are on fetch's blocked list)
async function closedPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

function cli (env, args, input = '') {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1', OVERKILL_HOSTS_ALLOW_LOOPBACK: '1', ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

// ---- parsers ----

test('parse: PrivateBin directory JSON and HTML', () => {
  const json = JSON.stringify([
    { url: 'https://paste.example.org/', https: true },
    { url: 'http://plain.example.org', https: false },
    { url: 'https://Bin.Example.net/paste/', https: true },
    { url: 'https://paste.example.org', https: true }
  ])
  assert.deepEqual(parse.privatebinJson(json), ['https://paste.example.org', 'https://bin.example.net/paste'])
  const html = `<table><thead><tr><th scope="col">Address</td></tr></thead><tbody>
    <tr class="opacity4">
      <td>
        <a href="https:&#x2F;&#x2F;0bin.example">https:&#x2F;&#x2F;0bin.example</a>
      </td><td>2.0.6</td><td><a href="https://observatory.example/x">A+</a></td>
    </tr>
    <tr><td><a href="https:&#x2F;&#x2F;cryptostorm.example&#x2F;paste&#x2F;">x</a></td></tr>
    <tr><td><a href="http:&#x2F;&#x2F;insecure.example">x</a></td></tr>
  </tbody></table>`
  assert.deepEqual(parse.privatebinHtml(html), ['https://0bin.example', 'https://cryptostorm.example/paste'])
  assert.equal(parse.guessFormat('privatebin', 'https://x.example/api', json), 'privatebin-json')
  assert.equal(parse.guessFormat('privatebin', 'https://x.example/', html), 'privatebin-html')
})

test('parse: CryptPad instances page', () => {
  const html = `<section class="instance-wrapper">
    <section class="instance" tabindex="0" data-url="https://cryptpad.example.org">
      <a href="https://cryptpad.example.org" target="_blank">x</a></section>
    <section class="instance" tabindex="0" data-url="https://pad.example.net/">
    </section></section><a href="https://forum.cryptpad.org">forum</a>`
  assert.deepEqual(parse.cryptpadHtml(html), ['https://cryptpad.example.org', 'https://pad.example.net'])
  assert.equal(parse.guessFormat('cryptpad', 'https://x.example/', html), 'cryptpad-html')
})

test('parse: NIP-66 monitors rank relays and drop auth, payment and restricted ones', () => {
  const ev = (d, R = [], sk = generateSecretKey()) => finalizeEvent({ kind: 30166, created_at: now(), tags: [['d', d], ...R.map((r) => ['R', r])], content: '' }, sk)
  const events = [
    ev('wss://one.example/', ['!auth', '!payment']),
    ev('wss://two.example/'), ev('wss://two.example'), ev('wss://two.example/'),
    ev('wss://paid.example/', ['payment']),
    ev('wss://closed.example/', ['writes']),
    ev('ws://insecure.example/'),
    ev('wss://hidden.onion/'),
    { kind: 1, tags: [['d', 'wss://not-a-monitor-event.example']], pubkey: 'x' }
  ]
  assert.deepEqual(parse.nip66(events), ['wss://two.example', 'wss://one.example'])
})

test('parse: relay host CSV, Blossom announcements and user lists, Markdown sections', () => {
  const csv = 'Relay URL,Latitude,Longitude\nrelay.one.example,1,2\nrelay.two.example:443,3,4\n\nrelay.one.example,1,2\n'
  assert.deepEqual(parse.hostCsv(csv), ['wss://relay.one.example', 'wss://relay.two.example'])
  assert.equal(parse.guessFormat('nostr', 'https://x.example/relays.csv', csv), 'host-csv')

  const sk = generateSecretKey()
  const ann = (d, extra = []) => finalizeEvent({ kind: 36363, created_at: now(), tags: [['d', d], ...extra], content: '' }, sk)
  assert.deepEqual(parse.blossom36363([ann('https://open.example/'), ann('https://club.example/', [['whitelist', '']]), ann('https://paid.example/', [['paid', '5000']])]), ['https://open.example'])

  const list = (...servers) => finalizeEvent({ kind: 10063, created_at: now(), tags: servers.map((s) => ['server', s]), content: '' }, generateSecretKey())
  assert.deepEqual(parse.blossom10063([list('https://a.example', 'https://b.example/'), list('https://b.example'), list('https://b.example', 'https://b.example/')]), ['https://b.example', 'https://a.example'])

  const md = '# Blossom\n- [tool](https://github.com/x/y)\n## Available blossom servers\n\n- [one](https://one.example)\n- https://two.example/.\n## Libraries\n- [lib](https://lib.example)\n'
  assert.deepEqual(parse.links('blossom', md, 'Available blossom servers'), ['https://one.example', 'https://two.example'])
  assert.deepEqual(parse.links('blossom', md, 'Missing section'), [])
  assert.equal(parse.links('blossom', md).length, 4)
  assert.equal(parse.guessFormat('blossom', 'wss://relay.example'), 'blossom-36363')
  assert.equal(parse.guessFormat('privatebin', 'wss://relay.example'), null)
})

test('parse: normalize keeps host addresses canonical and refuses the rest', () => {
  assert.equal(parse.normalize('privatebin', 'https://Paste.Example.org/sub/'), 'https://paste.example.org/sub')
  assert.equal(parse.normalize('cryptpad', 'https://pad.example.org/drive/'), 'https://pad.example.org')
  assert.equal(parse.normalize('nostr', 'wss://Relay.Example.org/'), 'wss://relay.example.org')
  assert.equal(parse.normalize('nostr', 'https://relay.example.org'), null)
  assert.equal(parse.normalize('blossom', 'http://blossom.example.org'), null)
  assert.equal(parse.normalize('blossom', 'https://user:pw@blossom.example.org'), null)
  assert.equal(parse.normalize('privatebin', 'not a url'), null)
  assert.equal(parse.normalize('privatebin', 'https://localhost'), null)
})

// ---- probes ----

test('probe PrivateBin: never offered and honored, test paste deleted, CORS noted', async () => {
  const pb = await startFakePrivatebin()
  try {
    const r = await probePrivatebin(pb.url)
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(r.details.expiry, 'never')
    assert.equal(r.details.deleted, true)
    assert.equal(r.details.cors, '*')
    assert.equal(pb.pastes.size, 0)
  } finally { await pb.close() }
})

test('probe PrivateBin: no never, capped never and refused posts fail; capped paste still deleted', async () => {
  const noNever = await startFakePrivatebin({ never: false })
  const capped = await startFakePrivatebin({ ttl: 3 * 86_400 })
  const refusing = await startFakePrivatebin({ refuse: 'Please wait 10 seconds between each post.' })
  try {
    let r = await probePrivatebin(noNever.url)
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /no "never"/)
    assert.ok(!noNever.requests.some((x) => x.startsWith('POST')), 'no paste without never')
    r = await probePrivatebin(capped.url)
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /capped.*3 days/)
    assert.equal(capped.pastes.size, 0)
    r = await probePrivatebin(refusing.url)
    assert.match(r.reason, /refused: Please wait/)
    r = await probePrivatebin(`http://127.0.0.1:${await closedPort()}`)
    assert.equal(r.status, 'failed')
    assert.equal(r.reason, 'ECONNREFUSED')
  } finally { await Promise.all([noNever.close(), capped.close(), refusing.close()]) }
})

test('probe Blossom: preflight, octet-stream upload, read back, delete; media-only servers fail', async () => {
  const ok = await startFakeBlossom()
  const media = await startFakeBlossom({ mediaOnly: true })
  const mediaNoPreflight = await startFakeBlossom({ mediaOnly: true, preflight: false })
  try {
    const r = await probeBlossom(ok.url)
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(r.details.deleted, true)
    assert.equal(r.details.cors, '*')
    assert.equal(ok.blobs.size, 0)
    const m = await probeBlossom(media.url)
    assert.equal(m.status, 'failed')
    assert.match(m.reason, /refused at preflight: HTTP 415 File type not allowed/)
    assert.deepEqual(media.requests, ['HEAD /upload'], 'no bytes sent after a refused preflight')
    const n = await probeBlossom(mediaNoPreflight.url)
    assert.match(n.reason, /octet-stream upload refused: HTTP 415 File type not allowed/)
  } finally { await Promise.all([ok.close(), media.close(), mediaNoPreflight.close()]) }
})

test('probe CryptPad: config only; open registration passes, captcha, TOTP and blocks fail', async () => {
  const open = await startFakeCryptpad()
  const closed = await startFakeCryptpad({ restrictRegistration: true })
  const captcha = await startFakeCryptpad({ captcha: true })
  const totp = await startFakeCryptpad({ enforceMFA: true })
  const blocked = await startFakeCryptpad({ forbidden: true })
  try {
    const r = await probeCryptpad(open.url)
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(r.details.quota, 1073741824)
    assert.equal((await probeCryptpad(closed.url)).reason, 'registration is closed')
    assert.equal((await probeCryptpad(captcha.url)).reason, 'captcha at registration')
    assert.equal((await probeCryptpad(totp.url)).reason, 'every account must set up TOTP')
    assert.equal((await probeCryptpad(blocked.url)).reason, '/api/config answered HTTP 403')
  } finally { await Promise.all([open, closed, captcha, totp, blocked].map((x) => x.close())) }
})

test('probe Nostr: NIP-11 limits, old data, a kind 30078 round trip and a deletion request', async () => {
  const old = finalizeEvent({ kind: 1, created_at: now() - 500 * 86_400, tags: [], content: 'old' }, generateSecretKey())
  const good = await startFakeRelayWithInfo({ events: [old] })
  const auth = await startFakeRelayWithInfo({ limitation: { auth_required: true } })
  const small = await startFakeRelayWithInfo({ limitation: { max_message_length: 16384 } })
  const refusing = await startFakeRelayWithInfo({ refuse: 'blocked: kind 30078 not accepted' })
  try {
    const r = await probeNostr(good.url, { pause: 0 })
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(r.details.servesOld, true)
    assert.equal(r.details.deleteRequested, true)
    assert.deepEqual(good.deleted, [r.details.event])
    assert.equal(good.events.length, 1, 'only the old note is left')
    assert.equal((await probeNostr(auth.url, { pause: 0 })).reason, 'NIP-11: auth required')
    assert.match((await probeNostr(small.url, { pause: 0 })).reason, /max_message_length 16384/)
    assert.match((await probeNostr(refusing.url, { pause: 0 })).reason, /refused: blocked: kind 30078/)
  } finally { await Promise.all([good.close(), auth.close(), small.close(), refusing.close()]) }
})

// ---- refresh ----

test('refresh: stale directories are named, the next one is used, results are cached, recent hosts skipped', async () => {
  const home = await tmp()
  const good = await startFakePrivatebin()
  const noNever = await startFakePrivatebin({ never: false })
  const web = await startFakeWeb({
    '/empty': { body: '[]', type: 'application/json' },
    '/api': { body: JSON.stringify([good.url, noNever.url, 'http://127.0.0.1:1', 'https://elsewhere.example'].map((url) => ({ url, https: true }))), type: 'application/json' }
  })
  const lines = []
  const directories = {
    privatebin: [
      { url: `${web.url}/gone`, format: 'privatebin-json' },
      { url: `${web.url}/empty`, format: 'privatebin-json' },
      { url: `${web.url}/api`, format: 'privatebin-json' }
    ]
  }
  // only the fake hosts are really probed; https://elsewhere.example stays unprobed by the cap
  try {
    const s = await refreshHosts({ home, type: 'privatebin', directories, cap: 3, pauseMs: 0, say: (l) => lines.push(l) })
    assert.deepEqual(s.privatebin, { listed: 4, probed: 3, ok: 1 })
    assert.ok(lines.includes(`privatebin: ${staleHint(`${web.url}/gone`)} (HTTP 404)`), lines.join('\n'))
    assert.ok(lines.includes(`privatebin: ${staleHint(`${web.url}/empty`)} (no privatebin hosts in it)`), lines.join('\n'))
    const cache = await loadCache(home)
    const byUrl = Object.fromEntries(cache.hosts.map((h) => [h.url, h]))
    assert.equal(byUrl[good.url].status, 'ok')
    assert.equal(byUrl[good.url].source, `${web.url}/api`)
    assert.ok(Date.now() - Date.parse(byUrl[good.url].probed) < 60_000)
    assert.equal(byUrl[noNever.url].status, 'failed')
    assert.equal(byUrl['http://127.0.0.1:1'].status, 'failed')
    assert.equal(byUrl['https://elsewhere.example'], undefined)
    assert.equal(cache.directories[`${web.url}/gone`].error, 'HTTP 404')
    assert.equal(cache.directories[`${web.url}/api`].count, 4)
    assert.equal(good.pastes.size, 0)

    // a second run only probes what was not probed recently
    const probed = []
    const fakeProbe = async (url) => { probed.push(url); return { status: 'failed', reason: 'fake' } }
    await refreshHosts({ home, type: 'privatebin', directories, cap: 3, pauseMs: 0, probes: { privatebin: fakeProbe } })
    assert.deepEqual(probed, ['https://elsewhere.example'])
  } finally { await Promise.all([good.close(), noNever.close(), web.close()]) }
})

test('refresh: when every directory is dead the built-in list is probed', async () => {
  const home = await tmp()
  const lines = []
  const probed = []
  const probes = { blossom: async (url) => { probed.push(url); return { status: 'ok', details: {} } } }
  const s = await refreshHosts({ home, type: 'blossom', directories: { blossom: [{ url: 'http://127.0.0.1:1/dir', format: 'markdown' }] }, cap: 2, pauseMs: 0, probes, say: (l) => lines.push(l) })
  assert.match(lines[0], /directory http:\/\/127\.0\.0\.1:1\/dir looks stale; use --directory <new url> or send a PR updating src\/hosts\/directories\.js/)
  assert.ok(lines.includes('blossom: every directory failed; probing the built-in list instead'))
  assert.deepEqual(probed, KNOWN.blossom.slice(0, 2))
  assert.equal(s.blossom.ok, 2)
  assert.equal((await loadCache(home)).hosts[0].source, 'built-in')
})

test('refresh: Nostr relays from NIP-66 events on a monitor relay, probed end to end', async () => {
  const home = await tmp()
  const target = await startFakeRelayWithInfo()
  const ev = (d, R = []) => finalizeEvent({ kind: 30166, created_at: now() - 3600, tags: [['d', d], ...R.map((r) => ['R', r])], content: '' }, generateSecretKey())
  const monitor = await startFakeRelayWithInfo({ events: [ev(target.url + '/'), ev(target.url), ev('wss://needs-auth.example/', ['auth'])] })
  try {
    const s = await refreshHosts({ home, type: 'nostr', directory: monitor.url, cap: 5, pauseMs: 0, probeOpts: { pause: 0 } })
    assert.deepEqual(s.nostr, { listed: 1, probed: 1, ok: 1 })
    const [h] = (await loadCache(home)).hosts
    assert.equal(h.url, target.url)
    assert.equal(h.source, monitor.url)
    assert.equal(target.events.length, 0, 'the probe event was deleted again')
  } finally { await Promise.all([target.close(), monitor.close()]) }
})

test('refresh: a CryptPad instance from a directory that passes the probe is usable like a built-in one', async () => {
  const home = await tmp()
  const cp = await startFakeCryptpad()
  const web = await startFakeWeb({ '/instances/': { body: `<section class="instance" data-url="${cp.url}"></section>` } })
  try {
    const s = await refreshHosts({ home, type: 'cryptpad', directory: `${web.url}/instances/`, pauseMs: 0 })
    assert.equal(s.cryptpad.ok, 1)
    const cache = await loadCache(home)
    assert.equal(cache.hosts[0].status, 'ok')
    // healthy beats never probed; the built-in ones follow
    assert.deepEqual(preferredHosts(cache, 'cryptpad'), [cp.url, ...KNOWN.cryptpad])
  } finally { await Promise.all([cp.close(), web.close()]) }
})

// ---- using the cache ----

const entry = (type, url, status, extra = {}) => ({ type, url, status, probed: new Date().toISOString(), source: 'test', details: {}, ...extra })

test('preferredHosts: healthy built-in first, then other healthy, unprobed built-in, failed built-in', () => {
  const [a, b, c, d] = KNOWN.privatebin
  const cache = {
    v: 1,
    directories: {},
    hosts: [
      entry('privatebin', a, 'failed'),
      entry('privatebin', c, 'ok'),
      entry('privatebin', 'https://new.example-a.org', 'ok'),
      entry('privatebin', 'https://second.example-b.org', 'ok'), // same operator as the next one
      entry('privatebin', 'https://paste.second.example-b.org', 'ok', { probed: new Date(Date.now() - DAY).toISOString() }),
      entry('privatebin', 'https://dead.example.net', 'failed'),
      entry('privatebin', d, 'ok', { removed: true })
    ]
  }
  const order = preferredHosts(cache, 'privatebin')
  assert.equal(order[0], c)
  assert.deepEqual(order.slice(1, 3).sort(), ['https://new.example-a.org', 'https://second.example-b.org'])
  assert.ok(!order.includes('https://paste.second.example-b.org'))
  assert.equal(order[3], b)
  assert.ok(!order.includes(d))
  assert.ok(!order.includes('https://dead.example.net'))
  assert.equal(order.at(-1), a)
  assert.equal(site('https://paste.example.co.uk/x'), 'example.co.uk')
  // no cache: exactly the built-in order
  assert.deepEqual(preferredHosts({ v: 1, hosts: [], directories: {} }, 'nostr'), KNOWN.nostr)
})

test('init defaults prefer cached healthy hosts and keep short names unique', async () => {
  const home = await tmp()
  const [a, b, c] = KNOWN.privatebin
  await saveCache(home, {
    v: 1,
    directories: {},
    hosts: [
      entry('privatebin', a, 'failed'),
      entry('privatebin', b, 'failed'),
      entry('privatebin', c, 'failed'),
      entry('privatebin', 'https://paste.twin.example.org', 'ok', { details: {} }),
      entry('privatebin', 'https://paste.twin.example.net', 'ok'),
      entry('privatebin', 'https://bin.third.example', 'ok'),
      entry('nostr', KNOWN.nostr[0], 'ok', { removed: true })
    ]
  })
  const saved = process.env.OVERKILL_DEFAULT_BACKENDS
  delete process.env.OVERKILL_DEFAULT_BACKENDS
  try {
    const cfgs = defaultBackends({ cryptpad: false, home })
    const pb = cfgs.filter((x) => x.type === 'privatebin')
    // four slots: the three healthy cached hosts first, then built-in hosts not known to be dead
    assert.equal(pb.length, 4)
    assert.deepEqual(pb.slice(0, 3).map((x) => x.url).sort(), ['https://bin.third.example', 'https://paste.twin.example.net', 'https://paste.twin.example.org'])
    assert.deepEqual(pb.slice(0, 3).map((x) => x.name).sort(), ['pb-third', 'pb-twin', 'pb-twin-2'])
    assert.deepEqual(pb.slice(3).map((x) => x.url), KNOWN.privatebin.slice(3, 4))
    assert.ok(!pb.some((x) => [a, b, c].includes(x.url)), 'failed hosts are not picked')
    assert.equal(new Set(pb.map((x) => x.name)).size, 4)
    const relays = cfgs.filter((x) => x.type === 'nostr').map((x) => x.url)
    assert.deepEqual(relays, KNOWN.nostr.slice(1, 5))
    // without a cache nothing changes
    const plain = defaultBackends({ cryptpad: false })
    assert.deepEqual(plain.filter((x) => x.type === 'privatebin').map((x) => x.url), KNOWN.privatebin.slice(0, 4))
  } finally {
    if (saved !== undefined) process.env.OVERKILL_DEFAULT_BACKENDS = saved
  }
})

test('dead backends: long-failing ones get a suggestion, healthy, fresh or just repaired ones do not', async () => {
  const home = await tmp()
  const t = new Date()
  const iso = (days) => new Date(t - days * DAY).toISOString()
  const backends = [
    { name: 'pb-dead', type: 'privatebin', url: KNOWN.privatebin[2] },
    { name: 'pb-fine', type: 'privatebin', url: KNOWN.privatebin[0] },
    { name: 'pb-blip', type: 'privatebin', url: KNOWN.privatebin[1] },
    { name: 'nostr-gone', type: 'nostr', url: KNOWN.nostr[0] },
    { name: 'usb', type: 'local', path: '/x' }
  ]
  const index = {
    health: {
      _vault: {
        'pb-dead': { status: 'error', last_ok: iso(12), last_checked: iso(0) },
        'pb-fine': { status: 'ok', last_ok: iso(0), last_checked: iso(0) },
        'pb-blip': { status: 'error', last_ok: iso(2), last_checked: iso(0) },
        'nostr-gone': { status: 'missing', last_ok: null, last_checked: iso(0) },
        usb: { status: 'missing', last_ok: null, last_checked: iso(0) }
      },
      groceries: { 'pb-dead': { status: 'missing', last_ok: iso(20), last_checked: iso(0) } }
    }
  }
  await saveCache(home, {
    v: 1,
    directories: {},
    hosts: [
      entry('privatebin', 'https://alt-one.example', 'ok'),
      entry('privatebin', 'https://alt-two.example', 'ok'),
      entry('privatebin', KNOWN.privatebin[0], 'ok'), // configured already, not an alternative
      entry('privatebin', 'https://alt-bad.example', 'failed')
    ]
  })
  const cache = await loadCache(home)
  assert.deepEqual(deadBackends({ index, backends, cache, now: t }).map((d) => [d.name, d.alternatives]), [['pb-dead', 2], ['nostr-gone', 0]])
  const hints = await replacementHints({ index, backends, home, now: t })
  assert.deepEqual(hints, [
    'pb-dead looks dead (no good copy in 12 days); `super-secret-notes hosts list --type privatebin` shows 2 healthy alternatives',
    'nostr-gone looks dead (never served a good copy); `super-secret-notes hosts refresh --type nostr` looks for alternatives'
  ])
  assert.deepEqual(await replacementHints({ index, backends, home, now: t, fixed: ['groceries on pb-dead', 'vault.age on nostr-gone (was expiring x)'] }), [])
  assert.equal(knownHosts(cache, 'privatebin').length, KNOWN.privatebin.length + 3)
})

// ---- the command ----

test('cli: hosts add, remove, list and refresh --directory', async () => {
  const dir = await tmp()
  const env = { OVERKILL_HOME: path.join(dir, 'home') }
  const pb = await startFakePrivatebin()
  const web = await startFakeWeb({ '/list.md': { body: `# PrivateBins\n- ${pb.url}\n`, type: 'text/plain' }, '/empty.md': { body: '# nothing here\n' } })
  try {
    let r = await cli(env, ['hosts', 'add', 'privatebin', `${pb.url}/`])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`privatebin: ok ${pb.url}\n`))
    assert.equal(pb.pastes.size, 0)
    r = await cli(env, ['hosts', 'add', 'cryptpad', 'https://pad.envs.net', '--no-probe'])
    assert.equal(r.code, 0, r.stderr)
    r = await cli(env, ['hosts', 'remove', 'nostr', KNOWN.nostr[0]])
    assert.match(r.stdout, /new vaults will not pick it/)
    r = await cli(env, ['hosts', 'remove', 'nostr', 'wss://never-heard-of.example'])
    assert.equal(r.code, 1)
    r = await cli(env, ['hosts', 'add', 'nostr', 'https://not-a-relay.example'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /wss:\/\/ expected/)

    r = await cli(env, ['hosts', 'list', '--type', 'privatebin'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`ok +${pb.url.replace(/[.]/g, '\\.')} +\\d+ min ago +manual`))
    assert.match(r.stdout, /unprobed https:\/\/pb\.envs\.net +never +built-in {2}\(new vaults use it\)/)
    r = await cli(env, ['hosts', 'list', '--type', 'nostr'])
    assert.ok(!r.stdout.includes(KNOWN.nostr[0] + ' '))
    r = await cli(env, ['hosts', 'list', '--type', 'nostr', '--all'])
    assert.match(r.stdout, /removed +wss:\/\/nos\.lol/)
    r = await cli(env, ['hosts', 'list', '--type', 'cryptpad'])
    assert.match(r.stdout, /unprobed https:\/\/pad\.envs\.net +never +manual\n +info: terms \(https:\/\/envs\.net\/terms-of-service\/\) forbid hosting backups/)

    r = await cli(env, ['hosts', 'refresh', '--type', 'privatebin', '--directory', `${web.url}/empty.md`])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`directory ${web.url}/empty\\.md looks stale; use --directory <new url> or send a PR updating src/hosts/directories\\.js`))
    r = await cli(env, ['hosts', 'refresh', '--type', 'privatebin', '--directory', `${web.url}/list.md`, '--max-age', '0'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`privatebin: ok +${pb.url.replace(/[.]/g, '\\.')}\n`))
    assert.match(r.stdout, /privatebin: 1 listed, 1 probed, 1 ok/)
    const cache = JSON.parse(await readFile(path.join(dir, 'home', 'hosts.json'), 'utf8'))
    assert.equal(cache.hosts.find((h) => h.url === pb.url).source, 'manual', 'a hand-added host stays manual')
    r = await cli(env, ['hosts', 'refresh', '--directory', `${web.url}/list.md`])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--directory needs --type/)
  } finally { await Promise.all([pb.close(), web.close()]) }
})

test('cli: a broken hosts.json does not break init defaults', async () => {
  const home = await tmp()
  await writeFile(path.join(home, 'hosts.json'), '{ not json')
  const saved = process.env.OVERKILL_DEFAULT_BACKENDS
  delete process.env.OVERKILL_DEFAULT_BACKENDS
  try {
    assert.deepEqual(defaultBackends({ cryptpad: false, home }).map((x) => x.url), defaultBackends({ cryptpad: false }).map((x) => x.url))
  } finally {
    if (saved !== undefined) process.env.OVERKILL_DEFAULT_BACKENDS = saved
  }
})

// ---- self-healing ----

test('dead backends: a backend that never worked counts once the vault is old enough', async () => {
  const t = new Date()
  const backends = [{ name: 'pb-new', type: 'privatebin', url: 'https://paste.example.org' }]
  const index = { health: { _vault: { 'pb-new': { status: 'error', last_ok: null, last_checked: t.toISOString() } } } }
  const cache = { v: 1, hosts: [], directories: {} }
  assert.deepEqual(deadBackends({ index, backends, cache, created: new Date(t - DAY).toISOString(), now: t, days: 7 }), [])
  assert.equal(deadBackends({ index, backends, cache, created: new Date(t - 8 * DAY).toISOString(), now: t, days: 7 }).length, 1)
})

test('replacementFor: healthy, unused, another operator, a fresh name; CryptPad gets a derived account', () => {
  const cache = {
    v: 1,
    directories: {},
    hosts: [
      entry('privatebin', 'https://paste.used-operator.org', 'ok'), // same operator as pb-other
      entry('privatebin', 'https://paste.broken.example', 'failed'),
      entry('privatebin', 'https://paste.fresh.example', 'ok'),
      entry('cryptpad', 'https://cryptpad.found-in-directory.example', 'ok')
    ]
  }
  // with nothing healthy yet, the built-in ones are never probed: no replacement
  const bare = { v: 1, hosts: [], directories: {} }
  const backends = [
    { name: 'pb-dead', type: 'privatebin', url: 'https://pb.dead.example' },
    { name: 'pb-other', type: 'privatebin', url: 'https://bin.used-operator.org' },
    { name: 'cp-gone', type: 'cryptpad', origin: 'https://cryptpad.gone.example', derived: true }
  ]
  assert.equal(replacementFor(backends[0], backends, bare), null)
  // the ledger remembers a backend once called pb-fresh: the new one must not reuse its locator file
  const index = { health: { _vault: { 'pb-fresh': { status: 'ok' } } } }
  assert.deepEqual(replacementFor(backends[0], backends, cache, index), { name: 'pb-fresh-2', type: 'privatebin', url: 'https://paste.fresh.example' })
  assert.deepEqual(replacementFor(backends[2], backends, cache), { name: 'cp-found-in-directory', type: 'cryptpad', origin: 'https://cryptpad.found-in-directory.example', derived: true })
})

test('cli: repair swaps a long-dead PrivateBin backend for a healthy cached one and re-uploads everything', async () => {
  const dir = await tmp()
  const home = path.join(dir, 'home')
  const dead = await startFakePrivatebin()
  const spare = await startFakePrivatebin()
  const cfgFile = path.join(dir, 'cfg.json')
  await writeFile(cfgFile, JSON.stringify({ root: 'ovk', backends: [{ name: 'usb', type: 'local', path: path.join(dir, 'usb') }, { name: 'pb-first', type: 'privatebin', url: dead.url }] }))
  const env = { OVERKILL_HOME: home, OVERKILL_PASSPHRASE: 'correct horse battery staple', OVERKILL_DISCOVERY_RELAYS: '', OVERKILL_DEAD_AFTER_DAYS: '0' }
  try {
    let r = await cli(env, ['init', '--from', cfgFile, '--scrypt-log-n', '12'])
    assert.equal(r.code, 0, r.stderr)
    r = await cli(env, ['put', 'groceries'], 'oat milk\n')
    assert.equal(r.code, 0, r.stderr)
    await dead.close()
    await saveCache(home, { v: 1, directories: {}, hosts: [entry('privatebin', spare.url, 'ok')] })

    r = await cli(env, ['repair', '--no-swap'])
    assert.equal(r.code, 1)
    assert.match(r.stdout, /pb-first looks dead \(no good copy in 0 days\); `super-secret-notes hosts list --type privatebin` shows 1 healthy alternative/)
    assert.equal(spare.pastes.size, 0)
    assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')).backends[1].url, dead.url)

    r = await cli(env, ['repair'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`swapped pb-first \\(${dead.url.replace(/[.]/g, '\\.')}, dead\\) for pb-127 \\(${spare.url.replace(/[.]/g, '\\.')}\\)`))
    assert.match(r.stdout, /repaired groceries on pb-127/)
    assert.match(r.stdout, /reprint the recovery kit/)
    assert.doesNotMatch(r.stdout, /could not repair|looks dead/)
    const cfg = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'))
    assert.deepEqual(cfg.backends[1], { name: 'pb-127', type: 'privatebin', url: spare.url })
    // vault.age and the note (whether the index goes to PrivateBin too depends on index_sync)
    assert.ok(spare.pastes.size >= 2, `${spare.pastes.size} pastes on the new host`)
    // the new host's paste keys and tokens went into secrets.ovk, the dead host's are gone
    assert.equal(await access(path.join(home, 'locators', 'pb-127.json')).then(() => true, () => false), false)
    const keys = await c.unlockKeys(await c.decryptVault(new Uint8Array(await readFile(path.join(home, 'vault.age'))), env.OVERKILL_PASSPHRASE))
    const secrets = JSON.parse(new TextDecoder().decode(await c.decryptBlob(keys, 'secrets', new Uint8Array(await readFile(path.join(home, 'secrets.ovk'))))))
    assert.ok(Object.keys(secrets.locators['pb-127'].paths).length >= 2)
    assert.equal(secrets.locators['pb-first'], undefined)

    r = await cli(env, ['check'])
    assert.equal(r.code, 0, r.stdout)
    assert.match(r.stdout, /groceries +usb OK, pb-127 OK/)
    // the note now reads from the new host alone
    await rename(path.join(dir, 'usb'), path.join(dir, 'usb-away'))
    r = await cli(env, ['get', 'groceries'])
    assert.equal(r.stdout, 'oat milk\n', r.stderr)
  } finally { await Promise.all([spare.close(), dead.close().catch(() => {})]) }
})
