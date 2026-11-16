// Bottom tool windows: Unity Log, Problems, Find, Output.
import { monaco } from './monaco.js';
import { el, icon, basename, dirname, relPath, fileIcon, debounce, joinPath } from './ui.js';

const MAX_LOGS = 5000;

export class Panels {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('bottom');
    this.tabsEl = document.getElementById('bottom-tabs');
    this.actionsEl = document.getElementById('bottom-actions');
    this.body = document.getElementById('bottom-body');
    this.current = null;
    this.views = {
      unity: new UnityLogView(app, this),
      problems: new ProblemsView(app, this),
      find: new FindView(app, this),
      output: new OutputView(app, this),
    };
    this.order = ['unity', 'problems', 'find', 'output'];
    document.getElementById('bottom-hide').onclick = () => this.hide();
    this.body.addEventListener('scroll', () => {
      const v = this.views[this.current];
      if (v && v.onScroll) v.onScroll(this.body);
    });
    this.renderTabs();
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }

  renderTabs() {
    this.tabsEl.replaceChildren(...this.order.map((id) => {
      const v = this.views[id];
      const c = v.count ? v.count() : '';
      return el('button.btab' + (this.current === id && this.visible ? '.active' : ''), { onclick: () => this.show(id) }, v.title, c ? el('span.count', null, c) : null);
    }));
    document.querySelectorAll('.stripe-btn[data-panel]').forEach((b) => b.classList.toggle('active', this.visible && b.dataset.panel === this.current));
  }

  show(id, { focus = false } = {}) {
    this.root.classList.remove('hidden');
    document.getElementById('resizer-bottom').classList.remove('hidden');
    if (this.current !== id) {
      this.current = id;
      const v = this.views[id];
      this.body.replaceChildren(v.el);
      this.actionsEl.replaceChildren(...(v.actions ? v.actions() : []));
      v.onShow && v.onShow();
    }
    this.renderTabs();
    if (focus && this.views[id].focus) this.views[id].focus();
    this.app.sessionSet('bottom', id);
  }

  toggle(id) {
    if (this.visible && this.current === id) this.hide();
    else this.show(id, { focus: true });
  }

  hide() {
    this.root.classList.add('hidden');
    document.getElementById('resizer-bottom').classList.add('hidden');
    this.renderTabs();
    this.app.sessionSet('bottom', null);
    this.app.editors.editor.focus();
  }

  refreshActions() {
    const v = this.views[this.current];
    if (v) this.actionsEl.replaceChildren(...(v.actions ? v.actions() : []));
  }
}

// ---------------------------------------------------------------------------- helpers
function toggleBtn(label, iconName, on, onclick, title) {
  return el('button.toggle' + (on ? '.on' : ''), { onclick, title: title || '' }, iconName ? icon(iconName) : null, label);
}

// Turn "Assets/Foo.cs:12" / "Assets/Foo.cs(12,5)" into clickable links.
const LOC_RE = /((?:[A-Za-z]:)?[^\s:()"'<>|]*?\.(?:cs|shader|hlsl|cginc|compute|json|asmdef|uss|uxml)) ?(?::(\d+)|\((\d+)(?:,(\d+))?\))/g;
export function linkify(text, app) {
  const frag = document.createDocumentFragment();
  let last = 0;
  LOC_RE.lastIndex = 0;
  let m;
  while ((m = LOC_RE.exec(text))) {
    const [all, file, l1, l2, c2] = m;
    if (m.index > last) frag.append(text.slice(last, m.index));
    const line = parseInt(l1 || l2 || '1', 10);
    const col = parseInt(c2 || '1', 10);
    const abs = /^[A-Za-z]:|^\//.test(file) ? file : joinPath(app.project, file.replace(/\//g, app.project.includes('\\') ? '\\' : '/'));
    frag.append(el('span.link', { onclick: (e) => { e.stopPropagation(); app.editors.open(abs, { line, column: col }); } }, all));
    last = m.index + all.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function firstLocation(text) {
  LOC_RE.lastIndex = 0;
  let m;
  while ((m = LOC_RE.exec(text))) {
    if (/Packages[\\/]com\.unity|UnityEngine\.|Library[\\/]PackageCache/.test(m[1])) continue;
    return { file: m[1], line: parseInt(m[2] || m[3] || '1', 10), column: parseInt(m[4] || '1', 10) };
  }
  return null;
}

// ---------------------------------------------------------------------------- Unity log
class UnityLogView {
  constructor(app, panels) {
    this.app = app;
    this.panels = panels;
    this.title = 'Unity 로그';
    this.logs = [];
    this.filters = { error: true, warning: true, log: true };
    this.collapse = false;
    this.query = '';
    this.autoscroll = true;
    this.selected = null;
    this.el = el('div.loglist');
    this.renderSoon = debounce(() => this.render(), 60);
  }

  sev(t) {
    if (t === 'Error' || t === 'Exception' || t === 'Assert') return 'error';
    if (t === 'Warning') return 'warning';
    return 'log';
  }

  count() {
    const errs = this.logs.filter((l) => l.sev === 'error').length;
    return errs ? String(errs) : this.logs.length ? String(this.logs.length) : '';
  }

  add(entry) {
    const e = {
      sev: this.sev(entry.logType),
      message: entry.message || '',
      stack: entry.stackTrace || '',
      time: entry.time ? new Date(entry.time) : new Date(),
    };
    this.logs.push(e);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.updateBadge();
    if (this.panels.current === 'unity' && this.panels.visible) this.renderSoon();
    else this.panels.renderTabs();
  }

  clear() {
    this.logs = [];
    this.selected = null;
    this.updateBadge();
    this.render();
    this.panels.renderTabs();
  }

  updateBadge() {
    const b = document.getElementById('badge-unity');
    const n = this.logs.filter((l) => l.sev === 'error').length;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('show', n > 0);
  }

  actions() {
    const c = { error: 0, warning: 0, log: 0 };
    for (const l of this.logs) c[l.sev]++;
    const search = el('input.filter-input', { placeholder: '로그 검색', value: this.query, oninput: (e) => { this.query = e.target.value; this.renderSoon(); } });
    return [
      search,
      toggleBtn(String(c.error), 'error', this.filters.error, () => { this.filters.error = !this.filters.error; this.render(); this.panels.refreshActions(); }, '에러'),
      toggleBtn(String(c.warning), 'warning', this.filters.warning, () => { this.filters.warning = !this.filters.warning; this.render(); this.panels.refreshActions(); }, '경고'),
      toggleBtn(String(c.log), 'info', this.filters.log, () => { this.filters.log = !this.filters.log; this.render(); this.panels.refreshActions(); }, '로그'),
      toggleBtn('묶기', null, this.collapse, () => { this.collapse = !this.collapse; this.render(); this.panels.refreshActions(); }, '같은 메시지 묶기'),
      el('button.tb-btn.icon.small', { title: '지우기', onclick: () => this.clear() }, icon('clear-all')),
    ];
  }

  onShow() {
    this.render();
  }

  onScroll(body) {
    this.autoscroll = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
  }

  render() {
    const q = this.query.toLowerCase();
    let list = this.logs.filter((l) => this.filters[l.sev] && (!q || l.message.toLowerCase().includes(q)));
    let counts = null;
    if (this.collapse) {
      const map = new Map();
      for (const l of list) {
        const k = l.sev + l.message + l.stack;
        const x = map.get(k);
        if (x) x.n++;
        else map.set(k, { l, n: 1 });
      }
      list = [...map.values()].map((x) => x.l);
      counts = new Map([...map.values()].map((x) => [x.l, x.n]));
    }
    const view = list.slice(-1500);
    if (!this.logs.length) {
      const st = this.app.unityStatus || {};
      // Connected: just an empty log. Only the "disconnected" status carries packageInstalled, so
      // the install offer needs an explicit false (it used to show up while connected, too).
      const missing = st.state !== 'connected' && st.packageInstalled === false && st.isUnityProject !== false;
      const msg = st.state === 'connected' ? null
        : missing ? 'Unity 연동 패키지(com.papyrus.ide)가 이 프로젝트에 없어요.'
          : 'Unity가 열려 있지 않거나 아직 연결 전이에요. Unity에서 프로젝트를 열면 자동으로 연결돼요.';
      this.el.replaceChildren(msg ? el('div.empty-msg', null, msg,
        missing ? el('div', null, el('button.btn.primary', { onclick: () => this.app.installUnityPackage() }, icon('package'), 'Unity 패키지 설치')) : null) : '');
      this.panels.refreshActions();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const l of view) {
      const lines = l.message.split('\n');
      const row = el('div.logrow.' + l.sev + (this.selected === l ? '.selected' : ''), {
        onclick: () => {
          this.selected = l;
          row.classList.toggle('expanded');
          this.el.querySelectorAll('.logrow.selected').forEach((x) => x !== row && x.classList.remove('selected'));
          row.classList.add('selected');
        },
        ondblclick: () => {
          const loc = firstLocation(l.message + '\n' + l.stack);
          if (loc) {
            const abs = /^[A-Za-z]:|^\//.test(loc.file) ? loc.file : joinPath(this.app.project, loc.file);
            this.app.editors.open(abs, { line: loc.line, column: loc.column });
          }
        },
      },
      el('span.licon', null, icon(l.sev === 'error' ? 'error' : l.sev === 'warning' ? 'warning' : 'info')),
      el('div.lmsg', null,
        el('div.first', null, linkify(lines[0], this.app)),
        lines.length > 1 || l.stack ? el('div.lstack', null, linkify([...lines.slice(1), l.stack].filter(Boolean).join('\n'), this.app)) : null),
      counts && counts.get(l) > 1 ? el('span.lcount', null, String(counts.get(l))) : null,
      el('span.ltime', null, l.time.toLocaleTimeString('ko-KR', { hour12: false })));
      frag.append(row);
    }
    this.el.replaceChildren(frag);
    this.panels.refreshActions();
    this.panels.renderTabs();
    if (this.autoscroll) this.el.parentElement && (this.el.parentElement.scrollTop = this.el.parentElement.scrollHeight);
  }
}

// ---------------------------------------------------------------------------- Problems
class ProblemsView {
  constructor(app, panels) {
    this.app = app;
    this.panels = panels;
    this.title = '문제';
    this.el = el('div.reslist');
    this.renderSoon = debounce(() => this.render(), 150);
    monaco.editor.onDidChangeMarkers(() => {
      this.updateBadge();
      if (this.panels.current === 'problems' && this.panels.visible) this.renderSoon();
      else this.panels.renderTabs();
    });
  }

  markers() {
    return monaco.editor.getModelMarkers({}).filter((m) => m.severity >= monaco.MarkerSeverity.Warning && this.app.editors.findTab(m.resource.fsPath));
  }

  count() {
    const n = this.markers().length;
    return n ? String(n) : '';
  }

  updateBadge() {
    const b = document.getElementById('badge-problems');
    const n = monaco.editor.getModelMarkers({}).filter((m) => m.severity === monaco.MarkerSeverity.Error && this.app.editors.findTab(m.resource.fsPath)).length;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('show', n > 0);
    this.app.editors.renderTabs();
  }

  onShow() {
    this.render();
  }

  render() {
    const ms = this.markers();
    if (!ms.length) {
      this.el.replaceChildren(el('div.empty-msg', null, '열린 파일에 문제가 없어요.'));
      return;
    }
    const byFile = new Map();
    for (const m of ms) {
      const k = m.resource.fsPath;
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k).push(m);
    }
    const frag = document.createDocumentFragment();
    for (const [file, list] of byFile) {
      list.sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber);
      frag.append(el('div.res-file', null, fileIcon(basename(file), false), basename(file), el('span.rdir', null, relPath(this.app.project, dirname(file))), el('span.rcount', null, String(list.length))));
      for (const m of list) {
        const ic = m.severity === monaco.MarkerSeverity.Error ? 'error' : m.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info';
        frag.append(el('div.res-line.prob', { onclick: () => this.app.editors.open(file, { line: m.startLineNumber, column: m.startColumn }) },
          icon(ic), el('span', null, m.message.split('\n')[0]), el('span.rl', { style: { marginLeft: 'auto' } }, `${m.code ? m.code + '  ' : ''}${m.startLineNumber}:${m.startColumn}`)));
      }
    }
    this.el.replaceChildren(frag);
  }
}

// ---------------------------------------------------------------------------- Find (in files / usages)
class FindView {
  constructor(app, panels) {
    this.app = app;
    this.panels = panels;
    this.title = '찾기';
    this.opts = { matchCase: false, wholeWord: false, regex: false, includePlugins: false };
    this.results = [];
    this.header = '';
    this.input = el('input.filter-input', {
      placeholder: '파일에서 찾기 (Ctrl+Shift+F)',
      onkeydown: (e) => {
        if (e.key === 'Enter') this.search(this.input.value);
        if (e.key === 'Escape') this.app.editors.editor.focus();
        e.stopPropagation();
      },
    });
    this.bar = el('div.findbar', null, this.input,
      this.optBtn('Aa', 'matchCase', '대소문자 구분'),
      this.optBtn('W', 'wholeWord', '단어 단위'),
      this.optBtn('.*', 'regex', '정규식'),
      this.optBtn('외부', 'includePlugins', '외부 폴더(Plugins, Feel 등 설정 > 파일 > 검색에서 뺄 외부 폴더)도 찾기'),
      el('button.btn', { onclick: () => this.search(this.input.value) }, '찾기'));
    this.list = el('div.reslist');
    this.status = el('div.empty-msg', null, '검색어를 입력하고 Enter를 누르세요.');
    this.el = el('div', null, this.bar, this.status, this.list);
    window.papyrus.fs.onFindResult((r) => this.addResult(r));
  }

  optBtn(label, key, title) {
    const b = el('button.toggle' + (this.opts[key] ? '.on' : ''), { title, onclick: () => { this.opts[key] = !this.opts[key]; b.classList.toggle('on', this.opts[key]); } }, label);
    return b;
  }

  focus(text) {
    if (text) this.input.value = text;
    this.input.focus();
    this.input.select();
  }

  async search(q) {
    if (!q) return;
    this.results = [];
    this.list.replaceChildren();
    this.status.textContent = `'${q}' 찾는 중…`;
    this.mode = 'files';
    this.query = q;
    // from the selected file's folder outward, so the nearby results come first
    const cur = (this.app.editors.active && this.app.editors.active.path) || this.app.explorer.selected;
    const from = cur ? (this.app.explorer.isDir(cur) ? cur : dirname(cur)) : null;
    const r = await window.papyrus.fs.findInFiles(this.app.project, q, { ...this.opts, from });
    if (r.error) this.status.textContent = `정규식 오류: ${r.error}`;
    else this.status.textContent = r.count ? `'${q}' — ${r.count}개${r.truncated ? ' 이상' : ''} 일치, 파일 ${this.results.length}개` : `'${q}' — 결과 없음`;
  }

  addResult(r) {
    if (this.mode !== 'files') return;
    this.results.push(r);
    this.list.append(this.renderFile(r.file, r.matches));
  }

  renderFile(file, matches) {
    const frag = document.createDocumentFragment();
    frag.append(el('div.res-file', null, fileIcon(basename(file), false), basename(file), el('span.rdir', null, relPath(this.app.project, dirname(file))), el('span.rcount', null, String(matches.length))));
    for (const m of matches) {
      const t = m.text;
      const s = Math.max(0, m.column - 1);
      const lead = t.slice(0, s).replace(/^\s+/, '');
      const trimmed = t.length - t.trimStart().length;
      frag.append(el('div.res-line', {
        onclick: (e) => {
          this.list.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
          e.currentTarget.classList.add('selected');
          this.app.editors.open(file, { line: m.line, column: m.column, endLine: m.line, endColumn: m.column + m.length });
        },
      }, el('span.rl', null, String(m.line)), el('span', null, s >= trimmed ? lead : '', el('mark', null, t.slice(s, s + m.length)), t.slice(s + m.length))));
    }
    return frag;
  }

  // Find Usages results: [{uri, range}]
  async showUsages(name, locations) {
    this.mode = 'usages';
    this.results = [];
    this.list.replaceChildren();
    this.input.value = '';
    const byFile = new Map();
    for (const l of locations) {
      const p = monaco.Uri.parse(l.uri).fsPath;
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p).push(l.range);
    }
    this.status.textContent = `'${name}' 사용처 ${locations.length}개, 파일 ${byFile.size}개`;
    for (const [file, ranges] of byFile) {
      const model = monaco.editor.getModel(monaco.Uri.file(file));
      let lines = model ? model.getLinesContent() : null;
      if (!lines) {
        const r = await window.papyrus.fs.readFile(file);
        lines = r.text ? r.text.split(/\r?\n/) : [];
      }
      ranges.sort((a, b) => a.start.line - b.start.line);
      const matches = ranges.map((r) => ({
        line: r.start.line + 1,
        column: r.start.character + 1,
        length: Math.max(1, r.end.line === r.start.line ? r.end.character - r.start.character : 1),
        text: (lines[r.start.line] || '').slice(0, 400),
      }));
      this.list.append(this.renderFile(file, matches));
    }
  }
}

// ---------------------------------------------------------------------------- Output
class OutputView {
  constructor(app, panels) {
    this.app = app;
    this.panels = panels;
    this.title = '출력';
    this.lines = [];
    this.el = el('div.output');
    this.renderSoon = debounce(() => this.render(), 80);
  }

  actions() {
    return [
      el('button.tb-btn.icon.small', { title: '언어 서버 재시작', onclick: () => this.app.restartLsp() }, icon('debug-restart')),
      el('button.tb-btn.icon.small', { title: '지우기', onclick: () => { this.lines = []; this.render(); } }, icon('clear-all')),
    ];
  }

  append(line) {
    this.lines.push(line);
    if (this.lines.length > 3000) this.lines.splice(0, 500);
    if (this.panels.current === 'output' && this.panels.visible) this.renderSoon();
  }

  onShow() {
    this.render();
  }

  render() {
    this.el.textContent = this.lines.join('\n');
    const p = this.el.parentElement;
    if (p) p.scrollTop = p.scrollHeight;
  }
}
