// The CLI's passphrase generator and strength check over the same EFF wordlist, bundled.
import words from '$cli/wordlist/eff_large_wordlist.txt?raw';
import { passphraseTools } from '$cli/passphrase-core.js';

export const { WORDS, MIN_BITS, DEFAULT_WORDS, generatePassphrase, estimateBits, isStrongEnough, generateVaultName } = passphraseTools(words);
