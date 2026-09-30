// A plain folder. For tests, and for the joy of carrying your notes on a USB stick.
import { mkdir, readFile, readdir, writeFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'

export const info = {
  title: 'Local folder',
  blurb: 'Any folder: a USB stick, a NAS mount, a Dropbox folder. No account, no E2E layer of its own, maximum vibes.',
  signup: null
}

export async function prompt (ask) {
  return { path: path.resolve(await ask('  Folder path (for example /Volumes/USBSTICK): ')) }
}

// a folder you own is not a hosted operator
export const operator = () => null

export function create (cfg, ctx) {
  const base = path.join(cfg.path, cfg.root ?? ctx.root)
  const abs = (rel) => path.join(base, ...rel.split('/'))
  return {
    name: cfg.name,
    type: 'local',
    where: base,
    async put (rel, bytes) {
      const file = abs(rel)
      await mkdir(path.dirname(file), { recursive: true })
      // write then rename, so a crash never leaves a half-written copy in place
      const tmp = `${file}.partial`
      await writeFile(tmp, bytes)
      await rename(tmp, file)
    },
    async get (rel) {
      try {
        return new Uint8Array(await readFile(abs(rel)))
      } catch (err) {
        if (err.code === 'ENOENT') return null
        throw err
      }
    },
    async exists (rel) {
      return stat(abs(rel)).then(() => true, (err) => { if (err.code === 'ENOENT') return false; throw err })
    },
    async list (dir) {
      try {
        return (await readdir(abs(dir), { withFileTypes: true })).filter((e) => e.isFile() && !e.name.endsWith('.partial')).map((e) => e.name)
      } catch (err) {
        if (err.code === 'ENOENT') return []
        throw err
      }
    },
    async close () {}
  }
}
