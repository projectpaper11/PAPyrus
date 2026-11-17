'use strict';
// Local History (Rider): every write PAPyrus makes to a project file keeps the content from before
// and after it, so a file can be compared with / restored to any earlier version, and a whole
// multi-file operation (rename, adjust namespaces...) can be undone by going back to the label put
// down before it. Stored per project under userData/local-history/<id>/: index.json + gzip blobs
// named by content hash (identical versions are stored once).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { app, shell } = require('electron');
const settings = require('./settings');

const MAX_SIZE = 2 * 1024 * 1024; // bigger files (scenes...) aren't kept
const MAX_ENTRIES = 300; // per file
const LABEL_MERGE_MS = 3000; // a label right after the same one is not repeated

const histories = new Map(); // root (lower) -> ProjectHistory

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
const key = (p) => (process.platform === 'win32' ? norm(p).toLowerCase() : norm(p));
const isText = (buf) => buf.length <= MAX_SIZE && !buf.subarray(0, 8000).includes(0);
const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

class ProjectHistory {
  constructor(root) {
    this.root = norm(root);
    this.dir = path.join(app.getPath('userData'), 'local-history', crypto.createHash('sha1').update(key(root)).digest('hex').slice(0, 16));
    this.blobs = path.join(this.dir, 'blobs');
    this.index = null;
    this.saveTimer = null;
  }

  enabled() {
    return settings.get('history.enabled') !== false;
  }

  load() {
    if (this.index) return this.index;
    try {
      this.index = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8'));
    } catch {
      this.index = null;
    }
    if (!this.index || typeof this.index.files !== 'object') this.index = { root: this.root, files: {}, labels: [], renames: [] };
    this.prune();
    return this.index;
  }

  /** Drops entries older than history.days, then blobs nothing points at (in the background). */
  prune() {
    const days = Math.max(1, Number(settings.get('history.days')) || 30);
    const cutoff = Date.now() - days * 86400000;
    const ix = this.index;
    for (const [k, f] of Object.entries(ix.files)) {
      f.entries = f.entries.filter((e) => e.t >= cutoff).slice(-MAX_ENTRIES);
      if (!f.entries.length) delete ix.files[k];
    }
    ix.labels = (ix.labels || []).filter((l) => l.t >= cutoff);
    ix.renames = (ix.renames || []).filter((r) => r.t >= cutoff);
    setTimeout(() => this.gc().catch(() => {}), 5000);
  }

  async gc() {
    const used = new Set();
    for (const f of Object.values(this.index.files)) for (const e of f.entries) if (e.h) used.add(e.h);
    let names = [];
    try { names = await fsp.readdir(this.blobs); } catch { return; }
    for (const n of names) if (!used.has(n.replace(/\.gz$/, ''))) await fsp.unlink(path.join(this.blobs, n)).catch(() => {});
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(this.index));
    }, 300);
  }

  rel(abs) {
    const r = path.relative(this.root, norm(abs));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : null;
  }

  fileOf(rel, create) {
    const ix = this.load();
    const k = process.platform === 'win32' ? rel.toLowerCase() : rel;
    if (!ix.files[k] && create) ix.files[k] = { path: rel, entries: [] };
    return ix.files[k] || null;
  }

  putBlob(buf) {
    const h = hashOf(buf);
    const p = path.join(this.blobs, h + '.gz');
    if (!fs.existsSync(p)) {
      fs.mkdirSync(this.blobs, { recursive: true });
      fs.writeFileSync(p, zlib.gzipSync(buf));
    }
    return h;
  }

  readBlob(h) {
    return zlib.gunzipSync(fs.readFileSync(path.join(this.blobs, h + '.gz')));
  }

  /** Adds an entry unless it repeats the last one's content. h: content hash, null = no file. */
  push(rel, entry) {
    const f = this.fileOf(rel, true);
    const last = f.entries[f.entries.length - 1];
    if (last && last.h === entry.h && entry.k === 'before') return; // already have this state
    f.entries.push({ t: Date.now(), ...entry });
    if (f.entries.length > MAX_ENTRIES) f.entries.splice(0, f.entries.length - MAX_ENTRIES);
    this.save();
  }

  /** The file as it is on disk now: { h } (null = missing), or undefined when it can't be kept. */
  snapshot(abs) {
    let buf;
    try { buf = fs.readFileSync(abs); } catch { return { h: null }; }
    return isText(buf) ? { h: this.putBlob(buf) } : undefined;
  }

  beforeWrite(abs) {
    if (!this.enabled()) return;
    const rel = this.rel(abs);
    if (!rel) return;
    const s = this.snapshot(abs);
    if (s) this.push(rel, { k: 'before', h: s.h });
  }

  afterWrite(abs, kind = 'save') {
    if (!this.enabled()) return;
    const rel = this.rel(abs);
    if (!rel) return;
    const s = this.snapshot(abs);
    if (s) this.push(rel, { k: kind, h: s.h });
  }

  beforeDelete(abs) { // a file or a whole folder (with the .meta files, so restoring keeps GUIDs)
    if (!this.enabled()) return;
    const files = [];
    try {
      if (fs.statSync(abs).isDirectory()) walkSync(abs, files);
      else files.push(abs, abs + '.meta'); // the .meta too: restored files keep their GUIDs
    } catch { return; }
    for (const f of files.slice(0, 2000)) {
      const rel = this.rel(f);
      const s = rel && this.snapshot(f);
      if (!s || !s.h) continue;
      this.push(rel, { k: 'before', h: s.h });
      this.push(rel, { k: 'deleted', h: null });
    }
  }

  renamed(from, to) {
    if (!this.enabled()) return;
    const rf = this.rel(from);
    const rt = this.rel(to);
    if (!rf || !rt) return;
    this.load().renames.push({ t: Date.now(), from: rf, to: rt });
    const s = this.snapshot(to);
    if (s && s.h) {
      this.push(rf, { k: 'before', h: s.h });
      this.push(rf, { k: 'moved', h: null, to: rt });
      this.push(rt, { k: 'moved', h: s.h, from: rf });
    }
    this.save();
  }

  label(text) {
    if (!this.enabled()) return;
    const ix = this.load();
    const last = ix.labels[ix.labels.length - 1];
    if (last && last.l === text && Date.now() - last.t < LABEL_MERGE_MS) return;
    ix.labels.push({ t: Date.now(), l: String(text).slice(0, 200) });
    this.save();
  }

  // ------------------------------------------------------------ queries
  fileEntries(abs) {
    const rel = this.rel(abs);
    const f = rel && this.fileOf(rel, false);
    return { path: rel, entries: f ? [...f.entries].reverse() : [] };
  }

  recent(limit = 400) {
    const ix = this.load();
    const out = [];
    for (const f of Object.values(ix.files)) {
      if (/.meta$/i.test(f.path)) continue;
      for (const e of f.entries) if (e.k !== 'before') out.push({ ...e, path: f.path });
    }
    for (const l of ix.labels) out.push({ t: l.t, k: 'label', l: l.l });
    return out.sort((a, b) => b.t - a.t).slice(0, limit);
  }

  /** Each file's state at time T: what reverting to T changes. [{ path, h }] (h null = remove the file) */
  changesSince(T) {
    const ix = this.load();
    const out = [];
    for (const f of Object.values(ix.files)) {
      const after = f.entries.filter((e) => e.t > T);
      if (!after.length) continue;
      const firstBefore = after.find((e) => e.k === 'before');
      const atT = [...f.entries].reverse().find((e) => e.t <= T);
      const h = firstBefore ? firstBefore.h : atT ? atT.h : null;
      const now = this.snapshot(path.join(this.root, f.path));
      if (now && now.h === h) continue;
      out.push({ path: f.path, h });
    }
    const renames = ix.renames.filter((r) => r.t > T).reverse();
    return { files: out, renames };
  }

  async revertTo(T) {
    this.label('되돌리기 직전 (자동)');
    const { renames } = this.changesSince(T);
    const done = { restored: [], removed: [], renamed: [] };
    // moves first, newest first: files go back to where they were (with their .meta, so GUIDs stay)
    for (const r of renames) {
      const from = path.join(this.root, r.from);
      const to = path.join(this.root, r.to);
      if (!fs.existsSync(to) || fs.existsSync(from)) continue;
      await fsp.mkdir(path.dirname(from), { recursive: true });
      await fsp.rename(to, from);
      if (fs.existsSync(to + '.meta') && !fs.existsSync(from + '.meta')) await fsp.rename(to + '.meta', from + '.meta');
      this.renamed(to, from);
      done.renamed.push({ from: r.from, to: r.to });
    }
    for (const c of this.changesSince(T).files) {
      const abs = path.join(this.root, c.path);
      if (c.h === null) {
        if (!fs.existsSync(abs)) continue;
        this.beforeDelete(abs);
        await shell.trashItem(abs);
        if (fs.existsSync(abs + '.meta')) await shell.trashItem(abs + '.meta');
        done.removed.push(c.path);
      } else {
        this.beforeWrite(abs);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, this.readBlob(c.h));
        this.afterWrite(abs, 'revert');
        done.restored.push(c.path);
      }
    }
    return done;
  }
}

function walkSync(dir, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walkSync(p, out);
    else out.push(p);
  }
}

function historyOf(root) {
  if (!root) return null;
  const k = key(root);
  if (!histories.has(k)) histories.set(k, new ProjectHistory(root));
  return histories.get(k);
}

/** The project history a path belongs to (any open project), for the fs handlers. */
function historyFor(project, abs) {
  const h = historyOf(project);
  return h && h.rel(abs) ? h : null;
}

function register(ipcMain, sessionFor, decode) {
  const of = (e) => historyOf((sessionFor(e.sender) || {}).project);
  ipcMain.handle('history:file', (e, p) => { const h = of(e); return h ? { ...h.fileEntries(p), labels: h.load().labels } : { entries: [], labels: [] }; });
  ipcMain.handle('history:content', (e, hash) => { const h = of(e); return h && hash ? decode(h.readBlob(hash)) : { text: '', encoding: 'utf8' }; });
  ipcMain.handle('history:recent', (e, limit) => { const h = of(e); return h ? h.recent(limit) : []; });
  ipcMain.handle('history:label', (e, text) => { const h = of(e); if (h) h.label(text); return true; });
  ipcMain.handle('history:changesSince', (e, t) => { const h = of(e); return h ? h.changesSince(t) : { files: [], renames: [] }; });
  ipcMain.handle('history:revertTo', (e, t) => { const h = of(e); return h ? h.revertTo(t) : null; });
}

module.exports = { register, historyFor, historyOf };
