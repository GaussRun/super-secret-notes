// Public directories of hosts, per backend type. No web search at runtime: `super-secret-notes hosts refresh`
// reads only these URLs (or one given with --directory). When one goes stale, point refresh at
// the new page with --directory and send a PR updating this file.
//
// `refresh` reads them in order and stops once it has enough unprobed candidates for its cap,
// so the later entries are the backups. Formats (parsers in ./parse.js):
//   privatebin-json  JSON array of { url, https, ... } (the directory's /api endpoint)
//   privatebin-html  the directory's table: the first link of every row
//   cryptpad-html    cryptpad.org/instances: <section class="instance" data-url="...">
//   nip66            Nostr relay: kind 30166 relay discovery events (NIP-66), d tag = relay URL
//   host-csv         CSV whose first column is a relay host name (header row skipped)
//   blossom-36363    Nostr relay: kind 36363 Blossom server announcements, d tag = server URL
//   blossom-10063    Nostr relay: kind 10063 user server lists, "server" tags, ranked by users
//   markdown         links in a Markdown or text file
import { INSTANCES as PRIVATEBIN } from '../backends/privatebin.js'
import { SIGNUP_INSTANCES } from '../backends/cryptpad.js'
import { RELAYS } from '../backends/nostr.js'
import { SERVERS as BLOSSOM } from '../backends/blossom.js'

export const TYPES = ['privatebin', 'cryptpad', 'nostr', 'blossom']

export const DIRECTORIES = {
  privatebin: [
    // checked 2026-09-29: 100 entries (the API maximum, random order out of about 210). Needs the
    // header Accept: application/json; documented at https://privatebin.info/directory/about
    { url: 'https://privatebin.info/directory/api?top=100&https_redirect=true', format: 'privatebin-json' },
    // checked 2026-09-29: HTML table of every listed instance (212 rows); same operator as the API
    { url: 'https://privatebin.info/directory/', format: 'privatebin-html' },
    // checked 2026-09-29: Wayback Machine copy of the table (snapshot of 2026-09-16), a different
    // operator, for when privatebin.info itself is down
    { url: 'https://web.archive.org/web/2026id_/https://privatebin.info/directory/', format: 'privatebin-html' }
  ],
  cryptpad: [
    // checked 2026-09-29: static HTML, 13 instances (cryptpad.fr plus 12 third-party ones). There is
    // no JSON behind it; uptime.cryptpad.org/api/status-page/public-instances names the monitors but
    // not their URLs
    { url: 'https://cryptpad.org/instances/', format: 'cryptpad-html' },
    // checked 2026-09-29: Wayback Machine copy (snapshot of 2026-09-13), same markup
    { url: 'https://web.archive.org/web/2026id_/https://cryptpad.org/instances/', format: 'cryptpad-html' }
  ],
  nostr: [
    // checked 2026-09-29: NIP-66 monitors publish kind 30166 here; 391 distinct relays seen in the last
    // 3 days by 11 monitors. api.nostr.watch answered 502 (v1) and 402 Payment Required (v2)
    { url: 'wss://relay.nostr.watch', format: 'nip66' },
    // checked 2026-09-29: a second NIP-66 aggregator, 391 relays from 13 monitors
    { url: 'wss://relaypag.es', format: 'nip66' },
    // checked 2026-09-29: a third, 390 relays from 13 monitors
    { url: 'wss://monitorlizard.nostr1.com', format: 'nip66' },
    // checked 2026-09-29: static CSV of relays answering from a crawl, updated daily (last commit
    // 2026-09-29) by the permissionlesstech/georelays GitHub repository; about 300 hosts
    { url: 'https://raw.githubusercontent.com/permissionlesstech/georelays/main/nostr_relays.csv', format: 'host-csv' }
  ],
  blossom: [
    // checked 2026-09-29: blossomservers.com is a web app that reads kind 36363 announcements from
    // wss://nostrue.com, relay.primal.net, nos.lol and relay.damus.io; nostrue.com had 17
    { url: 'wss://nostrue.com', format: 'blossom-36363' },
    // checked 2026-09-29: kind 10063 user server lists on the purplepag.es profile relay (500 lists);
    // ranks servers by how many people use them. Most popular servers are media only
    { url: 'wss://purplepag.es', format: 'blossom-10063' },
    // checked 2026-09-29: had no kind 36363 events today, kept as a backup source of announcements
    { url: 'wss://nos.lol', format: 'blossom-36363' },
    // checked 2026-09-29: "Available blossom servers" in hzrd149/awesome-blossom (3 links)
    { url: 'https://raw.githubusercontent.com/hzrd149/awesome-blossom/master/README.md', format: 'markdown', section: 'Available blossom servers' }
  ]
}

// Known-good hosts, used when every directory is dead and as the preferred order for `init`.
// They are the verified lists in the backend modules, so there is one list to update per type.
export const KNOWN = {
  privatebin: PRIVATEBIN,
  cryptpad: SIGNUP_INSTANCES,
  nostr: RELAYS,
  blossom: BLOSSOM
}

// What we know about some hosts' terms (read 2026-09-29). Information for `hosts list` only:
// nothing is filtered by it. Following each host's terms is up to whoever runs the tool.
export const TERMS_NOTES = {
  cryptpad: {
    'https://pad.envs.net': 'terms (https://envs.net/terms-of-service/) forbid hosting backups and automated account creation',
    'https://ebauche.facil.services': 'terms (https://facil.services/cgu/) forbid opening or using accounts automatically without consent',
    'https://pad.tchncs.de': 'terms (https://tchncs.de/tos) ask for a valid, non-throwaway email because of spambots'
  }
}

export const staleHint = (url) =>
  `directory ${url} looks stale; use --directory <new url> or send a PR updating src/hosts/directories.js`
