// Fileverse "embedded" writer: the official @fileverse/api library (its `base` export, made for
// embedding) driven directly, with an in-memory node:sqlite database, so no daemon, HTTP port,
// SQLite file or access log is involved. It runs in a child process (fork) because the library
// logs to fd 1 with its own pino instance, which would corrupt `super-secret-notes get` output, and because
// it reads its API key from process.env. The parent (fileverse.js) talks to it over IPC and
// never forwards its output.
//
// Messages: { id, op: 'create', title, content } -> { id, ok: true, fileId, ddocId }
//           { id, op: 'update', title, content, fileId, ddocId } -> { id, ok: true, fileId, ddocId }
//           failures -> { id, ok: false, error } with secrets redacted.
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { redact } from './fileverse.js'

/** DatabaseAdapter (the library's interface) over an in-memory node:sqlite database. */
export class MemoryAdapter {
  dialect = 'sqlite'
  db = new DatabaseSync(':memory:')
  async select (sql, params = []) { return this.db.prepare(sql).all(...params) }
  async selectOne (sql, params = []) { return this.db.prepare(sql).get(...params) }
  async execute (sql, params = []) {
    const r = this.db.prepare(sql).run(...params)
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
  }

  async transaction (fn) { return fn() }
  async exec (sql) { this.db.exec(sql) }
  async close () { this.db.close() }
  isConnected () { return true }
}

/**
 * The write logic over a loaded `base` module. `init` defaults to fetching the key material for
 * apiKey from Fileverse (tests pass their own).
 */
export function makeEmbeddedWriter (base, { apiKey, init } = {}) {
  let ready = null
  let portalAddress = null

  async function setup () {
    base.setAdapter(new MemoryAdapter())
    await base.runMigrations()
    await (init ? init(base) : base.initializeFromApiKey(apiKey))
    portalAddress = (await base.ApiKeysModel.findByApiKey(apiKey))?.portalAddress
    if (!portalAddress) throw new Error('fileverse: API key has no portal (is Developer Mode set up?)')
  }

  async function run (event) {
    const res = await base.processEvent(event)
    if (!res?.success) throw new Error(`fileverse: publish failed: ${res?.error ?? 'unknown error'}`)
  }

  async function eventsFor (fileRowId, type) {
    const db = await base.getAdapter()
    return db.select('SELECT * FROM events WHERE fileId = ? AND type = ?', [fileRowId, type])
  }

  return {
    async create (title, content) {
      await (ready ??= setup())
      const file = await base.createFile({ title, content, portalAddress })
      const [event] = await eventsFor(file._id, 'create')
      await run(event)
      const after = await base.getFile(file.ddocId, portalAddress)
      if (after?.syncStatus !== 'synced' || after.onChainFileId == null) throw new Error(`fileverse: create of ${file.ddocId} did not sync (${after?.syncStatus})`)
      return { fileId: Number(after.onChainFileId), ddocId: after.ddocId }
    },
    // Edits an on-chain file this process never created. The library only updates rows it
    // knows, so a row is made for it; the portal contract rejects an edit whose appFileId is not
    // the file's original ddocId ("FileId to AppFileId mismatch"), so the row takes that ddocId.
    async update ({ fileId, ddocId }, title, content) {
      // the library turns an edit of file 0 into an add (`if (fileId)`); callers create instead
      if (!(fileId > 0)) throw new Error('fileverse: file 0 cannot be edited through @fileverse/api; create a new file instead')
      await (ready ??= setup())
      const db = await base.getAdapter()
      let row = (await db.select('SELECT _id FROM files WHERE ddocId = ?', [ddocId]))[0]
      if (!row) {
        const file = await base.createFile({ title, content, portalAddress })
        await db.execute('DELETE FROM events WHERE fileId = ?', [file._id])
        await db.execute('UPDATE files SET ddocId = ? WHERE _id = ?', [ddocId, file._id])
        await base.FilesModel.update(file._id, { onChainFileId: fileId, onchainVersion: 1, syncStatus: 'synced' }, portalAddress)
        row = { _id: file._id }
      }
      await base.updateFile(ddocId, { title, content }, portalAddress)
      const events = await eventsFor(row._id, 'update')
      await run(events[events.length - 1])
      const after = await base.getFile(ddocId, portalAddress)
      if (after?.syncStatus !== 'synced') throw new Error(`fileverse: update of ${ddocId} did not sync (${after?.syncStatus})`)
      return { fileId: Number(after.onChainFileId), ddocId }
    }
  }
}

// child-process entry: node fileverse-embedded.js, with FILEVERSE_API_KEY in the environment
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.send) {
  const apiKey = process.env.FILEVERSE_API_KEY
  delete process.env.FILEVERSE_API_KEY
  process.env.API_KEY = apiKey // the library reads it from here
  if (process.env.FILEVERSE_RPC_URL) process.env.RPC_URL = process.env.FILEVERSE_RPC_URL
  const reply = (msg) => process.send(msg)
  let writer = null
  process.on('message', async (msg) => {
    try {
      writer ??= makeEmbeddedWriter(await import('@fileverse/api/base'), { apiKey })
      const out = msg.op === 'create'
        ? await writer.create(msg.title, msg.content)
        : await writer.update({ fileId: msg.fileId, ddocId: msg.ddocId }, msg.title, msg.content)
      reply({ id: msg.id, ok: true, ...out })
    } catch (err) {
      reply({ id: msg.id, ok: false, error: redact(err?.message ?? err, [apiKey]), missing: err?.code === 'ERR_MODULE_NOT_FOUND' })
    }
  })
  process.on('disconnect', () => process.exit(0))
}
