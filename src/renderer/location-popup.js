// Rider-style "show usages" popup: a list of code locations that opens right where you clicked
// (or at the caret for keyboard commands) instead of in the bottom panel.
import { monaco } from './monaco.js';
import { el, icon, basename, dirname, fileIcon, relPath, samePath } from './ui.js';

const MAX_ROWS_VISIBLE = 14;
const ROW_H = 24;
const WIDTH = 640;
const CLICK_FRESH_MS = 900; // a command fired this soon after a click opens at the click point

let lastClick = { x: 0, y: 0, t: 0 };
document.addEventListener('mousedown', (e) => { lastClick = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);

let open = null;

export function closeLocationPopup() {
  if (open) open.close();
}

/** Screen point for a popup: the click that triggered the command, else just below the caret. */
export function popupPoint(editor) {
  if (Date.now() - lastClick.t < CLICK_FRESH_MS) return { x: lastClick.x, y: lastClick.y + 6 };
  const pos = editor && editor.getPosition();
  const vis = pos && editor.getScrolledVisiblePosition(pos);
  if (!vis) return { x: window.innerWidth / 3, y: window.innerHeight / 3 };
  const r = editor.getDomNode().getBoundingClientRect();
  return { x: r.left + vis.left, y: r.top + vis.top + vis.height + 2 };
}

async function linesOf(path) {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  if (model) return model.getLinesContent();
  try {
    const r = await window.papyrus.fs.readFile(path);
    return r.text ? r.text.split(/\r?\n/) : [];
  } catch {
    return [];
  }
}

/**
 * @param {object} o
 * @param {string} o.title            header text
 * @param {{uri:string, range:object}[]} o.locations  LSP locations
 * @param {{x:number,y:number}} o.at   screen point
 * @param {string} [o.project]        for relative paths
 * @param {string} [o.currentPath]    listed first
 * @param {(path:string, line:number, column:number) => void} o.onPick
 * @param {() => void} [o.onPanel]    "open in panel" action
 */
export async function showLocationPopup({ title, locations, at, project, currentPath, onPick, onPanel }) {
  closeLocationPopup();
  const items = [];
  const byFile = new Map();
  for (const l of locations) {
    const p = monaco.Uri.parse(l.uri).fsPath;
    if (!byFile.has(p)) byFile.set(p, []);
    byFile.get(p).push(l.range);
  }
  const files = [...byFile.keys()].sort((a, b) => (samePath(b, currentPath) - samePath(a, currentPath)) || a.localeCompare(b));
  for (const file of files) {
    const lines = await linesOf(file);
    for (const r of byFile.get(file).sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character)) {
      const text = lines[r.start.line] || '';
      const indent = text.length - text.trimStart().length;
      const len = r.end.line === r.start.line ? Math.max(1, r.end.character - r.start.character) : 1;
      items.push({ file, line: r.start.line + 1, column: r.start.character + 1, text: text.trim().slice(0, 300), hl: [r.start.character - indent, r.start.character - indent + len] });
    }
  }
  return showPopupItems({ title, items, at, project, onPick, onPanel });
}

/**
 * The same popup for any rows: [{ file, line, column, text, hl?, label?, dir? }] (label replaces
 * "file:line", dir the folder column). onPick(file, line, column, item).
 */
export function showPopupItems({ title, items, at, project, onPick, onPanel }) {
  closeLocationPopup();
  let sel = 0;
  const rows = items.map((it, i) => {
    const code = el('span.lp-code');
    const [a, b] = it.hl || [-1, -1];
    if (a >= 0 && b <= it.text.length) code.append(it.text.slice(0, a), el('mark', null, it.text.slice(a, b)), it.text.slice(b));
    else code.append(it.text);
    return el('div.lp-row', {
      onmousemove: () => select(i),
      onclick: () => pick(i),
    },
    fileIcon(basename(it.file)),
    el('span.lp-file', null, it.label || `${basename(it.file)}:${it.line}`),
    code,
    el('span.lp-dir', null, it.dir != null ? it.dir : samePath(dirname(it.file), project) ? '' : relPath(project, dirname(it.file))));
  });
  const list = el('div.lp-list', { style: { maxHeight: `${MAX_ROWS_VISIBLE * ROW_H}px` } }, rows);
  const box = el('div.popup.loc-popup', { style: { width: `${Math.min(WIDTH, window.innerWidth - 24)}px` } },
    el('div.lp-head', null,
      el('span.lp-title', null, title),
      onPanel ? el('button.tb-btn.icon.small', { title: '아래 패널에서 보기', onclick: () => { close(); onPanel(); } }, icon('layout-panel')) : null),
    list);
  document.getElementById('overlay-root').append(box);

  // keep inside the window: below the point if it fits, otherwise above it
  const br = box.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.x - 18, window.innerWidth - br.width - 8));
  const top = at.y + br.height + 8 <= window.innerHeight ? at.y : Math.max(8, at.y - br.height - 28);
  Object.assign(box.style, { left: `${left}px`, top: `${top}px` });

  function select(i) {
    if (!rows.length) return;
    rows[sel] && rows[sel].classList.remove('selected');
    sel = (i + rows.length) % rows.length;
    rows[sel].classList.add('selected');
    rows[sel].scrollIntoView({ block: 'nearest' });
  }
  function pick(i) {
    const it = items[i];
    close();
    if (it) onPick(it.file, it.line, it.column, it);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') select(sel + 1);
    else if (e.key === 'ArrowUp') select(sel - 1);
    else if (e.key === 'PageDown') select(Math.min(sel + MAX_ROWS_VISIBLE, rows.length - 1));
    else if (e.key === 'PageUp') select(Math.max(sel - MAX_ROWS_VISIBLE, 0));
    else if (e.key === 'Enter') pick(sel);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onDown(e) {
    if (!box.contains(e.target)) close();
  }
  function close() {
    if (open !== handle) return;
    open = null;
    box.remove();
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
  }
  const handle = { close };
  open = handle;
  select(0);
  // registered after the click that opened us has finished
  setTimeout(() => {
    if (open !== handle) return;
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
  });
  return handle;
}
