# Nostr backend (experimental, relies on `super-secret-notes refresh`)

Nostr relays are public servers that store signed JSON events. Anyone can write; nobody
promises to keep anything. That makes them a fun extra copy and a poor only copy.

## How Overkill stores a blob

- **Key.** `K_nostr = HKDF-SHA256(master, salt empty, info "overkill v1 nostr", 32 bytes)` is a
  secp256k1 secret key. If it is 0 or not below the group order (probability about 2^-128) the
  info becomes `"overkill v1 nostr 1"`, then `"overkill v1 nostr 2"`, and so on. No extra secret:
  whoever has the vault (vault.age plus passphrase, or the recovery kit) has the Nostr identity.
  Known answer: `derivation.k_nostr_hex`, `nostr_pubkey_hex` and `nostr_npub` in
  `test/vectors.json`.
- **Events.** Each path (`vault.age`, `index.ovk`, `notes/<blob_id>.ovk`) is one NIP-78 event:
  kind 30078, addressable, tag `["d", "<root>/<path>"]`, so a newer event replaces the older one.
  `created_at` always moves forward (at least the newest one seen, plus one second).
- **Third layer.** The content is NIP-44 v2 encryption to ourselves (conversation key from our
  own secret and public key: ECDH, HKDF, ChaCha20, HMAC-SHA256) of the JSON `{"b": "<base64 of
  the OVK1 blob>"}`. Like PrivateBin's AES layer, it is applied by the client, not the host.
- **Chunks.** Blobs over 30000 bytes are split: chunk `i` of `n` goes to d tag
  `<root>/<path>#<i>/<n>` as `{"b": "<base64 of the chunk>"}`, then the head event at `<root>/<path>` holds
  `{"n": n, "sha256": "<hex of the whole blob>", "size": bytes}`. Chunks are sent first, the
  head last. On read, a missing chunk, a chunk that fails NIP-44, or a sha256 mismatch makes
  the copy `CORRUPT`. Leftover chunks from an older, longer version are ignored.
- **Why 30000.** strfry, the software most big relays run, refuses events over 64 KiB
  (`invalid: event too large: 87857`) even where NIP-11 advertises `max_message_length:
  131072`. A 30000-byte chunk becomes 40000 base64 characters, NIP-44 pads that to 40960, and
  the event is 55099 bytes on the wire. A 200 KB blob is 7 chunks plus a head.
- **Reading needs the key.** Before the vault is unlocked the backend adapter reads nothing: its
  copy of `vault.age` is under the master-derived key, so it serves `check` and kit-based
  recovery. Passphrase-only recovery goes through the discovery key below. The kit prints the
  main npub, so the events can be found and inspected with any Nostr client.
- **Signatures and authors are checked** on every event read. A relay can withhold events or
  serve an older version (that shows up as `MISSING` or `STALE`), but it cannot forge one.
- **What relays see.** The npub, event sizes and times, and d tags such as
  `overkill/notes/<64 hex>.ovk`. Unlike the other backends, this metadata is public to everyone,
  not just to one provider.

## Discovery key and bootstrap record (`src/bootstrap.js`)

For recovery with only the vault name and the passphrase (docs/OVERKILL.md, "Defaults:
zero-signup first"):

- `discovery = scrypt(passphrase as UTF-8, salt "overkill v1 discovery:" || NFC(vault name),
  N=2^18, r=8, p=1, 32 bytes)`, used as a second Nostr secret key (about 0.8 s in Node). Same
  invalid-scalar rule: retry with salt `"overkill v1 discovery 1:" || name`, and so on. Vectors:
  `discovery.cases` in `test/vectors.json` (secret hex, nsec, pubkey hex, npub; one NFD name),
  cross-checked against `node:crypto` scrypt.
- Under it, on every discovery relay: the vault.age bytes and the bootstrap record, same event
  format as above (kind 30078, NIP-44 to self, chunked if large), under per-vault d tags
  `hex(HKDF-SHA256(discovery, info "overkill v1 discovery tag:vault.age"))` and the same with
  `bootstrap.json` (`crypto.deriveDiscoveryTags`, docs/OVERKILL.md format history 17). A relay
  sees two opaque events by an unlinked npub. Records from before that sit at the shared tags
  `overkill-discovery/vault.age` and `overkill-discovery/bootstrap.json`; `fetchBootstrap` falls
  back to them and republishes under the new tags (`legacy: true` in its result).
- A third event, under `tag("index.ovk")`, holds a copy of the encrypted index (format history
  18), kept current by `indexMirror` (the store's `indexMirror` option); `fetchBootstrap` returns
  the copies it found as `indexBlobs`, and recovery seeds the index cache with them.
- `auditBootstrap(secret, relays)` says when each relay last got the record (null: none);
  `refresh` republishes when a relay that answered lacks it or holds one older than 30 days.
- `publishBootstrap(passphrase, vaultName, vaultAgeBytes, bootstrapJson, { relays, secret })`
  publishes both to every relay (in parallel, one relay failing is fine, all failing throws)
  and returns `[{ relay, ok, error }]`. `fetchBootstrap(passphrase, vaultName, { relays, secret })`
  asks every relay and returns `{ vaultAge, bootstrap, from, npub }` from the newest record.
  `discoveryIdentity(passphrase, vaultName)` returns `{ secret, pubkey, npub }`; pass `secret`
  to the other two to skip the second scrypt.
- Suggested bootstrap shape (the caller owns it; any JSON works):
  `{"v":1,"main_npub":"<main npub>","locators":{"<backend>":{"index.ovk":"<paste URL>"}},
  "cryptpad":[{"instance":"<instance URL>","username":"<username>"}]}`.
- Security: anyone who guesses name + passphrase gets vault.age and can then try it, which
  is why `init` generates a strong passphrase. The name is the salt, so there is no global
  precomputation.

## Retention and refresh

Relays promise no retention (none of the probed ones publishes a NIP-11 `retention` field).
So the backend assumes a copy may vanish: `check` reports each Nostr copy as expiring
120 days after it was published (config `assumeRetentionDays`), and `super-secret-notes refresh`
(default `--days 90`) republishes every Nostr copy older than 30 days. Run it from cron.
`repair` fixes copies that are already gone.

"Republish by <date>" (in `check`, in the Retention column of `status`, and in the web app) is
**our policy, not the relay's promise**: the date is 120 days after the copy was published, the
point by which we treat it as possibly gone. Blossom copies are handled the same way (see below).

Politeness: one WebSocket per relay per command, publishes at least 3 s apart, one retry after
30 s on `rate-limited:`. relay.damus.io banned our IP for a while after chunk events sent 1 s
apart (`banned: too many rate-limit violations`), which is why.

## Relay probe (2026-09-29)

`node scripts/probe-nostr-relays.js` per relay: NIP-11, a retention probe (`REQ` with
`until` = now minus 400 days, then minus 1000 days, limit 5, kinds 1 and 30078; relays answer
newest first, so a hit means data that old is still served), and one write of a 55099-byte
event (30000 random bytes, NIP-44 under a throwaway key) plus read-back. The first run used
87867-byte events; where a big write failed, a 4583-byte event was tried.

Retention is **empirical, not promised**. `created_at` is set by the author, so an old
timestamp is evidence, not proof, and a relay that serves old data today can wipe tomorrow.

| Relay | Software, NIP-11 max msg | Write 55 KB / 88 KB | Read-back | Events served older than 400 d (kind 1; 30078) | Older than 1000 d (kind 1; 30078) | supported_nips (NIP-11) | AUTH (NIP-42) for kind 30078 | Verdict |
|---|---|---|---|---|---|---|---|---|
| wss://relay.damus.io | strfry, 1000000 | OK / OK | OK | yes, to 2025-08-25; yes, 2025-05-19 to 2025-08-08 | yes, 2023-12-14 to 2023-12-25; none | 1 2 4 9 11 28 40 45 59 70 | no: wrote and read back without AUTH | OK for reads; not a default: banned our IP from writing after about 6 quick events (still banned 23 minutes later) |
| wss://nos.lol | strfry, 131072 | OK / too large | OK | yes, 2024-08-05 to 2025-05-31; yes, 2025-05-14 to 2025-08-03 | none; none | 1 2 4 9 11 28 40 45 70 | no: wrote and read back without AUTH | OK, default |
| wss://relay.primal.net | strfry, 1000000 | not reached | not reached | queries timed out (20 s) | timed out | 1 2 4 9 11 22 28 40 70 77 | unknown (queries timed out) | Rejected: queries time out, second run could not connect; earlier research saw no read-back |
| wss://nostr.mom | strfry, 131072 | OK / too large | OK | yes, to 2025-08-25; yes, to 2025-08-25 | yes, 2024-01-03; yes, 2023-12-31 to 2024-01-03 | 1 2 4 9 11 28 40 45 70 | no: wrote and read back without AUTH | OK, default |
| wss://purplerelay.com | strfry, 131072 | OK / too large | OK | yes, to 2025-08-25; yes, 2025-08-07 to 2025-08-20 | yes, 2024-01-03; yes, 2023-09-19 to 2023-11-30 | 1 2 4 9 11 22 28 40 45 70 77 | no: wrote and read back without AUTH | OK, default |
| wss://offchain.pub | strfry, 131072 | refused (web of trust) / too large | small event OK in run 1 | yes; yes | yes; yes, 2023-11-07 to 2023-11-29 | 1 2 4 9 11 28 40 45 70 77 | no AUTH asked; writes gated by web of trust | Rejected: "pubkey is not in our web of trust" |
| wss://nostr.bitcoiner.social | strfry, 131072 | refused (web of trust) / too large | small event only | yes; yes | yes; yes, 2023-10-16 to 2023-11-29 | 1 2 4 9 11 28 40 45 70 77 | no AUTH asked; big writes gated by web of trust | Rejected: big events need web of trust |
| wss://relay.snort.social | memlay (in memory), 524288 | OK / OK | OK | none; none | none; none | 1 9 11 | no: wrote and read back without AUTH | Rejected: in-memory relay, no old data |
| wss://nostr.oxtr.dev | strfry, 131072 | OK / OK | OK | yes, to 2025-08-25; yes, to 2025-08-25 | yes, 2024-01-03; yes, 2023-10-01 to 2023-11-01 | 1 2 4 9 11 22 28 40 70 77 | no: wrote and read back without AUTH | OK, default |
| wss://relay.nostrcheck.me | nostrcheck-server, 140000 (content 8196) | refused (content too large) / refused | small event written but NOT read back | none; none | none; none | 1 2 3 4 5 7 9 11 13 14 19 28 40 42 44 45 47 48 50 56 62 65 70 73 78 94 96 98 | no for writes; read-back failed without AUTH (NIP-11 says auth_required false) | Rejected |
| wss://relay.wellorder.net | nostr-rs-relay, no limit given | OK / OK | OK | none; none | none; none | 1 2 9 11 12 15 16 20 22 33 40 | no: wrote and read back without AUTH | Rejected: no evidence of 1-year retention |

"Too large" is strfry's `invalid: event too large: 87857`. The many relays whose newest event
before now minus 1000 days is 2024-01-03 probably share one imported backfill.

**Defaults** (`init` offers the first four, `src/backends/nostr.js`): nos.lol, nostr.mom,
purplerelay.com, nostr.oxtr.dev. relay.damus.io is verified but last and not a default, because
of its write bans. Each relay counts as its own
operator (one backend entry per relay).

Only relay.nostrcheck.me lists NIP-78 in `supported_nips`, and no relay needs to: kind 30078 is an
ordinary addressable event (NIP-01 range 30000 to 39999), which every relay above that accepted
writes stored and replaced correctly.

## Why NIP-78, and what we borrowed

- "Note to self" in Coracle and Nostrudel uses DMs (NIP-17 gift wraps, kind 1059, or old NIP-04
  kind 4). Not for storage: a gift wrap cannot be replaced, and many relays demand NIP-42 AUTH to
  read kind 1059. Addressable events can be replaced in place and read without AUTH.
- Manent (https://manent.app, source https://github.com/dtonon/manent) is the closest existing
  app: notes as addressable events encrypted with NIP-44 to self. Its layout, read on 2026-09-29
  in `lib/notes/note_cache.dart`: its own kinds 33301 (text) and 33302 (file) rather than 30078,
  `["d", <random local id>]` as the only tag, content inline only while the encrypted payload is
  under 32 KiB (`encryptedBytes.length < 32 * 1024`), bigger files on Blossom servers, and
  deletion as a kind 5 event with `e` and `a` tags. Borrowed: the single-`d`-tag layout (no
  plaintext metadata tags) and its size instinct, which our 64 KiB strfry measurement confirms;
  we chunk instead of adding Blossom so every copy stays on the relay. Not borrowed yet: kind 5
  deletion of leftover chunks (costs an extra event per shrink; the head already ignores them).
- Generic viewers: our events are plain kind 30078 with a `d` tag, so any NIP-78 viewer lists
  them; showing the plaintext needs the key, by design.

## Relay discovery at scale (2026-09-29)

Candidates: NIP-66 relay monitor events (kind 30166 from wss://relay.nostr.watch,
wss://monitorlizard.nostr1.com and wss://relaypag.es; api.nostr.watch answered 502 and "Payment
Required") gave 1092 relays; 983 had no auth, payment or restricted-writes requirement. We kept
those seen by at least 4 monitors, dropped personal inboxes (haven, `/inbox`), community relays
(nostr1.com) and search endpoints, and added about 70 well-known relays: 321 candidates.

1. Read-only scan of all 321 (NIP-11, then kind 1 with `until` now minus 400 and minus 1000
   days): 179 served data older than 400 days, 154 older than 1000 days.
2. Write probe (one 55099-byte kind 30078 event, then read-back) on 36 of those, picked for size
   and reputation, one at a time: 19 wrote and read back. The other 17 refused: whitelists or
   members only (relay.nostr.hu, nostr.lopp.social, relay.nostromo.social, nostr.kosmos.org,
   relay.noderunners.network, relay.cxplay.org, relay.jeffg.fyi, relay.nostrarabia.com), NIP-05
   required (nostr.einundzwanzig.space, relay.nostrplebs.com), kind 30078 not accepted
   (relay.nos.social, relay.deepmarks.org), refused: country block (yabu.me),
   paid time ran out (us.azzamo.net), AUTH needed to query (relay.ditto.pub), kinds not supported
   (relay.fountain.fm), message too long (relay.44billion.net).
3. Re-read of every written probe event by id minutes later (all still there) and again
   1.5 to 2.3 hours after writing (column "Kept 90 min": every relay still had it), plus a query for kind 30078 events older than 400 days.

All relays that wrote and read back (the first probe's included):

| Relay | Software | NIP-11 max msg | 55 KB write + read-back | Newest kind 1 before now minus 400 d | Before now minus 1000 d | Newest kind 30078 before now minus 400 d | Kept 90 min | Verdict |
|---|---|---|---|---|---|---|---|---|
| wss://relay.damus.io | strfry | 1000000 | OK | 2025-08-25 | 2023-12-25 | 2025-08-08 | yes | OK, but write bans |
| wss://nos.lol | strfry | 131072 | OK | 2025-05-31 | none | 2025-08-03 | yes | **best 10** |
| wss://nostr.mom | strfry | 131072 | OK | 2025-08-25 | 2024-01-03 | 2025-08-25 | yes | **best 10** |
| wss://purplerelay.com | strfry | 131072 | OK | 2025-08-25 | 2024-01-03 | 2025-08-20 | yes | **best 10** |
| wss://nostr.oxtr.dev | strfry | 131072 | OK | 2025-08-25 | 2024-01-03 | 2025-08-25 | yes | **best 10** |
| wss://nostr.data.haus | strfry | 131072 | OK | 2025-08-25 | 2024-01-03 | 2025-08-25 | yes | **best 10** |
| wss://relay.nostr.wirednet.jp | strfry | 131072 | OK | 2025-08-25 | 2024-01-03 | 2025-08-25 | yes | **best 10** |
| wss://nostr.stakey.net | strfry | 131072 | OK | 2025-08-25 | 2024-01-02 | 2025-08-19 | yes | OK |
| wss://nostr-01.yakihonne.com | strfry | not given | OK | 2025-08-25 | 2024-01-03 | 2025-08-25 | yes | **best 10** |
| wss://relay.illuminodes.com | nostr-rs-relay | not given | OK | 2025-08-25 | 2024-01-03 | 2025-08-25 | yes | **best 10** |
| wss://relay.coinos.io | strfry | 524288 | OK | 2025-08-23 | 2023-12-24 | 2025-08-19 | yes | OK |
| wss://relay.nostrhub.fr | strfry | 131072 | OK | 2025-08-25 | 2024-01-02 | 2025-08-10 | yes | OK |
| wss://nostr.girino.org | khatru | not given | OK | 2025-08-25 | 2023-12-30 | 2023-09-30 | yes | OK |
| wss://nostr.computingcache.com | strfry | 262144 | OK | 2025-08-25 | 2024-01-01 | 2025-07-28 | yes | OK |
| wss://relay.nostr.com | strfry | 131072 | OK | 2025-08-25 | 2023-12-31 | 2025-08-05 | yes | OK |
| wss://relay01.lnfi.network | nostream | 524288 | OK | 2025-08-24 | 2023-12-18 | none | yes | OK, but no kind 30078 older than 400 d |
| wss://relay.lacrypta.ar | strfry | 131072 | OK | 2025-08-25 | 2023-12-31 | 2025-07-11 | yes | OK |
| wss://relay.wavlake.com | strfry | 131072 | OK | 2025-08-25 | 2024-01-03 | 2025-08-20 | yes | OK |
| wss://schnorr.me | strfry | 1310720 | OK | 2025-08-25 | 2024-01-03 | 2025-08-25 | yes | **best 10** |
| wss://relay.angor.io | strfry | 131072 | OK | 2025-08-25 | 2024-01-02 | 2025-07-28 | yes | OK |
| wss://relay.plebeian.market | relay | not given | OK | 2025-08-25 | 2024-01-03 | 2025-08-08 | yes | OK |
| wss://nostr-01.uid.ovh | nostr-relay | 512000 | OK | 2025-08-25 | 2024-01-03 | 2025-08-10 | yes | OK |
| wss://strfry.bonsai.com | strfry | 131072 | OK | 2025-08-25 | 2024-01-03 | 2025-08-25 | yes | **best 10** |
| wss://nostr.robosats.org | strfry | 131072 | OK | 2025-08-25 | 2023-12-31 | 2025-08-23 | yes | OK |

**Best 10 long-retention free relays** (write and read-back OK, kind 1 older than 1000 days and
kind 30078 older than 400 days served, different operators): nos.lol, nostr.mom,
purplerelay.com, nostr.oxtr.dev (the four `init` defaults), nostr.data.haus,
relay.nostr.wirednet.jp, nostr-01.yakihonne.com, relay.illuminodes.com, strfry.bonsai.com,
schnorr.me. nos.lol stays a default despite no kind 1 older than 1000 days because it serves
kind 30078 older than 400 days, which is what we store. relay.coinos.io, nostr.robosats.org,
relay.wavlake.com and nostr.stakey.net are equally good spares. All in `RELAYS` in
`src/backends/nostr.js`.

The same caveat as above: `created_at` is chosen by authors, many relays seem to share an
imported backfill ending 2024-01-03, and serving old data today is no promise for tomorrow.

## Live runs (2026-09-29)

Blossom, throwaway vault, root `overkill-dev-blossom`, a local folder plus nostr.download,
blossom.ditto.pub and cdn.hzrd149.com (a 150 KB note included):

```
$ super-secret-notes check
vault.age  usb OK, blossom-download OK, blossom-ditto OK, blossom-hzrd149 OK (4/4 healthy)
index      usb OK, blossom-download OK, blossom-ditto OK, blossom-hzrd149 OK (4/4 healthy)
big        usb OK, blossom-download OK, blossom-ditto OK, blossom-hzrd149 OK (4/4 healthy)
groceries  usb OK, blossom-download OK, blossom-ditto OK, blossom-hzrd149 OK (4/4 healthy)
16/16 copies healthy. Gloriously redundant.
$ super-secret-notes chaos blossom-ditto groceries
$ super-secret-notes check
groceries  usb OK, blossom-download OK, blossom-ditto CORRUPT (aes layer), blossom-hzrd149 OK (3/4 healthy)
15/16 copies healthy. Run `super-secret-notes repair`.
$ super-secret-notes repair
repaired groceries on blossom-ditto
repaired index (refreshed with new paste locators) on usb
repaired index (refreshed with new paste locators) on blossom-download
repaired index (refreshed with new paste locators) on blossom-ditto
repaired index (refreshed with new paste locators) on blossom-hzrd149
$ super-secret-notes check
16/16 copies healthy. Gloriously redundant.
```

Nostr relays, root `overkill-dev-nostr`, a local folder plus relay.damus.io, nos.lol and
nostr.mom: `chaos nostr-nos groceries` gave `nostr-nos CORRUPT (aes layer)`, `repair` gave
`repaired groceries on nostr-nos`, and the chunked 40 KB note was healthy on nos.lol and
nostr.mom. relay.damus.io banned the IP mid-run (see "Retention and refresh"), so its copies
stayed MISSING or STALE. Bootstrap: `publishBootstrap` and `fetchBootstrap` worked on all four
default relays, and the vault.age that came back was byte-identical.

## Blossom blob servers (`src/backends/blossom.js`, experimental)

Blossom (BUD-01 get, BUD-02 upload and delete, BUD-04 mirror, BUD-06 upload preflight) stores
blobs by sha256 over plain HTTP, with uploads authorized by a kind 24242 event. The backend:

- signs uploads and deletes with the vault's Nostr key (`K_nostr`, no account, no extra secret);
- adds a third layer: `"OVKB" || nonce(12) || AES-256-GCM(K_blossom, nonce, blob, AAD
  "overkill v1 blossom")`, `K_blossom = HKDF(master, "overkill v1 blossom")`
  (`derivation.k_blossom_hex` in `test/vectors.json`), so the server never holds bytes that also
  exist elsewhere and passes the "host-side layer" half of the admission rule the way PrivateBin does;
- is locator-addressed like PrivateBin: a new version has a new sha256, so path to blob URL
  travels in the encrypted index, and the `vault.age` and `index.ovk` URLs are printed in the kit;
- verifies the sha256 of what the server returns before decrypting, deletes the replaced blob
  after an upload, and needs no chunking (servers take megabytes).
- BUD-04 mirroring is not used: every server gets its own nonce, so the blobs differ per server.

Probe (`node scripts/probe-blossom.js`, 2026-09-29): BUD-06 preflight for 50 KB and 100 MB, one
upload of 50000 random bytes as `application/octet-stream` under a throwaway key, read-back,
CORS, then a delete. "Old blobs" is empirical retention: blob URLs for that server found in kind 1
notes older than 120, 250 and 400 days (authors from kind 10063 server lists), checked with HEAD
today. Samples are small; treat them as hints.

| Server | Users (kind 10063 lists) | Upload octet-stream | Read-back | Delete | Size limit | CORS | Old blobs still served | Verdict |
|---|---|---|---|---|---|---|---|---|
| https://nostr.download | 274 | OK (201) | OK | OK (204) | 100 MB preflight passes; NIP-96 says 10 GB free | `*` | 4 of 4 from 2025-08-24 (400 d) served; 4 of 4 from 2026-01-22 gone (404) | **default** (route96, "Free File Hosting") |
| https://blossom.ditto.pub | 67 | OK (201) | OK | OK (204) | 2 GB (landing page) | `*` | none found | **default** (1147808 blobs, 614 GB) |
| https://cdn.hzrd149.com | 62 | OK (201) | OK | OK (204) | 2 GB | `*` | none found | **default** (run by the Blossom author) |
| https://blossom.yakihonne.com | 250 | OK (201) | OK | OK (204) | 200 MB | `*` | 1 URL from 2026-06-01, gone (404) | OK, listed |
| https://files.sovbit.host | 62 | OK (200) | OK | OK (200) | 10 MB free (NIP-96) | `*` | none found | OK, listed |
| https://blossom.nmail.li | 89 | OK (201) | OK | OK (204) | not given | `*` | none found | OK, listed |
| https://blossom.jumble.social | 57 | OK (200) | OK | OK (200) | 20 MB; 10 uploads per min, 30 per hour per IP | `*` | none found | OK, listed |
| https://blossom.primal.net | 712 | refused (415) | | | | preflight `*` | 8 of 8 served, back to 2025-08-23 | media only |
| https://blossom.band | 321 | refused (415 "File type not allowed", paid options at nostr.build) | | | | preflight `*` | none found | media only |
| https://blossom.nostr.build | 29 | refused (415, same) | | | | | | media only |
| https://24242.io | 220 | refused (400 unsupported content type) | | | | | | media only |
| https://nostr.media | 101 | refused (400, same) | | | | | | media only |
| https://cdn.nostrcheck.me | 174 | refused (400 file type not allowed) | | | | | | media only |
| https://blossom.azzamo.media | 130 | refused (415 MIME type not supported) | | | | | | media only |
| https://cdn.satellite.earth | 152 | refused (401 blossom.upload required) | | | | | one from 2026-01-22 gone (404), ones from 2026-05 served | paid account |
| https://nostrmedia.com | 143 | refused (403) | | | | | | account |
| https://blossom.f7z.io, https://blossom.oxtr.dev, https://blossom.nostr.hu | small | refused (401, pubkey not authorized or not on whitelist) | | | | | | whitelist |
| https://blossom.einundzwanzig.space | 21 | refused (403 members only) | | | | | | members |
| https://blossom.data.haus | 27 | refused (400) | | | | | | refused |
| https://milo.nostria.app | 50 | HTTP 530 | | | | | | down |
| https://cdn.sovbit.host, https://files.v0l.io | | DNS name not found | | | | | | gone |

We did not upload random bytes as `image/png` to get past the media-only servers: that would
misrepresent the content to people who offer free media hosting.

Retention: no server publishes a retention policy (none of the landing pages or NIP-96 documents
we read states one; NIP-96 `file_expiration` is `[0,0]`, meaning none declared). So Blossom is
experimental too and relies on `check` and `repair`. Like Nostr copies, a Blossom blob counts as
expiring 120 days after this machine uploaded it (`ASSUMED_RETENTION_DAYS` in
`src/backends/blossom.js`, config `assumeRetentionDays`), so `refresh` republishes it once it is
30 days old; "republish by" is again our policy, not the server's promise. A blob whose locator
came from another machine has no known upload time until this machine uploads it itself.
Live round trip below (section "Live runs").

Why Blossom may beat relays for blobs: no 64 KiB cap, so no chunking; content addressing lets
the client verify the bytes before decrypting; uploads are plain HTTP PUTs. Why it does not
replace them: blob URLs change on every write, so it needs locators, and the free servers that
take arbitrary bytes are few and small.

## NIP-96 HTTP file servers

NIP-96 (now marked as superseded by Blossom) servers publish `/.well-known/nostr/nip96.json`.
Every one we found restricts content types to media, except route96:

| Server | Free plan | Content types | Test |
|---|---|---|---|
| https://nostr.download (`/n96`) | 10 GB max per file, no expiration declared | image, video, audio (declared) | 20000 random bytes as octet-stream: upload 200, read back identical, delete 200. Same server and operator as the Blossom one |
| https://nostr.build | 20 MB, expiration `[0,0]` | image, video, audio | not tried (declared media only) |
| https://nostrcheck.me (api cdn.nostrcheck.me) | 100 MB | named image and video types | upload refused: "file type not detected or not allowed, mime: application/octet-stream" |
| https://nostpic.com | 16 MB | named image and video types | not tried |
| https://share.yabu.me | 100 MB | named image types | not tried |
| https://nostrmedia.com | 25 MB | file extensions for media | not tried |
| https://files.sovbit.host | 10 MB | image, video, audio, pdf | not tried (its Blossom endpoint took octet-stream) |
| void.cat, nostrage.com, nostr.media, media.nostr.band | no NIP-96 document (or error) | | |

Verdict: no NIP-96 backend. The only one that takes arbitrary bytes is also a Blossom server,
and Blossom is the better protocol for this (sha256 addressing, BUD-02 delete).

## Paid relays (prices from NIP-11 `fees`, 2026-09-29; nothing was paid)

| Relay | Price | Notes |
|---|---|---|
| wss://nostr21.com | 21 sats one-time admission (21000 msats) | cheapest; served data older than 1000 days |
| wss://relay.orangepill.dev | 3000 sats per 30 days | subscription |
| wss://filter.nostr.wine | 10000 sats per 30 days | subscription |
| wss://nostr.wine | 18888 sats one-time admission | the site says the same |
| wss://nostrelites.org | 50000 sats per 30 days | web of trust relay |
| wss://nostr.land, wss://eden.nostr.land, wss://atlas.nostr.land, wss://puravida.nostr.land | payment required, no fee in NIP-11 | pricing only at https://nostr.land |
| wss://relay.azzamo.net, wss://us.azzamo.net | time-based credit ("You ran out of time! Please top-up") | https://azzamo.net/pay |

A one-time admission (nostr21.com at 21 sats) would buy a relay that at least has a paying
customer relationship. Paid relays still promise no retention in NIP-11.

## Other Nostr-native storage ideas

- NIP-65 outbox relays: a person's kind 10002 list names the relays they write to. Publishing the
  Overkill events to the vault owner's own outbox relays (if they have a Nostr identity) would put copies
  where their clients already look, and their relays are more likely to keep their data. Needs the
  owner's own key or a NIP-46 signer; out of scope for a derived key.
- Encrypted storage via DVMs (NIP-90 data vending machines): a paid job could pin a blob, but no
  storage DVM with a retention promise was found; interesting only if one appears.
- NIP-17 gift wraps or NIP-04 DMs to self: rejected (see "Why NIP-78").
- Blossom BUD-04 mirror plus kind 10063 server lists: a future option to let other Blossom servers
  mirror our blobs by sha256, if we ever use one deterministic encryption per blob.

## Admission rule

Layer: NIP-44 to self, applied by the client like PrivateBin's AES, so the encryption part
holds. Retention: not promised, only observed (table above), so Nostr is **experimental** and
counts on `refresh`. Keep at least one backend that passes the rule without help.
