// MEGA stale-tree guards, with fake megajs objects (no network).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catchUp, ensureFullTree } from '../src/backends/mega.js'

function fakeApi () {
  const api = { keepalive: false, closed: 0, waited: 0 }
  api.wait = () => { api.waited++ }
  api.close = () => { api.closed++ }
  return api
}

test('catchUp resolves when megajs reaches the long-poll wait, without starting the poll or closing the API', async () => {
  const storage = { api: fakeApi() }
  const p = catchUp(storage, 1000)
  assert.equal(storage.api.keepalive, true)
  storage.api.wait('https://g.api.mega.co.nz/wsc/x', 'sn1') // what megajs does once caught up
  await p
  assert.equal(storage.api.keepalive, false)
  assert.equal(storage.api.closed, 0) // a closed megajs API refuses every later request
  assert.equal(storage.api.waited, 0) // the real wait() would start a long-poll
})

test('catchUp times out when the tree never catches up', async () => {
  await assert.rejects(catchUp({ api: fakeApi() }, 50), /timed out syncing the MEGA file tree/)
})

test('ensureFullTree: fine with a real tree or an empty account, retries a root-only tree, then fails loudly', async () => {
  const roots = { a: 1, b: 1, c: 1 }
  await ensureFullTree({ files: { ...roots, d: 1 } })
  await ensureFullTree({ files: roots, getAccountInfo: async () => ({ spaceUsed: 0 }) }, { waits: [1] })

  let reloads = 0
  const healing = { files: { ...roots }, getAccountInfo: async () => ({ spaceUsed: 1234 }), reload: async () => { if (++reloads === 2) healing.files.d = 1 } }
  await ensureFullTree(healing, { waits: [1, 1] })
  assert.equal(reloads, 2)

  const stuck = { files: { ...roots }, getAccountInfo: async () => ({ spaceUsed: 1234 }), reload: async () => {} }
  await assert.rejects(ensureFullTree(stuck, { waits: [1, 1] }), /incomplete file tree \(only the root folders, but 1234 bytes in use\)/)
})
