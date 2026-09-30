// Proton Drive via Proton's official CLI (https://github.com/ProtonDriveApps/sdk, `proton-drive`).
// One human browser login per machine (`proton-drive auth login`), then fully headless.
// The session lives in the OS keychain and is only ever touched by the proton-drive binary.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { run } from './run.js'

export const info = {
  title: 'Proton Drive (official CLI)',
  blurb: 'Swiss, end-to-end encrypted, 5 GB free. Needs the proton-drive CLI and one `proton-drive auth login` in a browser.',
  signup: 'https://proton.me/drive/pricing'
}

export async function prompt (ask) {
  const bin = await ask('  Path to the proton-drive binary (empty = proton-drive on PATH): ')
  return bin ? { bin: path.resolve(bin) } : {}
}

export const operator = () => 'Proton'

const NOT_FOUND = /node not found|not found/i

export function create (cfg, ctx) {
  const bin = cfg.bin ?? 'proton-drive'
  const base = `/my-files/${(cfg.root ?? ctx.root).replace(/^\/+|\/+$/g, '')}`
  // ciphertext only: a staging area for uploads and downloads, overwritten in place
  const staging = path.join(ctx.home, 'staging', cfg.name)
  const known = new Set()
  const pd = (args) => run(bin, args)

  async function ensureFolder (remoteDir) {
    if (known.has(remoteDir)) return
    try {
      await pd(['fs', 'info', '--json', remoteDir])
    } catch (err) {
      if (!NOT_FOUND.test(err.message)) throw err
      await ensureFolder(path.posix.dirname(remoteDir))
      await pd(['fs', 'create-folder', '--json', path.posix.dirname(remoteDir), path.posix.basename(remoteDir)])
    }
    known.add(remoteDir)
  }

  async function list (dirRel) {
    try {
      const nodes = JSON.parse((await pd(['fs', 'list', '--json', path.posix.join(base, dirRel)])).stdout.toString())
      return nodes.filter((n) => n.type === 'file' && n.name?.ok).map((n) => n.name.value)
    } catch (err) {
      if (NOT_FOUND.test(err.message)) return []
      throw err
    }
  }

  return {
    name: cfg.name,
    type: 'proton-cli',
    where: `proton:${base}`,
    async put (rel, bytes) {
      const remote = path.posix.join(base, rel)
      await ensureFolder(path.posix.dirname(remote))
      const up = path.join(staging, 'up')
      await mkdir(up, { recursive: true, mode: 0o700 })
      const local = path.join(up, path.posix.basename(rel))
      await writeFile(local, bytes)
      // new revision instead of replace: Proton keeps the old versions for us
      await pd(['fs', 'upload', '--json', '-t', '-f', 'create-new-revision', local, path.posix.dirname(remote)])
    },
    async get (rel) {
      const down = path.join(staging, 'down')
      await mkdir(down, { recursive: true, mode: 0o700 })
      try {
        await pd(['fs', 'download', '--json', '-f', 'remove', path.posix.join(base, rel), down])
      } catch (err) {
        if (NOT_FOUND.test(err.message)) return null
        throw err
      }
      return new Uint8Array(await readFile(path.join(down, path.posix.basename(rel))))
    },
    async exists (rel) {
      return (await list(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel))).includes(path.posix.basename(rel))
    },
    list,
    async close () {}
  }
}
