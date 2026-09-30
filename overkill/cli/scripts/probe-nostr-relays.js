// Probes candidate Nostr relays for the nostr backend and prints JSON (docs/NOSTR.md has the table).
// Per relay: NIP-11 limits, a retention probe (the oldest events it still serves before
// now - 400 days), and one or two writes of random bytes under a throwaway key, read back.
// Polite on purpose: at most two events per relay per run, relays one after another.
//   node scripts/probe-nostr-relays.js [wss://relay ...]
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RelayConn, sealEvents, openEvents, CHUNK, KIND } from '../src/backends/nostr.js'
import { randomBytes } from '../src/crypto.js'

const CANDIDATES = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://purplerelay.com',
  'wss://offchain.pub',
  'wss://nostr.bitcoiner.social',
  'wss://relay.snort.social',
  'wss://nostr.oxtr.dev',
  'wss://relay.nostrcheck.me',
  'wss://relay.wellorder.net'
]
const DAY = 86_400
const iso = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function nip11 (url) {
  try {
    const res = await fetch(url.replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' }, signal: AbortSignal.timeout(10_000) })
    const doc = await res.json()
    return { software: doc.software ?? null, version: doc.version ?? null, limitation: doc.limitation ?? null, retention: doc.retention ?? null }
  } catch (err) {
    return { error: err.message }
  }
}

// Relays answer newest first, so `until` = now - N days, limit 5 shows whether anything that
// old is still served. created_at is chosen by the author, so this is evidence, not proof.
async function retention (conn) {
  const out = {}
  for (const days of [400, 1000]) {
    const until = Math.floor(Date.now() / 1000) - days * DAY
    for (const kinds of [[1], [KIND]]) {
      const key = `kind${kinds[0]}_older_than_${days}d`
      try {
        const ts = (await conn.query({ kinds, until, limit: 5 })).map((e) => e.created_at).filter((t) => t <= until)
        out[key] = ts.length ? { count: ts.length, oldest: iso(Math.min(...ts)), newest: iso(Math.max(...ts)) } : { count: 0 }
      } catch (err) {
        out[key] = { error: err.message }
      }
    }
  }
  return out
}

async function writeRead (conn, secret, size) {
  const d = `overkill-probe/${Buffer.from(randomBytes(8)).toString('hex')}`
  const bytes = randomBytes(size)
  const [ev] = await sealEvents(secret, d, bytes, Math.floor(Date.now() / 1000))
  const eventBytes = Buffer.byteLength(JSON.stringify(['EVENT', ev]))
  const res = await conn.publish(ev)
  if (!res.ok) return { size, eventBytes, write: false, message: res.message }
  await sleep(1500)
  const pubkey = getPublicKey(secret)
  const back = await openEvents(secret, d, (tags) => conn.query({ kinds: [KIND], authors: [pubkey], '#d': tags }))
  const same = back.bytes && back.bytes.length === bytes.length && back.bytes.every((b, i) => b === bytes[i])
  return { size, eventBytes, write: true, readBack: Boolean(same), id: ev.id }
}

async function probe (url) {
  const r = { url, nip11: await nip11(url) }
  const conn = new RelayConn(url)
  try {
    await conn.open()
    r.retention = await retention(conn)
    const secret = generateSecretKey()
    r.big = await writeRead(conn, secret, CHUNK)
    // only when the full-size chunk failed: is it the size, or writes in general?
    if (!r.big.write || !r.big.readBack) r.small = await writeRead(conn, secret, 2000)
    r.pubkey = getPublicKey(secret)
  } catch (err) {
    r.error = err.message
  } finally {
    conn.close()
  }
  return r
}

const urls = process.argv.slice(2).length ? process.argv.slice(2) : CANDIDATES
const results = []
for (const url of urls) {
  const r = await probe(url)
  results.push(r)
  console.error(`${url}: ${r.error ?? `big write ${r.big?.write} read ${r.big?.readBack}`}`)
}
console.log(JSON.stringify({ probed: new Date().toISOString(), results }, null, 2))
process.exit(0)
