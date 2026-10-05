// Recovery with vault name + passphrase only (docs/OVERKILL.md): find vault.age and the
// bootstrap record under the discovery key on the Nostr relays (src/discovery.js), check the
// passphrase opens vault.age, then write this machine's config from the record.
import { decryptVault, unlockKeys, decryptBlob } from './crypto.js'
import { SECRETS_ID, SecretStore, migrateConfig } from './vaultsecrets.js'
import path from 'node:path'
import { files, writePrivate } from './config.js'
import { fetchVault as defaultFetch } from './discovery.js'
import { indexCacheFromCopies } from './discovery-core.js'

export async function recover ({ name, passphrase, home, fetchVault = defaultFetch }) {
  name = name.normalize('NFC')
  const { vaultBytes, cfg, others, from, secretsBlob, indexBlobs } = await fetchVault({ name, passphrase })
  const vault = await decryptVault(vaultBytes, passphrase) // fail early, before writing anything
  const keys = await unlockKeys(vault)
  if (secretsBlob) {
    // the opt-in logins come back too; check they open before writing anything
    await decryptBlob(keys, SECRETS_ID, secretsBlob)
    await writePrivate(path.join(home, 'secrets.ovk'), secretsBlob)
  }
  // locators in the record (paste URLs with their keys) go into secrets.ovk, not config.json
  const store = await new SecretStore(home).unlock(keys)
  if (migrateConfig(cfg, store)) await store.save()
  // the index copy from the record seeds this machine's index cache: the remote copies are merged
  // with it on every read, so the notes are found even when no index holder has the index
  const cache = await indexCacheFromCopies(keys, indexBlobs)
  if (cache) await writePrivate(files(home).indexCache, cache)
  await writePrivate(files(home).vault, vaultBytes)
  await writePrivate(files(home).config, JSON.stringify(cfg, null, 2) + '\n')
  return { cfg, others, from }
}
