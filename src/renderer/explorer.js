// Explorer tool window: lazy file tree of the Unity project.
import { monaco } from './monaco.js';
import { isInspectable } from './inspector.js';
import { fixScriptCopy, topLevelTypes, predefinedAssembly } from './script-copy.js';
import { el, icon, basename, dirname, joinPath, fileIcon, contextMenu, prompt, toast, samePath, relPath, extname } from './ui.js';

const ofs = window.papyrus.fs;
const RENAME_CLASS_KEY = 'explorer.renameClassWithFile'; // "클래스 이름도 같이 바꾸기" checkbox state
const COPY_CLASS_KEY = 'explorer.renameClassOnCopy'; // the same checkbox in the copy dialog (on by default)
const SAFE_DELETE_KEY = 'explorer.safeDelete'; // "안전 삭제 (사용처 검색)" in the delete dialog (on by default)
const TYPE_KINDS = [5, 10, 11, 23]; // LSP SymbolKind: class, enum, interface, struct

const TEMPLATES = {
  mono: (n, ns) => wrapNs(ns, `public class ${n} : MonoBehaviour
{
    private void Start()
    {

    }

    private void Update()
    {

    }
}`, ['UnityEngine']),
  so: (n, ns) => wrapNs(ns, `[CreateAssetMenu(fileName = "${n}", menuName = "Scriptable Objects/${n}")]
public class ${n} : ScriptableObject
{

}`, ['UnityEngine']),
  cls: (n, ns) => wrapNs(ns, `public class ${n}
{

}`, []),
  iface: (n, ns) => wrapNs(ns, `public interface ${n}
{

}`, []),
  editor: (n, ns) => wrapNs(ns, `public class ${n} : EditorWindow
{
    [MenuItem("Window/${n}")]
    private static void Open() => GetWindow<${n}>("${n}");

    private void OnGUI()
    {

    }
}`, ['UnityEditor', 'UnityEngine']),
};

const MOVE_MIME = 'application/x-papyrus-move'; // a tree row being dragged (moved when dropped on a folder)

function wrapNs(ns, body, usings) {
  const u = usings.map((x) => `using ${x};\n`).join('') + (usings.length ? '\n' : '');
  if (!ns) return u + body + '\n';
  return `${u}namespace ${ns}\n{\n${body.split('\n').map((l) => (l ? '    ' + l : l)).join('\n')}\n}\n`;
}

export class Explorer {
  constructor(app) {
    this.app = app;
    this.root = null;
    this.expanded = new Set();
    this.children = new Map(); // dir -> entries
    this.selected = null;
    this.rows = [];
    this.el = el('div.tree', { tabindex: 0 });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('contextmenu', (e) => {
      if (e.target === this.el) {
        e.preventDefault();
        this.menu(this.viewRoot || this.root, true, e.clientX, e.clientY);
      }
    });

    // Script search under the header: type a name, Enter opens the 1st match, Enter again the next.
    this.search = { query: null, items: [], index: -1, seq: 0 };
    this.searchInput = el('input', {
      type: 'text', placeholder: '스크립트 이름으로 찾기 (Enter: 다음)', spellcheck: 'false',
      oninput: () => this.onSearchInput(),
      onkeydown: (e) => this.onSearchKey(e),
    });
    this.searchCount = el('span.ex-search-count');
    // Pinned folders: tabs over the tree, each shows only its folder (like browser tabs)
    this.pins = [];
    this.viewRoot = null; // what the tree shows: the project, or the active pinned folder
    this.pinsEl = el('div.ex-pins', {
      // many pinned folders: the mouse wheel scrolls the tab row sideways
      onwheel: (e) => {
        const p = this.pinsEl;
        if (p.scrollWidth <= p.clientWidth) return;
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!d) return;
        e.preventDefault();
        p.scrollLeft += e.deltaMode === 1 ? d * 20 : d;
      },
    });
    this.view = el('div.explorer-view', null,
      this.pinsEl,
      el('div.ex-search-wrap', null, el('div.ex-search', null, icon('search'), this.searchInput, this.searchCount)),
      this.el);
    this.setupDragMove();
  }

  // ------------------------------------------------------------------ drag & drop move
  // A file or folder dragged onto a folder of the tree moves there (with its .meta, then the
  // namespace offer, like Cut/Paste). While dragging, the tree scrolls by itself near its top or
  // bottom edge, the mouse wheel scrolls it, and a closed folder held over for a moment opens.
  setupDragMove() {
    this.drag = null; // { path, y, raf, hoverDir, hoverSince, target }
    const scroller = () => this.view.parentElement || this.view;
    const targetDir = (e) => {
      const row = e.target.closest && e.target.closest('.tree-row');
      if (!row) return this.el.contains(e.target) || e.target === this.el ? this.viewRoot || this.root : null;
      const r = this.rows.find((x) => samePath(x.path, row.dataset.path));
      if (!r) return null;
      return r.dir ? r.path : dirname(r.path);
    };
    const canDrop = (from, dir) => {
      if (!from || !dir) return false;
      if (samePath(dirname(from), dir) || samePath(from, dir)) return false;
      const f = from.toLowerCase().replace(/[\\/]+$/, '');
      const d = dir.toLowerCase();
      return !(d.startsWith(f + '\\') || d.startsWith(f + '/')); // not into itself
    };
    const mark = (dir) => {
      if (this.drag && this.drag.target === dir) return;
      this.el.querySelectorAll('.tree-row.drop-target').forEach((x) => x.classList.remove('drop-target'));
      if (this.drag) this.drag.target = dir;
      if (!dir) return;
      const row = [...this.el.querySelectorAll('.tree-row')].find((x) => samePath(x.dataset.path, dir));
      if (row) row.classList.add('drop-target');
      else if (samePath(dir, this.viewRoot || this.root)) this.el.classList.add('drop-root');
    };
    // edge auto-scroll: faster the closer to the edge
    const tick = () => {
      const d = this.drag;
      if (!d) return;
      if (Date.now() - d.lastOver > 300) d.y = null; // not over the tree any more
      const s = scroller();
      const rect = s.getBoundingClientRect();
      const top = rect.top + (this.pinsEl.classList.contains('show') ? 30 : 0) + 34; // under the sticky pins + search box
      const zone = Math.min(56, rect.height / 4);
      let v = 0;
      if (d.y != null && d.y < top + zone) v = -Math.ceil(((top + zone - d.y) / zone) * 18);
      else if (d.y != null && d.y > rect.bottom - zone) v = Math.ceil(((d.y - (rect.bottom - zone)) / zone) * 18);
      if (v) s.scrollTop += v;
      d.raf = requestAnimationFrame(tick);
    };
    this.dragStart = (path) => {
      this.dragEnd();
      this.drag = { path, y: null, raf: 0, hoverDir: null, hoverSince: 0, target: null, lastOver: Date.now() };
      this.drag.raf = requestAnimationFrame(tick);
    };
    this.dragEnd = () => {
      if (!this.drag) return;
      cancelAnimationFrame(this.drag.raf);
      this.drag = null;
      this.el.querySelectorAll('.tree-row.drop-target').forEach((x) => x.classList.remove('drop-target'));
      this.el.classList.remove('drop-root');
    };
    this.view.addEventListener('dragover', (e) => {
      const d = this.drag;
      if (!d || !e.dataTransfer.types.includes(MOVE_MIME)) return;
      d.y = e.clientY;
      d.lastOver = Date.now();
      const dir = targetDir(e);
      this.el.classList.remove('drop-root');
      if (!canDrop(d.path, dir)) {
        mark(null);
        e.dataTransfer.dropEffect = 'none';
        e.preventDefault();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      mark(dir);
      // hold over a closed folder: it opens
      if (d.hoverDir !== dir) { d.hoverDir = dir; d.hoverSince = Date.now(); }
      else if (Date.now() - d.hoverSince > 700 && !this.expanded.has(dir) && this.isDir(dir)) {
        d.hoverSince = Infinity;
        this.toggle(dir, true);
      }
    });
    // pointer left the panel: keep scrolling only while it is still over the panel's edges
    this.view.addEventListener('dragleave', (e) => {
      if (this.drag && !this.view.contains(e.relatedTarget)) {
        this.drag.y = null;
        mark(null);
        this.el.classList.remove('drop-root');
      }
    });
    // the wheel while dragging (Chromium may skip its own scrolling during a drag)
    this.view.addEventListener('wheel', (e) => {
      if (!this.drag) return;
      e.preventDefault();
      scroller().scrollTop += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
    }, { passive: false });
    this.view.addEventListener('drop', async (e) => {
      const d = this.drag;
      if (!d || !e.dataTransfer.types.includes(MOVE_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = targetDir(e);
      const from = d.path;
      this.dragEnd();
      if (canDrop(from, dir)) await this.moveTo(from, dir);
    });
    this.setupPointerDrag();
  }

  // The tree's rows are dragged with the mouse, not the browser's drag & drop: during a native drag
  // Windows delivers no wheel events (the tree couldn't be scrolled). The drop targets (folders
  // here, the inspector / hierarchy) still get ordinary dragenter/dragover/dragleave/drop events,
  // with a DataTransfer holding the same data as before, so they need no change.
  setupPointerDrag() {
    let arm = null; // mousedown on a row: { x, y, row: r }
    let pd = null; // a drag going on: { dt, ghost, target, x, y, accepted, timer }
    let swallowClick = false;
    const send = (type, target, x, y, related) => {
      if (!target) return false;
      pd.dt.dropEffect = 'none';
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: pd.dt, relatedTarget: related || null });
      target.dispatchEvent(ev);
      return ev.defaultPrevented && pd.dt.dropEffect !== 'none';
    };
    const over = () => {
      if (!pd) return;
      const t = document.elementFromPoint(pd.x, pd.y);
      if (t !== pd.target) {
        if (pd.target && pd.target.isConnected) send('dragleave', pd.target, pd.x, pd.y, t);
        if (t) send('dragenter', t, pd.x, pd.y, pd.target);
        pd.target = t;
      }
      pd.accepted = send('dragover', t, pd.x, pd.y);
      document.body.classList.toggle('pdrag-no', !pd.accepted);
      pd.ghost.style.transform = `translate(${pd.x + 14}px, ${pd.y + 10}px)`;
    };
    const start = (r, x, y) => {
      const dt = new DataTransfer();
      // a DataTransfer made by script ignores dropEffect writes: keep the targets' answer ourselves
      let effect = 'none';
      Object.defineProperty(dt, 'dropEffect', { get: () => effect, set: (v) => { effect = String(v); }, configurable: true });
      if (!r.dir) {
        dt.setData('application/x-papyrus-path', r.path);
        dt.setData('application/x-papyrus-ext' + extname(r.path), '1');
        dt.setData('text/plain', r.path);
      }
      dt.setData(MOVE_MIME, r.path);
      const ghost = el('div.drag-ghost', null, fileIcon(r.name, r.dir), el('span', null, r.name));
      document.body.append(ghost);
      document.body.classList.add('pdrag');
      pd = { dt, ghost, target: null, x, y, accepted: false, timer: 0 };
      this.dragStart(r.path);
      // like a native drag: dragover keeps coming while the mouse rests (edge scroll, folder opening)
      pd.timer = setInterval(over, 60);
      over();
    };
    const finish = (drop) => {
      if (!pd) return;
      const p = pd;
      clearInterval(p.timer);
      if (drop && p.accepted && p.target && p.target.isConnected) send('drop', p.target, p.x, p.y);
      else if (p.target && p.target.isConnected) send('dragleave', p.target, p.x, p.y, null);
      p.ghost.remove();
      document.body.classList.remove('pdrag', 'pdrag-no');
      pd = null;
      this.dragEnd();
    };
    this.armDrag = (e, r) => {
      if (e.button !== 0 || r.isRoot || e.ctrlKey || e.shiftKey || e.altKey) return;
      arm = { x: e.clientX, y: e.clientY, row: r };
    };
    window.addEventListener('mousemove', (e) => {
      if (arm && !pd) {
        if (!(e.buttons & 1)) { arm = null; return; }
        if (Math.abs(e.clientX - arm.x) + Math.abs(e.clientY - arm.y) < 6) return;
        start(arm.row, e.clientX, e.clientY);
        arm = null;
      }
      if (!pd) return;
      e.preventDefault(); // no text selection while dragging
      pd.x = e.clientX;
      pd.y = e.clientY;
      over();
    }, true);
    window.addEventListener('mouseup', (e) => {
      arm = null;
      if (!pd) return;
      swallowClick = true; // the click that follows this mouseup isn't a click on a row
      setTimeout(() => { swallowClick = false; });
      finish(e.button === 0);
    }, true);
    window.addEventListener('click', (e) => {
      if (swallowClick) { swallowClick = false; e.stopPropagation(); e.preventDefault(); }
    }, true);
    window.addEventListener('keydown', (e) => {
      if (pd && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    }, true);
    window.addEventListener('blur', () => finish(false));
  }

  // ------------------------------------------------------------------ pinned folders (tabs)
  isPinned(path) {
    return this.pins.some((p) => samePath(p, path));
  }

  async pin(path) {
    if (!this.isPinned(path)) {
      this.pins.push(path);
      this.app.sessionSet('explorerPins', this.pins);
    }
    await this.showPin(path);
  }

  async unpin(path) {
    const i = this.pins.findIndex((p) => samePath(p, path));
    if (i < 0) return;
    this.pins.splice(i, 1);
    this.app.sessionSet('explorerPins', this.pins);
    if (samePath(this.viewRoot, path)) await this.showPin(this.pins[Math.min(i, this.pins.length - 1)] || null);
    else this.renderPins();
  }

  /** Shows a pinned folder's contents only (null: the whole project). */
  async showPin(path) {
    this.viewRoot = path && this.isPinned(path) ? path : this.root;
    this.expanded.add(this.viewRoot);
    this.app.sessionSet('explorerPin', samePath(this.viewRoot, this.root) ? null : this.viewRoot);
    this.renderPins();
    await this.render();
    this.onSearchInput();
  }

  renderPins() {
    if (!this.pins.length) {
      this.pinsEl.replaceChildren();
      this.pinsEl.classList.remove('show');
      return;
    }
    this.pinsEl.classList.add('show');
    const tab = (path, label, iconName, closable) => el('div.ex-pin' + (samePath(this.viewRoot, path) ? '.active' : ''), {
      title: closable ? `${relPath(this.root, path).replace(/\\/g, '/')}\n가운데 클릭: 고정 해제 · 끌어서 순서 바꾸기` : '프로젝트 전체',
      draggable: closable ? 'true' : null,
      onmousedown: (e) => {
        if (e.button === 1 && closable) { e.preventDefault(); this.unpin(path); }
        else if (e.button === 0 && !e.target.closest('.ex-pin-x')) this.showPin(closable ? path : null);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        contextMenu(e.clientX, e.clientY, closable ? [
          { label: '고정 해제', icon: 'pinned', action: () => this.unpin(path) },
          { label: '다른 고정 모두 해제', disabled: this.pins.length < 2, action: () => { this.pins = [path]; this.app.sessionSet('explorerPins', this.pins); this.showPin(path); } },
          '-',
          { label: '프로젝트 전체에서 보기', icon: 'target', action: () => this.showPin(null).then(() => this.reveal(path)) },
          { label: '파일 탐색기에서 열기', icon: 'folder-opened', action: () => window.papyrus.app.reveal(path) },
        ] : [
          { label: '고정 모두 해제', icon: 'pinned', action: () => { this.pins = []; this.app.sessionSet('explorerPins', []); this.showPin(null); } },
        ]);
      },
      ondragstart: (e) => { e.dataTransfer.setData('application/x-papyrus-pin', path); e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => { if (closable && e.dataTransfer.types.includes('application/x-papyrus-pin')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } },
      ondrop: (e) => {
        const from = e.dataTransfer.getData('application/x-papyrus-pin');
        if (!from || !closable || samePath(from, path)) return;
        e.preventDefault();
        const list = this.pins.filter((p) => !samePath(p, from));
        list.splice(list.findIndex((p) => samePath(p, path)), 0, from);
        this.pins = list;
        this.app.sessionSet('explorerPins', this.pins);
        this.renderPins();
      },
    },
    icon(iconName),
    el('span.ex-pin-name', null, label),
    closable ? el('span.ex-pin-x', { title: '고정 해제', onclick: (e) => { e.stopPropagation(); this.unpin(path); } }, icon('close')) : null);
    this.pinsEl.replaceChildren(
      tab(this.root, basename(this.root), 'root-folder', false),
      ...this.pins.map((p) => tab(p, basename(p), 'folder', true)));
    const act = this.pinsEl.querySelector('.ex-pin.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** The pinned folder showing `path` (deepest), else null. */
  pinFor(path) {
    const p = path.toLowerCase();
    return this.pins.filter((d) => p.startsWith(d.toLowerCase() + '\\') || p.startsWith(d.toLowerCase() + '/'))
      .sort((a, b) => b.length - a.length)[0] || null;
  }

  focusSearch() {
    this.searchInput.focus();
    this.searchInput.select();
  }

  // .cs files whose name contains the query: exact name first, then prefix, then anywhere.
  fileMatches(q) {
    const lq = q.toLowerCase();
    const out = [];
    const scope = this.viewRoot && !samePath(this.viewRoot, this.root) ? this.viewRoot.toLowerCase() + '\\' : null; // a pinned folder: only its scripts
    for (const p of this.app.fileIndex || []) {
      if (!/\.cs$/i.test(p)) continue;
      if (scope && !p.toLowerCase().startsWith(scope)) continue;
      const name = basename(p).slice(0, -3);
      const i = name.toLowerCase().indexOf(lq);
      if (i < 0) continue;
      const rank = name.length === lq.length ? 0 : i === 0 ? 1 : 2;
      out.push({ path: p, name, rank });
    }
    return out.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.path.localeCompare(b.path));
  }

  onSearchInput() {
    const q = this.searchInput.value.trim();
    this.search.query = null; // next Enter starts again from the first match
    this.searchCount.textContent = q ? `${this.fileMatches(q).length}개` : '';
    this.searchCount.classList.toggle('none', !!q && this.searchCount.textContent === '0개');
  }

  async onSearchKey(e) {
    if (e.key === 'Escape') {
      this.searchInput.value = '';
      this.onSearchInput();
      this.app.editors.editor.focus();
    } else if (e.key === 'Enter') {
      await this.searchStep(e.shiftKey ? -1 : 1);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  async searchStep(dir) {
    const q = this.searchInput.value.trim();
    if (!q) return;
    const S = this.search;
    if (S.query !== q) {
      const seq = ++S.seq;
      const items = this.fileMatches(q).map((f) => ({ path: f.path, name: f.name }));
      // classes whose file is named differently (several types in one file, etc.)
      const lsp = this.app.lsp;
      if (lsp.running) {
        const syms = await lsp.workspaceSymbols(q).catch(() => []);
        if (seq !== S.seq) return;
        const lq = q.toLowerCase();
        const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
        for (const s of syms) {
          if (!TYPE_KINDS.includes(s.kind) || !s.name.toLowerCase().includes(lq) || !s.location) continue;
          const path = monaco.Uri.parse(s.location.uri).fsPath;
          if (!/\.cs$/i.test(path) || items.some((it) => samePath(it.path, path) && it.name === s.name)) continue;
          if (this.root && !norm(path).startsWith(norm(this.viewRoot || this.root) + '/')) continue; // project (or pinned folder) files only
          const r = s.location.range;
          items.push({ path, name: s.name, line: r ? r.start.line + 1 : undefined, column: r ? r.start.character + 1 : undefined });
        }
      }
      S.query = q;
      S.items = items;
      S.index = dir > 0 ? -1 : 0;
    }
    if (!S.items.length) {
      this.searchCount.textContent = '0개';
      this.searchCount.classList.add('none');
      return;
    }
    S.index = (S.index + dir + S.items.length) % S.items.length;
    const it = S.items[S.index];
    this.searchCount.classList.remove('none');
    this.searchCount.textContent = `${S.index + 1}/${S.items.length}`;
    await this.app.editors.open(it.path, { preview: true, focus: false, ...(it.line ? { line: it.line, column: it.column } : {}) });
    await this.reveal(it.path);
    this.searchInput.focus(); // keep typing / pressing Enter here
  }

  async setRoot(root) {
    this.root = root;
    this.expanded = new Set([root]);
    this.children.clear();
    const saved = this.app.sessionGet('expanded');
    if (Array.isArray(saved)) saved.forEach((p) => this.expanded.add(p));
    else this.expanded.add(joinPath(root, 'Assets'));
    // pinned folders of this project (gone ones dropped)
    const pins = this.app.sessionGet('explorerPins');
    this.pins = [];
    for (const p of Array.isArray(pins) ? pins : []) if (typeof p === 'string' && (await ofs.exists(p))) this.pins.push(p);
    const pin = this.app.sessionGet('explorerPin');
    this.viewRoot = pin && this.isPinned(pin) ? pin : root;
    this.expanded.add(this.viewRoot);
    this.renderPins();
    await this.render();
  }

  async load(dir, force) {
    if (!force && this.children.has(dir)) return this.children.get(dir);
    const list = await ofs.listDir(dir);
    this.children.set(dir, list);
    return list;
  }

  async render() {
    if (!this.root) {
      this.el.replaceChildren();
      return;
    }
    // a pinned folder that was deleted / moved: back to the project
    if (this.viewRoot && !samePath(this.viewRoot, this.root) && !(await ofs.exists(this.viewRoot))) {
      this.pins = this.pins.filter((p) => !samePath(p, this.viewRoot));
      this.app.sessionSet('explorerPins', this.pins);
      this.viewRoot = this.root;
      this.renderPins();
    }
    const top = this.viewRoot || this.root;
    const rows = [];
    const walk = async (dir, depth) => {
      const list = await this.load(dir);
      for (const ent of list) {
        rows.push({ ...ent, depth });
        if (ent.dir && this.expanded.has(ent.path)) await walk(ent.path, depth + 1);
      }
    };
    rows.push({ name: basename(top), path: top, dir: true, depth: 0, isRoot: true, pinned: !samePath(top, this.root) });
    if (this.expanded.has(top)) await walk(top, 1);
    this.rows = rows;
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.append(this.row(r));
    this.el.replaceChildren(frag);
  }

  row(r) {
    const open = r.dir && this.expanded.has(r.path);
    const isSel = this.selected && samePath(this.selected, r.path);
    const inPin = this.viewRoot && !samePath(this.viewRoot, this.root);
    const dim = !inPin && r.depth === 1 && !['Assets', 'Packages'].includes(r.name) && r.dir;
    const cut = this.clipboard && this.clipboard.cut && samePath(this.clipboard.path, r.path);
    const row = el('div.tree-row' + (isSel ? '.selected' : '') + (dim ? '.dim' : '') + (cut ? '.cut' : ''), {
      style: { paddingLeft: 6 + r.depth * 16 + 'px' },
      'data-path': r.path,
      // dragged with the mouse (setupPointerDrag): onto a folder = move, onto the hierarchy /
      // inspector = attach the script / fill an object field
      ondragstart: (e) => e.preventDefault(), // dragged with the mouse instead (setupPointerDrag)
      onmousedown: (e) => {
        this.armDrag(e, r);
        if (e.button !== 0) return;
        this.select(r.path);
        if (r.dir && e.detail === 1 && e.target.closest('.twisty')) this.toggle(r.path);
      },
      onclick: (e) => {
        if (r.dir || e.detail !== 1) return;
        // scenes / prefabs / ScriptableObjects: show them decoded in the inspector, not as YAML text
        if (isInspectable(r.path)) this.app.inspector.preview(r.path);
        else this.app.editors.open(r.path, { preview: true, focus: false });
      },
      ondblclick: () => {
        if (r.dir) this.toggle(r.path);
        else if (isInspectable(r.path)) this.app.inspector.pin(r.path);
        else this.app.editors.open(r.path, { preview: false });
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.select(r.path);
        this.menu(r.path, r.dir, e.clientX, e.clientY);
      },
    },
    el('span.twisty', null, r.dir && !r.empty ? icon(open ? 'chevron-down' : 'chevron-right') : null),
    fileIcon(r.name, r.dir, open ? 'open' : ''),
    el('span.label', null, r.name),
    r.isRoot ? el('span.hint', null, r.pinned ? relPath(this.root, r.path).replace(/\\/g, '/')
      : this.app.project ? relPath('', this.app.project).replace(/\\/g, '/') : '') : null);
    return row;
  }

  isDir(path) {
    const r = this.rows.find((x) => samePath(x.path, path));
    return !!(r && r.dir);
  }

  select(path) {
    this.selected = path;
    this.el.querySelectorAll('.tree-row.selected').forEach((x) => x.classList.remove('selected'));
    const row = [...this.el.children].find((x) => samePath(x.dataset.path, path));
    if (row) row.classList.add('selected');
  }

  async toggle(path, force) {
    const open = force != null ? force : !this.expanded.has(path);
    if (open) this.expanded.add(path);
    else this.expanded.delete(path);
    await this.render();
    this.app.sessionSet('expanded', [...this.expanded]);
  }

  async reveal(path) {
    if (!this.root) return;
    // outside the pinned folder being shown: the pin that holds it, else the whole project
    const top0 = this.viewRoot || this.root;
    const inside = (d) => samePath(path, d) || path.toLowerCase().startsWith(d.toLowerCase() + '\\') || path.toLowerCase().startsWith(d.toLowerCase() + '/');
    if (!inside(top0)) {
      this.viewRoot = this.pinFor(path) || this.root;
      this.app.sessionSet('explorerPin', samePath(this.viewRoot, this.root) ? null : this.viewRoot);
      this.renderPins();
    }
    const top = this.viewRoot || this.root;
    let dir = dirname(path);
    const chain = [];
    while (dir && dir.length >= top.length && !samePath(dir, top)) {
      chain.unshift(dir);
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    this.expanded.add(top);
    chain.forEach((d) => this.expanded.add(d));
    await this.render();
    this.select(path);
    const row = [...this.el.children].find((x) => samePath(x.dataset.path, path));
    if (row) row.scrollIntoView({ block: 'center' });
    this.app.showTool('explorer');
  }

  async refresh(changedPaths) {
    if (!changedPaths) {
      this.children.clear();
      await this.render();
      return;
    }
    // the grandparent too: its listing says whether the folder is empty (expand arrow or not)
    const dirs = new Set(changedPaths.flatMap((p) => [dirname(p), dirname(dirname(p))]));
    let touched = false;
    for (const d of dirs) {
      for (const k of this.children.keys()) {
        if (samePath(k, d)) {
          this.children.delete(k);
          touched = true;
        }
      }
    }
    if (touched) await this.render();
  }

  onKey(e) {
    const idx = this.rows.findIndex((r) => samePath(r.path, this.selected));
    const cur = this.rows[idx];
    const go = (i) => {
      const r = this.rows[Math.max(0, Math.min(this.rows.length - 1, i))];
      if (!r) return;
      this.select(r.path);
      const row = [...this.el.children].find((x) => samePath(x.dataset.path, r.path));
      if (row) row.scrollIntoView({ block: 'nearest' });
    };
    switch (e.key) {
      case 'ArrowDown': go(idx + 1); break;
      case 'ArrowUp': go(idx - 1); break;
      case 'ArrowRight':
        if (cur && cur.dir && !this.expanded.has(cur.path)) this.toggle(cur.path, true);
        else go(idx + 1);
        break;
      case 'ArrowLeft':
        if (cur && cur.dir && this.expanded.has(cur.path)) this.toggle(cur.path, false);
        else if (cur) {
          const parent = this.rows.slice(0, idx).reverse().find((r) => r.depth < cur.depth);
          if (parent) go(this.rows.indexOf(parent));
        }
        break;
      case 'Enter':
        if (cur) {
          if (cur.dir) this.toggle(cur.path);
          else if (isInspectable(cur.path)) this.app.inspector.pin(cur.path);
          else this.app.editors.open(cur.path);
        }
        break;
      case 'F2':
      case 'F6':
        if (cur && (e.key === 'F2' || e.shiftKey)) this.rename(cur.path);
        break;
      case 'Delete':
        if (cur && !cur.isRoot) this.remove(cur.path);
        break;
      case 'Insert':
        if (e.altKey && cur) this.newMenu(cur.dir ? cur.path : dirname(cur.path));
        break;
      default: {
        // Ctrl+C / Ctrl+X / Ctrl+V like Rider's Solution Explorer; Ctrl+D = Rider's Copy... (F5 is Play here)
        const k = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey ? e.key.toLowerCase() : '';
        if (k === 'z') this.undo();
        else if (k === 'd' && cur && !cur.isRoot) this.copyTo(cur.path, dirname(cur.path));
        else if (k === 'c' && cur && !cur.isRoot) this.setClipboard(cur.path, false);
        else if (k === 'x' && cur && !cur.isRoot) this.setClipboard(cur.path, true);
        else if (k === 'v' && cur) this.paste(cur.dir ? cur.path : dirname(cur.path));
        else return;
      }
    }
    e.preventDefault();
  }

  // ------------------------------------------------------------------ undo (Ctrl+Z in the tree)
  // Moves and renames done here (drag & drop, cut/paste, F2). When nothing else was written since,
  // the project goes back to the local history label put down before it: the file returns with its
  // .meta, and what came with it (class rename, namespace fix) is undone too. Otherwise only the
  // file goes back.
  pushUndo(entry) {
    const e = { ...entry, endAt: Date.now() };
    this.undoStack = (this.undoStack || []).concat(e).slice(-30);
    return e;
  }

  async undo() {
    const e = (this.undoStack || []).pop();
    if (!e) {
      toast({ title: '되돌리기', message: '탐색기에서 되돌릴 이동·이름 바꾸기가 없어요.', timeout: 2000 });
      return;
    }
    const H = window.papyrus.history;
    let later = [];
    if (this.app.settings['history.enabled'] !== false) {
      try { later = (await H.recent(100)).filter((x) => x.t > e.endAt + 20); } catch { later = null; }
    }
    if (later && !later.length && this.app.settings['history.enabled'] !== false) {
      await this.app.localHistory.revertProject(e.T - 1, { quiet: true });
    }
    if (!(await ofs.exists(e.from))) {
      // something else changed since: only the file goes back
      if (!(await ofs.exists(e.to)) || (await ofs.exists(e.from))) {
        toast({ kind: 'warn', title: '되돌릴 수 없어요', message: `${basename(e.to)}이(가) 그 뒤로 다시 옮겨졌거나 같은 이름이 있어요.`, timeout: 3500 });
        return;
      }
      try {
        const tab = this.app.editors.findTab(e.to);
        if (tab && tab.dirty) await this.app.editors.save(tab);
        await ofs.rename(e.to, e.from);
        if (tab) {
          await this.app.editors.closeTab(tab, { force: true, noHistory: true });
          await this.app.editors.open(e.from);
        }
      } catch (err) {
        toast({ kind: 'error', title: '되돌릴 수 없어요', message: String(err.message || err) });
        return;
      }
    }
    this.expanded.add(dirname(e.from));
    await this.refresh([e.from, e.to]);
    this.select(e.from);
    this.app.unityRefreshSoon();
    toast({ title: '되돌렸어요', message: `${e.what}: ${basename(e.to)} → ${relPath(this.app.project, e.from)}`, timeout: 2500 });
  }

  // ------------------------------------------------------------------ copy / cut / paste
  setClipboard(path, cut) {
    this.clipboard = { path, cut };
    this.el.querySelectorAll('.tree-row.cut').forEach((r) => r.classList.remove('cut'));
    if (cut) {
      const row = [...this.el.children].find((x) => samePath(x.dataset.path, path));
      if (row) row.classList.add('cut');
    }
    navigator.clipboard.writeText(path).catch(() => {});
    toast({ title: cut ? '잘라냈어요' : '복사했어요', message: `${basename(path)} · 붙여넣을 폴더에서 Ctrl+V`, timeout: 1800 });
  }

  async paste(dir) {
    const c = this.clipboard;
    if (!c) return;
    if (!(await ofs.exists(c.path))) {
      this.clipboard = null;
      toast({ kind: 'warn', title: '붙여넣을 파일이 없어졌어요', message: basename(c.path), timeout: 3000 });
      return;
    }
    if (c.cut) {
      await this.moveTo(c.path, dir);
      this.clipboard = null;
    } else {
      await this.copyTo(c.path, dir);
    }
  }

  /** "Name.cs" -> "Name1.cs", "Name2.cs"... the first name not taken in dir. */
  async freeName(dir, name, isDir) {
    const dot = isDir ? -1 : name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const base = stem.replace(/\d+$/, '');
    for (let i = 1; i < 1000; i++) {
      const n = `${base}${i}${ext}`;
      if (!(await ofs.exists(joinPath(dir, n)))) return n;
    }
    return name;
  }

  /** Rider's Copy dialog: pick the new name; for a script optionally rename the class in the copy. */
  async copyTo(path, dir) {
    const old = basename(path);
    const isDir = this.isDir(path) || !!(await ofs.stat(path) || {}).dir;
    const isCs = !isDir && /\.cs$/i.test(old);
    const suggested = (await ofs.exists(joinPath(dir, old))) ? await this.freeName(dir, old, isDir) : old;
    const dot = isDir ? -1 : suggested.lastIndexOf('.');
    const r = await prompt({
      title: isCs ? '스크립트 복사' : '복사',
      sub: `${relPath(this.app.project, path)} → ${relPath(this.app.project, dir) || '.'}`,
      value: suggested,
      select: [0, dot > 0 ? dot : suggested.length],
      check: isCs ? {
        label: '클래스 이름도 새 파일 이름으로 바꾸기',
        checked: this.app.settings[COPY_CLASS_KEY] !== false,
        onChange: (v) => this.app.setSetting(COPY_CLASS_KEY, v),
      } : null,
    });
    let name = r && (typeof r === 'string' ? r : r.value).trim();
    if (!name) return;
    if (isCs && !/\.cs$/i.test(name)) name += '.cs';
    const to = joinPath(dir, name);
    if (samePath(to, path)) {
      toast({ kind: 'warn', title: '같은 이름으로는 복사할 수 없어요', message: name, timeout: 3000 });
      return;
    }
    // a script copy that keeps the class name is a duplicate type: Unity won't compile it
    const renameClass = isCs && r.checked;
    const oldClass = old.slice(0, -3);
    const newClass = name.slice(0, -3);
    if (renameClass && oldClass !== newClass && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newClass)) {
      toast({ kind: 'error', title: '클래스 이름으로 쓸 수 없는 이름이에요', message: newClass });
      return;
    }
    try {
      if (isCs) await this.copyScript(path, to, { renameClass, oldClass, newClass });
      else await ofs.copy(path, to);
      if (isDir) await this.fixFolderCopy(path, to);
    } catch (err) {
      toast({ kind: 'error', title: '복사할 수 없어요', message: String(err.message || err) });
      return;
    }
    this.expanded.add(dir);
    await this.refresh([to]);
    this.select(to);
    if (isCs) await this.app.editors.open(to);
    this.app.unityRefreshSoon();
  }

  /**
   * Writes the copy of a script so it compiles next to the original (only the copy is touched):
   * - renamed copy: the file's main type (named like the file, else its only / component type) gets
   *   the new name with every reference inside the file; the file's other top-level types (enums,
   *   data classes, delegates) are left out, the original still declares them (no CS0101).
   * - same name in another folder: the copy moves to that folder's namespace instead.
   */
  async copyScript(from, to, { renameClass, oldClass, newClass }) {
    // copy what the user sees: unsaved edits of the original go into the copy too
    const tab = this.app.editors.findTab(from);
    const text = tab && tab.model ? tab.model.getValue() : (await ofs.readFile(from)).text || '';
    const sameAsm = this.assemblyOf(dirname(from)) === this.assemblyOf(dirname(to));
    if (renameClass && oldClass !== newClass) {
      const r = fixScriptCopy(text, { fileClass: oldClass, newClass, dropOthers: sameAsm });
      await ofs.createFile(to, r.text);
      if (!r.main) toast({ kind: 'warn', title: '클래스 이름은 그대로 뒀어요', message: '이 파일에서 타입 선언을 찾지 못했어요.', timeout: 5000 });
      else if (r.removed.length) {
        toast({ title: '복사본에서 뺀 타입', message: `${r.removed.join(', ')} — 원본 파일에 그대로 있어서 복사본도 같이 써요 (이름이 겹치면 컴파일이 안 돼요).`, timeout: 6000 });
      }
      return;
    }
    await ofs.createFile(to, text);
    if (!sameAsm) return; // another assembly: the same names don't clash
    const types = topLevelTypes(text);
    if (!types.length) return;
    const oldNs = (/^[ \t]*namespace\s+([\w.]+)\s*[;{]/m.exec(text) || [])[1] || '';
    const newNs = samePath(dirname(from), dirname(to)) ? '' : await this.app.refactor.namespaceForDir(dirname(to));
    if (newNs && newNs !== oldNs) {
      await this.app.refactor.changeNamespace(to, oldNs, newNs, []);
      toast({ title: '네임스페이스를 바꿨어요', message: `같은 이름의 타입이 겹치지 않게 복사본을 '${newNs}'(으)로 옮겼어요.`, timeout: 5000 });
    } else {
      toast({ kind: 'warn', title: '같은 이름의 타입이 두 개예요', message: `${types.map((t) => t.name).join(', ')} — 이름이나 네임스페이스를 바꾸기 전까지 Unity가 컴파일하지 못해요.`, timeout: 6000 });
    }
  }

  /**
   * A copied folder re-declares all its scripts' types. Copied .asmdef files get a new assembly name
   * (two assemblies can't share one); scripts outside them go into the new folder's namespace.
   */
  async fixFolderCopy(from, to) {
    const files = await ofs.listAllFiles(to);
    const asmdefs = files.filter((f) => /\.asmdef$/i.test(f));
    const taken = new Set();
    for (const f of [...(this.app.fileIndex || []), ...asmdefs]) {
      if (!/\.asmdef$/i.test(f)) continue;
      try { taken.add(JSON.parse((await ofs.readFile(f)).text || '{}').name); } catch { /* broken asmdef */ }
    }
    for (const a of asmdefs) {
      try {
        const raw = (await ofs.readFile(a)).text || '{}';
        const json = JSON.parse(raw.replace(/^﻿/, ''));
        if (!json.name) continue;
        const stem = json.name.replace(/\d+$/, '');
        let i = 1;
        while (taken.has(`${stem}${i}`)) i++;
        json.name = `${stem}${i}`;
        taken.add(json.name);
        await ofs.writeFile(a, JSON.stringify(json, null, 4) + '\n');
      } catch { /* leave it as it is */ }
    }
    if (this.assemblyOf(dirname(from)) !== this.assemblyOf(dirname(to))) return;
    const ownAsm = (f) => asmdefs.some((a) => (f.toLowerCase()).startsWith(dirname(a).toLowerCase() + '\\'));
    const scripts = files.filter((f) => /\.cs$/i.test(f) && !ownAsm(f));
    if (!scripts.length) return;
    const newNs = await this.app.refactor.namespaceForDir(to);
    let moved = 0;
    for (const f of scripts) {
      const text = (await ofs.readFile(f)).text || '';
      if (!topLevelTypes(text).length) continue;
      const oldNs = (/^[ \t]*namespace\s+([\w.]+)\s*[;{]/m.exec(text) || [])[1] || '';
      if (!newNs || oldNs === newNs) continue;
      await this.app.refactor.changeNamespace(f, oldNs, newNs, []);
      moved++;
    }
    if (moved) toast({ title: '네임스페이스를 바꿨어요', message: `복사한 스크립트 ${moved}개를 '${newNs}'(으)로 옮겨서 원본과 이름이 겹치지 않아요.`, timeout: 5000 });
  }

  /** The assembly a folder's scripts compile into: nearest .asmdef/.asmref, else Unity's predefined ones. */
  assemblyOf(dir) {
    const d = dir.toLowerCase() + '\\';
    let best = null;
    for (const f of this.app.fileIndex || []) {
      if (!/\.asm(def|ref)$/i.test(f)) continue;
      const ad = dirname(f).toLowerCase() + '\\';
      if (d.startsWith(ad) && (!best || ad.length > best.length)) best = ad;
    }
    return best || predefinedAssembly(relPath(this.app.project, dir));
  }

  /** Cut + paste: move the file with its .meta (Unity keeps the GUID, so references survive). */
  async moveTo(path, dir, { offerNamespace = true } = {}) {
    if (samePath(dirname(path), dir)) return;
    let name = basename(path);
    if (await ofs.exists(joinPath(dir, name))) {
      const v = await prompt({ title: '이동', sub: `'${name}'이(가) 이미 있어요. 새 이름:`, value: await this.freeName(dir, name, this.isDir(path)) });
      if (!v || !v.trim()) return;
      name = v.trim();
    }
    const to = joinPath(dir, name);
    const T = Date.now();
    await this.app.localHistory.label(`이동: ${basename(path)} → ${relPath(this.app.project, dir) || '/'}`);
    try {
      const tab = this.app.editors.findTab(path);
      if (tab && tab.dirty) await this.app.editors.save(tab);
      await ofs.rename(path, to);
      if (tab) {
        await this.app.editors.closeTab(tab, { force: true, noHistory: true });
        await this.app.editors.open(to);
      }
    } catch (err) {
      toast({ kind: 'error', title: '이동할 수 없어요', message: String(err.message || err) });
      return;
    }
    this.expanded.add(dir);
    await this.refresh([path, to]);
    this.select(to);
    this.app.unityRefreshSoon();
    const undo = this.pushUndo({ what: '이동', from: path, to, T });
    if (offerNamespace) {
      const isDir = !!((await ofs.stat(to)) || {}).dir;
      const scripts = isDir ? (await ofs.listAllFiles(to)).filter((f) => /\.cs$/i.test(f)) : /\.cs$/i.test(to) ? [to] : [];
      // where each script was before the move
      const fromDirOf = (f) => dirname(isDir ? path + f.slice(to.length) : path);
      if (scripts.length) this.offerNamespaceFix(scripts.slice(0, 500), fromDirOf, undo).catch(() => {});
    }
  }

  menu(path, isDir, x, y) {
    const dir = isDir ? path : dirname(path);
    const ext = isDir ? '' : extname(path);
    const ins = this.app.inspector;
    const live = this.app.unityStatus.state === 'connected';
    const sel = ins.selected && typeof ins.selected.id === 'number' ? ins.selected : null;
    const unityItems = [];
    if (ext === '.cs') {
      unityItems.push(
        { label: sel ? '선택한 오브젝트에 붙이기' : '선택한 오브젝트에 붙이기 (인스펙터에서 먼저 고르세요)', icon: 'symbol-class', disabled: !live || !sel, action: () => ins.attachScript(sel.id, path) },
        { label: '이 스크립트로 새 오브젝트 만들기', icon: 'add', disabled: !live, action: () => ins.createObject({ scriptPath: path }) },
        { label: 'ScriptableObject 에셋 만들기', icon: 'symbol-structure', disabled: !live, action: () => ins.createAsset(path) },
        '-');
    } else if (isInspectable(path)) {
      unityItems.push(
        { label: '인스펙터에 고정', icon: 'lock', action: () => ins.pin(path) },
        { label: '텍스트로 열기', icon: 'file-code', action: () => this.app.editors.open(path, { preview: false }) },
        '-');
    }
    contextMenu(x, y, [
      ...unityItems,
      { label: '새 폴더…', icon: 'new-folder', action: () => this.newFolder(dir) },
      { label: '새 C# 스크립트…', icon: 'symbol-class', key: this.app.kb('papyrus.newScript'), action: () => this.newScript(dir) },
      { label: '새 파일…', icon: 'new-file', action: () => this.newFile(dir) },
      '-',
      { label: '잘라내기', icon: 'clippy', key: 'Ctrl+X', disabled: samePath(path, this.root), action: () => this.setClipboard(path, true) },
      { label: '복사', icon: 'copy', key: 'Ctrl+C', disabled: samePath(path, this.root), action: () => this.setClipboard(path, false) },
      { label: this.clipboard ? `붙여넣기 (${basename(this.clipboard.path)})` : '붙여넣기', icon: 'clippy', key: 'Ctrl+V', disabled: !this.clipboard, action: () => this.paste(dir) },
      { label: '복제…', icon: 'files', key: 'Ctrl+D', disabled: samePath(path, this.root), action: () => this.copyTo(path, dirname(path)) },
      '-',
      { label: '이름 바꾸기…', icon: 'edit', key: 'F2', disabled: samePath(path, this.root), action: () => this.rename(path) },
      { label: '삭제', icon: 'trash', key: 'Delete', disabled: samePath(path, this.root), action: () => this.remove(path) },
      ...(isDir || ext === '.cs' ? [{ label: '네임스페이스를 폴더에 맞추기…', icon: 'symbol-namespace', action: () => this.adjustNamespaces(path, isDir) }] : []),
      ...(isDir && !samePath(path, this.root) ? [this.isPinned(path)
        ? { label: '고정 해제', icon: 'pinned', action: () => this.unpin(path) }
        : { label: '탭으로 고정', icon: 'pin', action: () => this.pin(path) }] : []),
      '-',
      ...(isDir ? [] : [{ label: '로컬 히스토리…', icon: 'history', action: () => this.app.localHistory.showFile(path) }]),
      { label: '경로 복사', icon: 'link', action: () => navigator.clipboard.writeText(path) },
      { label: '파일 탐색기에서 열기', icon: 'folder-opened', action: () => window.papyrus.app.reveal(path) },
      { label: '새로고침', icon: 'refresh', action: () => this.refresh() },
    ]);
  }

  newMenu(dir) {
    const r = this.el.querySelector('.tree-row.selected');
    const b = r ? r.getBoundingClientRect() : { left: 100, bottom: 100 };
    contextMenu(b.left + 30, b.bottom, [
      { label: '새 폴더…', icon: 'new-folder', action: () => this.newFolder(dir) },
      { label: '새 C# 스크립트…', icon: 'symbol-class', key: this.app.kb('papyrus.newScript'), action: () => this.newScript(dir) },
      { label: '새 파일…', icon: 'new-file', action: () => this.newFile(dir) },
    ]);
  }

  /** Scripts in a folder (and below) or the one script, through the namespace dialog. */
  async adjustNamespaces(path, isDir) {
    const files = isDir ? (await ofs.listAllFiles(path)).filter((f) => /\.cs$/i.test(f)) : [path];
    await this.app.refactor.adjustNamespaces(files);
  }

  /** Scripts that followed their folder's namespace before a move: offer to follow the new folder. */
  async offerNamespaceFix(scripts, fromDirOf, undo) {
    const follow = [];
    for (const f of scripts) {
      const text = (await ofs.readFile(f)).text || '';
      const ns = (/^[ \t]*namespace\s+([\w.]+)\s*[;{]/m.exec(text) || [])[1] || '';
      if (!topLevelTypes(text).length) continue;
      const was = await this.app.refactor.namespaceForDir(fromDirOf(f));
      const now = await this.app.refactor.namespaceForDir(dirname(f));
      if (ns && ns === was && now !== was) follow.push(f);
    }
    if (!follow.length) return;
    toast({
      title: '네임스페이스도 옮길까요?',
      message: follow.length === 1 ? `${basename(follow[0])}의 네임스페이스가 예전 폴더 기준이에요.` : `스크립트 ${follow.length}개의 네임스페이스가 예전 폴더 기준이에요.`,
      // taken right after the move: Ctrl+Z in the explorer undoes both
      actions: [{ label: '폴더에 맞추기', action: async () => { await this.app.refactor.adjustNamespaces(follow, { tickAll: true }); if (undo) undo.endAt = Date.now(); } }],
      timeout: 12000,
    });
  }

  async guessNamespace(dir) {
    // like the scripts around (folder namespaces in Rider style, one shared namespace, or none),
    // else the nearest asmdef's rootNamespace (Unity default)
    const s = await this.app.refactor.suggestNamespace(dir).catch(() => undefined);
    if (s !== undefined) return s;
    return this.app.rootNamespaceFor ? this.app.rootNamespaceFor(dir) : '';
  }

  async newScript(dir) {
    const r = await prompt({
      title: '새 C# 스크립트',
      sub: relPath(this.app.project, dir),
      placeholder: 'PlayerController',
      choices: [
        { value: 'mono', label: 'MonoBehaviour', icon: 'symbol-class' },
        { value: 'so', label: 'ScriptableObject', icon: 'symbol-structure' },
        { value: 'cls', label: '클래스', icon: 'symbol-class' },
        { value: 'iface', label: '인터페이스', icon: 'symbol-interface' },
        { value: 'editor', label: 'EditorWindow', icon: 'window' },
      ],
    });
    if (!r || !r.value.trim()) return;
    const name = r.value.trim().replace(/\.cs$/i, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      toast({ kind: 'error', title: '클래스 이름으로 쓸 수 없는 이름이에요', message: name });
      return;
    }
    const ns = await this.guessNamespace(dir);
    const text = TEMPLATES[r.choice](name, ns).replace(/\n/g, '\r\n');
    const p = joinPath(dir, name + '.cs');
    try {
      await ofs.createFile(p, text);
    } catch (err) {
      toast({ kind: 'error', title: '만들 수 없어요', message: String(err.message || err) });
      return;
    }
    this.expanded.add(dir);
    await this.refresh([p]);
    const tab = await this.app.editors.open(p);
    if (tab && tab.model) {
      // put the caret inside Start() / the class body
      const lines = tab.model.getLinesContent();
      const i = lines.findIndex((l, k) => k > 0 && /^\s+$/.test(l));
      if (i >= 0) this.app.editors.editor.setPosition({ lineNumber: i + 1, column: lines[i].length + 1 });
    }
    this.app.unityRefreshSoon();
  }

  async newFile(dir) {
    const name = await prompt({ title: '새 파일', sub: relPath(this.app.project, dir), placeholder: 'notes.txt' });
    if (!name) return;
    const p = joinPath(dir, name.trim());
    try {
      await ofs.createFile(p, '');
    } catch (err) {
      toast({ kind: 'error', title: '만들 수 없어요', message: String(err.message || err) });
      return;
    }
    this.expanded.add(dir);
    await this.refresh([p]);
    this.app.editors.open(p);
  }

  async newFolder(dir) {
    const name = await prompt({ title: '새 폴더', sub: relPath(this.app.project, dir), placeholder: 'Scripts' });
    if (!name) return;
    const p = joinPath(dir, name.trim());
    await ofs.createFolder(p);
    this.expanded.add(dir);
    await this.refresh([p]);
    this.select(p);
  }

  async rename(path) {
    const old = basename(path);
    const dot = old.lastIndexOf('.');
    const isCs = /\.cs$/i.test(old);
    const r = await prompt({
      title: '이름 바꾸기',
      sub: relPath(this.app.project, path),
      value: old,
      select: [0, dot > 0 ? dot : old.length],
      // remembered across renames and restarts
      check: isCs ? {
        label: '클래스 이름도 같이 바꾸기',
        checked: !!this.app.settings[RENAME_CLASS_KEY],
        onChange: (v) => this.app.setSetting(RENAME_CLASS_KEY, v),
      } : null,
    });
    const name = r && (typeof r === 'string' ? r : r.value).trim();
    if (!name || name === old) return;
    const to = joinPath(dirname(path), name);
    const T = Date.now();
    await this.app.localHistory.label(`이름 바꾸기: ${old} → ${name}`);
    try {
      if (isCs && r.checked && /\.cs$/i.test(name)) await this.renameClassForFile(path, old.slice(0, -3), name.slice(0, -3));
      const tab = this.app.editors.findTab(path);
      if (tab && tab.dirty) await this.app.editors.save(tab);
      if (!(await ofs.exists(path)) && (await ofs.exists(to))) {
        // the language server's rename already moved the file along with the class
        await this.refresh([path, to]);
        this.select(to);
        this.app.unityRefreshSoon();
        this.pushUndo({ what: '이름 바꾸기', from: path, to, T });
        return;
      }
      await ofs.rename(path, to);
      if (tab) {
        await this.app.editors.closeTab(tab, { force: true, noHistory: true });
        await this.app.editors.open(to);
      }
      await this.refresh([path, to]);
      this.select(to);
      this.app.unityRefreshSoon();
      this.pushUndo({ what: '이름 바꾸기', from: path, to, T });
    } catch (err) {
      toast({ kind: 'error', title: '이름을 바꿀 수 없어요', message: String(err.message || err) });
    }
  }

  // Renames the type named like the file (Foo.cs -> class Foo) everywhere via the language server,
  // the same as F2 on the class name. Open files it touches are left unsaved, like F2.
  async renameClassForFile(path, oldName, newName) {
    if (oldName === newName) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
      toast({ kind: 'warn', title: '클래스 이름은 그대로 뒀어요', message: `'${newName}'은(는) 클래스 이름으로 쓸 수 없어요.` });
      return;
    }
    const lsp = this.app.lsp;
    if (!lsp.running || !lsp.caps || !lsp.caps.renameProvider) {
      toast({ kind: 'warn', title: '클래스 이름은 그대로 뒀어요', message: 'C# 언어 서버가 준비된 뒤에 다시 시도하세요.' });
      return;
    }
    const tab = this.app.editors.findTab(path);
    const text = tab && tab.model ? tab.model.getValue() : (await ofs.readFile(path)).text || '';
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const decl = new RegExp(`\\b(?:class|struct|interface|enum|record)\\s+(${esc})\\b`).exec(text);
    if (!decl) {
      toast({ kind: 'warn', title: '클래스 이름은 그대로 뒀어요', message: `이 파일에 '${oldName}' 클래스가 없어요.` });
      return;
    }
    const offset = decl.index + decl[0].length - oldName.length;
    const before = text.slice(0, offset).split(/\r?\n/);
    const position = { line: before.length - 1, character: before[before.length - 1].length };
    const uri = monaco.Uri.file(path).toString();
    const edit = await lsp.request('textDocument/rename', { textDocument: { uri }, position, newName });
    if (!edit) return;
    const E = this.app.editors;
    const wasDirty = new Set(E.dirtyTabs);
    await E.applyWorkspaceEdit(edit);
    // The file now holds the new class name, so the usages must reach disk too or Unity compiles
    // a half-renamed project. Save only what this rename touched; leave the user's own edits.
    for (const t of E.dirtyTabs) if (!wasDirty.has(t)) await E.save(t);
  }

  async remove(path) {
    if (!(await this.confirmDelete(path))) return;
    const tab = this.app.editors.findTab(path);
    if (tab) await this.app.editors.closeTab(tab, { force: true });
    try {
      await ofs.trash(path);
    } catch (err) {
      toast({ kind: 'error', title: '삭제 실패', message: String(err.message || err) });
    }
    await this.refresh([path]);
    this.app.unityRefreshSoon();
  }

  /**
   * Rider-style delete dialog. Resolves true to delete. For a C# script, "안전 삭제" (on by default)
   * first looks up who uses its class; if anyone does, the dialog lists the usages (click one to
   * jump there) and asks "그래도 삭제" instead of deleting right away.
   */
  async confirmDelete(path) {
    const st = await ofs.stat(path);
    const isDir = !!(st && st.dir);
    const name = basename(path);
    const cls = name.replace(/\.cs$/i, '');
    const isCs = !isDir && /\.cs$/i.test(name);
    const lsp = this.app.lsp;
    const canSearch = !!(isCs && lsp && lsp.running && lsp.caps && lsp.caps.referencesProvider);
    let count = 0;
    if (isDir) {
      const norm = (p) => p.replace(/\//g, '\\').toLowerCase();
      const pre = norm(path).replace(/\\+$/, '') + '\\';
      count = (this.app.fileIndex || []).filter((f) => norm(f).startsWith(pre)).length;
    }
    let safe = canSearch;
    try { if (localStorage.getItem(SAFE_DELETE_KEY) === '0') safe = false; } catch { /* default on */ }

    return new Promise((resolve) => {
      const body = el('div.cd-body');
      const foot = el('div.cd-foot');
      const prevFocus = document.activeElement;
      const close = (v) => {
        back.remove();
        if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus(); // back to the tree row
        resolve(v);
      };
      const back = el('div.dialog-back.cd-back', {
        tabindex: '-1',
        onmousedown: (e) => { if (e.target === back) close(false); },
        onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); } },
      }, el('div.cd-dialog', { role: 'dialog', 'aria-label': '삭제' },
        el('div.cd-head', null,
          el('span.cd-title', null, '삭제'),
          el('button.cd-x', { title: '닫기 (Esc)', onclick: () => close(false) }, icon('close'))),
        body, foot));

      const ask = () => {
        const box = el('input', {
          type: 'checkbox', checked: safe, disabled: !canSearch,
          onchange: () => { safe = box.checked; try { localStorage.setItem(SAFE_DELETE_KEY, safe ? '1' : '0'); } catch { /* ignore */ } },
        });
        const what = isDir
          ? `'${name}' 폴더${count ? `와 안의 파일 ${count}개를` : '를'} 삭제할까요?`
          : `'${name}' 파일을 삭제할까요?`;
        body.replaceChildren(
          el('div.cd-main', null, fileIcon(name, isDir),
            el('div.cd-text', null,
              el('div.cd-msg', null, what),
              el('div.cd-path', { title: path }, relPath(this.app.project, path)))),
          isCs ? el('label.cd-check' + (canSearch ? '' : '.disabled'), null, box,
            el('span', null, '안전 삭제 (사용처 검색)'),
            canSearch ? null : el('span.cd-hint', null, 'C# 언어 서버 준비 중')) : null,
          el('div.cd-note', null, icon('info'),
            el('span', null, isDir ? '안의 .meta 파일까지 휴지통으로 옮겨져요. 휴지통에서 되돌릴 수 있어요.' : '.meta 파일도 함께 휴지통으로 옮겨져요. 휴지통에서 되돌릴 수 있어요.')));
        const ok = el('button.btn.primary', { onclick: () => (safe && canSearch ? search() : close(true)) }, '삭제');
        foot.replaceChildren(el('button.btn', { onclick: () => close(false) }, '취소'), ok);
        ok.focus();
      };

      const search = async () => {
        body.replaceChildren(el('div.cd-busy', null, icon('loading', 'codicon-modifier-spin'), `'${cls}'의 사용처를 찾는 중…`));
        const cancel = el('button.btn', { onclick: () => close(false) }, '취소');
        foot.replaceChildren(cancel);
        cancel.focus();
        let refs = null;
        try { refs = await this.findTypeUsages(path, cls); } catch { refs = null; }
        if (!back.isConnected) return; // cancelled meanwhile
        if (refs && !refs.length) return close(true);
        usages(refs);
      };

      const usages = (refs) => {
        const kids = [];
        if (!refs) {
          kids.push(el('div.cd-warn', null, icon('warning'), el('div', null,
            el('div.cd-msg', null, '사용처를 확인하지 못했어요'),
            el('div.cd-sub', null, '언어 서버가 응답하지 않았어요. 그래도 삭제할 수 있어요.'))));
        } else {
          const files = new Set(refs.map((r) => r.path.toLowerCase())).size;
          kids.push(el('div.cd-warn', null, icon('warning'), el('div', null,
            el('div.cd-msg', null, `'${cls}'을(를) 사용하는 곳이 ${refs.length}곳 있어요`),
            el('div.cd-sub', null, `파일 ${files}개 · 삭제하면 이 코드는 컴파일되지 않아요.`))));
          kids.push(el('div.cd-list', null, refs.slice(0, 200).map((r) => el('div.cd-use', {
            title: `${relPath(this.app.project, r.path)}:${r.line + 1}`,
            onclick: () => {
              close(false);
              this.app.editors.open(r.path, { line: r.line + 1, column: r.character + 1, pushHistory: true });
            },
          }, fileIcon(basename(r.path), false),
          el('span.cd-file', null, basename(r.path)),
          el('span.cd-ln', null, `:${r.line + 1}`),
          el('span.cd-code', null, r.text.trim())))));
        }
        body.replaceChildren(...kids);
        const cancel = el('button.btn', { onclick: () => close(false) }, '취소');
        foot.replaceChildren(cancel, el('button.btn.danger', { onclick: () => close(true) }, '그래도 삭제'));
        cancel.focus();
      };

      document.getElementById('overlay-root').append(back);
      ask();
    });
  }

  /** Where the file's own class (named like the file) is used in other files, via Roslyn. */
  async findTypeUsages(path, cls) {
    const tab = this.app.editors.findTab(path);
    const text = tab && tab.model ? tab.model.getValue() : (await ofs.readFile(path)).text || '';
    const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const decl = new RegExp(`\\b(?:class|struct|interface|enum|record)\\s+(${esc})\\b`).exec(text);
    if (!decl) return []; // no type named after the file: nothing to break
    const offset = decl.index + decl[0].length - cls.length;
    const before = text.slice(0, offset).split(/\r?\n/);
    const position = { line: before.length - 1, character: before[before.length - 1].length };
    const req = this.app.lsp.request('textDocument/references', {
      textDocument: { uri: monaco.Uri.file(path).toString() },
      position,
      context: { includeDeclaration: false },
    });
    const res = await Promise.race([req, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))]);
    const lines = new Map(); // file -> its lines, read once
    const out = [];
    for (const loc of res || []) {
      const p = monaco.Uri.parse(loc.uri).fsPath;
      if (!p || samePath(p, path)) continue; // the class using itself doesn't count
      if (!lines.has(p)) {
        const t = this.app.editors.findTab(p);
        let src = '';
        try { src = t && t.model ? t.model.getValue() : (await ofs.readFile(p)).text || ''; } catch { /* unreadable */ }
        lines.set(p, src.split(/\r?\n/));
      }
      out.push({ path: p, line: loc.range.start.line, character: loc.range.start.character, text: lines.get(p)[loc.range.start.line] || '' });
    }
    return out;
  }
}
