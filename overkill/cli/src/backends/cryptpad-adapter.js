// The CryptPad adapter itself (derived accounts, register on first use, one drive per vault),
// with no Node imports: cryptpad.js wires it for the CLI, the web client for the browser.
import { deriveCryptpadCredentials } from '../crypto.js'
import { logger } from '../log.js'

// open registration, no captcha, no email, and their terms allow it (checked 2026-09-29)
export const SIGNUP_INSTANCES = ['https://cryptpad.private.coffee', 'https://crypt.unredacted.org']

// a login backend: with its credentials in secrets.ovk it can travel in the bootstrap record
export const travelsWithSecrets = true

// every instance is its own operator
export const operator = (cfg) => `CryptPad ${new URL(cfg.origin ?? 'https://cryptpad.fr').host}`

/**
 * The adapter, without the module loading: `loadDrive()` returns { CryptPadBackend, CryptPadSession }
 * (drive.js, or the web client's bundle of it) and `resolveSecret` reads a login that is not derived.
 * @param {any} cfg
 * @param {any} ctx
 * @param {{loadDrive: () => Promise<any>, resolveSecret: Function}} platform
 */
export function createCryptpad (cfg, ctx, { loadDrive, resolveSecret }) {
  const origin = (cfg.origin ?? 'https://cryptpad.fr').replace(/\/+$/, '')
  const root = (cfg.root ?? ctx.root).replace(/^\/+|\/+$/g, '')
  let drive = null
  let keys = null

  // Accounts with "derived": true belong to the vault: username and password come from the
  // master (crypto.deriveCryptpadCredentials), and the account is registered on first use.
  async function credentials () {
    if (!cfg.derived) {
      return {
        user: resolveSecret(cfg.user, `${cfg.name} user`, ctx.secrets, cfg.name, 'user'),
        pass: resolveSecret(cfg.password, `${cfg.name} password`, ctx.secrets, cfg.name, 'password')
      }
    }
    if (!keys) throw new Error('vault is locked')
    const { username, password } = await deriveCryptpadCredentials(keys.master, new URL(origin).host)
    return { user: username, pass: password }
  }

  // one login (or registration) at a time: parallel calls share it instead of racing to register twice
  let opening = null
  function open () {
    opening ??= openOnce().catch((err) => { opening = null; throw err })
    return opening
  }

  async function openOnce () {
    if (drive) return drive
    const { CryptPadBackend, CryptPadSession } = await loadDrive()
    const { user, pass } = await credentials()
    try {
      drive = await CryptPadBackend.open({ origin, user, pass, baseFolder: root })
    } catch (err) {
      if (!cfg.derived || err.code !== 'NO_SUCH_USER') throw err
      logger.info(`${cfg.name}: creating this vault's account on ${new URL(origin).host} (takes a few seconds)`)
      await CryptPadSession.register({ origin, user, pass, absent: true })
      drive = await CryptPadBackend.open({ origin, user, pass, baseFolder: root })
    }
    return drive
  }

  return {
    name: cfg.name,
    type: 'cryptpad',
    where: `${origin} drive:/${root}`,
    unlock (k) { keys = k },
    /** The account name (not a secret; the password is derived too) for the recovery kit. */
    async accountName () {
      return cfg.derived && keys ? (await credentials()).user : null
    },
    // one session at a time: the drive is a single realtime object
    async put (rel, bytes) {
      await (await open()).put(rel, bytes)
    },
    async get (rel) {
      try {
        return await (await open()).get(rel)
      } catch (err) {
        if (err.code === 'ENOENT') return null
        throw err
      }
    },
    async exists (rel) {
      return (await open()).exists(rel)
    },
    async list (dir) {
      const prefix = dir ? `${dir}/` : ''
      return (await (await open()).list(prefix)).map((p) => p.slice(prefix.length)).filter((p) => !p.includes('/'))
    },
    async close () {
      drive?.close()
      drive = null
      opening = null
    }
  }
}
