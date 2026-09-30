// Tiny child-process helper for CLI-driven backends. Secrets never go on argv.
import { spawn } from 'node:child_process'

export class CommandError extends Error {
  constructor (message, { code, stderr, stdout }) {
    super(message)
    this.name = 'CommandError'
    this.code = code
    this.stderr = stderr
    this.stdout = stdout
  }
}

export function run (cmd, args, { input, env, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out)
      const stderr = Buffer.concat(err).toString()
      if (code === 0) return resolve({ stdout, stderr })
      const first = stderr.trim().split('\n').filter(Boolean).pop() ?? `exit ${code ?? signal}`
      reject(new CommandError(`${cmd} ${args[0]} failed: ${first}`, { code, stderr, stdout }))
    })
    child.stdin.on('error', () => {}) // the child may exit before reading stdin
    child.stdin.end(input)
  })
}
