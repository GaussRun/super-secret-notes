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

// `timeoutMs`: SIGTERM after that long, SIGKILL `killGraceMs` later if the child ignores it
export function run (cmd, args, { input, env, timeoutMs = 180_000, killGraceMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let timedOut = false
    let kill = null
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      kill = setTimeout(() => child.kill('SIGKILL'), killGraceMs)
    }, timeoutMs)
    const stop = () => { clearTimeout(timer); clearTimeout(kill) }
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => { stop(); reject(e) })
    const timedOutError = (code) => new CommandError(`${cmd} ${args[0]} timed out after ${timeoutMs} ms`, { code, stderr: Buffer.concat(err).toString(), stdout: Buffer.concat(out) })
    // after a timeout the exit is enough: a grandchild holding the pipes open must not keep us waiting
    child.on('exit', (code) => { if (timedOut) { stop(); reject(timedOutError(code)) } })
    child.on('close', (code, signal) => {
      stop()
      if (timedOut) return reject(timedOutError(code))
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
