# Third-party files in the web app

The web app bundles the CLI's modules, including CryptPad's client modules and the EFF wordlist;
those are listed in `overkill/cli/THIRD_PARTY.md`. npm dependencies carry their own licenses in
`node_modules` and are bundled at build time. This file covers what lives in `overkill/web` itself.

## Logos (`static/logos/`)

Used unaltered, in the encryption diagram only (`src/lib/diagram.ts`, `static/diagram.svg`), to
name where copies go. No endorsement by these projects is implied, and the diagram says so.

| File | Source (official repository, pinned) | License / terms | SHA-256 |
|---|---|---|---|
| `privatebin.svg` | https://github.com/PrivateBin/PrivateBin/blob/43bf85e48b401398a971df9af4acaaf93574b620/img/icon.svg | CC BY 4.0, by rugk (PrivateBin/assets), as stated in PrivateBin's LICENSE.md ("CC-BY (favicon, icon, logo)"). Attribution: "PrivateBin icon by rugk, CC BY 4.0". Trademarks are not licensed; used only to name the project. | `f7a080b5330aa7f0ffbb3d52a09a94d24104c16572fe384cfd41a41221b89e31` |
| `cryptpad.svg` | https://github.com/cryptpad/cryptpad/blob/9808cf25c1091d6cf532df13bf5a70ba332f8d4d/customize.dist/CryptPad_logo.svg | AGPL-3.0-or-later (its REUSE file `CryptPad_logo.svg.license`: "SPDX-FileCopyrightText: 2023 XWiki CryptPad Team and contributors"), the same license as this project. No trademark policy found on cryptpad.org; used only to name the project. | `691058e2b587a32972afa65451e74359a811460034aeb617ee91631fc3f7e526` |

## Text badges, logo not cleared

Shown as a plain text badge with the name instead of a logo:

| Name | Why no logo |
|---|---|
| age | Its logo terms (https://github.com/FiloSottile/age/blob/main/logo/README.md) allow use only "unaltered, ... not combined with other text or graphic", which a labeled diagram arguably is. Text badge until the author confirms (age-logo@filippo.io). |
| Nostr | No logo in the protocol's official repositories (github.com/nostr-protocol); community logos exist but none is official. |
| Blossom | No logo in the specification repository (github.com/hzrd149/blossom). |
| MEGA, Proton Drive, Filen, Fileverse | Commercial services; their brand guidelines were not reviewed for this use, so the opt-in group uses text only. |
