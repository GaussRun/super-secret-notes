// In-process fake Nostr relay for tests (ws server): NIP-01 EVENT / REQ / CLOSE, addressable
// replacement (newest created_at wins, tie to the lowest id), and strfry's 64 KiB event cap.
import { WebSocketServer } from 'ws'
import { verifyEvent } from 'nostr-tools/pure'

export const MAX_EVENT = 65536 // what strfry relays enforce
const dOf = (ev) => ev.tags.find((t) => t[0] === 'd')?.[1]

function matches (ev, f) {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (f.ids && !f.ids.includes(ev.id)) return false
  if (f['#d'] && !f['#d'].includes(dOf(ev))) return false
  if (f.until && ev.created_at > f.until) return false
  return true
}

/** -> { url, store ("kind:pubkey:d" -> event), rateLimited (answer the next n EVENTs so), close() } */
export async function startFakeRelay () {
  const relay = { store: new Map(), rateLimited: 0 }
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const send = (ws, msg) => ws.send(JSON.stringify(msg))
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg[0] === 'EVENT') {
        const ev = msg[1]
        if (raw.length > MAX_EVENT) return send(ws, ['OK', ev.id, false, `invalid: event too large: ${raw.length}`])
        if (relay.rateLimited > 0 && relay.rateLimited--) return send(ws, ['OK', ev.id, false, 'rate-limited: slow down'])
        if (!verifyEvent(ev)) return send(ws, ['OK', ev.id, false, 'invalid: bad signature'])
        const key = `${ev.kind}:${ev.pubkey}:${dOf(ev)}`
        const cur = relay.store.get(key)
        if (cur && (cur.created_at > ev.created_at || (cur.created_at === ev.created_at && cur.id < ev.id))) {
          return send(ws, ['OK', ev.id, true, 'duplicate: have a newer event'])
        }
        relay.store.set(key, ev)
        return send(ws, ['OK', ev.id, true, ''])
      }
      if (msg[0] === 'REQ') {
        const [, id, ...filters] = msg
        const hits = [...relay.store.values()].filter((ev) => filters.some((f) => matches(ev, f))).sort((a, b) => b.created_at - a.created_at)
        for (const ev of hits) send(ws, ['EVENT', id, ev])
        send(ws, ['EOSE', id])
      }
    })
  })
  await new Promise((resolve) => wss.on('listening', resolve))
  relay.url = `ws://127.0.0.1:${wss.address().port}`
  relay.close = () => new Promise((resolve) => wss.close(resolve))
  return relay
}
