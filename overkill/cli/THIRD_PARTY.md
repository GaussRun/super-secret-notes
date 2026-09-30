# Third-party code in this directory

## CryptPad client modules

`src/backends/cryptpad/vendor/cryptpad/` holds 8 unmodified files from CryptPad
(https://github.com/cryptpad/cryptpad), `src/common/` at commit
9808cf25c1091d6cf532df13bf5a70ba332f8d4d.

- Copyright: XWiki CryptPad Team <contact@cryptpad.org> and contributors
- License: AGPL-3.0-or-later (SPDX headers kept in every file)
- Update: `scripts/vendor-cryptpad.sh` (change `COMMIT` in the script, run it, review the diff)

| file | sha256 |
|---|---|
| `common-hash.js` | `a99faa3b89f697665aa726071ddb9169b880138b74fbfa0f0f92ffd46e310802` |
| `common-realtime.js` | `8da2de5544f9309dadd87d0438e86b6f80715056981cbd1864b62baef01cd4da` |
| `common-signing-keys.js` | `122298df4d776a92eba39051afa4c2fc89f1c7ae2d7abf5ec452111fb1785a7d` |
| `common-util.js` | `f24821a5f1e76f2f6047328b4affe578c531fb6a1ea6d3b59aee13fd6ad0127e` |
| `outer/http-command.js` | `a44e281cdfc1ed9c4ae3f65641f2ad82a94b2b6d9c3d53800064ed64600d3b01` |
| `outer/login-block.js` | `47ea51e1783afe57fecd1a8f57ff21c87e45ccde444ddfcd07b4c28285cfe035` |
| `pinpad.js` | `f9314a441c24973ee720c0b201498f6579ebc1e0d404a3b4f3cb1caabaae38c6` |
| `rpc.js` | `887a598610640a8289d4ae4cc5feb3830a19bad9595efdf5f750436735338076` |

`package.json` there only marks the directory as CommonJS.

## EFF large wordlist

`src/wordlist/eff_large_wordlist.txt`: the EFF large diceware wordlist (https://www.eff.org/dice),
by the Electronic Frontier Foundation, CC BY 3.0 US. Dice numbers removed. See
`src/wordlist/README.md`.
