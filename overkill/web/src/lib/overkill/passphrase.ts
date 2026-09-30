// The CLI's passphrase generator and strength check over the same EFF wordlist, bundled.
import words from '$cli/wordlist/eff_large_wordlist.txt?raw';
import { passphraseTools } from '$cli/passphrase-core.js';

export const NOTE_NAME_WORDS = 3;

export const { WORDS, MIN_BITS, DEFAULT_WORDS, generatePassphrase, estimateBits, isStrongEnough, generateVaultName } = passphraseTools(words);

/** A made-up note name ("amber-river-kettle"): notes never collide on one default name. */
export const generateNoteName = () => generateVaultName(NOTE_NAME_WORDS);
