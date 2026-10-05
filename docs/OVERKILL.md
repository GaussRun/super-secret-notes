# Super Secret Notes: format and design (v1)

Super Secret Notes keeps a note so that losing any single host loses nothing: every note is
encrypted twice on the device where it is written and copied to several independent hosts, each of which adds
its own encryption layer, and it is read back from any healthy copy. The weak point, as with any
encryption tool, is key handling (the passphrase, the recovery kit and the device they are typed
on), and the documentation says so.

Naming: the project was first called "Overkill Notes". Every `overkill v1 ...` label below is a
cryptographic domain separator and stays as it is, as do the `OVERKILL_*` environment variables
and the `~/.overkill-notes` state directory. The command line tool is `super-secret-notes`.

Two clients, same on-disk format, so a note written by one is readable by the other:
- `overkill/cli/` (Node CLI)
- `overkill/web/` (static web app, runs the CLI's modules in the browser: PrivateBin, CryptPad, Nostr, Blossom, recover by name)

## Format v1 (both clients follow it)

### Vault (keys)
- `master`: 32 random bytes.
- `age_identity`: an age X25519 identity (`AGE-SECRET-KEY-1...`).
- Vault plaintext JSON: `{"v":1,"age_identity":"...","master":"<base64 32 bytes>","created":"<ISO 8601>"}`.
- Vault file `vault.age` = that JSON encrypted with age passphrase mode (scrypt).
- `vault.age` is uploaded to every backend, so passphrase alone recovers from any device.
- Recovery kit: printable text with the age identity + master (base64) + list of backends.

### Derived keys
- `K_aes  = HKDF-SHA256(ikm=master, salt=empty, info="overkill v1 aes",  L=32)`
- `K_name = HKDF-SHA256(ikm=master, salt=empty, info="overkill v1 name", L=32)`

### Blob encryption (used for notes and the index)
1. Layer 1: `inner = age_encrypt(plaintext, recipient = public key of age_identity)` (binary age format, not armored).
2. Layer 2: `blob = "OVK1" (4 ASCII bytes) || nonce (12 random bytes) || AES-256-GCM(K_aes, nonce, inner, AAD = "OVK1" || blob_id as ASCII)`.
3. Decrypt reverses both; any tag/MAC failure = corrupted or tampered copy.
- Use WebCrypto (`crypto.subtle`) for HKDF / HMAC / AES-GCM and the `age-encryption` npm package (typage) for age, so Node and browser share identical code paths.

### Names and layout on each backend
- `blob_id` of a note = lowercase hex of `HMAC-SHA256(K_name, UTF-8 note name)` (all 64 chars).
- `blob_id` of the index = the literal string `index`.
- Paths, under a configurable root folder (default `super-secret-notes`):
  - `<root>/vault.age`
  - `<root>/index.ovk`
  - `<root>/notes/<blob_id>.ovk`
- Providers only ever see random-looking names.

### Index
Plaintext JSON, encrypted as a blob with `blob_id = "index"`:
```json
{"v":1,"notes":{"<note name>":{"id":"<blob_id>","sha256":"<hex of plaintext>","size":123,"updated":"<ISO 8601>"}}}
```
- Merge rule when backends disagree: union of names, per name newest `updated` wins.
- Deletion: out of scope for v1 (keep it simple).

### Operations
- `init`: create vault, pick passphrase, add backends, upload `vault.age`, print recovery kit.
- `put <name>`: encrypt, upload blob to ALL backends, then update index on all backends.
- `get <name>`: read from first healthy backend, decrypt, verify sha256 against index; fall back to next backend on failure.
- `ls`: list names from merged index.
- `check`: download every copy from every backend, verify, report e.g. `mega OK, proton OK (2/2 healthy)`; flag missing or corrupt copies.
- `repair` (nice to have): re-upload missing/corrupt copies from a healthy one.
- `backup -o <file>`: the full backup file (below). `restore <file>`: a vault from it, with no host needed.

### Backup file
One JSON document (UTF-8), made by `backup -o <file>` (CLI) or "Download full backup" (web):
```json
{"format":"super-secret-notes-backup","v":1,"created":"<ISO 8601>","vault_name":"<name or null>",
 "root":"<root folder or null>","config":"<base64>","notes":2,
 "files":{"vault.age":"<base64>","index.ovk":"<base64>","notes/<blob_id>.ovk":"<base64>"}}
```
- `files` holds the blobs exactly as the format above defines them, before any host's own layer:
  `vault.age` as is, the index and every note as two-layer blobs (`"OVK1" || nonce || AES-256-GCM(...)`
  around the age ciphertext) under their usual blob ids. Each note is read from its first healthy copy and
  encrypted again for the file; copies the index does not know (DIVERGED) are not included.
- `config` is the vault config (which backends hold the copies) as a two-layer blob with blob id
  `backup-config`. The format header, `vault_name`, `root`, `created` and the note count are the only
  plaintext.
- Restoring needs the passphrase (it opens `vault.age`); every note is checked against the index's sha256
  before anything is written. The restored blobs become a local copy (a `local` backend named `backup-copy`
  in the CLI; "Backup in this browser" in the web app), read first and needing no host; `repair` (CLI) or
  "Copy everything back to the hosts" (web) then fills the hosts from it.
- Readers refuse a `format` they do not know and a `v` newer than theirs.

## Backends
- Account-based: MEGA (`megajs`), Proton Drive (through the Proton CLI or rclone), Filen, Fileverse.
- Zero-signup: PrivateBin instances, CryptPad instances, Nostr relays and Blossom servers (below).
- Other candidates looked at: Koofr, Backblaze B2 with Object Lock, Cloudflare R2, GitHub,
  Vaultwarden and Proton Pass.

## Backend admission rule
A backend is allowed only if BOTH hold:
1. The host adds its own encryption layer (on top of our two).
2. Data is kept at least 1 year before a refresh is needed.

Allowed: MEGA, Proton Drive, Filen, CryptPad (registered account), Proton Pass, Vaultwarden (self),
PrivateBin instances with `never` expiry.
Experimental (allowed, relies on `refresh`): Nostr relays, with a NIP-44 layer to self (see Format history, item 6).
Rejected: rentry, Gist/snippets, dpaste, Arweave,
PrivateBin instances capped under 1 year (e.g. privatebin.net, 3 days max), Standard Notes (captcha at signup).

PrivateBin instances verified 2026-09-29 (live, `1year` and `never` in the expiry select;
`never` honored by the server on the first three: stored meta has no `time_to_live`):
- https://pb.envs.net
- https://paste.systemli.org
- https://extrait.facil.services
- https://bin.disroot.org
- https://paste.evolix.org
- https://cryptostorm.is/paste/
- https://paste.d-ku.de
- https://0g.gg
- https://paste.unredacted.org
- https://bin.infra.mee6.cloud
- https://paste.coalserver.de

Volunteer instances die (roughly 60% of the instances listed in 2021 are gone today), so use 3 or
more and rely on `check` + `repair`; `refresh` re-uploads copies that are missing or near expiry.

One account per provider. Redundancy comes from independent operators, never from several accounts
with the same provider (same outage, same ToS, no extra safety). Each PrivateBin or CryptPad
instance counts as its own operator. `init` should refuse or warn on two backends with the same operator.

## License
Released open source under AGPL-3.0-or-later. Reason: the Filen SDK (`@filen/sdk`) and the CryptPad
client modules are AGPL-3.0; everything else in use is MIT or BSD-3-Clause, which is compatible.

## Defaults: zero-signup first
Default backends are hosts that one CLI command can use with no email, no captcha and no manual signup.
Random draw from known-good pools: new vaults do not all sit on the same hosts.
At creation each vault draws its own hosts at random (crypto.getRandomValues, no modulo bias) from
per-type pools (`overkill/cli/src/pools.js`), one operator per host, the smallest pool first:
1. PrivateBin instances (no account; `never` expiry; list above, minus paste.coalserver.de; in the browser
   also minus instances that refuse posts from a page, paste.evolix.org): 4.
2. Nostr relays (NIP-78 kind 30078 + NIP-44; the key is derived, no account; the good-retention relays of
   overkill/cli/docs/NOSTR.md, never relay.damus.io): 4.
3. CryptPad instances with automated signup, only where registration is open, no captcha, and the ToS allows
   it (one account per instance): 2 (in the browser only those whose API allows other origins: 1).
That is 10 copies from the CLI, 9 from a browser. The draw guarantees at least one host of each type and at
least one index holder (CryptPad or Nostr). The choice is saved in the vault config and travels in the
bootstrap as before; the rest of each pool is the setup fallbacks. With a host cache (`hosts refresh`) the
CLI draws from its hosts not known to fail, directory finds included. Host lists saved in the web app's
Settings replace the draw there.

The recovery record does not depend on the draw: it always goes to the fixed, well-known
`DISCOVERY_RELAYS` (`overkill/cli/src/bootstrap.js`: nos.lol, nostr.mom, purplerelay.com, nostr.oxtr.dev;
only ever add to that list), besides the vault's own relays, and `recover --name` and /recover/ ask the
fixed set. Old vaults (made with the fixed defaults) keep working unchanged. Blossom servers are not a default (since 2026-09-30): they add no encryption of their
own. They stay available as an opt-in (`init --advanced`, `hosts add`), and vaults that already have
Blossom backends keep using them unchanged.
Second priority, opt-in: Proton Drive, MEGA, Filen (need a manual signup with email/captcha/verification).

One-command goal: `super-secret-notes put <name> [file]` on a fresh machine creates the vault if there is none,
provisions the default backends, uploads, and prints the recovery kit. No config file editing.

### Failure handling (CLI and web: init/setup, put, repair)
- Best effort, never all-or-nothing: every host is tried in parallel, each call with its own
  deadline (CLI 120 s; web 20 s, CryptPad 45 s for its first-use registration, Nostr 60 s for
  chunked notes). A host that fails or times out is marked FAILED in the log and the health
  ledger, and the operation goes on. Calls outside that deadline (deleting a replaced paste or
  blob, dropping a path) are bounded too: every PrivateBin and Blossom HTTP request, body
  included, gives up after 60 s, and a CLI-driven backend (proton-drive, rclone) gets SIGTERM
  at its limit and SIGKILL 5 s later.
- Success at 2 copies: vault.age and each note count as stored once `MIN_COPIES` = 2 hosts hold
  them ("Stored on N hosts; M failed (will retry)"). With 1 copy the work is kept (the vault
  and the index stay encrypted on the device) and a clear warning offers "Retry now" (web) or
  `super-secret-notes repair` (CLI). With 0 copies the operation fails and nothing is lost on
  the device.
- Fallbacks at setup: a default host that fails is replaced by the next known-good host of the
  same type (`src/fallbacks.js`: the verified PrivateBin instances after the defaults, the other
  good relays from docs/NOSTR.md), one operator per host as always, until the alternatives run
  out. The stand-in goes into the config like any other backend. Later failures (put, check)
  are left to `repair`, which swaps dead backends (docs: overkill/cli/docs/HOSTS.md).
- The index: if no index-holding host (CryptPad, Nostr) takes it, it stays on the device (as
  with `index_sync` manual) with a warning, and every later write uploads it again: reads of the
  index (`put`, `get`, `ls`, `check`) merge this device's copy into the remote ones, so the next
  write, or `repair` (index copies lacking those writes are STALE), carries them up.
- A put that answers after its deadline is kept (it counted as FAILED for that operation). On a
  paste host it replaces the previous paste, which the adapter deletes, while the index that
  already went up still names the old one; so the index is written again with the new locator
  (index writes run one at a time), and an adapter never swaps a paste it made for an older
  one an index names (paste creation times, `pastes` in format history 10).
- Stored is not the same as findable: 2 copies on paste hosts (PrivateBin, Blossom) are useless
  to another device until an index holder has the index with their locators. `put` writes the
  index before it returns and reports `indexed` (remote index copies written; null with
  `index_sync` manual/never) and `findable` (`indexed > 0`, null when not synced). With
  `findable: false` it warns separately ("stored on N hosts but NOT yet findable from other
  devices ... keep this device"), and the CLI exits with status 1.
- Never destroy a version the index does not know. Two devices can disagree: a put can reach some
  hosts while its index update reaches none, so another device (older index) sees the newer copies
  as "not the index's version". `repair` therefore overwrites only copies that are MISSING,
  CORRUPT, ERROR, or STALE in the strict sense: the copy's blob hash is one the index entry lists
  as replaced (`superseded`, format history 16). Any other copy that decrypts and authenticates
  but differs is DIVERGED: `check` and `status` report it, `repair` leaves it alone and lists it,
  `get` names it, and `get <name> --from <backend>` reads it so the user can pick and `put` it
  again. Why not "newest wins" with a version counter inside the encrypted blob: that changes the
  blob format, every existing blob would lack it, and a wrong clock or counter on one device would
  still let it silently replace a newer version; keeping every unknown version costs at most a
  warning. The price: copies written before blob hashes were recorded that are merely old show
  as DIVERGED until the note is written again.
- The recovery record goes to every relay that answers; recover-by-name needs at least 1, so
  0 gives a clear warning (the recovery kit still works).

### Recovery with vault name + passphrase only (no locators needed)
Zero-account hosts give no stable path, so bootstrap discovery through Nostr:
- `discovery_key = scrypt(passphrase, salt = "overkill v1 discovery:" || NFC(vault_name), N=2^18, r=8, p=1, 32 bytes)`
  gives a Nostr secp256k1 key (the same invalid-scalar rule as the main Nostr key).
- Under that key, publish `vault.age` plus a small encrypted "bootstrap" record (the locators for
  index.ovk on PrivateBin, the CryptPad instance usernames, and the main npub) to all default relays.
- Recovery: vault name + passphrase, then the discovery key, then fetch vault.age plus bootstrap from any
  relay, then decrypt with the passphrase, then master, then everything else.
- Security consequence: vault.age is already public (pastes, relays), so the passphrase IS the security.
  `init` therefore GENERATES a passphrase by default (6 or more diceware words, at least 77 bits) and only accepts
  a user-chosen one if it passes a strength check. The vault name acts as the salt, so there is no global
  precomputation.
- The printed kit remains as a second path (identity + master + locators).

## Health ledger + sampling on every write
Goal: always know where every copy sits AND when it was last confirmed alive.

### Ledger (inside the encrypted index, so it is replicated like everything else)
Per note, per backend, add to the index:
```json
"health": {"<note name or _vault/_index>": {"<backend name>": {
  "last_ok": "<ISO 8601, last successful download + full decrypt/verify>",
  "last_checked": "<ISO 8601, last attempt>",
  "status": "ok | missing | corrupt | stale | diverged | error",
  "expires": "<ISO 8601 or null, from host metadata e.g. PrivateBin time_to_live>"}}}
```
- Merge rule across backends: per field, keep the entry with the newest `last_checked`; `last_ok` takes the max.
- Locators stay where they are (`locators`); ledger + locators together = "where what sits and is it alive".

### Sampling on every put
After a successful `put`, verify a small sample of OTHER existing copies (default: 3 copies or 10 seconds,
whichever comes first), picking least-recently-verified first (oldest `last_checked`), not purely random,
so over many writes every copy gets revisited. Update the ledger with the results and write the index once.
Failures print a warning and a hint (`super-secret-notes repair`), never block the put. `--no-sample` to skip.

### Status command
`super-secret-notes status`: per backend: copies, healthy, oldest `last_ok` age, retention (the kind of promise: PrivateBin "never (host-confirmed)", CryptPad "while the account is active", Nostr and Blossom "none promised; republish by <date>" where the date is our own 120-day policy, account-based hosts "while the account exists"), and warnings:
- a copy not verified in more than 30 days (`STALE CHECK`),
- a note with fewer than 2 healthy backends (`AT RISK`),
- a backend with repeated errors (`FLAKY`).
It reads the ledger only (instant, offline). `check` stays the full live verification and refreshes the ledger.

Fileverse: opt-in only, through the official `@fileverse/api` daemon with a user-obtained API key (their AUP forbids non-UI account creation).

## Format history

Additions and clarifications made after the first version of the format. Both clients follow them.

1. **Note names are Unicode NFC-normalized** before use, both as the HMAC input for `blob_id` and
   as the key in the index. Without this, "für" typed in a browser (NFC) and the same name derived
   from a macOS file name (NFD) would map to two different blobs. `test/vectors.json` has an NFD
   input that must produce the same `blob_id` as its NFC twin.

2. **Locators for backends that pick their own IDs** (PrivateBin and other paste sites). The index
   JSON gets two optional top-level fields:
   ```json
   {"v":1,"written":"<ISO 8601>","notes":{...},
    "locators":{"<backend name>":{"<path>":"<opaque locator string>"}}}
   ```
   - `<path>` is the same relative path as on path-addressed backends (`vault.age`,
     `notes/<blob_id>.ovk`). For PrivateBin the locator is the full paste URL including the
     `#<base58 key>` fragment, so the index (itself encrypted) holds those keys.
   - `index.ovk` never appears in `locators` (an index cannot point to itself). The locators of
     `vault.age` and `index.ovk` on each such backend are printed in the recovery kit. The index
     locator changes on every write, so a kit only gives the index as of when it was printed; the
     full current map normally comes from the index on any path-addressed backend.
   - `written` is set (toISOString) on every index write.
   - Merge: notes as before, but a tie on `updated` goes to the index with the newer `written`
     (missing `written` counts as oldest). A note path's locator comes from the index whose entry
     for that note won. Every other path's locator comes from the newest-`written` index that has
     one. A locator missing from the winning index is filled in from the others (union). Merged
     `written` = the newest input. Why: `repair` re-uploads a paste to a new URL without changing
     the note's `updated`, so the locators need their own recency. Vectors: `merge` in
     `overkill/cli/test/vectors.json`, which must give the same result in any input order.
   - PrivateBin paste format used by the CLI: v2, no password, compression `none`, format
     `plaintext`, content `{"paste":"<standard base64 of the OVK1 blob>"}`, expire `never`.

3. **Derived CryptPad accounts** (zero-signup default). A vault owns one account per CryptPad
   instance; nothing extra is stored because the login comes from the master:
   `b = HKDF-SHA256(ikm=master, salt=empty, info="overkill v1 cryptpad:" || lowercase host, L=32)`,
   username = `"ovk-" || hex(b[0..8])`, password = base64url of `b[8..32]` without padding (32 chars).
   Backend config: `{"type":"cryptpad","origin":"https://<host>","derived":true}`. The account is
   registered on first use, through CryptPad's own protocol (fresh drive, then a login block via
   the `/api/auth` WRITE_BLOCK command). Note for both clients: instances may set
   `AppConfig.loginSalt` in `/customize/application_config.js`, which CryptPad appends to the
   username in the scrypt salt; both default instances do. Vectors: `cryptpad_credentials`.
   Default instances (terms allow it, no captcha, no email):
   `https://cryptpad.private.coffee`, `https://crypt.unredacted.org`.

4. **New-vault passphrase and zero-config setup.** `init` (and `put` with no vault) generate 6 words
   from the EFF large wordlist (77.5 bits) and accept a user-chosen passphrase only if its
   estimate is at least 77 bits (list words 12.9 bits each, other words at most 17, single
   tokens a discounted charset estimate). The config records `"name"` (the vault name, NFC).
   The recovery kit also shows the vault name, the generated passphrase (the kit already holds
   the master) and the derived CryptPad usernames. `init --advanced` is the old guided flow.

5. **Health ledger details** (implements "Health ledger + sampling on every write"):
   - Only a real download plus full verification sets `last_ok`. An upload alone records nothing
     (a failed upload records `error`), so a fresh copy counts as unverified until sampled or checked.
   - `status` values are the check states in lowercase; `stale` = decrypts but older than the index;
     `diverged` = decrypts but is a version the index does not know (format history 16).
   - `check` writes the refreshed ledger to the backends whose index copy was readable (OK or
     STALE); missing or corrupt index copies are left for `repair` to report and fix.
   - Sampling ties (same `last_checked`, including never checked) are broken at random.
   - `FLAKY` = a backend with `error` on at least 2 copies, or on every copy it was asked about.
   - The CLI keeps the last index it saw, encrypted, as `index-cache.ovk` in its state directory, so
     `status` needs no network. Vectors: the last `merge` case in `vectors.json`.

6. **Nostr backend (experimental, relies on `refresh`).** Details and the relay probe:
   `overkill/cli/docs/NOSTR.md`.
   - Key: `K_nostr = HKDF-SHA256(ikm=master, salt=empty, info="overkill v1 nostr", L=32)`, used as
     a secp256k1 secret key. If it is 0 or not below the group order (about 2^-128), use info
     `"overkill v1 nostr 1"`, then `"overkill v1 nostr 2"`, and so on. Vector:
     `derivation.k_nostr_hex`, `nostr_pubkey_hex`, `nostr_npub` in `overkill/cli/test/vectors.json`.
   - Each path is a kind 30078 (NIP-78) addressable event with tag `["d", "<root>/<path>"]`.
     Content: NIP-44 v2 to self (conversation key from K_nostr and its own public key) of the JSON
     `{"b":"<standard base64 of the blob>"}`. Newest `created_at` wins, tie to the lowest id (NIP-01);
     writers use at least the newest seen `created_at` plus one.
   - Blobs over 30000 bytes: chunk `i` of `n` (1-based, 30000 bytes each, the last shorter) at d
     tag `<root>/<path>#<i>/<n>` with `{"b":"<base64 of the chunk>"}`; the head at `<root>/<path>` holds
     `{"n":n,"sha256":"<hex of the whole blob>","size":<bytes>}`. Chunks are published before
     the head. A missing chunk or a sha256 mismatch makes the copy corrupt. (strfry relays refuse
     events over 64 KiB, hence 30000.)
   - No locators: the path is the address. The recovery kit prints the npub. Because vault.age on
     a relay is NIP-44 encrypted too, it can only be read once the vault is unlocked: a Nostr copy
     of vault.age serves `check` and kit-based recovery, not passphrase-only bootstrap. (Chosen over
     a world-readable vault.age, which would invite offline passphrase guessing.)
   - Admission: the NIP-44 layer is applied by the client, as with PrivateBin. Retention is not
     promised, only observed, so `check` reports Nostr copies as expiring 120 days after they were
     published and `refresh` (default 90 days) republishes them when older than 30 days.

7. **Discovery key (implemented in `overkill/cli/src/bootstrap.js`).** Precise form of the
   "Recovery with vault name + passphrase only" rule: scrypt input is the passphrase as UTF-8
   exactly as typed; salt `"overkill v1 discovery:" || NFC(vault_name)`; if the result is 0 or not
   below the secp256k1 order, the salt becomes `"overkill v1 discovery 1:" || NFC(vault_name)`,
   then `"overkill v1 discovery 2:" || NFC(vault_name)`, and so on. Under that key, d tags `overkill-discovery/vault.age` and
   `overkill-discovery/bootstrap.json`, event format as in item 6 (fixed root, independent of the
   vault's root folder). Vectors: `discovery` in `overkill/cli/test/vectors.json`.
8. **Bootstrap record and when it is published** (CLI wiring of item 7). Shape:
   `{"v":1,"name","root","main_npub","backends":[...],"others":[{"name","type"}],"cryptpad":[{"instance","username"}]}`.
   `backends` holds only configs that need no login of their own: PrivateBin (url, plus the
   `vault.age` locator), derived CryptPad (origin), Nostr (url). Backends with their own logins
   (MEGA, Proton, Filen, ...) are only named in `others`. There are no index or note locators:
   once vault.age is open, the index comes from any path-addressed backend (CryptPad, Nostr) and
   carries the note locators. So the record only changes with the backend list, and it is
   published on init, on put or refresh when it changed, and at least every 30 days (relays
   promise no retention). A machine restored with `recover --name` does not know the other
   machine's PrivateBin index pastes; one `repair` gives it its own.

9. **Blossom backend (experimental).** Uploads (BUD-02 `PUT /upload`) and deletes carry a kind
   24242 authorization signed with K_nostr (item 6). Stored bytes: `"OVKB" || nonce (12 random
   bytes) || AES-256-GCM(K_blossom, nonce, blob, AAD = "overkill v1 blossom")`, with
   `K_blossom = HKDF-SHA256(ikm=master, salt=empty, info="overkill v1 blossom", L=32)` (vector
   `derivation.k_blossom_hex`). Locator-addressed like PrivateBin (item 2): the locator is the blob
   URL `<server>/<sha256 of the stored bytes>`; readers check that sha256 before decrypting.
   Details: `overkill/cli/docs/NOSTR.md`.

10. **Delete tokens in the index** (`pastes`). Optional top-level field
    `{"<backend>": {"<paste id>": {"path": "<path>", "token": "<deletetoken>", "at": "<ISO 8601>"}}}`
    listing every paste the vault owns on paste-like backends (PrivateBin), created by any machine.
    Merge: union by paste id. Any machine may delete, with the token from the index: a note or
    vault.age paste once the current locator for that path points to a newer paste, and index
    pastes beyond the newest two that are also older than 7 days (orphans from other machines,
    e.g. after `recover`). A paste that is already gone counts as deleted and leaves the list. At
    most 5 deletions per backend per index write. Because an index paste cannot list itself, the
    CLI writes the index to paste-like backends first and then writes a copy that lists those new
    pastes to the other backends. Vector: the `pastes` case in `merge`.

11. **The index lives only on path-addressed backends** (supersedes the index-paste parts of 2,
    8 and 10). Backends at server-chosen addresses (PrivateBin, Blossom) hold notes and vault.age,
    never `index.ovk`; the index goes to CryptPad, Nostr, MEGA, Proton, Filen, Fileverse and local
    folders. A config needs at least one of those (a warning below two). `check` and `status`
    expect index copies only there. Index pastes and Blossom index blobs from before are deleted
    on the next index write (their tokens are in `pastes`, or the machine's own locator file).
    `pastes` keeps the delete tokens of note and vault.age pastes, so any machine can delete a
    superseded one. A machine restored by `recover --name` is fully healthy without a repair.

12. **`index_sync`** (config field, default `"always"`): `"always"` writes the index to the
    index-holding backends on every change; `"manual"` keeps it in the machine's encrypted local
    copy (`index-cache.ovk`) until `super-secret-notes sync`; `"never"` keeps it local only (`sync` needs
    `--force`). With manual/never, put/check/status/repair work from the local copy, `check` does
    not expect remote index copies, and a machine without a local copy (just recovered) starts
    from the last synced remote index. The bootstrap record carries `index_sync`; recovery warns
    that notes written after the last sync are not listed (`get <exact name>` still finds them,
    as blob ids come from the name). `super-secret-notes index export` writes the index encrypted (OVK1,
    `blob_id` "index") or, with `--plaintext --yes-reveal-note-names`, as JSON, which shows note
    names and the PrivateBin/Blossom locators including their keys.

13. **Recovery from the printed kit** (`recover --kit <file>`, or `-` for stdin). Reads the age
    identity, master, vault name, root folder, `index_sync`, the backend lines, the derived
    CryptPad account lines and the vault.age locators of paste backends. Backends that need no
    login of their own come back (PrivateBin, Blossom, Nostr, derived CryptPad, local folders);
    the others are named. vault.age is rebuilt under a new, strength-checked passphrase; the old
    copies on the backends differ from it until `repair` replaces them.

14. **`secrets.ovk`: stored credentials and sessions are encrypted.** A local blob in the blob
    format (`blob_id` "secrets"), JSON `{"v":1,"creds":{"<backend>":{"<field>":"..."}},
    "sessions":{"<name>.<type>":{...}}}`. Credential fields (`email`, `password`, `user`, `apiKey`,
    `api_key`, `token`, `privateKey`, `mnemonic`, `secret`) are stored there and config.json
    holds `{"stored": true}` in their place; `env` and `envFile` references remain the explicit
    opt-out. MEGA and Filen sessions (they contain account keys) live there too. Migration on
    the first unlocked run: plaintext config fields move in and the config is rewritten; files in
    `sessions/` move in and are overwritten with a stub (the CLI deletes nothing). Login backends
    whose credentials are all stored travel in the bootstrap record, together with the encrypted
    secrets.ovk (field `secrets`, standard base64), so `recover --name` restores them.
    The locators of paste-like backends (PrivateBin URLs with their `#key`, delete tokens, Blossom
    URLs) are stored there too, under `"locators": {"<backend>": {"paths": {...}, "pastes": {...}}}`;
    old `locators/<backend>.json` and `.pastes.json` files are migrated and stubbed the same way,
    and locators that arrive with a kit or a bootstrap record go straight into the store.
    Audit of the other files under OVERKILL_HOME: `vault.age`, `index-cache.ovk` and
    `secrets.ovk` are encrypted; `staging/` holds only our ciphertext; `bootstrap-published.json`
    and `index-sync.json` hold hashes and times; the Fileverse account progress and file maps
    under `locators/` hold public addresses, transaction hashes and file ids. Outside it: the
    Proton CLI keeps its session in the OS keychain, and rclone keeps tokens in its own config.

15. **Fileverse account from the master** (`crypto.deriveFileverseSecrets`, opt-in backend with
    `"derived": true`). Everything is re-derived on every run, from the master alone:
    - `wallet` = HKDF-SHA256(master, info `"overkill v1 fileverse"`, 32 bytes): the EVM key that
      signs the Privy SIWE login. `ownerAgent` = HKDF(master, `"overkill v1 fileverse owner agent"`):
      owner key of the Safe that owns the Developer Space portal. Both are secp256k1 scalars; if
      one is 0 or not below the group order, the info gets `" 1"`, then `" 2"`, ... appended
      (the K_nostr rule).
    - `ownerUcan` = HKDF(master, `"overkill v1 fileverse owner ucan"`, 32): ed25519 seed of the
      portal owner DID. `portalSeed` = HKDF(master, `"overkill v1 fileverse portal seed"`, 48): the
      portal's EC key seed. `apiKeySeed` = HKDF(master, `"overkill v1 fileverse api key"`, 24).
    - `api_key` = unpadded base64url of `apiKeySeed` (32 characters, the format the official app
      generates); `api_key_id` = `0x` || hex sha256(apiKeySeed). The collaborator key and DID are
      HKDF-SHA256(apiKeySeed, salt 0x00, info `COLLABORATOR_PRIVATE_KEY` / `COLLABORATOR_UCAN_SECRET`),
      as in `@fileverse/api`.
    - Stored, all public: the account setup progress under `locators/<backend>.fileverse-account.json`
      (wallet, portal and owner addresses, transaction hashes, timestamps; it only lets an
      interrupted setup resume), and the title-to-file-id and path maps (a cache; rebuilt from
      the chain if lost). No key or API key is written anywhere.
    Vectors: `fileverse` in `overkill/cli/test/vectors.json` (from `derivation.master_hex`).

16. **Blob hashes in note entries** (optional, both clients write them from this version on):
    ```json
    "notes": {"<name>": {"id": "...", "sha256": "...", "size": 1, "updated": "...",
      "blob_sha256": "<hex sha256 of the uploaded OVK1 blob>",
      "superseded": ["<blob_sha256 of versions this one replaced, newest first>"]}}
    ```
    - `blob_sha256` is over the encrypted blob as uploaded (the fresh nonces make every put
      unique, so a later put of the same text is still a different version). `superseded` is the
      previous entry's `blob_sha256` followed by its `superseded`, without duplicates or the
      current hash, at most 16; omitted when empty.
    - A copy whose plaintext sha256 differs from `sha256` is STALE only if its blob hash is in
      `superseded`; otherwise it is DIVERGED and nothing overwrites it (see "Failure handling").
      Entries without these fields (older clients) make every differing copy DIVERGED.
    - Merge is unchanged: the winning entry is taken whole, fields included. After two devices
      wrote different versions concurrently, the losing version's copies are DIVERGED, not STALE.

Clarifications (no format change):

- `age_identity` must be generated as X25519 explicitly (`generateX25519Identity()` in
  `age-encryption`). Its `generateIdentity()` is documented as possibly switching to a
  post-quantum hybrid identity (`AGE-SECRET-KEY-PQ-1...`) in a future release.
- `vault.age` uses scrypt work factor 18 (the age default) when created. Readers accept any work
  factor the age library accepts.
- `init` writes an empty index (`{"v":1,"notes":{}}`) to every backend, so a fresh vault checks as healthy.
- On Proton Drive the root folder is `/my-files/<root>` (the Drive root is `/my-files`).
- Replacing a file must not leave duplicates (MEGA allows several nodes with one name): the CLI
  uploads the new node, then moves older same-name nodes to the rubbish bin. Readers that do find
  duplicates should take the newest.
- vault.age is binary age; readers also accept armored. `master` is standard padded base64 (44 chars).
  `updated` is written with `toISOString()` and compared with `Date.parse`. `size` is the plaintext
  byte length.
- `check` reports `STALE` for a note copy that decrypts fine, does not match the merged index, and
  is one the index recorded as replaced (format history 16), and for an index copy that lacks
  entries or has older ones. A differing note copy the index does not know is `DIVERGED`.
