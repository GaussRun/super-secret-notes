// Filen via @filen/sdk (email + password login, no browser). Filen is end-to-end encrypted,
// 10 GB free, based in Germany. The saved session holds the account master keys, so it lives
// in secrets.ovk (encrypted with the vault keys), like the MEGA session.
import { FilenSDK } from '@filen/sdk'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { resolveSecret } from '../secrets.js'
import { logger } from '../log.js'

export const info = {
  title: 'Filen',
  blurb: '10 GB free, Germany, end-to-end encrypted. Email and password; accounts with 2FA are not supported yet.',
  signup: 'https://filen.io/register'
}

export async function prompt (ask, askSecret) {
  const email = await ask('  Filen email: ')
  const password = await askSecret('  Filen password (stored encrypted in secrets.ovk; or type env:VARNAME to keep it outside): ')
  return { email, password: password.startsWith('env:') ? { env: password.slice(4) } : password }
}

// a login backend: with its credentials in secrets.ovk it can travel in the bootstrap record
export const travelsWithSecrets = true

export const operator = () => 'Filen'

export function create (cfg, ctx) {
  const root = '/' + (cfg.root ?? ctx.root).replace(/^\/+|\/+$/g, '')
  const tmpPath = path.join(ctx.home, 'staging', cfg.name)
  let sdk = null
  const made = new Set()

  async function fs () {
    if (sdk) return sdk.fs()
    await mkdir(tmpPath, { recursive: true, mode: 0o700 })
    const base = { metadataCache: true, connectToSocket: false, tmpPath }
    // the session holds the account master keys: it lives in secrets.ovk, not in a file
    const saved = ctx.secrets?.session(`${cfg.name}.filen`) ?? null
    if (saved) {
      const s = new FilenSDK({ ...saved, ...base })
      try {
        await s.fs().readdir({ path: '/' })
        return (sdk = s).fs()
      } catch (err) {
        logger.info(`${cfg.name}: saved Filen session did not work (${err.message}), logging in again`)
      }
    }
    const s = new FilenSDK(base)
    await s.login({
      email: resolveSecret(cfg.email, `${cfg.name} email`, ctx.secrets, cfg.name, 'email'),
      password: resolveSecret(cfg.password, `${cfg.name} password`, ctx.secrets, cfg.name, 'password')
    })
    const { email, password, twoFactorCode, ...session } = s.config
    if (ctx.secrets?.unlocked) await ctx.secrets.setSession(`${cfg.name}.filen`, session)
    return (sdk = s).fs()
  }

  const abs = (rel) => path.posix.join(root, rel)
  const missing = (err) => err?.code === 'ENOENT' || /ENOENT|not found/i.test(err?.message ?? '')

  return {
    name: cfg.name,
    type: 'filen',
    where: `filen:${root}`,
    async put (rel, bytes) {
      const f = await fs()
      const dir = path.posix.dirname(abs(rel))
      if (!made.has(dir)) { await f.mkdir({ path: dir }); made.add(dir) }
      // an upload to an existing path becomes a new version on Filen
      await f.writeFile({ path: abs(rel), content: Buffer.from(bytes) })
    },
    async get (rel) {
      try {
        return new Uint8Array(await (await fs()).readFile({ path: abs(rel) }))
      } catch (err) {
        if (missing(err)) return null
        throw err
      }
    },
    async exists (rel) {
      return (await this.get(rel)) !== null
    },
    async list (dir) {
      try {
        return await (await fs()).readdir({ path: abs(dir) })
      } catch (err) {
        if (missing(err)) return []
        throw err
      }
    },
    async close () {}
  }
}
