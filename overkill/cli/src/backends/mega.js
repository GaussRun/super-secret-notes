// MEGA via megajs. MEGA adds its own E2E layer, so a note on MEGA is triple encrypted.
// Gotchas: a same-name upload creates a duplicate node,
// Storage.close() logs the session out server side, and bursts can get rate limited.
import { Storage } from 'megajs'
import path from 'node:path'
import { resolveSecret } from '../secrets.js'
import { logger } from '../log.js'

export const info = {
  title: 'MEGA',
  blurb: '20 GB free, New Zealand based, end-to-end encrypted. Adds a third encryption layer on top of our two.',
  signup: 'https://mega.io/register'
}

export async function prompt (ask, askSecret) {
  const email = await ask('  MEGA email: ')
  const password = await askSecret('  MEGA password (stored encrypted in secrets.ovk; or type env:VARNAME to keep it outside): ')
  return { email, password: password.startsWith('env:') ? { env: password.slice(4) } : password }
}

// a login backend: with its credentials in secrets.ovk it can travel in the bootstrap record
export const travelsWithSecrets = true

// One account per provider (docs/OVERKILL.md): the operator is the provider, not the account.
export const operator = () => 'MEGA'

const USER_AGENT = 'overkill-notes/0.1'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The tree from a fetch ("f") can be an older snapshot; MEGA clients catch up through the
 * action-packet channel. megajs polls it when keepalive is on and calls api.wait() once there is
 * nothing more to fetch, so that call means "caught up". Polling stops there.
 * Call before the fetch (login or reload).
 */
export function catchUp (storage, timeoutMs = 30_000) {
  const api = storage.api
  api.keepalive = true
  const wait = api.wait.bind(api)
  const caught = new Promise((resolve) => {
    // not calling the real wait() means no long-poll starts; api.close() would also block
    // every later request ("API is closed")
    api.wait = (url, sn) => {
      api.wait = wait
      api.keepalive = false
      resolve()
    }
  })
  let timer
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timed out syncing the MEGA file tree')), timeoutMs) })
  return Promise.race([caught, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Seen by the web client: for minutes MEGA answered the tree fetch with only the root nodes
 * although the account held files. Trusting it would report every copy missing and create a
 * duplicate root folder on the next put, so retry, then fail loudly (an ERROR, not MISSING).
 */
export async function ensureFullTree (storage, { waits = [3000, 8000] } = {}) {
  const nodes = () => Object.keys(storage.files ?? {}).length
  if (nodes() > 3) return
  const info = await storage.getAccountInfo()
  if (!info.spaceUsed) return
  for (const ms of waits) {
    await sleep(ms)
    await storage.reload(true)
    if (nodes() > 3) return
  }
  throw new Error(`MEGA sent an incomplete file tree (only the root folders, but ${info.spaceUsed} bytes in use). Try again in a few minutes.`)
}

export function create (cfg, ctx) {
  const rootParts = (cfg.root ?? ctx.root).split('/').filter(Boolean)
  const gapMs = cfg.gapMs ?? 400
  let storage = null
  let last = 0
  // nodes we moved to the rubbish bin; with polling off, megajs keeps them in the tree
  const gone = new Set()

  // be gentle: MEGA does not like bursts
  async function throttle () {
    const wait = last + gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    last = Date.now()
  }

  async function connect () {
    if (storage) return storage
    // the session holds the account keys: it lives in secrets.ovk, not in a file
    const saved = ctx.secrets?.session(`${cfg.name}.mega`) ?? null
    if (saved) {
      try {
        const s = Storage.fromJSON(saved)
        const synced = catchUp(s)
        await s.reload(true)
        await synced
        await ensureFullTree(s)
        logger.debug(`${cfg.name}: resumed MEGA session`)
        return (storage = s)
      } catch (err) {
        logger.info(`${cfg.name}: saved MEGA session did not work (${err.message}), logging in again`)
      }
    }
    const email = resolveSecret(cfg.email, `${cfg.name} email`, ctx.secrets, cfg.name, 'email')
    const password = resolveSecret(cfg.password, `${cfg.name} password`, ctx.secrets, cfg.name, 'password')
    const fresh = new Storage({ email, password, userAgent: USER_AGENT, keepalive: false })
    const synced = catchUp(fresh)
    storage = await fresh.ready
    await synced
    await ensureFullTree(storage)
    const json = storage.toJSON()
    // toJSON() embeds the constructor options, which include the email: keep only harmless ones
    json.options = { userAgent: USER_AGENT, keepalive: false }
    if (ctx.secrets?.unlocked) await ctx.secrets.setSession(`${cfg.name}.mega`, json)
    logger.debug(`${cfg.name}: logged in to MEGA, session saved`)
    return storage
  }

  async function folder (rel, createMissing) {
    const s = await connect()
    let node = s.root
    for (const part of [...rootParts, ...rel.split('/').filter(Boolean)]) {
      let child = node.children?.find((c) => c.directory && c.name === part)
      if (!child) {
        if (!createMissing) return null
        await throttle()
        child = await node.mkdir(part)
      }
      node = child
    }
    return node
  }

  function files (dir, name) {
    return (dir?.children ?? [])
      .filter((c) => !c.directory && c.name === name && !gone.has(c.nodeId))
      .sort((a, b) => b.timestamp - a.timestamp)
  }

  const split = (rel) => [path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), path.posix.basename(rel)]

  return {
    name: cfg.name,
    type: 'mega',
    where: `mega:/${rootParts.join('/')}`,
    async put (rel, bytes) {
      const [dirRel, name] = split(rel)
      const dir = await folder(dirRel, true)
      const old = files(dir, name)
      await throttle()
      await dir.upload({ name, size: bytes.length }, Buffer.from(bytes)).complete
      // replace = upload new, then move old versions to the rubbish bin (free version history)
      for (const node of old) {
        await throttle()
        await node.delete(false)
        gone.add(node.nodeId)
      }
    },
    async get (rel) {
      const [dirRel, name] = split(rel)
      const node = files(await folder(dirRel, false), name)[0]
      if (!node) return null
      await throttle()
      return new Uint8Array(await node.downloadBuffer({}))
    },
    async exists (rel) {
      const [dirRel, name] = split(rel)
      return files(await folder(dirRel, false), name).length > 0
    },
    async list (dirRel) {
      const dir = await folder(dirRel, false)
      return [...new Set((dir?.children ?? []).filter((c) => !c.directory && !gone.has(c.nodeId)).map((c) => c.name))]
    },
    async close () {
      // not storage.close(): that logs the saved session out server side
      storage?.api.close()
      storage = null
    }
  }
}
