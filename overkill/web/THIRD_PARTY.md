# Third-party files in the web app

The web app bundles the CLI's modules, including CryptPad's client modules and the EFF wordlist;
those are listed in `overkill/cli/THIRD_PARTY.md`. npm dependencies carry their own licenses in
`node_modules` and are bundled at build time. This file covers what lives in `overkill/web` itself.

## Logos (`static/logos/`)

Used unaltered (the Nostr icon cropped and resized, see below), in the encryption diagram only (`src/lib/diagram.ts`, `static/diagram.svg`), to
name where copies go. No endorsement by these projects is implied, and the diagram says so.

| File | Source (pinned) | License / terms | SHA-256 |
|---|---|---|---|
| `privatebin.svg` | https://github.com/PrivateBin/PrivateBin/blob/43bf85e48b401398a971df9af4acaaf93574b620/img/icon.svg | CC BY 4.0, by rugk (PrivateBin/assets), as stated in PrivateBin's LICENSE.md ("CC-BY (favicon, icon, logo)"). Attribution: "PrivateBin icon by rugk, CC BY 4.0". Trademarks are not licensed; used only to name the project. | `f7a080b5330aa7f0ffbb3d52a09a94d24104c16572fe384cfd41a41221b89e31` |
| `cryptpad.svg` | https://github.com/cryptpad/cryptpad/blob/9808cf25c1091d6cf532df13bf5a70ba332f8d4d/customize.dist/CryptPad_logo.svg | AGPL-3.0-or-later (its REUSE file `CryptPad_logo.svg.license`: "SPDX-FileCopyrightText: 2023 XWiki CryptPad Team and contributors"), the same license as this project. No trademark policy found on cryptpad.org; used only to name the project. | `691058e2b587a32972afa65451e74359a811460034aeb617ee91631fc3f7e526` |
| `nostr.png` | The purple "Nostrich" button image linked from the README of https://github.com/SovrynMatt/Nostr-Website-Button-Design (commit 037b245a11f5ea99093f83781b8aa85c233d820f): https://user-images.githubusercontent.com/99301796/219715119-8d2d017a-3a76-4f16-abc2-08f9ea0e985d.png (1125x750, SHA-256 `4ece05f1d77c9cb97d334ba9c0301b2960640df89bf5d75d6bffadefc4355673`). Cropped to the 620x620 ostrich and scaled to 128x128; not otherwise altered. | No LICENSE file; the author's README grants use: "Nostr is Freedom Open Source Software (FOSS). And so is everything in this repository. Feel free to use whatever you like, copy/paste/save these images, share them, use them on your websites...". Community artwork, not an official Nostr logo: nostrdesign.org says "Nostr doesn't have a logo that everyone can agree on", and its own icons sit in a Figma file with no license, so they were not used. Attribution: "Nostr ostrich icon by SovrynMatt". | `ab3fa16624be55ce3bb36ef91105772b7ce9ee59990f061274368dd30478d8b3` |

## Text badges, logo not cleared

Shown as a plain text badge with the name instead of a logo:

| Name | Why no logo |
|---|---|
| age | Its logo terms (https://github.com/FiloSottile/age/blob/main/logo/README.md) allow use only "unaltered, ... not combined with other text or graphic", which a labeled diagram arguably is. Text badge until the author confirms (age-logo@filippo.io). |
| Blossom | No logo in the specification repository (github.com/hzrd149/blossom). Now in the "Coming soon" row (opt-in, no native encryption), text only. |
| MEGA, Proton Drive, Filen, Fileverse | Commercial services; their brand guidelines were not reviewed for this use, so the opt-in group uses text only. |
