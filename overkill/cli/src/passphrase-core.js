// Passphrase generation and the strength check, without file access (passphrase.js loads the
// wordlist from disk, the web client bundles the same file).
export const MIN_BITS = 77
export const DEFAULT_WORDS = 6 // 77.5 bits
export const VAULT_NAME_WORDS = 4

/** Tools over a wordlist given as text, one word per line (the EFF large list). */
export function passphraseTools (wordlistText) {
  const WORDS = wordlistText.split('\n').map((w) => w.trim()).filter(Boolean)
  const WORDSET = new Set(WORDS)
  const BITS_PER_WORD = Math.log2(WORDS.length) // 12.92 for 7776 words

  /** Uniformly random words from the list, space separated. */
  function generatePassphrase (words = DEFAULT_WORDS) {
    const out = []
    const limit = Math.floor(65536 / WORDS.length) * WORDS.length // rejection sampling, no modulo bias
    while (out.length < words) {
      const [x] = globalThis.crypto.getRandomValues(new Uint16Array(1))
      if (x < limit) out.push(WORDS[x % WORDS.length])
    }
    return out.join(' ')
  }

  /**
   * Estimated bits of a user-chosen passphrase, deliberately on the low side (humans pick
   * badly). Several words: each distinct word counts 12.9 bits if it is on the list, else at
   * most 17 (a human picking a word). One token: a charset estimate at 60%, over at most twice
   * the number of distinct characters.
   */
  function estimateBits (pass) {
    const words = pass.trim().split(/\s+/).filter(Boolean)
    if (words.length > 1) {
      return [...new Set(words.map((w) => w.toLowerCase()))]
        .reduce((sum, w) => sum + (WORDSET.has(w) ? BITS_PER_WORD : Math.min(charsetBits(w), 17)), 0)
    }
    return charsetBits(pass)
  }

  const isStrongEnough = (pass) => estimateBits(pass) >= MIN_BITS

  /**
   * A readable vault name, e.g. "velvet-otter-harbor-lantern": random words from the same list,
   * joined with "-" (no list word contains one). A clash with someone else's name is harmless,
   * since the discovery key also depends on the passphrase; four words keep clashes rare.
   */
  const generateVaultName = (words = VAULT_NAME_WORDS) => generatePassphrase(words).replace(/ /g, '-')

  return { WORDS, BITS_PER_WORD, MIN_BITS, DEFAULT_WORDS, generatePassphrase, estimateBits, isStrongEnough, generateVaultName }
}

function charsetBits (s) {
  let pool = 0
  if (/[a-z]/.test(s)) pool += 26
  if (/[A-Z]/.test(s)) pool += 26
  if (/[0-9]/.test(s)) pool += 10
  if (/[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(s)) pool += 33
  if (/[^\x00-\x7f]/.test(s)) pool += 100
  const chars = [...s]
  const effective = Math.min(chars.length, 2 * new Set(chars).size)
  return 0.6 * effective * Math.log2(Math.max(pool, 2))
}
