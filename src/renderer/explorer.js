// Explorer tool window: lazy file tree of the Unity project.
import { el, icon, basename, dirname, joinPath, fileIcon, contextMenu, prompt, toast, samePath, relPath } from './ui.js';

const ofs = window.papyrus.fs;

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
        this.menu(this.root, true, e.clientX, e.clientY);
      }
    });
  }

  async setRoot(root) {
    this.root = root;
    this.expanded = new Set([root]);
    this.children.clear();
    const saved = this.app.sessionGet('expanded');
    if (Array.isArray(saved)) saved.forEach((p) => this.expanded.add(p));
    else this.expanded.add(joinPath(root, 'Assets'));
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
    const rows = [];
    const walk = async (dir, depth) => {
      const list = await this.load(dir);
      for (const ent of list) {
        rows.push({ ...ent, depth });
        if (ent.dir && this.expanded.has(ent.path)) await walk(ent.path, depth + 1);
      }
    };
    rows.push({ name: basename(this.root), path: this.root, dir: true, depth: 0, isRoot: true });
    if (this.expanded.has(this.root)) await walk(this.root, 1);
    this.rows = rows;
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.append(this.row(r));
    this.el.replaceChildren(frag);
  }

  row(r) {
    const open = r.dir && this.expanded.has(r.path);
    const isSel = this.selected && samePath(this.selected, r.path);
    const dim = r.depth === 1 && !['Assets', 'Packages'].includes(r.name) && r.dir;
    const row = el('div.tree-row' + (isSel ? '.selected' : '') + (dim ? '.dim' : ''), {
      style: { paddingLeft: 6 + r.depth * 16 + 'px' },
      'data-path': r.path,
      onmousedown: (e) => {
        if (e.button !== 0) return;
        this.select(r.path);
        if (r.dir && e.detail === 1 && e.target.closest('.twisty')) this.toggle(r.path);
      },
      onclick: (e) => {
        if (!r.dir && e.detail === 1) this.app.editors.open(r.path, { preview: true, focus: false });
      },
      ondblclick: () => {
        if (r.dir) this.toggle(r.path);
        else this.app.editors.open(r.path, { preview: false });
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.select(r.path);
        this.menu(r.path, r.dir, e.clientX, e.clientY);
      },
    },
    el('span.twisty', null, r.dir ? icon(open ? 'chevron-down' : 'chevron-right') : null),
    fileIcon(r.name, r.dir, open ? 'open' : ''),
    el('span.label', null, r.name),
    r.isRoot ? el('span.hint', null, this.app.project ? relPath('', this.app.project).replace(/\\/g, '/') : '') : null);
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
    let dir = dirname(path);
    const chain = [];
    while (dir && dir.length >= this.root.length && !samePath(dir, this.root)) {
      chain.unshift(dir);
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    this.expanded.add(this.root);
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
    const dirs = new Set(changedPaths.map((p) => dirname(p)));
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
      default:
        return;
    }
    e.preventDefault();
  }

  menu(path, isDir, x, y) {
    const dir = isDir ? path : dirname(path);
    contextMenu(x, y, [
      { label: '새 C# 스크립트…', icon: 'symbol-class', key: this.app.kb('papyrus.newScript'), action: () => this.newScript(dir) },
      { label: '새 파일…', icon: 'new-file', action: () => this.newFile(dir) },
      { label: '새 폴더…', icon: 'new-folder', action: () => this.newFolder(dir) },
      '-',
      { label: '이름 바꾸기…', icon: 'edit', key: 'F2', disabled: samePath(path, this.root), action: () => this.rename(path) },
      { label: '삭제', icon: 'trash', key: 'Delete', disabled: samePath(path, this.root), action: () => this.remove(path) },
      '-',
      { label: '경로 복사', icon: 'copy', action: () => navigator.clipboard.writeText(path) },
      { label: '파일 탐색기에서 열기', icon: 'folder-opened', action: () => window.papyrus.app.reveal(path) },
      { label: '새로고침', icon: 'refresh', action: () => this.refresh() },
    ]);
  }

  newMenu(dir) {
    const r = this.el.querySelector('.tree-row.selected');
    const b = r ? r.getBoundingClientRect() : { left: 100, bottom: 100 };
    contextMenu(b.left + 30, b.bottom, [
      { label: '새 C# 스크립트…', icon: 'symbol-class', action: () => this.newScript(dir) },
      { label: '새 파일…', icon: 'new-file', action: () => this.newFile(dir) },
      { label: '새 폴더…', icon: 'new-folder', action: () => this.newFolder(dir) },
    ]);
  }

  guessNamespace(dir) {
    // Use the nearest asmdef's rootNamespace if any; otherwise none (Unity default).
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
    const name = await prompt({ title: '이름 바꾸기', sub: relPath(this.app.project, path), value: old, select: [0, dot > 0 ? dot : old.length] });
    if (!name || name === old) return;
    const to = joinPath(dirname(path), name.trim());
    try {
      const tab = this.app.editors.findTab(path);
      if (tab && tab.dirty) await this.app.editors.save(tab);
      await ofs.rename(path, to);
      if (tab) {
        await this.app.editors.closeTab(tab, { force: true, noHistory: true });
        await this.app.editors.open(to);
      }
      await this.refresh([path, to]);
      this.select(to);
      this.app.unityRefreshSoon();
    } catch (err) {
      toast({ kind: 'error', title: '이름을 바꿀 수 없어요', message: String(err.message || err) });
    }
  }

  async remove(path) {
    const r = await window.papyrus.app.confirm({ message: `'${basename(path)}'을(를) 휴지통으로 옮길까요?`, detail: '.meta 파일도 같이 옮겨져요.', buttons: ['삭제', '취소'], type: 'warning' });
    if (r !== 0) return;
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
}
