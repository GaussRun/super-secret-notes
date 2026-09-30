# Super Secret Notes by GaussRun (web)

A note you cannot afford to lose, saved in many independent places, recoverable anywhere with a
vault name plus passphrase. In a browser tab, with no server of ours.

![Our encryption (age + AES-256-GCM) on your device, then each host's native encryption: copies go to 3 PrivateBin instances (native AES-256-GCM), 2 CryptPad instances (native XSalsa20-Poly1305), 4 Nostr relays (native NIP-44) and 3 Blossom servers (no native encryption, so we add AES-256-GCM); any one healthy copy plus the vault name and passphrase brings it back](static/diagram.svg)

The diagram is `static/diagram.svg` (regenerate with `node scripts/diagram.mjs`; the same layout
renders inline on the landing page and on /how-it-works/). Logo sources and terms:
[THIRD_PARTY.md](THIRD_PARTY.md).

This is the web client of Super Secret Notes (the CLI is `super-secret-notes`, same format: see
`docs/OVERKILL.md`, including its "Format history"). It is a **static site**: prerendered pages plus a client-side fallback, no
server routes, no relay. The page talks straight to hosts that need no account:

| Host | How the browser reaches it | The host's own layer |
|---|---|---|
| PrivateBin instances | CORS simple requests (`Content-Type: text/plain`, `Accept: application/json`, no `X-Requested-With`): PrivateBin answers no preflight but does answer these, with `Access-Control-Allow-Origin: *` | AES-256-GCM, key in the URL fragment |
| Nostr relays | WebSocket | NIP-44 to a key derived from the vault |
| Blossom servers | CORS with preflight (BUD-01 servers allow any origin) | AES-256-GCM under a key derived from the vault |
| CryptPad instances | its HTTP API with CORS (config, login blocks, `/api/auth` as form posts) and the realtime protocol over WebSocket; the account is derived from the vault and registered on first use | CryptPad's own encryption of every pad |

A vault made by the CLI (`overkill/cli`) opens here and the other way round: the web app runs the
CLI's own modules (crypto, the replication store with its index merge and health ledger, the
PrivateBin/CryptPad/Nostr/Blossom adapters, the discovery record, the recovery kit). The few
that touch Node get a browser shim with the same exports (`src/lib/overkill/shims/`, wired in
`vite.config.ts`); the rest are imported as they are from `../cli/src`. CryptPad's vendored
client modules (UMD/CommonJS, AGPL-3.0-or-later, `overkill/cli/src/backends/cryptpad/vendor`)
are turned into ES modules at build time, and CryptPad's scrypt (N = 2^8, r = 1024, 32 MiB)
runs in a Web Worker so the page keeps responding.

## Read this first (no, really)

- **Key loss means data loss.** Lose the passphrase *and* the recovery kit and the notes are gone.
- **vault.age sits on public hosts**, so the passphrase is the whole security. New vaults get six
  random words from the EFF list (77.5 bits); a chosen one must pass the same strength check as in the CLI.
- **Whoever serves this page can change it.** A changed page could send your passphrase anywhere.
  For anything real, build it yourself and serve it from a machine you control (see `/trust/` in the app).
- Keys, the passphrase and plaintext live in the tab's memory only; a reload locks the vault. The
  browser keeps only encrypted files (IndexedDB: `vault.age`, `config.ovk`, `index-cache.ovk`,
  `secrets.ovk`). Host lists for new vaults (not secret) sit in `localStorage`.

## Run it

Node 24 and pnpm. The build imports `../cli/src`, so keep the repository layout; the CLI's own
dependencies are only needed for the interop tests.

```sh
cd overkill/web
pnpm install
pnpm dev          # http://localhost:5173
```

## Pages

`/setup/` is note first: write the note, press "Encrypt and scatter", and the vault (a made-up
four-word name such as `velvet-otter-harbor-lantern` and a six-word passphrase, both shown as
read-only password-manager fields with a "change" link), the hosts, the note and the recovery
record are all done in one go; the result screen offers the password-manager save, the kit and
Send to phone. "Skip, just create the vault" is the old path. The CLI offers the same kind of
made-up name when `super-secret-notes put` runs with no vault (Enter accepts it).

Hosts can be added to an existing vault on `/hosts/` (everything is copied there right away).

Every view has its own URL: `/` `/setup/` `/recover/` `/unlock/` `/notes/` `/notes/<name>/` `/new/`
`/check/` `/status/` `/hosts/` `/recovery-kit/` `/settings/` `/trust/` `/how-it-works/` `/thanks/`.

A note's page edits in place: "Publish changes" appears only when the text differs from what is
on the hosts (leaving with unpublished changes asks first), and it lists every host of the vault
with the last verified status, marks the one the note was just read from, and can check this
note's copies on demand. "Sign out" in the header clears the keys from memory; the encrypted
vault stays in the browser for the next unlock.

## Password managers

The vault name is the username and the passphrase the password, so any password manager (the
browser's own, 1Password, Bitwarden, ...) can save and fill them:

- Setup, unlock and recover are real `<form method="post" action="#">` elements with a submit
  button; the page handles the submit itself, so nothing is sent anywhere and the passphrase never
  reaches the URL or the history (the Playwright suite checks both).
- The vault name field is `name="username" autocomplete="username"` on all three (read-only on
  unlock, where the browser remembers the name in `localStorage`; it is not secret). The passphrase
  field is `autocomplete="new-password"` on setup, pre-filled with the generated words (show/hide and
  copy buttons), and `current-password` on unlock and recover.
- Where the Credential Management API exists (Chromium), a successful setup or recovery also calls
  `navigator.credentials.store(new PasswordCredential(...))`, and the unlock form tries
  `navigator.credentials.get({ password: true, mediation: 'optional' })` to fill itself. Both are
  best effort; elsewhere the form hints do the work.
- **Serve the site from one stable origin** (a GitHub Pages custom domain, or one fixed
  `https://<user>.github.io/<repo>/` path). Managers file credentials by origin: a new domain or
  port means a new, empty entry.
- The manager is a convenience. The recovery kit is the backstop: keep it too.

Whether a manager actually shows its "save?" prompt cannot be automated in a test.

## Send to phone, and public computers

- **Send to phone** (on `/recovery-kit/` and behind a button on `/notes/`): a QR code, generated
  in the page with the bundled `qrcode-generator` (MIT; no network, no eval). Two kinds:
  - a recovery link `<site>/recover/#v=<vault name>&p=<passphrase>`. Everything after `#` is the
    URL fragment, which browsers never send to a server. `/recover/` reads it, fills the form
    (username and current-password, so the manager can save it after), removes the fragment from
    the address bar and the history entry at once, and asks "Recover this vault?" before doing
    anything;
  - plain text (`vault name: ...`, `passphrase: ...`) for a password-manager or notes app.
  The QR stays hidden until "Show QR", comes with a large warning (anyone who sees it can open
  the vault), hides itself after 60 seconds and has a "Hide now" button.
- **Public computer mode** (a switch on setup, recover and unlock; off by default): the vault
  lives in the tab's memory only. Nothing is written to IndexedDB or localStorage and the password
  manager is not asked to save anything. "Done: wipe this tab" forgets the keys and files, clears
  this browser's stored copy of the vault too, and reloads the start page. The landing page has a
  one-click throwaway flow for this (made-up vault name and passphrase, public mode on).
- Limits, stated plainly: a public computer may have a keylogger or record the screen, so use a
  throwaway vault for one-off transfers and change anything important afterwards. On the phone,
  the page that opened the link keeps its original URL in its own navigation-timing entry
  (readable only by that page, gone when it closes; no API clears it), and the phone's browser may
  record the visited link in its own history before the page can strip it: open the QR in a
  private tab where the phone offers that, or clear the entry afterwards. Nothing ever sends the
  fragment over the network (the Playwright suite checks every request).

## Build and deploy

```sh
pnpm build                    # static site in build/
BASE_PATH=/overkill pnpm build   # served from a subpath (GitHub Pages project sites)
```

`build/` works from any static file server. Two things the server has to do:

1. Serve `<dir>/index.html` for `<dir>/` (every static server does).
2. Serve `404.html` for unknown paths, so a note page opened directly (`/notes/<name>/`) boots
   the app. GitHub Pages does this by itself. nginx: `try_files $uri $uri/ /404.html;`. Caddy:
   `try_files {path} {path}/ /404.html`. Without it, everything works except opening a note URL cold.

Try it locally the way GitHub Pages serves it: `pnpm build && pnpm preview` (serves `build/` at
http://127.0.0.1:4173/ with the 404 fallback; for a subpath build: `node e2e/serve.mjs build /overkill 4173`).

GitHub Pages: build with `BASE_PATH=/<repository name>`, publish the contents of `build/` (for
example with `actions/upload-pages-artifact` and `actions/deploy-pages`). Asset URLs are relative,
so the same build also works from a folder on disk served by any static server.

The site lives at **https://gaussrun.github.io/super-secret-notes/** (GitHub Pages, built with
`BASE_PATH=/super-secret-notes`). Every absolute URL the site names comes from `SITE_URL` at
build time (default `https://gaussrun.github.io/super-secret-notes`):

```sh
SITE_URL=https://notes.example.org BASE_PATH= pnpm build
```

The title, description, OpenGraph and Twitter tags and the schema.org JSON-LD sit in
`src/app.html` (as `%sveltekit.env.PUBLIC_SITE_URL%`), not in page components: the pages render
in the browser, so the template is what crawlers and link previews read. `robots.txt`,
`sitemap.xml` and `llms.txt` (a plain-text summary for AI assistants) are templates in `site/`
(`{{SITE_URL}}`), rendered into each build's own assets folder (`.site-assets/`) together with
`static/`. `src/lib/site-url.node.spec.ts` builds for `https://example.org/sub` and checks that no
other site URL appears. Note that crawlers only read `robots.txt` at the root of an origin, so on a
project subpath it is informative; the sitemap is still found through it where the origin root
points there, or when submitted directly. `static/og.png` (the 1200x630 link preview) is generated by
`node scripts/og-image.mjs`, with no external assets. The JSON-LD block is data, not script, so
the CSP needs nothing extra for it (`e2e/seo.e2e.ts` checks there are no violations).

Nothing here deploys anything; publishing is a separate decision.

## Security of the static page

- A Content-Security-Policy meta tag on every page: `default-src 'none'`, scripts only from the
  site itself plus the hash of SvelteKit's one inline boot script, `connect-src 'self' https: wss:`,
  no objects, no frames, `base-uri 'none'`, `form-action 'self'` (the forms only submit to `#`,
  handled in the page; a real form target is what some password managers need to offer saving).
- No third-party scripts, CDNs, fonts or analytics: everything is bundled.
- `Referrer-Policy: no-referrer` (meta), so paste URLs never leak through a Referer header.
- The test build (`pnpm build:test`) is the only one whose CSP also allows `http://127.0.0.1:*`
  and `ws://127.0.0.1:*`, for the fake hosts.

## Tests

```sh
pnpm test:unit    # vitest, twice: in Node and in headless Chromium
pnpm test:e2e     # Playwright against in-process fake hosts (needs the CLI installed for interop)
pnpm check        # svelte-check
```

- `src/lib/overkill/vectors.spec.ts` runs the CLI's known-answer vectors
  (`overkill/cli/test/vectors.json`) through the bundled modules, plus the layers each host adds.
- `e2e/app.e2e.ts`: setup, new note, list, open, check with a corrupted copy flagged, repair,
  status, reload + unlock, recover by name in a fresh browser, a wrong passphrase.
- `e2e/interop.e2e.ts`: the CLI (`node overkill/cli/bin/overkill.js`) makes a vault and a note, the
  web app recovers it by name and reads it (and writes one the CLI reads); then the reverse.
- `e2e/fakes.ts`: a fake PrivateBin, Nostr relay and Blossom server with CORS behaving like the
  real ones (PrivateBin refuses preflights, Blossom answers them). `e2e/fake-cryptpad.ts`: a fake
  CryptPad instance (HTTP API with real signature checks and no preflight for `/api/auth`, the
  netflux protocol, a history keeper, the pinning RPCs); `src/lib/overkill/cryptpad.node.spec.ts`
  drives the web client's CryptPad backend against it, and the Playwright suites include it. The site is built with
  `BASE_PATH=/ovk-test` and served like GitHub Pages (`e2e/serve.mjs`), so the subpath is tested too.

## Browser CORS, checked live (2026-09-30, headless Chromium, origin `http://localhost`)

- PrivateBin: all 11 instances in the CLI's list answered a JSON read with CORS.
- Blossom: all 7 servers in the CLI's list answered the upload preflight and returned readable
  responses (nostr.download, blossom.ditto.pub, cdn.hzrd149.com, blossom.yakihonne.com,
  files.sovbit.host, blossom.nmail.li, blossom.jumble.social).
- Nostr: WebSockets are not subject to CORS.
- CryptPad: `cryptpad.private.coffee` sends `Access-Control-Allow-Origin: *` on its API but
  answers no preflight, so `/api/auth` (the login block for a new account) goes out as
  `application/x-www-form-urlencoded`, which its server also parses. `crypt.unredacted.org` pins
  `Access-Control-Allow-Origin` to its own sandbox origin, so no other page can read its config
  or login blocks: the web app leaves it to the CLI (a vault using it keeps that backend in its
  config and recovery record). WebSockets open on both.

## Live check against the real hosts

Not part of `pnpm test`: one polite run of setup, put, check, get and recover by name (fresh
browser) against the real defaults, with the throwaway vault name `overkill-dev-web-static`:

```sh
OVERKILL_LIVE_SECRET_FILE=/somewhere/outside/the/repo/live-vault.json \
  pnpm exec playwright test -c playwright.live.config.ts
```

The generated passphrase goes to that file (mode 0600) so the next run recovers the same vault
instead of making another one; it is never printed. Result on 2026-09-30: all 10 default hosts
worked from the browser (PrivateBin pb.envs.net, paste.systemli.org, extrait.facil.services; Nostr
nos.lol, nostr.mom, purplerelay.com, nostr.oxtr.dev; Blossom nostr.download, blossom.ditto.pub,
cdn.hzrd149.com), 23 of 24 copies verified (nos.lol answered one read with "rate-limited"), and
recovery by name found the vault in a fresh browser.

`e2e-live/cryptpad.live.ts` (same command and secret file) adds the default CryptPad instances
to that vault from the hosts page. Result on 2026-09-30: `crypt.unredacted.org` refused by the
page (CORS, nothing sent); `cryptpad.private.coffee` got the vault's derived account (one
account, registered from the browser in about 13 s including copying everything there), check
27/27 healthy, put to 11/11 hosts, and a fresh browser recovered by name with the CryptPad
backend and verified 38/38 copies.

## Roadmap

- Passkey unlock through the WebAuthn PRF extension (a passkey derives the key that opens
  vault.age, so no passphrase is typed on a device that has the passkey). A passkey PRF
  prototype exists; not in this release.
