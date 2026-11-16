'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');
const iconv = require('iconv-lite');
const settings = require('./settings');

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.psd', '.tga', '.tif', '.tiff', '.exr', '.hdr', '.bmp', '.ico',
  '.fbx', '.obj', '.blend', '.dae', '.3ds', '.max', '.ma', '.mb', '.wav', '.mp3', '.ogg', '.aif', '.aiff', '.flac',
  '.mp4', '.mov', '.avi', '.webm', '.dll', '.exe', '.so', '.dylib', '.a', '.lib', '.pdb', '.mdb', '.zip', '.7z', '.rar',
  '.unitypackage', '.ttf', '.otf', '.bank', '.bytes', '.asset', '.prefab', '.unity', '.mat', '.anim', '.controller',
  '.physicMaterial', '.cubemap', '.flare', '.mask', '.overrideController', '.mixer', '.lighting', '.giparams', '.spriteatlas', '.spriteatlasv2', '.terrainlayer']);
// .asset/.prefab/.unity are YAML text but usually huge; they are still openable through "Open as text".

function excluded() {
  return new Set(settings.get('files.exclude') || []);
}

function isHidden(name) {
  return name.endsWith('.meta') || name === '.DS_Store' || name === 'Thumbs.db';
}

// ------------------------------------------------------------ encoding
function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString('utf8'), encoding: 'utf8bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: iconv.decode(buf.slice(2), 'utf16le'), encoding: 'utf16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: iconv.decode(buf.slice(2), 'utf16be'), encoding: 'utf16be' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf8' };
  } catch {
    // Old Korean Unity scripts are often saved as CP949.
    return { text: iconv.decode(buf, 'cp949'), encoding: 'cp949' };
  }
}

function encode(text, encoding) {
  switch (encoding) {
    case 'utf8bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf16le')]);
    case 'utf16be': return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf16be')]);
    case 'cp949': return iconv.encode(text, 'cp949');
    default: return Buffer.from(text, 'utf8');
  }
}

// ------------------------------------------------------------ listing
async function listDir(dir, opts = {}) {
  const ex = excluded();
  const hideProj = !opts.all && settings.get('explorer.hideProjectFiles') !== false;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of entries) {
    if (isHidden(d.name)) continue;
    if (d.isDirectory() && ex.has(d.name)) continue;
    if (hideProj && !d.isDirectory() && /\.(csproj|sln|slnx)$/i.test(d.name)) continue;
    out.push({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() });
  }
  // folders with nothing to show get no expand arrow (only .meta files count as nothing)
  await Promise.all(out.filter((e) => e.dir).map(async (e) => {
    try {
      const inner = await fsp.readdir(e.path, { withFileTypes: true });
      e.empty = !inner.some((d) => !isHidden(d.name) && !(d.isDirectory() && ex.has(d.name))
        && !(hideProj && !d.isDirectory() && /\.(csproj|sln|slnx)$/i.test(d.name)));
    } catch {
      e.empty = false;
    }
  }));
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
  return out;
}

async function walk(root, onFile, opts = {}) {
  const ex = excluded();
  const max = opts.max || 60000;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (isHidden(d.name)) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (ex.has(d.name) || d.name.startsWith('.')) continue;
        stack.push(p);
      } else if (d.isFile()) {
        if (++count > max) return;
        if ((await onFile(p, d.name)) === false) return;
      }
    }
  }
}

async function listAllFiles(root) {
  const out = [];
  await walk(root, (p) => { out.push(p); });
  return out;
}

// ------------------------------------------------------------ find in files
const TEXT_EXT = new Set(['.cs', '.shader', '.hlsl', '.cginc', '.compute', '.glsl', '.txt', '.json', '.asmdef', '.asmref', '.xml',
  '.uxml', '.uss', '.md', '.yaml', '.yml', '.csproj', '.sln', '.rsp', '.js', '.ts', '.lua', '.py', '.ini', '.cfg', '.html', '.css',
  '.shadergraph', '.shadersubgraph', '.inputactions', '.editorconfig']);

let activeSearch = 0;
async function findInFiles(root, query, opts, onResult) {
  const id = ++activeSearch;
  if (!query) return { count: 0 };
  let re;
  try {
    const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(opts.wholeWord ? `\\b${src}\\b` : src, opts.matchCase ? 'g' : 'gi');
  } catch (err) {
    return { error: String(err.message || err) };
  }
  let count = 0;
  const limit = 2000;
  await walk(root, async (p) => {
    if (id !== activeSearch) return false;
    const ext = path.extname(p).toLowerCase();
    if (!TEXT_EXT.has(ext)) return true;
    let st;
    try { st = await fsp.stat(p); } catch { return true; }
    if (st.size > 2 * 1024 * 1024) return true;
    let text;
    try { text = decode(await fsp.readFile(p)).text; } catch { return true; }
    const lines = text.split(/\r?\n/);
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i]))) {
        matches.push({ line: i + 1, column: m.index + 1, length: m[0].length || 1, text: lines[i].slice(0, 400) });
        if (!m[0].length) re.lastIndex++;
        if (++count >= limit) break;
      }
      if (count >= limit) break;
    }
    if (matches.length) onResult({ file: p, matches });
    return count < limit;
  });
  return { count, truncated: count >= limit };
}

// ------------------------------------------------------------ watcher
function watchProject(root, onChange) {
  const ex = excluded();
  let watcher;
  const pending = new Map();
  let timer = null;
  const flush = () => {
    timer = null;
    const list = [...pending.values()];
    pending.clear();
    onChange(list);
  };
  try {
    watcher = fs.watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const first = filename.split(/[\\/]/)[0];
      if (ex.has(first) || first.startsWith('.')) return;
      if (filename.endsWith('.meta')) return;
      const full = path.join(root, filename);
      pending.set(full, { path: full, event });
      if (!timer) timer = setTimeout(flush, 250);
    });
  } catch {
    return () => {};
  }
  return () => { try { watcher.close(); } catch { /* ignore */ } };
}

// ------------------------------------------------------------ IPC
function register(ipcMain, sessionFor) {
  const watchers = new Map();

  ipcMain.handle('fs:listDir', (_e, dir, opts) => listDir(dir, opts));
  ipcMain.handle('fs:listAllFiles', (_e, root) => listAllFiles(root));
  ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));
  ipcMain.handle('fs:stat', async (_e, p) => {
    try {
      const st = await fsp.stat(p);
      return { size: st.size, mtimeMs: st.mtimeMs, dir: st.isDirectory() };
    } catch {
      return null;
    }
  });
  ipcMain.handle('fs:readFile', async (_e, p) => {
    const ext = path.extname(p).toLowerCase();
    const buf = await fsp.readFile(p);
    if (BINARY_EXT.has(ext) && !['.asset', '.prefab', '.unity', '.mat', '.anim', '.controller'].includes(ext)) {
      return { binary: true, size: buf.length };
    }
    if (buf.length > 20 * 1024 * 1024) return { tooLarge: true, size: buf.length };
    if (buf.indexOf(0) !== -1 && buf.indexOf(0) < 8000 && !(buf[0] === 0xff || buf[0] === 0xfe)) return { binary: true, size: buf.length };
    const st = await fsp.stat(p);
    return { ...decode(buf), mtimeMs: st.mtimeMs };
  });
  ipcMain.handle('fs:writeFile', async (_e, { path: p, text, encoding }) => {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, encode(text, encoding || 'utf8'));
    const st = await fsp.stat(p);
    return { mtimeMs: st.mtimeMs };
  });
  ipcMain.handle('fs:createFile', async (_e, { path: p, text }) => {
    if (fs.existsSync(p)) throw new Error('이미 같은 이름의 파일이 있어요');
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, encode(text || '', 'utf8bom'));
    return true;
  });
  ipcMain.handle('fs:createFolder', async (_e, p) => {
    await fsp.mkdir(p, { recursive: true });
    return true;
  });
  ipcMain.handle('fs:rename', async (_e, { from, to }) => {
    if (fs.existsSync(to)) throw new Error('이미 같은 이름이 있어요');
    await fsp.rename(from, to);
    // keep Unity .meta in sync so GUIDs survive the rename
    if (fs.existsSync(from + '.meta')) await fsp.rename(from + '.meta', to + '.meta');
    return true;
  });
  // Copy a file or folder. Unity .meta files stay behind: a copy with the same GUID would clash,
  // Unity gives the new files fresh ones.
  ipcMain.handle('fs:copy', async (_e, { from, to }) => {
    if (fs.existsSync(to)) throw new Error('이미 같은 이름이 있어요');
    const norm = (p) => path.resolve(p).toLowerCase() + path.sep;
    if (norm(to).startsWith(norm(from))) throw new Error('폴더를 자기 안으로 복사할 수는 없어요');
    await fsp.cp(from, to, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (src) => !src.toLowerCase().endsWith('.meta'),
    });
    return true;
  });
  ipcMain.handle('fs:trash', async (_e, p) => {
    await shell.trashItem(p);
    if (fs.existsSync(p + '.meta')) await shell.trashItem(p + '.meta');
    return true;
  });
  ipcMain.handle('fs:findInFiles', async (e, { root, query, opts }) => {
    return findInFiles(root, query, opts || {}, (r) => e.sender.send('fs:findResult', r));
  });
  ipcMain.handle('fs:watch', (e, root) => {
    const s = sessionFor(e.sender);
    const key = s.win.id;
    if (watchers.has(key)) watchers.get(key)();
    const stop = watchProject(root, (changes) => {
      if (!s.win.isDestroyed()) s.win.webContents.send('fs:changed', changes);
    });
    watchers.set(key, stop);
    s.win.once('closed', () => { stop(); watchers.delete(key); });
    return true;
  });
}

module.exports = { register, decode, encode, listAllFiles };
