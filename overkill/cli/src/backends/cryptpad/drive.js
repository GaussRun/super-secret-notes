// Overkill storage adapter backed by a CryptPad drive.
// Each object path (e.g. overkill/notes/<blob_id>.ovk) becomes a code pad titled with the last path
// segment, stored in drive folder <baseFolder>/<dirs...>. The pad body is the bytes as base64 text.
import { CryptPadSession, Hash, Util, Sortify } from './client.js';
import { toBase64, fromBase64 } from '../../crypto.js';
export { CryptPadSession };

const LINE = 76;

function toBase64Lines(bytes) {
  const b64 = toBase64(bytes);
  const lines = [];
  for (let i = 0; i < b64.length; i += LINE) lines.push(b64.slice(i, i + LINE));
  return lines.join('\n') + '\n';
}

function fromBase64Text(text) {
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('pad content is not base64');
  return fromBase64(clean);
}

// Same shape the CryptPad code app writes (keys sorted with json.sortify).
function codePadDoc(title, text) {
  return Sortify({
    content: text,
    highlightMode: 'text/plain',
    metadata: { defaultTitle: title, title, type: 'code', users: {} },
  });
}

function splitPath(p) {
  const parts = p.split('/').filter(Boolean);
  if (!parts.length) throw new Error(`invalid path: ${p}`);
  return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] };
}

export class CryptPadBackend {
  static async open({ origin, user, pass, baseFolder = 'overkill-dev-cryptpad' }) {
    const b = new CryptPadBackend();
    b.baseFolder = baseFolder;
    b.s = await CryptPadSession.login({ origin, user, pass });
    b.origin = origin;
    // accounts we registered start with an empty drive; the web app fills in the rest
    const p = b.s.proxy;
    if (!p.drive) p.drive = {};
    if (!p.drive.root) p.drive.root = {};
    if (!p.drive.filesData) p.drive.filesData = {};
    return b;
  }

  get drive() { return this.s.proxy.drive; }

  // Walk (and optionally create) the drive folder for a list of directory names.
  #folder(dirs, create) {
    let f = this.drive.root;
    for (const d of [this.baseFolder, ...dirs]) {
      if (f[d] === undefined) {
        if (!create) return undefined;
        f[d] = {};
      }
      f = f[d];
      if (typeof f !== 'object' || f === null) throw new Error(`drive path clash at "${d}" (is a file)`);
    }
    return f;
  }

  // Entries of a folder that are pads: [{ key, id, data }]
  #files(folder) {
    const out = [];
    for (const [key, v] of Object.entries(folder || {})) {
      if (typeof v !== 'number' && typeof v !== 'string') continue;
      const data = this.drive.filesData[v];
      if (data) out.push({ key, id: v, data });
    }
    return out;
  }

  #find(path) {
    const { dirs, name } = splitPath(path);
    const folder = this.#folder(dirs, false);
    if (!folder) return undefined;
    // If duplicates exist (e.g. two writers raced), the newest wins.
    const hits = this.#files(folder).filter((f) => f.data.title === name);
    hits.sort((a, b) => (b.data.ctime || 0) - (a.data.ctime || 0));
    return hits[0];
  }

  // Drive entry ({ href, roHref, channel, title, ... }) for a path, looked up inside the base folder only.
  entry(path) {
    return this.#find(path)?.data;
  }

  async exists(path) {
    return Boolean(this.#find(path));
  }

  async get(path) {
    const hit = this.#find(path);
    if (!hit) throw Object.assign(new Error(`not found: ${path}`), { code: 'ENOENT' });
    const href = hit.data.href || hit.data.roHref;
    const doc = JSON.parse(await this.s.readPad(href));
    if (doc.metadata?.title !== hit.data.title) {
      throw new Error(`pad title mismatch for ${path}: ${doc.metadata?.title}`);
    }
    return fromBase64Text(doc.content || '');
  }

  // Always writes a fresh pad. Overwriting in place would make chainpad diff the old and new base64
  // (fast-diff on two unrelated 270 KB strings pins a CPU for minutes) and would keep every old
  // version in the channel history, counting against quota. So an overwrite swaps the drive entry to
  // a new pad and then deletes the old owned channel.
  async put(path, bytes) {
    const { dirs, name } = splitPath(path);
    const doc = codePadDoc(name, toBase64Lines(bytes));
    const hash = Hash.createRandomHash('code');
    const secret = Hash.getSecrets('code', hash);
    const href = `/code/#${hash}`;
    const roHref = `/code/#${Hash.getViewHashFromKeys(secret)}`;
    const owners = [this.s.edPublic];
    await this.s.writePad(href, doc, { owners });
    await this.s.pin([secret.channel]);
    const now = Date.now();
    const data = { href, roHref, channel: secret.channel, title: name, atime: now, ctime: now, owners };

    const hit = this.#find(path);
    if (hit) {
      const old = this.drive.filesData[hit.id];
      this.drive.filesData[hit.id] = data;
      await this.s.syncDrive();
      if (old.channel && (old.owners || []).includes(this.s.edPublic)) {
        await this.s.unpin([old.channel]);
        await this.s.removeOwnedChannel(old.channel);
      }
      return { href: this.origin + href, channel: secret.channel, created: false };
    }
    const id = Util.createRandomInteger();
    this.drive.filesData[id] = data;
    this.#folder(dirs, true)[Hash.createChannelId()] = id;
    await this.s.syncDrive();
    return { href: this.origin + href, channel: secret.channel, created: true };
  }

  // Paths (relative to the base folder) of every pad under `prefix`.
  async list(prefix = '') {
    const out = [];
    const walk = (folder, parts) => {
      for (const [key, v] of Object.entries(folder)) {
        if (typeof v === 'object' && v !== null) walk(v, [...parts, key]);
      }
      for (const f of this.#files(folder)) out.push([...parts, f.data.title].join('/'));
    };
    const root = this.#folder([], false);
    if (root) walk(root, []);
    return [...new Set(out)].filter((p) => p.startsWith(prefix)).sort();
  }

  async usage() { return this.s.usage(); }

  close() { this.s.close(); }
}
