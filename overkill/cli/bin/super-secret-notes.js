#!/usr/bin/env node
import { buildCli } from '../src/cli.js'
import { logger } from '../src/log.js'
import { WrongPassphraseError } from '../src/crypto.js'

try {
  await buildCli().parseAsync(process.argv)
} catch (err) {
  logger.error(err instanceof WrongPassphraseError ? 'wrong passphrase. The vault stays shut.' : err.message)
  logger.debug(err.stack)
  process.exitCode = 1
}
// backend SDKs can hold sockets open; we are done either way
await new Promise((resolve) => logger.on('finish', resolve).end())
process.exit(process.exitCode ?? 0)
