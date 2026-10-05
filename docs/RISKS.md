# Super Secret Notes: what can go wrong

A plain list of the ways a vault or a note can be lost or become hard to reach, what is in place
against each, and what is left to you. The format and the mechanisms are specified in
[OVERKILL.md](OVERKILL.md).

The short version: keep the passphrase (your password manager), keep the recovery kit or a full
backup somewhere offline, and open the vault now and then so Check can repair what free hosts drop.

| Risk | What happens | What is in place | Status |
|---|---|---|---|
| Passphrase lost | Nobody can open `vault.age`; there is no reset. | The passphrase is generated (6 random words) and offered to the password manager at setup. The recovery kit (downloaded at setup unless unchecked) holds the passphrase and the two key lines; `recover --kit` rebuilds the vault under a new passphrase from the key lines alone. | Covered as long as the password manager entry or the kit survives. Without both the notes are gone, by design. |
| Vault name forgotten | Recovery by name needs the name and the passphrase. | The name is shown large at setup and on Vault access, saved as the password manager's username, and carried by the vault link (safe to keep in notes or bookmarks), the recovery kit, the backup file and the calendar reminder. | Covered. |
| Discovery relays drop the recovery record | Recovery by name finds nothing. | The record goes to a fixed, well-known set of relays and to the vault's own relays, and is published again whenever it changes or is 30 days old when the vault is used, and put back where a discovery relay lost it (on unlock, check, repair and refresh). The recovery kit and the backup file work without it. | Partly: relays promise no retention, so the record stays fresh only while the vault is used. Keep the kit or a backup. |
| Every host that keeps the index is gone | The list of notes (and where the copies are) cannot be read from the hosts. | Every device keeps an encrypted copy of the index and uploads it again with the next write; the backup file contains it; Repair copies it to hosts that answer again. Notes on hosts with fixed paths can still be read by name. | Covered on any device that used the vault, by a backup, and by recovery by name: the recovery record on the discovery relays carries a copy of the index (updated with every change to the notes). |
| Copies decay while the vault is not used | Free hosts drop data: relays and Blossom servers promise no retention (copies are treated as gone after 120 days), volunteer pastebins close. | Each note sits on many independent hosts. A full check finds missing copies and Repair restores them from a healthy one; Refresh republishes copies before the 120 days are up. The web app shows a quiet banner once the last full check is over 30 days old, and offers a calendar reminder every 3 months. | Covered if the vault is opened from time to time (the reminder is there for that). |
| The index is only on this device | A note is stored but other devices do not see it yet (no index-holding host took the update, or `index_sync` is manual). | The page says so ("not yet findable from other devices") with Retry; the index goes out again with the next write; `sync` pushes it in the command line tool. | Covered once a host takes the index; until then keep the device (or tab) or save a backup. |
| The web site disappears | The page that runs the app is gone. | The site is static and open source: it can be built and served from the source anywhere. The command line tool reads the same vaults. The format is documented. The backup file and the kit need no particular site. | Covered. |
| Browser storage is cleared | This browser forgets the vault (and a restored backup's local copy). | The hosts keep every copy: recovery by name, the vault link, the access link or the kit bring the vault back. Public-computer mode never stores anything on purpose. | Covered, as long as the hosts or a backup still hold the vault. |
| The site moves to another address | Browsers keep data per address, so the vault is not there at the new one; old vault links point at the old address. | Recover at the new address by name, or paste a vault link or access link from any address into its Recover page (the paste field reads the part after `#`). | Covered with one extra step. |
| A host deletes an account or closes | Its copies are gone (for example a CryptPad account after long inactivity, or a volunteer instance shutting down). | One operator per host, many hosts per vault; Check and Repair restore copies elsewhere; setup and the command line tool's repair swap a dead host for a known-good one of the same type. | Covered by redundancy and regular checks. |

Notes:
- Recovery by name needs this version of the web app or command line tool, or newer: the recovery
  record is now published under tags of its own for each vault, which older versions do not look for.
- The two encryption layers (age, then AES-256-GCM) run on your device; hosts add their own layer
  on top. None of the measures above weakens that: the vault link holds only the name, the
  calendar reminder holds only the vault link, and the backup file holds only encrypted blobs.
- What the hosts see (sizes, timing, the fact that you use them) and what a compromised device
  can do are covered in the trust model on the site.
