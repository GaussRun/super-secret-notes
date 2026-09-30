# Host discovery (`super-secret-notes hosts`)

The zero-signup backends live on volunteer hosts: PrivateBin instances, CryptPad instances,
Nostr relays and Blossom servers. Roughly 60% of the PrivateBin instances listed in 2021 are
gone today, so the CLI can find new ones on its own, from public directories.

No web search at runtime. `refresh` reads only the directory URLs hardcoded in
`src/hosts/directories.js` (each with the date it was last checked), or one URL given with
`--directory`. When a directory goes stale, point `refresh` at the new page and send a PR that
updates that file. When every directory is dead, `refresh` probes the built-in known-good lists
instead (the verified lists in the backend modules).

## Commands

```sh
super-secret-notes hosts refresh [--type privatebin|cryptpad|nostr|blossom] [--directory <url>] [--cap 10] [--max-age 24]
super-secret-notes hosts list [--type ...] [--all]
super-secret-notes hosts add <type> <url> [--no-probe]
super-secret-notes repair [--no-swap]
super-secret-notes hosts remove <type> <url>
```

- `refresh` reads the directories of each type in order, and reads the next one only while
  the candidates so far do not fill the cap. Hosts probed in the last `--max-age` hours are
  skipped. Probes run one at a time (one host after another, a pause in between), at most
  `--cap` per type and run. Results go to `hosts.json` after every probe.
- `list` shows the built-in hosts first, then everything found: status (`ok`, `failed`,
  `unprobed`, `removed`), last probe, the directory that listed it, the reason for a failure,
  what we know about a host's terms (an `info:` line), and which hosts a new vault would use.
- `add` records a host by hand and probes it (unless `--no-probe`).
- `remove` hides a host from `init` (built-in ones too); `add` brings it back.

State: `$OVERKILL_HOME/hosts.json` (default `~/.overkill-notes/hosts.json`), mode 0600. Nothing
in it is secret: URLs, probe results, times, and when each directory was read.

## Directories (checked 2026-09-29)

| Type | Directory | Format | Notes |
|---|---|---|---|
| PrivateBin | https://privatebin.info/directory/api?top=100&https_redirect=true | JSON (`Accept: application/json`) | Official API, at most 100 of about 210, random order |
| | https://privatebin.info/directory/ | HTML table | Every listed instance (212 rows) |
| | https://web.archive.org/web/2026id_/https://privatebin.info/directory/ | HTML table | Wayback copy, another operator |
| CryptPad | https://cryptpad.org/instances/ | HTML, `<section class="instance" data-url>` | 13 instances; no JSON behind it (the uptime page names monitors, not URLs) |
| | https://web.archive.org/web/2026id_/https://cryptpad.org/instances/ | same | Wayback copy |
| Nostr | wss://relay.nostr.watch | NIP-66 kind 30166 events | About 390 relays from 11 monitors over 3 days; api.nostr.watch answered 502 (v1) and 402 (v2) |
| | wss://relaypag.es | NIP-66 | 13 monitors |
| | wss://monitorlizard.nostr1.com | NIP-66 | 13 monitors |
| | https://raw.githubusercontent.com/permissionlesstech/georelays/main/nostr_relays.csv | CSV of relay hosts | Crawl updated daily, about 320 hosts |
| Blossom | wss://nostrue.com | kind 36363 server announcements | What blossomservers.com reads; 17 announcements |
| | wss://purplepag.es | kind 10063 user server lists | Ranked by users, max 500 events per query |
| | wss://nos.lol | kind 36363 | Empty today, kept as a backup |
| | https://raw.githubusercontent.com/hzrd149/awesome-blossom/master/README.md | Markdown, section "Available blossom servers" | 3 links |

Directory filters: PrivateBin entries without HTTPS, NIP-66 relays that announce `auth`,
`payment`, `pow` or `writes` requirements, and Blossom servers that announce a whitelist or
payment are dropped before probing. `.onion` and `.i2p` hosts are skipped.

## Probes (the admission rule, live)

Each probe writes at most one small object under a throwaway key, reads it back and deletes it.

| Type | Passes when |
|---|---|
| PrivateBin | The front page is PrivateBin and offers `never`; a 64-byte test paste with `never` expiry is accepted, reads back identical with no `time_to_live` (or one of at least a year), and is deleted with its delete token. The CORS header on the JSON API is noted. |
| Nostr | NIP-11 does not require auth or payment, does not restrict writes, and allows 60000-byte messages; a kind 30078 event with NIP-44 content (random bytes) is accepted and read back. A NIP-09 kind 5 deletion follows. Whether the relay serves kind 1 notes older than 400 days is recorded, and `init` prefers relays that do. |
| Blossom | The BUD-06 preflight (when the server has one) accepts `application/octet-stream`; a 1024-byte random blob uploads, reads back with the right sha256 and is deleted. |
| CryptPad | Reachable (a 403 fails it), `/api/config` says registration is open, no SSO or mandatory TOTP, no captcha in the config. The probe never creates an account. |

## Terms of service: your responsibility

A CryptPad instance that passes the probe is used like the built-in ones: when a vault needs a
CryptPad host (`init`, or `repair` replacing a dead one) it registers one account per vault on
it, with credentials derived from the vault. Hosts that block this technically (captcha,
mandatory TOTP, HTTP 403) are skipped; the CLI never tries to get around a captcha or an
anti-bot check. It does not read terms of service. **Following each host's terms is up to
you.** Where we know something relevant, `hosts list` prints it as an `info:` line (from
`TERMS_NOTES` in `src/hosts/directories.js`), for example that https://pad.envs.net and
https://ebauche.facil.services forbid automated account creation. Nothing is filtered by it;
`super-secret-notes hosts remove cryptpad <url>` keeps an instance out of your vaults.

## How the results are used

- `init` (zero-config) picks, per type: healthy built-in hosts in the built-in order, then other
  healthy hosts (for relays, ones serving old data first), then built-in hosts never probed, and
  built-in hosts whose last probe failed only as a last resort. Removed hosts and a second
  host of an operator already picked (same registrable domain) are left out. Without a
  `hosts.json` the choice is the built-in list, as before.
- A backend is **dead** when, in the health ledger, every copy on it failed its last check and
  it has served no good copy for 7 days (or never, in a vault older than 7 days). Every
  `check`, `repair` and `put` sample updates the ledger, so "unreachable across several runs
  for a week" is what this measures. `OVERKILL_DEAD_AFTER_DAYS` changes the 7.
- `repair` swaps each dead PrivateBin, CryptPad, Nostr or Blossom backend for the first healthy
  cached host of the same type (in `init`'s order) that is not in use and not run by an
  operator the vault already uses, rewrites `config.json`, re-uploads every copy there,
  rewrites the index, republishes the recovery-by-name bootstrap, and asks you to reprint the
  kit. The new backend gets a fresh name (never one the vault used before). For CryptPad the
  vault's derived account on the new instance is registered on the first upload.
  `repair --no-swap` only prints a suggestion instead:

  ```
  pb-extrait looks dead (no good copy in 12 days); `super-secret-notes hosts list --type privatebin` shows 6 healthy alternatives
  ```

  `refresh` never swaps; it prints the same suggestion.

## Live run (2026-09-29, `--cap 5` per type, fresh state)

| Type | Listed | Probed | Result |
|---|---|---|---|
| PrivateBin | 100 (API) | 5 | 4 ok (rhoen.dev/bin, extrait.facil.services, paste.hostify.cz, paste.cracktek.eu); bin.mycozy.space offers no `never` |
| CryptPad | 13 | 13 (config fetch only) | 11 ok; docs.fediverse.foundation and cryptpad.blablalinux.be require TOTP for every account; envs.net, FACiL and tchncs get an `info:` line about their terms |
| Nostr | 596 (relay.nostr.watch) | 5 + 5 | relay.nostr.dev.br and relay.klabo.world ok; the rest private, whitelisted, web of trust, auth-only or kind 30078 refused |
| Blossom | 11 (nostrue) + 49 (purplepag.es) + 3 | 5 + 5 + 4 + 5 | nostr.download, files.sovbit.host, blossom.yakihonne.com, blossom.ditto.pub ok; the rest media only, whitelist or gone |

Relays and Blossom servers mostly refuse strangers' writes, so expect a low hit rate there and
a larger `--cap` when looking for more.

## Tests

`test/hosts.test.js` runs every parser, probe and command against in-process fakes
(`test/fake-hosts.js`): no network. Loopback `http://` and `ws://` hosts are accepted only
with `OVERKILL_HOSTS_ALLOW_LOOPBACK=1`, which the tests set.
