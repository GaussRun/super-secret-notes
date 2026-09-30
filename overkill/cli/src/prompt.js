// Interactive prompts. Reads from the terminal even when stdin carries note content
// (`echo hi | super-secret-notes put x`), by falling back to /dev/tty.
import readline from 'node:readline/promises'
import tty from 'node:tty'
import { openSync, createWriteStream, readFileSync } from 'node:fs'

function terminal () {
  if (process.stdin.isTTY) return { input: process.stdin, output: process.stderr, own: false }
  return { input: new tty.ReadStream(openSync('/dev/tty', 'r')), output: createWriteStream('/dev/tty'), own: true }
}

function release (t) {
  if (t.own) { t.input.destroy(); t.output.end() } else t.input.pause()
}

export async function ask (question) {
  const t = terminal()
  const rl = readline.createInterface({ input: t.input, output: t.output, terminal: true })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
    release(t)
  }
}

/** Reads a line in raw mode without echoing it. */
export function askSecret (question) {
  const t = terminal()
  t.output.write(question)
  t.input.setRawMode(true)
  t.input.resume()
  return new Promise((resolve) => {
    let value = ''
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          t.input.off('data', onData)
          t.input.setRawMode(false)
          t.output.write('\n')
          release(t)
          return resolve(value)
        }
        if (ch === '\u0003') { t.input.setRawMode(false); t.output.write('\n'); process.exit(130) }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    t.input.on('data', onData)
  })
}

export async function askYesNo (q, dflt = false) {
  const a = (await ask(`${q} ${dflt ? '[Y/n]' : '[y/N]'} `)).toLowerCase()
  return a ? a.startsWith('y') : dflt
}

/** OVERKILL_PASSPHRASE, then OVERKILL_PASSPHRASE_FILE (first line), otherwise ask. */
export async function passphrase ({ confirm = false } = {}) {
  if (process.env.OVERKILL_PASSPHRASE) return process.env.OVERKILL_PASSPHRASE
  if (process.env.OVERKILL_PASSPHRASE_FILE) {
    const line = readFileSync(process.env.OVERKILL_PASSPHRASE_FILE, 'utf8').split(/\r?\n/)[0]
    if (!line) throw new Error('OVERKILL_PASSPHRASE_FILE is empty')
    return line
  }
  for (;;) {
    const p = await askSecret('Vault passphrase: ')
    if (!confirm) return p
    if (p.length < 12) { process.stderr.write('At least 12 characters please. This is the one secret that matters.\n'); continue }
    if (p === await askSecret('Again, for luck: ')) return p
    process.stderr.write('Those did not match. Deep breath, try again.\n')
  }
}
