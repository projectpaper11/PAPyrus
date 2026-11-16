// "Search Everywhere" popup (Double Shift / Ctrl+T), Go to File / Type / Symbol, Recent Files, Actions.
import { monaco } from './monaco.js';
import * as cv from './conv.js';
import { el, icon, basename, dirname, relPath, fileIcon, fuzzy, highlight, debounce } from './ui.js';

const TABS = [
  { id: 'all', label: '전체' },
  { id: 'types', label: '타입' },
  { id: 'files', label: '파일' },
  { id: 'symbols', label: '심볼' },
  { id: 'actions', label: '명령' },
];
const TYPE_KINDS = new Set([5, 10, 11, 23, 26]);

export class SearchEverywhere {
  constructor(app) {
    this.app = app;
    this.popup = null;
    this.items = [];
    this.index = 0;
    this.tab = 'all';
    this.symbolSeq = 0;
    this.searchSymbols = debounce((q) => this.loadSymbols(q), 120);
  }

  get isOpen() {
    return !!this.popup;
  }

  open(tab = 'all', initial) {
    if (this.popup) {
      if (tab === this.tab) {
        // pressing the shortcut again cycles tabs like Rider
        const i = TABS.findIndex((t) => t.id === this.tab);
        this.setTab(TABS[(i + 1) % TABS.length].id);
      } else this.setTab(tab);
      return;
    }
    this.tab = tab;
    this.recentMode = tab === 'recent';
    if (this.recentMode) this.tab = 'files';
    const sel = this.app.editors.editor.getModel() ? this.app.editors.editor.getModel().getValueInRange(this.app.editors.editor.getSelection()) : '';
    this.input = el('input', { placeholder: this.recentMode ? '최근 파일' : '파일, 타입, 심볼, 명령 검색', spellcheck: 'false' });
    this.input.value = initial != null ? initial : sel && !sel.includes('\n') ? sel : (this.lastQuery || '');
    this.tabsEl = el('div.se-tabs');
    this.list = el('div.se-list');
    this.popup = el('div.popup.se', null, this.tabsEl, el('div.se-input', null, icon('search'), this.input), this.list);
    const back = el('div', { style: { position: 'fixed', inset: '0' }, onmousedown: (e) => { if (e.target === back) this.close(); } }, this.popup);
    this.back = back;
    document.getElementById('overlay-root').append(back);
    this.input.addEventListener('input', () => this.update());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.renderTabs();
    this.input.focus();
    this.input.select();
    this.update();
  }

  close() {
    if (!this.popup) return;
    this.lastQuery = this.input.value;
    this.back.remove();
    this.popup = null;
    this.symbols = null;
    this.app.editors.editor.focus();
  }

  setTab(id) {
    this.tab = id;
    this.recentMode = false;
    this.renderTabs();
    this.update();
    this.input.focus();
  }

  renderTabs() {
    this.tabsEl.replaceChildren(...(this.recentMode
      ? [el('button.se-tab.active', null, '최근 파일')]
      : TABS.map((t) => el('button.se-tab' + (t.id === this.tab ? '.active' : ''), { onclick: () => this.setTab(t.id) }, t.label))),
    el('span.se-hint', null, this.recentMode ? '최근 파일' : 'Tab으로 탭 전환'));
  }

  onKey(e) {
    if (e.key === 'Escape') { this.close(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { this.move(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this.move(-1); e.preventDefault(); }
    else if (e.key === 'PageDown') { this.move(10); e.preventDefault(); }
    else if (e.key === 'PageUp') { this.move(-10); e.preventDefault(); }
    else if (e.key === 'Enter') { this.accept(this.items[this.index]); e.preventDefault(); }
    else if (e.key === 'Tab' && !this.recentMode) {
      const i = TABS.findIndex((t) => t.id === this.tab);
      this.setTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id);
      e.preventDefault();
    }
    e.stopPropagation();
  }

  move(d) {
    if (!this.items.length) return;
    this.index = Math.max(0, Math.min(this.items.length - 1, this.index + d));
    this.renderList();
  }

  // ------------------------------------------------------------------ sources
  fileItems(q) {
    const root = this.app.project;
    const files = this.recentMode ? this.app.recentFiles.filter((p) => !this.app.editors.active || p !== this.app.editors.active.path).concat(this.app.editors.active ? [this.app.editors.active.path] : []) : this.app.fileIndex || [];
    const out = [];
    // "Foo.cs:42" jumps to a line
    let line = null;
    const m = q.match(/^(.*?):(\d+)$/);
    if (m) { q = m[1]; line = parseInt(m[2], 10); }
    for (const p of files) {
      const name = basename(p);
      let f = fuzzy(q, name);
      let onPath = false;
      if (!f && q.includes('/')) {
        f = fuzzy(q, relPath(root, p));
        onPath = true;
      }
      if (!f) continue;
      let score = f.score;
      if (/\.cs$/i.test(name)) score += 2;
      if (/[\\/]Assets[\\/]/.test(p)) score += 1;
      out.push({ type: 'file', path: p, name, positions: onPath ? [] : f.positions, score, line });
    }
    if (this.recentMode && !q) return out.reverse();
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 60);
  }

  actionItems(q) {
    const out = [];
    for (const a of this.app.actions()) {
      const f = fuzzy(q, a.label);
      if (!f) continue;
      out.push({ type: 'action', action: a, name: a.label, positions: f.positions, score: f.score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 30);
  }

  async loadSymbols(q) {
    const seq = ++this.symbolSeq;
    if (!q || q.length < 2 || !this.app.lsp.running) {
      this.symbols = [];
      this.renderList();
      return;
    }
    const res = await this.app.lsp.workspaceSymbols(q);
    if (seq !== this.symbolSeq || !this.popup) return;
    this.symbols = res.filter((s) => {
      const p = s.location && s.location.uri ? cv.uriToPath(s.location.uri) : null;
      return p; // only symbols with a source location (skip metadata)
    }).slice(0, 200);
    this.compose();
  }

  update() {
    const q = this.input.value.trim();
    this.index = 0;
    if (['all', 'types', 'symbols'].includes(this.tab) && !this.recentMode) this.searchSymbols(q.replace(/:\d+$/, ''));
    this.compose();
  }

  compose() {
    if (!this.popup) return;
    const q = this.input.value.trim();
    const groups = [];
    const symItems = (filter) => (this.symbols || []).filter(filter).map((s) => {
      const f = fuzzy(q, s.name) || { score: 0, positions: [] };
      const p = cv.uriToPath(s.location.uri);
      return { type: 'symbol', sym: s, name: s.name, positions: f.positions, score: f.score + (TYPE_KINDS.has(s.kind) ? 3 : 0), path: p };
    }).sort((a, b) => b.score - a.score);
    if (this.recentMode) groups.push(['', this.fileItems(q)]);
    else if (this.tab === 'files') groups.push(['', this.fileItems(q)]);
    else if (this.tab === 'actions') groups.push(['', this.actionItems(q)]);
    else if (this.tab === 'types') groups.push(['', symItems((s) => TYPE_KINDS.has(s.kind)).slice(0, 60)]);
    else if (this.tab === 'symbols') groups.push(['', symItems(() => true).slice(0, 80)]);
    else {
      if (!q) {
        groups.push(['최근 파일', this.app.recentFiles.slice(0, 12).map((p) => ({ type: 'file', path: p, name: basename(p), positions: [] }))]);
      } else {
        groups.push(['타입', symItems((s) => TYPE_KINDS.has(s.kind)).slice(0, 8)]);
        groups.push(['파일', this.fileItems(q).slice(0, 10)]);
        groups.push(['심볼', symItems((s) => !TYPE_KINDS.has(s.kind)).slice(0, 10)]);
        groups.push(['명령', this.actionItems(q).slice(0, 5)]);
      }
    }
    this.groups = groups.filter(([, items]) => items.length);
    this.items = this.groups.flatMap(([, items]) => items);
    if (this.index >= this.items.length) this.index = 0;
    this.renderList();
  }

  renderList() {
    if (!this.popup) return;
    const frag = document.createDocumentFragment();
    let i = 0;
    if (!this.items.length) {
      const q = this.input.value.trim();
      const msg = ['types', 'symbols'].includes(this.tab) && !this.app.lsp.running ? '언어 서버가 준비되면 심볼을 검색할 수 있어요.' : q ? '결과 없음' : '입력하세요';
      frag.append(el('div.se-empty', null, msg));
    }
    for (const [title, items] of this.groups || []) {
      if (title) frag.append(el('div.se-group', null, title));
      for (const it of items) {
        const idx = i++;
        const row = el('div.se-item' + (idx === this.index ? '.active' : ''), {
          onmousemove: () => { if (this.index !== idx) { this.index = idx; this.renderList(); } },
          onclick: () => this.accept(it),
        });
        if (it.type === 'file') {
          row.append(fileIcon(it.name, false), el('span.se-name', null, highlight(it.name, it.positions)), el('span.se-right', null, relPath(this.app.project, dirname(it.path))));
        } else if (it.type === 'symbol') {
          const s = it.sym;
          const ic = icon(cv.symbolIcon(s.kind));
          ic.style.color = cv.symbolColor(s.kind);
          row.append(...[ic, el('span.se-name', null, highlight(it.name, it.positions)), s.containerName ? el('span.se-detail', null, s.containerName) : null,
            el('span.se-right', null, basename(it.path))].filter(Boolean));
        } else if (it.type === 'action') {
          row.append(...[icon(it.action.icon || 'zap'), el('span.se-name', null, highlight(it.name, it.positions)), it.action.category ? el('span.se-detail', null, it.action.category) : null, it.action.key ? el('span.se-right', null, el('kbd', null, it.action.key)) : null].filter(Boolean));
        }
        frag.append(row);
      }
    }
    this.list.replaceChildren(frag);
    const act = this.list.querySelector('.se-item.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }

  accept(it) {
    if (!it) return;
    this.close();
    if (it.type === 'file') this.app.editors.open(it.path, it.line ? { line: it.line } : {});
    else if (it.type === 'symbol') {
      const r = it.sym.location.range;
      if (r) this.app.editors.open(it.path, { line: r.start.line + 1, column: r.start.character + 1 });
      else this.app.editors.open(it.path);
    } else if (it.type === 'action') setTimeout(() => it.action.run(), 0);
  }
}

// Structure tool window (document symbols of the active C# file)
export class StructureView {
  constructor(app) {
    this.app = app;
    this.el = el('div.tree', { tabindex: 0 });
    this.refreshSoon = debounce(() => this.refresh(), 500);
  }

  async refresh() {
    if (!this.app.isToolVisible('structure')) return;
    const tab = this.app.editors.active;
    if (!tab || !tab.model || tab.model.getLanguageId() !== 'csharp') {
      this.el.replaceChildren(el('div.empty-msg', null, 'C# 파일을 열면 구조가 표시돼요.'));
      return;
    }
    if (!this.app.lsp.running) {
      this.el.replaceChildren(el('div.empty-msg', null, '언어 서버를 기다리는 중…'));
      return;
    }
    const model = tab.model;
    const syms = await this.app.lsp.documentSymbols(model);
    if (tab !== this.app.editors.active) return;
    const frag = document.createDocumentFragment();
    const walk = (list, depth) => {
      for (const s of list) {
        const ic = icon(cv.symbolIcon(s.kind));
        ic.style.color = cv.symbolColor(s.kind);
        frag.append(el('div.tree-row', {
          style: { paddingLeft: 10 + depth * 16 + 'px' },
          onclick: () => this.app.editors.open(tab.path, { line: s.selectionRange.start.line + 1, column: s.selectionRange.start.character + 1 }),
        }, ic, el('span.label', null, s.name), s.detail ? el('span.hint', null, s.detail) : null));
        if (s.children && s.children.length) walk(s.children, depth + 1);
      }
    };
    walk(syms, 0);
    if (!syms.length) frag.append(el('div.empty-msg', null, '심볼 없음'));
    this.el.replaceChildren(frag);
  }
}

export { monaco };
