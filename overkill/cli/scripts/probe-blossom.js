// Probes Blossom servers for the blossom backend and prints JSON (docs/NOSTR.md has the table).
// Per server: BUD-06 preflight for 50 KB and for 100 MB (size limit without uploading it),
// one upload of 50000 random bytes under a throwaway key, read-back, CORS headers, then a
// BUD-02 delete to leave nothing behind. Servers one after another.
//   node scripts/probe-blossom.js [https://server ...]
import { generateSecretKey } from 'nostr-tools/pure'
import { authHeader } from '../src/backends/blossom.js'
import { sha256Hex } from '../src/crypto.js'
import nodeCrypto from 'node:crypto'

const CANDIDATES = [
  'https://blossom.primal.net', 'https://blossom.band', 'https://nostr.download', 'https://blossom.yakihonne.com',
  'https://24242.io', 'https://cdn.nostrcheck.me', 'https://cdn.satellite.earth', 'https://nostrmedia.com',
  'https://blossom.azzamo.media', 'https://cdn.sovbit.host', 'https://nostr.media', 'https://blossom.nmail.li',
  'https://blossom.ditto.pub', 'https://cdn.hzrd149.com', 'https://files.sovbit.host', 'https://blossom.jumble.social',
  'https://milo.nostria.app', 'https://blossom.nostr.build', 'https://blossom.data.haus', 'https://blossom.einundzwanzig.space',
  'https://blossom.f7z.io', 'https://files.v0l.io', 'https://blossom.oxtr.dev', 'https://blossom.nostr.hu'
]
const T = () => AbortSignal.timeout(30_000)
const hdr = (res, h) => res.headers.get(h)

async function probe (base) {
  const r = { server: base }
  const secret = generateSecretKey()
  const data = new Uint8Array(nodeCrypto.randomBytes(50_000))
  const sha = await sha256Hex(data)
  const pre = async (size) => {
    const res = await fetch(`${base}/upload`, { method: 'HEAD', signal: T(), headers: { Authorization: authHeader(secret, 'upload', sha, base), 'X-SHA-256': sha, 'X-Content-Length': String(size), 'X-Content-Type': 'application/octet-stream' } })
    return `${res.status}${hdr(res, 'x-reason') ? ` ${hdr(res, 'x-reason')}` : ''}`
  }
  try {
    r.preflight50k = await pre(50_000)
    r.preflight100m = await pre(100_000_000)
    const up = await fetch(`${base}/upload`, { method: 'PUT', signal: T(), headers: { Authorization: authHeader(secret, 'upload', sha, base), 'Content-Type': 'application/octet-stream', 'X-SHA-256': sha, Origin: 'https://example.org' }, body: data })
    r.upload = `${up.status}${hdr(up, 'x-reason') ? ` ${hdr(up, 'x-reason')}` : ''}`
    r.corsUpload = hdr(up, 'access-control-allow-origin')
    if (up.ok) {
      const desc = await up.json().catch(() => null)
      r.descriptorUrl = desc?.url ?? null
      r.expiration = desc?.expiration ?? desc?.expires ?? null
      const get = await fetch(`${base}/${sha}`, { signal: T(), headers: { Origin: 'https://example.org' } })
      const back = new Uint8Array(await get.arrayBuffer())
      r.readBack = get.ok && await sha256Hex(back) === sha
      r.corsGet = hdr(get, 'access-control-allow-origin')
      const del = await fetch(`${base}/${sha}`, { method: 'DELETE', signal: T(), headers: { Authorization: authHeader(secret, 'delete', sha, base) } })
      r.delete = `${del.status}${hdr(del, 'x-reason') ? ` ${hdr(del, 'x-reason')}` : ''}`
      r.sha256 = sha
    }
    const opt = await fetch(`${base}/upload`, { method: 'OPTIONS', signal: T(), headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type,x-sha-256' } })
    r.corsPreflight = `${opt.status} ${hdr(opt, 'access-control-allow-origin') ?? 'no allow-origin'}`
  } catch (err) {
    r.error = err.cause?.code ?? err.message
  }
  return r
}

const servers = process.argv.slice(2).length ? process.argv.slice(2) : CANDIDATES
const results = []
for (const s of servers) {
  const r = await probe(s)
  results.push(r)
  console.error(`${s}: upload ${r.upload ?? r.error} read ${r.readBack}`)
}
console.log(JSON.stringify({ probed: new Date().toISOString(), results }, null, 2))
