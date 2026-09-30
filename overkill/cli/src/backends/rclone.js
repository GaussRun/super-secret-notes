// Any rclone remote: Proton Drive, Koofr, Filen, B2, R2, Google Drive, and about 70 more.
// Headless once the remote is configured (`rclone config`). For Proton Drive this is the
// server-friendly path (its session stays in rclone's own config).
import { run } from './run.js'

export const info = {
  title: 'rclone remote',
  blurb: 'Anything rclone can talk to (Proton Drive, Koofr, Filen, B2, R2, and friends). Set the remote up with `rclone config` first.',
  signup: 'https://rclone.org/overview/'
}

export async function prompt (ask) {
  const remote = (await ask('  rclone remote name (as in `rclone listremotes`, for example pd): ')).replace(/:$/, '')
  const config = await ask('  rclone config file (empty = rclone default): ')
  return { remote, ...(config ? { config } : {}) }
}

const PROVIDERS = { protondrive: 'Proton', mega: 'MEGA', filen: 'Filen' }

/** The provider behind the remote, from `rclone listremotes --long` (types only, no secrets). */
export async function operator (cfg) {
  try {
    const { stdout } = await run(cfg.bin ?? 'rclone', ['listremotes', '--long'], { env: cfg.config ? { RCLONE_CONFIG: cfg.config } : {} })
    const line = stdout.toString().split('\n').find((l) => l.startsWith(`${cfg.remote}:`))
    const type = line?.slice(cfg.remote.length + 1).trim()
    if (type) return PROVIDERS[type] ?? `rclone ${type}`
  } catch {}
  return `rclone remote ${cfg.remote}`
}

const NOT_FOUND = /not found|doesn't exist|does not exist|no such file/i

export function create (cfg, ctx) {
  const root = (cfg.root ?? ctx.root).replace(/^\/+|\/+$/g, '')
  const bin = cfg.bin ?? 'rclone'
  const env = cfg.config ? { RCLONE_CONFIG: cfg.config } : {}
  const target = (rel) => `${cfg.remote}:${root}${rel ? '/' + rel : ''}`
  const rc = (args, opts) => run(bin, [...args, '--retries', '2', '--low-level-retries', '3', '-q'], { env, ...opts })

  return {
    name: cfg.name,
    type: 'rclone',
    where: target(''),
    async put (rel, bytes) {
      await rc(['rcat', target(rel)], { input: Buffer.from(bytes) })
    },
    async get (rel) {
      try {
        return new Uint8Array((await rc(['cat', target(rel)])).stdout)
      } catch (err) {
        if (NOT_FOUND.test(err.stderr ?? '') || err.code === 3 || err.code === 4) return null
        throw err
      }
    },
    async exists (rel) {
      const i = rel.lastIndexOf('/')
      return (await this.list(i < 0 ? '' : rel.slice(0, i))).includes(rel.slice(i + 1))
    },
    async list (dir) {
      try {
        return (await rc(['lsf', '--files-only', target(dir)])).stdout.toString().split('\n').filter(Boolean)
      } catch (err) {
        if (NOT_FOUND.test(err.stderr ?? '') || err.code === 3) return []
        throw err
      }
    },
    async close () {}
  }
}
