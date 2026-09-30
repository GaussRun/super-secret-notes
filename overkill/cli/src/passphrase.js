// Generated passphrases and a (deliberately crude) strength check. vault.age sits on public
// hosts (pastes, relays), so the passphrase is the whole security: docs/OVERKILL.md,
// "Recovery with vault name + passphrase only". The logic is in passphrase-core.js (shared
// with the web client); this module only loads the EFF wordlist from disk.
import { readFileSync } from 'node:fs'
import { passphraseTools } from './passphrase-core.js'

export const { WORDS, BITS_PER_WORD, MIN_BITS, DEFAULT_WORDS, generatePassphrase, estimateBits, isStrongEnough, generateVaultName } =
  passphraseTools(readFileSync(new URL('./wordlist/eff_large_wordlist.txt', import.meta.url), 'utf8'))
