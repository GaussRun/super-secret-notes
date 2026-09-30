// RelayConn.open(): a failed or timed-out connect must not leave the relay unusable for the rest
// of the process, whatever events the WebSocket implementation fires afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayConn } from '../src/backends/nostr.js'

// A fake WebSocket; `plan` says what each successive connection does:
// 'open', 'error' (error, then close as the WHATWG spec does), 'error-only' (error, no close
// ever), or 'silent' (never answers; close() fires close only if `closeOnClose`).
function fakeSocket (plan, { closeOnClose = true } = {}) {
  const made = []
  class FakeWS {
    constructor (url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      const what = plan[made.length] ?? 'open'
      made.push(this)
      setTimeout(() => {
        if (what === 'open') { this.readyState = 1; this.onopen?.() }
        if (what === 'error' || what === 'error-only') this.onerror?.({ message: 'refused' })
        if (what === 'error') { this.readyState = 3; this.onclose?.() }
      }, 5)
    }

    send (frame) {
      this.sent.push(frame)
      const [type, key] = JSON.parse(frame)
      if (type === 'REQ') setTimeout(() => this.onmessage?.({ data: JSON.stringify(['EOSE', key]) }), 1)
    }

    close () {
      if (this.readyState === 3) return
      this.readyState = 3
      if (closeOnClose) setTimeout(() => this.onclose?.(), 1)
    }
  }
  return { FakeWS, made }
}

for (const [label, plan, opts] of [
  ['error then close', ['error'], {}],
  ['error without a close event', ['error-only'], {}],
  ['connect timeout, close event follows', ['silent'], {}],
  ['connect timeout, no close event', ['silent'], { closeOnClose: false }]
]) {
  test(`a relay that failed once (${label}) is tried again on the next call`, async () => {
    const { FakeWS, made } = fakeSocket(plan, opts)
    const conn = new RelayConn('wss://relay.example.org', { WebSocketImpl: FakeWS, timeout: 50 })
    await assert.rejects(conn.query({ kinds: [1] }))
    // let any late close event run, as it would in a real process
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(await conn.query({ kinds: [1] }), [])
    assert.equal(made.length, 2)
    conn.close()
  })
}

test('a late close event from a dead socket does not drop the new connection', async () => {
  const { FakeWS, made } = fakeSocket(['silent'])
  const conn = new RelayConn('wss://relay.example.org', { WebSocketImpl: FakeWS, timeout: 30 })
  await assert.rejects(conn.open())
  // retry at once, before the first socket's close event arrives
  const opening = conn.open()
  const second = conn.ready
  await opening
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(conn.ready, second, 'the old socket closing must not reset the new one')
  assert.deepEqual(await conn.query({ kinds: [1] }), [])
  assert.equal(made.length, 2)
  conn.close()
})
