# Security

Super Secret Notes by GaussRun (the `super-secret-notes` CLI and the web app in
`overkill/web`) is a hobby project. **Nothing in it has been audited**: not the format, not the
code, not the way it drives PrivateBin, CryptPad, Nostr, Blossom, MEGA, Proton Drive, Filen or
Fileverse. It is built from well-known parts (age, AES-256-GCM, HKDF, scrypt, NIP-44), but
putting well-known parts together is exactly where mistakes hide. Do not store anything with
it that you could not afford to lose or to see published.

## What we consider a vulnerability

- Anything that lets a host, a relay, or someone who downloads `vault.age` read a note without
  the passphrase or the recovery kit.
- Anything that lets a host swap or roll back a note without `get` or `check` noticing.
- Key derivation, nonce reuse, or random number problems in `overkill/cli/src/crypto.js`,
  `overkill/cli/src/bootstrap.js` or a backend's extra layer.
- The CLI writing a secret (passphrase, master, age identity, provider password, API key,
  session, PrivateBin `#key`, delete token) somewhere it should not: logs, world-readable files,
  plaintext outside `secrets.ovk`, command lines, error messages, the recovery record.
- A derived login (CryptPad accounts, the Fileverse wallet and API key) that leaks the master
  or lets one host's credentials unlock another host.
- Host discovery (`super-secret-notes hosts refresh`) that can be steered by a hostile directory into
  something worse than a failed probe, such as requests to local network addresses.
- In the web app: anything that gets a secret out of the tab (to storage in plaintext, to the
  URL or history, to a host, through a Referer header), or a gap in its Content-Security-Policy.
  A changed copy of the page served by someone else is a known limit, not a bug (see the
  `/trust/` page); a way to change the page we serve is a bug.
- A mismatch between the code and the format spec in `docs/OVERKILL.md` that weakens either.

Not a vulnerability, but still welcome as a normal issue: a volunteer host going away, a relay
dropping events, a provider changing its API. The design expects those; `check`, `repair` and
`refresh` are the answer.

Known and accepted, see the README: `vault.age` sits on public hosts, so a weak passphrase can
be guessed offline. That is why `init` generates a 6-word passphrase and refuses weak ones.

## How to report

Please report privately first, through GitHub's private vulnerability reporting on this
repository (the **Security** tab, then **Report a vulnerability**). Include what you found, how to
reproduce it, and which version or commit you looked at. Please do not open a public issue for
something that could expose someone's notes.

We will acknowledge the report as soon as we can, fix what we can, and credit you in the release
notes unless you would rather stay anonymous. There is no bug bounty: this is a hobby project.

## Your own secrets

If you file an issue or paste a log, remove passphrases, recovery kits, `config.json`
contents, PrivateBin URLs (their `#fragment` is a key), session files, API keys and any
`super-secret-notes index export --plaintext` output first. `secrets.ovk`, `vault.age` and
`index-cache.ovk` are encrypted, but there is no reason to share them either; `hosts.json`
holds only public host data.
Debug logs (`OVERKILL_LOG=debug`) name hosts and backends; read them before you share them.
