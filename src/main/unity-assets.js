'use strict';
// Reads a Unity project's text-serialized assets for the editor's Unity features:
//  - which scenes / prefabs / ScriptableObjects use each script (m_Script guid), on which object
//  - methods called from UnityEvents (Button.onClick...) and animation events
//  - tags, layers, sorting layers, scenes in Build Settings, input axes, animator parameters and
//    Resources paths, for string completions and typo warnings
// Files are cached by mtime, so a rescan after a save only reads what changed.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ASSET_EXT = new Set(['.prefab', '.unity', '.asset', '.controller', '.anim', '.overridecontroller']);
const SKIP_DIRS = new Set(['Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'UserSettings', '.git', '.vs', '.idea']);
const MAX_FILE = 80 * 1024 * 1024;
const cache = new Map(); // path -> { mtimeMs, data }

async function walk(dir, onFile) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name)) await walk(p, onFile);
    } else if (d.isFile() && !d.name.endsWith('.meta')) {
      await onFile(p, d.name);
    }
  }
}

/** 1-based line of each offset, for offsets visited in increasing order. */
function lineCounter(text) {
  let pos = 0;
  let line = 1;
  return (offset) => {
    for (; pos < offset; pos++) if (text.charCodeAt(pos) === 10) line++;
    return line;
  };
}

const DOC_RE = /^--- !u!(\d+) &(-?\d+)[^\r\n]*$/gm;

/** One YAML asset: script uses, UnityEvent / animation event methods, with object names and lines. */
function parseAsset(text, ext) {
  const docs = [];
  let m;
  DOC_RE.lastIndex = 0;
  while ((m = DOC_RE.exec(text))) docs.push({ cls: +m[1], id: m[2], start: m.index });
  for (let i = 0; i < docs.length; i++) docs[i].end = i + 1 < docs.length ? docs[i + 1].start : text.length;

  const goName = new Map(); // GameObject fileID -> name
  const compGo = new Map(); // component fileID -> GameObject fileID
  const docName = new Map(); // fileID -> m_Name of that object (ScriptableObjects, clips...)
  for (const d of docs) {
    const body = text.slice(d.start, Math.min(d.end, d.start + 4000)); // headers are near the top
    const name = /^\s*m_Name: ?(.*)$/m.exec(body);
    if (name) docName.set(d.id, name[1].trim());
    if (d.cls === 1 && name) goName.set(d.id, name[1].trim());
    const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(body);
    if (go && go[1] !== '0') compGo.set(d.id, go[1]);
  }
  const objectOf = (id) => {
    if (!id || id === '0') return '';
    if (goName.has(id)) return goName.get(id);
    if (compGo.has(id)) return goName.get(compGo.get(id)) || '';
    return docName.get(id) || '';
  };

  const lineAt = lineCounter(text);
  const scripts = [];
  const events = [];
  for (const d of docs) {
    const body = text.slice(d.start, d.end);
    const sc = /m_Script: \{fileID: -?\d+, guid: ([0-9a-f]{32}), type: 3\}/.exec(body);
    if (sc) scripts.push([sc[1], lineAt(d.start + sc.index), objectOf(d.id) || docName.get(d.id) || '']);
    // UnityEvent persistent calls: m_Target / (m_TargetAssemblyTypeName) / m_MethodName
    const callRe = /m_Target: \{fileID: (-?\d+)[^}]*\}\s*\r?\n(?:\s*m_TargetAssemblyTypeName: ([^\r\n]*)\r?\n)?\s*m_MethodName: (\w+)/g;
    let c;
    while ((c = callRe.exec(body))) {
      const type = (c[2] || '').split(',')[0].trim();
      events.push([type, c[3], lineAt(d.start + c.index + c[0].lastIndexOf('m_MethodName')), objectOf(c[1]) || objectOf(d.id)]);
    }
  }
  // animation events call a method by name on every script of the animated object
  if (ext === '.anim') {
    const re = /functionName: (\w+)/g;
    let a;
    while ((a = re.exec(text))) events.push(['', a[1], lineAt(a.index), '(애니메이션 이벤트)']);
  }
  return { scripts, events };
}

async function scanAssets(root) {
  const assets = path.join(root, 'Assets');
  const seen = new Set();
  const files = [];
  await walk(assets, async (p, name) => {
    const ext = path.extname(name).toLowerCase();
    if (!ASSET_EXT.has(ext)) return;
    seen.add(p);
    let st;
    try { st = await fsp.stat(p); } catch { return; }
    let hit = cache.get(p);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      let data = { scripts: [], events: [] };
      if (st.size <= MAX_FILE) {
        try {
          const text = await fsp.readFile(p, 'utf8');
          if (text.startsWith('%YAML')) data = parseAsset(text, ext); // binary-serialized assets are skipped
        } catch { /* unreadable: nothing */ }
      }
      hit = { mtimeMs: st.mtimeMs, data };
      cache.set(p, hit);
    }
    if (hit.data.scripts.length || hit.data.events.length) files.push({ path: p, ...hit.data });
  });
  for (const k of cache.keys()) if (!seen.has(k) && k.startsWith(assets)) cache.delete(k);
  return files;
}

// ------------------------------------------------------------ project settings
async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return ''; }
}

/** Items of a top-level YAML list `key:` (plain `- value` lines). */
function yamlList(text, key) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === key + ':');
  if (at < 0) return [];
  const indent = lines[at].length - lines[at].trimStart().length;
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    const ind = l.length - l.trimStart().length;
    if (!l.trim()) continue;
    if (ind < indent || (ind === indent && !l.trimStart().startsWith('-'))) break;
    const m = /^\s*-\s?(.*)$/.exec(l);
    if (m && ind <= indent + 2) out.push(m[1].trim());
  }
  return out;
}

function animatorParams(text, controller) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== 'm_AnimatorParameters:') continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    let cur = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      const ind = l.length - l.trimStart().length;
      if (l.trim() && (ind < indent || (ind === indent && !l.trimStart().startsWith('-')))) break;
      const n = /^\s*- m_Name: (.*)$/.exec(l);
      if (n) { cur = { name: n[1].trim(), type: 0, controller }; out.push(cur); continue; }
      const t = /^\s*m_Type: (\d+)/.exec(l);
      if (t && cur) cur.type = +t[1]; // 1 float, 3 int, 4 bool, 9 trigger
    }
  }
  return out;
}

async function projectData(root) {
  const ps = path.join(root, 'ProjectSettings');
  const tagText = await readText(path.join(ps, 'TagManager.asset'));
  const tags = ['Untagged', 'Respawn', 'Finish', 'EditorOnly', 'MainCamera', 'Player', 'GameController', ...yamlList(tagText, 'tags')];
  const layers = yamlList(tagText, 'layers').filter(Boolean);
  const sortingLayers = [];
  const sl = /m_SortingLayers:\s*\r?\n([\s\S]*?)(?:\r?\n\s{0,2}\w|$)/.exec(tagText);
  if (sl) for (const m of sl[1].matchAll(/- name: (.*)/g)) sortingLayers.push(m[1].trim());

  const buildText = await readText(path.join(ps, 'EditorBuildSettings.asset'));
  const buildScenes = [];
  for (const m of buildText.matchAll(/- enabled: (\d)\s*\r?\n\s*path: (.*)/g)) buildScenes.push({ path: m[2].trim(), enabled: m[1] === '1' });

  const inputText = await readText(path.join(ps, 'InputManager.asset'));
  const axes = [...new Set([...inputText.matchAll(/^\s*m_Name: (.+)$/gm)].map((m) => m[1].trim()).filter(Boolean))];

  const scenes = [];
  const params = [];
  const resources = [];
  const assets = path.join(root, 'Assets');
  await walk(assets, async (p, name) => {
    const ext = path.extname(name).toLowerCase();
    const rel = path.relative(root, p).replace(/\\/g, '/');
    if (ext === '.unity') scenes.push(rel);
    else if (ext === '.controller') {
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.size < 8 * 1024 * 1024) params.push(...animatorParams(await readText(p), rel));
    }
    const r = /(?:^|\/)Resources\/(.+)$/.exec(rel);
    if (r) resources.push(r[1].replace(/\.[^./]+$/, ''));
  });
  return { tags: [...new Set(tags)], layers, sortingLayers, buildScenes, scenes, axes, animatorParams: params, resources: [...new Set(resources)] };
}

function register(ipcMain) {
  ipcMain.handle('unity:scanAssets', (_e, root) => scanAssets(root));
  ipcMain.handle('unity:projectData', (_e, root) => projectData(root));
}

module.exports = { register, scanAssets, projectData, parseAsset };
