import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/400-italic.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles.css';
import logoUrl from '../../build/icon256.png';

import { monaco } from './monaco.js';
import '@vscode/codicons/dist/codicon.css';
import * as cv from './conv.js';
import { LspClient } from './lsp-client.js';
import { Editors } from './editors.js';
import { Explorer } from './explorer.js';
import { Inspector } from './inspector.js';
import { Panels } from './panels.js';
import { SearchEverywhere, StructureView } from './search.js';
import { Keybindings, displayKey } from './keybindings.js';
import { SettingsView } from './settings-view.js';
import { Updates } from './updates.js';
import { SetupWizard } from './setup-wizard.js';
import { CodeMemory } from './code-memory.js';
import './unity-completions.js';
import { registerOverrideCompletion } from './override-completions.js';
import { Refactorings } from './refactorings.js';
import { UsingCleanup } from './using-cleanup.js';
import { UnityFeatures } from './unity-features.js';
import { showLocationPopup, popupPoint } from './location-popup.js';
import { el, icon, basename, dirname, relPath, joinPath, contextMenu, toast, debounce, samePath, extname } from './ui.js';

const O = window.papyrus;
const KM = monaco.KeyMod;
const KC = monaco.KeyCode;

class App {
  constructor() {
    this.project = null;
    this.settings = {};
    this.recentFiles = [];
    this.fileIndex = [];
    this.unityStatus = { state: 'disconnected' };
    this.unityState = {};
    this.tool = 'explorer';
    this.sidebarVisible = true;
  }

  // ======================================================================== init
  async init() {
    const init = await O.app.init();
    this.settings = init.settings;
    this.version = init.version;
    this.electronVersion = init.electron;
    this.externalEditorPath = init.externalEditorPath;
    this.recentProjects = init.recentProjects;
    this.applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.settings['workbench.theme'] === 'system') this.applyTheme();
    });
    if (init.platform === 'darwin') document.body.classList.add('mac');
    document.querySelector('.tb-logo').replaceChildren(el('img.logo-img', { src: logoUrl, alt: '' }));

    this.lsp = new LspClient({
      onStatus: (st) => this.onLspStatus(st),
      onApplyEdit: (edit) => this.editors.applyWorkspaceEdit(edit),
      onShowDocument: (p) => {
        const path = cv.uriToPath(p.uri);
        if (path) this.editors.open(path, p.selection ? { line: p.selection.start.line + 1, column: p.selection.start.character + 1 } : {});
        else O.app.openExternal(p.uri);
      },
      onMessage: (m) => toast({ kind: m.type === 1 ? 'error' : m.type === 2 ? 'warn' : 'info', title: 'C# 언어 서버', message: m.message }),
    });
    this.lsp.codeLensEnabled = this.settings['editor.codeLens'] !== false;
    this.editors = new Editors(this);
    this.codeMemory = new CodeMemory({
      enabled: () => this.settings['editor.learnedCompletions'] !== false,
      lspCovers: (model) => model.getLanguageId() === 'csharp' && this.lspState === 'ready',
    });
    registerOverrideCompletion(this);
    this.refactor = new Refactorings(this);
    // every split gets the same context menu / Ctrl+click / learned completions (also splits made later)
    this.editors.forEachEditor((ed) => {
      this.codeMemory.attach(ed);
      this.attachRefactorMenu(ed);
      this.attachCtrlClickUsages(ed);
    });
    this.lsp.ensureModelHook = (uris) => this.editors.ensureModels(uris);
    this.usingCleanup = new UsingCleanup(this);
    this.lsp.onDiagnostics = (model, diags) => this.usingCleanup.onDiagnostics(model, diags);
    this.unityFeatures = new UnityFeatures(this);
    this.lsp.onRename = (model, position, newName, result) => this.unityFeatures.onRename(model, position, newName, result);
    this.lsp.isEditableModel = (m) => this.editors.tabs.some((t) => t.model === m);
    this.logoUrl = logoUrl;
    this.keys = new Keybindings(this);
    this.explorer = new Explorer(this);
    this.inspector = new Inspector(this);
    this.structure = new StructureView(this);
    this.panels = new Panels(this);
    this.search = new SearchEverywhere(this);
    this.updates = new Updates(this);
    this.setup = new SetupWizard(this);

    this.editors.onActiveChange = (tab) => this.onActiveTab(tab);
    this.editors.onDirtyChange = () => this.updateTitle();

    this.setupLayout();
    this.setupToolbar();
    this.setupCommands();
    this.setupKeys();
    this.setupEvents();
    this.showTool('explorer');
    this.updateStatus();
    this.renderUnity();

    if (init.project) await this.openProject(init.project, init.goto);
    else this.showWelcome();
  }

  // ======================================================================== layout
  setupLayout() {
    const root = document.documentElement;
    const sideW = parseInt(localStorage.getItem('layout:sideW') || '290', 10);
    const bottomH = parseInt(localStorage.getItem('layout:bottomH') || '260', 10);
    root.style.setProperty('--side-w', sideW + 'px');
    root.style.setProperty('--bottom-h', bottomH + 'px');
    const drag = (elm, axis, get, set) => {
      elm.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const start = axis === 'x' ? e.clientX : e.clientY;
        const startVal = get();
        const move = (ev) => set(startVal, (axis === 'x' ? ev.clientX : ev.clientY) - start);
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
        };
        document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    };
    const cssPx = (name) => parseInt(getComputedStyle(root).getPropertyValue(name), 10);
    drag(document.getElementById('resizer-side'), 'x', () => cssPx('--side-w'), (start, d) => {
      const w = Math.max(160, Math.min(700, start + d));
      root.style.setProperty('--side-w', w + 'px');
      localStorage.setItem('layout:sideW', w);
    });
    const rightW = parseInt(localStorage.getItem('layout:rightW') || '340', 10);
    root.style.setProperty('--right-w', rightW + 'px');
    drag(document.getElementById('resizer-right'), 'x', () => cssPx('--right-w'), (start, d) => {
      const w = Math.max(240, Math.min(800, start - d));
      root.style.setProperty('--right-w', w + 'px');
      localStorage.setItem('layout:rightW', w);
    });
    document.getElementById('btn-inspector').onclick = () => this.inspector.toggleDock();
    drag(document.getElementById('resizer-bottom'), 'y', () => cssPx('--bottom-h'), (start, d) => {
      const h = Math.max(90, Math.min(window.innerHeight - 200, start - d));
      root.style.setProperty('--bottom-h', h + 'px');
      localStorage.setItem('layout:bottomH', h);
    });
    // bottom panel starts hidden until something asks for it
    this.panels.hide();

    document.querySelectorAll('.stripe-btn[data-tool]').forEach((b) => {
      b.onclick = () => this.toggleTool(b.dataset.tool);
    });
    document.querySelectorAll('.stripe-btn[data-panel]').forEach((b) => {
      b.onclick = () => this.panels.toggle(b.dataset.panel);
    });
  }

  showTool(id) {
    if (id === 'inspector') {
      // the inspector lives in the right dock now (older sessions saved it as a sidebar tool)
      this.inspector.showDock();
      id = 'explorer';
    }
    this.tool = id;
    this.sidebarVisible = true;
    const side = document.getElementById('sidebar');
    side.classList.remove('hidden');
    document.getElementById('resizer-side').classList.remove('hidden');
    document.querySelectorAll('.stripe-btn[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === id));
    const body = document.getElementById('sidebar-body');
    const actions = document.getElementById('sidebar-actions');
    document.getElementById('sidebar-title').textContent = id === 'explorer' ? '탐색기' : '구조';
    document.getElementById('sidebar-sub').textContent = id === 'explorer' ? (this.isUnityProject ? 'Unity' : '') : '';
    if (id === 'explorer') {
      body.replaceChildren(this.explorer.view);
      actions.replaceChildren(
        el('button.tb-btn.icon.small', { title: '현재 파일 선택', onclick: () => this.keys.run('papyrus.revealInExplorer') }, icon('target')),
        el('button.tb-btn.icon.small', { title: '모두 접기', onclick: () => { this.explorer.expanded = new Set([this.project]); this.explorer.render(); } }, icon('collapse-all')),
        el('button.tb-btn.icon.small', { title: '새로고침', onclick: () => this.explorer.refresh() }, icon('refresh')));
    } else {
      body.replaceChildren(this.structure.el);
      actions.replaceChildren();
      this.structure.refresh();
    }
    this.sessionSet('tool', id);
  }

  toggleTool(id) {
    if (this.sidebarVisible && this.tool === id) this.hideSidebar();
    else this.showTool(id);
  }

  hideSidebar() {
    this.sidebarVisible = false;
    document.getElementById('sidebar').classList.add('hidden');
    document.getElementById('resizer-side').classList.add('hidden');
    document.querySelectorAll('.stripe-btn[data-tool]').forEach((b) => b.classList.remove('active'));
    this.sessionSet('tool', null);
  }

  isToolVisible(id) {
    return this.sidebarVisible && this.tool === id;
  }

  // ======================================================================== toolbar
  setupToolbar() {
    document.getElementById('btn-menu').onclick = (e) => this.mainMenu(e.currentTarget);
    document.getElementById('project-widget').onclick = (e) => this.projectMenu(e.currentTarget);
    document.getElementById('btn-search').onclick = () => this.search.open('all');
    document.getElementById('btn-settings').onclick = () => this.openSettings();
    document.getElementById('btn-play').onclick = () => this.unityPlay();
    document.getElementById('btn-pause').onclick = () => O.unity.send({ type: 'pause' });
    document.getElementById('btn-step').onclick = () => O.unity.send({ type: 'step' });
    document.getElementById('btn-refresh').onclick = () => this.unityRefresh(true);
    document.getElementById('unity-dot').parentElement.querySelector('.unity-label').onclick = (e) => this.unityMenu(e.currentTarget);
  }

  menuAt(anchor, items) {
    const r = anchor.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, items);
  }

  kb(id) {
    return displayKey(this.keys.primaryKey(id));
  }

  // menu item bound to a registered command
  cmdItem(id, label, iconName, extra = {}) {
    const c = this.keys.commands.get(id);
    return { label: label || c.label, icon: iconName || c.icon, key: this.kb(id), action: () => this.keys.run(id), ...extra };
  }

  mainMenu(anchor) {
    this.menuAt(anchor, [
      this.cmdItem('papyrus.openFolder', '폴더 열기…'),
      this.cmdItem('papyrus.newWindow'),
      this.cmdItem('papyrus.newScript', '새 C# 스크립트…'),
      '-',
      this.cmdItem('papyrus.save'),
      this.cmdItem('papyrus.saveAll'),
      this.cmdItem('workbench.commandPalette', '명령 팔레트…'),
      { label: '전체 검색', icon: 'search', key: this.settings['keyboard.doubleShift'] ? 'Shift Shift' : '', action: () => this.search.open('all') },
      this.cmdItem('papyrus.findInFiles'),
      '-',
      this.cmdItem('papyrus.toggleTheme', this.effectiveTheme() === 'dark' ? '밝은 테마로 전환' : '어두운 테마로 전환'),
      this.cmdItem('papyrus.settings', '설정'),
      this.cmdItem('papyrus.keybindings', '키보드 단축키'),
      '-',
      this.cmdItem('unity.installPackage'),
      this.cmdItem('lsp.restart'),
      this.cmdItem('lsp.install'),
      '-',
      this.cmdItem('papyrus.setupWizard'),
      this.cmdItem('papyrus.checkUpdate'),
      this.cmdItem('papyrus.about'),
      this.cmdItem('papyrus.devtools'),
    ]);
  }

  async projectMenu(anchor) {
    const recent = (this.recentProjects || []).slice(0, 10);
    const missing = await this.missingProjects(recent);
    const items = [{ label: '폴더 열기…', icon: 'folder-opened', action: () => this.pickProject() }, '-'];
    for (const p of recent) {
      const gone = missing.has(p);
      items.push({
        label: basename(p),
        icon: samePath(p, this.project) ? 'check' : gone ? 'warning' : 'folder',
        key: gone ? '폴더 없음' : p.length > 50 ? '…' + p.slice(-48) : p,
        dim: gone,
        title: '우클릭: 목록에서 제거 · 정리',
        action: () => (gone ? this.recentProjectMenu(p, anchor.getBoundingClientRect().left, anchor.getBoundingClientRect().bottom + 4) : this.openProject(p)),
        onContext: (x, y) => this.recentProjectMenu(p, x, y),
      });
    }
    if (missing.size) items.push('-', { label: `없는 프로젝트 정리 (${missing.size})`, icon: 'clear-all', action: () => this.pruneRecentProjects() });
    this.menuAt(anchor, items);
  }

  /** Recent projects whose folder no longer exists (moved / deleted). */
  async missingProjects(list) {
    const gone = new Set();
    await Promise.all(list.map(async (p) => { if (!(await O.fs.exists(p))) gone.add(p); }));
    return gone;
  }

  /** Right-click on a recent project (title bar list or welcome screen). */
  async recentProjectMenu(p, x, y) {
    const current = samePath(p, this.project);
    const gone = !(await O.fs.exists(p));
    const others = (this.recentProjects || []).filter((q) => !samePath(q, this.project));
    const missing = await this.missingProjects(this.recentProjects || []);
    contextMenu(x, y, [
      { label: current ? '현재 열린 프로젝트' : '열기', icon: 'folder-opened', disabled: current || gone, action: () => this.openProject(p) },
      { label: '새 창에서 열기', icon: 'empty-window', disabled: current || gone, action: () => O.app.newWindow(p) },
      { label: '파일 탐색기에서 보기', icon: 'folder', disabled: gone, action: () => O.app.reveal(p) },
      { label: '경로 복사', icon: 'copy', action: () => navigator.clipboard.writeText(p) },
      '-',
      { label: '목록에서 제거', icon: 'close', key: current ? '열려 있음' : '', disabled: current, action: () => this.setRecentProjects((this.recentProjects || []).filter((q) => !samePath(q, p)), `'${basename(p)}'을(를) 목록에서 뺐어요.`) },
      { label: `없는 프로젝트 정리${missing.size ? ` (${missing.size})` : ''}`, icon: 'clear-all', disabled: !missing.size, action: () => this.pruneRecentProjects() },
      { label: '다른 프로젝트 모두 지우기', icon: 'trash', disabled: !others.length, action: () => this.clearOtherRecentProjects() },
    ]);
  }

  async pruneRecentProjects() {
    const missing = await this.missingProjects(this.recentProjects || []);
    if (!missing.size) return;
    await this.setRecentProjects((this.recentProjects || []).filter((p) => !missing.has(p)), `폴더가 없는 프로젝트 ${missing.size}개를 목록에서 뺐어요.`);
  }

  async clearOtherRecentProjects() {
    const others = (this.recentProjects || []).filter((q) => !samePath(q, this.project));
    const ok = await O.app.confirm({ message: '최근 프로젝트 목록을 비울까요?', detail: `${others.length}개를 목록에서 뺍니다. 프로젝트 폴더는 지우지 않아요.`, buttons: ['비우기', '취소'] });
    if (ok !== 0 && ok !== true) return;
    await this.setRecentProjects(this.project ? [this.project] : [], '최근 프로젝트 목록을 비웠어요.');
  }

  /** Saves the list (only the list: project folders on disk are never touched). */
  async setRecentProjects(list, message) {
    this.recentProjects = await O.app.setRecentProjects(list);
    if (!this.project && document.getElementById('welcome').classList.contains('show')) this.showWelcome();
    if (message) toast({ title: '최근 프로젝트', message, timeout: 2500 });
  }

  unityMenu(anchor) {
    const st = this.unityStatus;
    const off = st.state !== 'connected';
    this.menuAt(anchor, [
      { label: st.state === 'connected' ? `연결됨 · Unity ${st.unityVersion || ''}` : 'Unity 연결 안 됨', icon: st.state === 'connected' ? 'pass' : 'circle-slash', disabled: true },
      '-',
      this.cmdItem('unity.play', '플레이 / 정지', null, { disabled: off }),
      this.cmdItem('unity.pause', '일시정지', null, { disabled: off }),
      this.cmdItem('unity.step', '한 프레임 진행', null, { disabled: off }),
      this.cmdItem('unity.refresh', '에셋 새로고침', null, { disabled: off }),
      this.cmdItem('unity.sync', '프로젝트 파일 다시 생성', null, { disabled: off }),
      '-',
      this.cmdItem('papyrus.showUnityLog', 'Unity 로그 보기'),
      this.cmdItem('unity.installPackage'),
    ]);
  }

  // ======================================================================== project
  async pickProject() {
    const p = await O.app.openFolderDialog();
    if (p) await this.openProject(p);
  }

  async openProject(path, goto) {
    // Picking the Assets folder by mistake: open the Unity project root instead.
    if (/^assets$/i.test(basename(path)) && (await O.fs.exists(joinPath(dirname(path), 'ProjectSettings')))) {
      path = dirname(path);
    }
    if (this.project && !samePath(path, this.project)) {
      if (!(await this.editors.closeAll())) return;
    }
    await O.app.setProject(path);
    this.project = path;
    this.recentProjects = [path, ...(this.recentProjects || []).filter((p) => !samePath(p, path))];
    this.isUnityProject = await O.fs.exists(joinPath(path, 'ProjectSettings'));
    this.unityFeatures.onProjectOpened(); // assets + project settings, in the background
    this.session = this.loadSession();
    document.getElementById('proj-name').textContent = basename(path);
    document.getElementById('proj-badge').textContent = basename(path).replace(/[^A-Za-z0-9가-힣]/g, '').slice(0, 2).toUpperCase() || 'P';
    this.updateTitle();
    document.getElementById('welcome').classList.remove('show');
    this.showEmptyEditor();

    await this.explorer.setRoot(path);
    const tool = this.sessionGet('tool');
    if (tool === null) this.hideSidebar();
    else this.showTool(tool || 'explorer');
    O.fs.watch(path);
    this.inspector.resetForProject();
    Promise.resolve(this.indexFiles()).then(() => this.inspector.restore());

    this.slnAtStart = await this.hasSolution();
    O.unity.start();
    this.startLsp();
    if (this.isUnityProject) {
      O.unity.ensureAnalyzers().then((r) => {
        // regenerate project files so they pick up the analyzer
        if (r && r.downloaded && this.unityStatus.state === 'connected') O.unity.send({ type: 'sync' });
      });
    }

    // restore tabs (and the splits they were in)
    const layout = this.sessionGet('layout');
    if (layout && Array.isArray(layout.groups)) {
      await this.editors.restore(layout, (p) => O.fs.exists(p));
    } else {
      const tabs = this.sessionGet('tabs') || [];
      for (const t of tabs) {
        if (await O.fs.exists(t)) await this.editors.open(t, { focus: false, pushHistory: false });
      }
      const active = this.sessionGet('active');
      if (active) {
        const tab = this.editors.findTab(active);
        if (tab) this.editors.activate(tab);
      }
    }
    this.recentFiles = (this.sessionGet('recent') || []).filter(Boolean);
    const bottom = this.sessionGet('bottom');
    if (bottom) this.panels.show(bottom);
    if (goto) await this.goto(goto);
    this.setup.maybeShow();
  }

  async hasSolution() {
    const list = await O.fs.listDir(this.project, { all: true });
    return list.some((e) => !e.dir && /\.slnx?$/.test(e.name));
  }

  async indexFiles() {
    this.fileIndex = await O.fs.listAllFiles(this.project);
  }

  async goto(g) {
    if (!g || !g.file) return;
    await this.editors.open(g.file, { line: g.line || 1, column: g.column || 1 });
  }

  updateTitle() {
    const t = this.editors.active;
    const parts = [];
    if (this.project) parts.push(basename(this.project));
    if (t) parts.push(t.special ? t.title : (t.dirty ? '● ' : '') + relPath(this.project, t.path));
    const title = parts.join(' – ') || 'PAPyrus';
    document.title = title;
    O.app.setTitle(title + ' – PAPyrus');
  }

  // ======================================================================== session
  loadSession() {
    try {
      return JSON.parse(localStorage.getItem('session:' + (this.project || '').toLowerCase()) || '{}');
    } catch {
      return {};
    }
  }

  sessionGet(k) {
    return this.session ? this.session[k] : undefined;
  }

  sessionSet(k, v) {
    if (!this.project || !this.session) return;
    this.session[k] = v;
    this.saveSessionSoon();
  }

  saveSession() {
    if (!this.project || !this.session) return;
    this.session.tabs = this.editors.tabs.filter((t) => !t.preview && !t.special).map((t) => t.path);
    this.session.active = this.editors.active && !this.editors.active.special ? this.editors.active.path : null;
    this.session.layout = this.editors.serialize();
    this.session.recent = this.recentFiles.slice(0, 50);
    localStorage.setItem('session:' + this.project.toLowerCase(), JSON.stringify(this.session));
  }

  saveSessionSoon = debounce(() => this.saveSession(), 400);

  recordRecent(path) {
    if (!path || path.startsWith('papyrus://')) return;
    this.recentFiles = [path, ...this.recentFiles.filter((p) => !samePath(p, path))].slice(0, 50);
    this.saveSessionSoon();
  }

  // ======================================================================== welcome / empty editor
  showWelcome() {
    const w = document.getElementById('welcome');
    w.classList.add('show');
    document.getElementById('editor-area').classList.add('empty');
    const recent = (this.recentProjects || []).slice(0, 8);
    w.replaceChildren(el('div.welcome', null,
      el('h1', null, el('img.logo-img.big', { src: logoUrl, alt: '' }), 'PAPyrus'),
      el('p', null, 'Unity용 가벼운 C# IDE. Unity 프로젝트 폴더(Assets가 있는 폴더)를 열어 주세요.'),
      el('div.actions', null,
        el('button.btn.primary', { onclick: () => this.pickProject() }, icon('folder-opened'), '폴더 열기')),
      recent.length ? el('div.recent-title', null, '최근 프로젝트') : null,
      el('div.recent', null, recent.map((p) => el('div.recent-item', {
        title: '우클릭: 목록에서 제거 · 정리',
        onclick: (e) => (e.currentTarget.classList.contains('missing') ? this.recentProjectMenu(p, e.clientX, e.clientY) : this.openProject(p)),
        oncontextmenu: (e) => { e.preventDefault(); this.recentProjectMenu(p, e.clientX, e.clientY); },
        'data-path': p,
      },
      el('span.proj-badge', null, basename(p).slice(0, 2).toUpperCase()),
      el('div', null, el('div.rn', null, basename(p)), el('div.rp', null, p)))))));
    // folders that are gone: struck through (click/right-click offers the cleanup)
    this.missingProjects(recent).then((gone) => {
      for (const row of w.querySelectorAll('.recent-item')) {
        if (!gone.has(row.dataset.path)) continue;
        row.classList.add('missing');
        row.querySelector('.rp').textContent = `${row.dataset.path} · 폴더 없음`;
      }
    });
  }

  showEmptyEditor() {
    const w = document.getElementById('welcome');
    const row = (key, label) => (key ? [el('span', null, ...key.split(' ').map((x) => el('kbd', null, x))), el('span', null, label)] : []);
    w.replaceChildren(el('div.welcome', { style: { marginTop: '20vh', maxWidth: '380px' } },
      el('div.shortcuts', null,
        row(this.settings['keyboard.doubleShift'] ? 'Shift Shift' : '', '전체 검색'),
        row(this.kb('workbench.quickOpen'), '파일로 이동'),
        row(this.kb('workbench.commandPalette'), '명령 팔레트'),
        row(this.kb('workbench.gotoSymbol'), '심볼로 이동'),
        row(this.kb('workbench.recentFiles'), '최근 파일'),
        row(this.kb('papyrus.findInFiles'), '파일에서 찾기'),
        row(this.kb('papyrus.newScript'), '새 C# 스크립트'),
        row(this.kb('unity.play'), 'Unity 플레이 / 정지'),
        row(this.kb('papyrus.settings'), '설정'))));
  }

  onActiveTab(tab) {
    const w = document.getElementById('welcome');
    if (!tab && this.project) {
      w.classList.add('show');
      this.showEmptyEditor();
    } else if (tab) w.classList.remove('show');
    this.updateTitle();
    this.updateStatus();
    this.updatePath();
    this.symbols = null;
    this.refreshSymbols();
    this.structure.refreshSoon();
    this.saveSessionSoon();
    if (tab && tab.model) {
      if (this.symSub) this.symSub.dispose();
      this.symSub = tab.model.onDidChangeContent(() => { this.refreshSymbols(); this.structure.refreshSoon(); });
    }
  }

  refreshSymbols = debounce(async () => {
    const tab = this.editors.active;
    if (!tab || !tab.model || tab.model.getLanguageId() !== 'csharp' || !this.lsp.running) {
      this.symbols = null;
      this.renderBreadcrumbs();
      return;
    }
    this.symbols = await this.lsp.documentSymbols(tab.model);
    this.renderBreadcrumbs();
  }, 400);

  renderBreadcrumbs() {
    const bc = document.getElementById('breadcrumbs');
    const tab = this.editors.active;
    if (!tab || !tab.model) { bc.replaceChildren(); return; }
    const pos = this.editors.editor.getPosition();
    const chain = [];
    const walk = (list) => {
      for (const s of list || []) {
        const r = s.range;
        if (pos && (pos.lineNumber - 1 > r.start.line || (pos.lineNumber - 1 === r.start.line && pos.column - 1 >= r.start.character))
          && (pos.lineNumber - 1 < r.end.line || (pos.lineNumber - 1 === r.end.line && pos.column - 1 <= r.end.character))) {
          chain.push(s);
          walk(s.children);
          return;
        }
      }
    };
    walk(this.symbols);
    const parts = [];
    for (const s of chain) {
      if (parts.length) parts.push(el('span.sep', null, '›'));
      const ic = icon(cv.symbolIcon(s.kind));
      ic.style.color = cv.symbolColor(s.kind);
      parts.push(el('span.crumb', { onclick: () => this.editors.open(tab.path, { line: s.selectionRange.start.line + 1, column: s.selectionRange.start.character + 1 }) }, ic, s.name));
    }
    bc.replaceChildren(...parts);
  }

  onCursor(pos) {
    const sel = this.editors.editor.getSelection();
    const m = this.editors.editor.getModel();
    let txt = `${pos.lineNumber}:${pos.column}`;
    if (sel && m && !sel.isEmpty()) {
      const n = m.getValueLengthInRange(sel);
      const lines = sel.endLineNumber - sel.startLineNumber + 1;
      txt += lines > 1 ? `  (${n}자, 줄바꿈 ${lines - 1})` : `  (${n}자)`;
    }
    document.getElementById('sb-pos').textContent = txt;
    this.renderBreadcrumbsSoon();
  }

  renderBreadcrumbsSoon = debounce(() => this.renderBreadcrumbs(), 80);

  updatePath() {
    const sb = document.getElementById('sb-path');
    const tab = this.editors.active;
    if (!this.project) { sb.replaceChildren(); return; }
    if (tab && tab.special) { sb.replaceChildren(el('span.crumb', null, tab.title)); return; }
    const rel = tab ? relPath(this.project, tab.path) : '';
    const inside = !tab || !/^([A-Za-z]:|\/)/.test(rel);
    const out = [];
    if (inside) {
      const parts = [basename(this.project), ...(rel ? rel.split('/') : [])];
      let acc = this.project;
      parts.forEach((p, i) => {
        if (i) {
          out.push(el('span.sep', null, icon('chevron-right')));
          acc = joinPath(acc, p);
        }
        const target = acc;
        out.push(el('span.crumb', { onclick: () => this.explorer.reveal(target) }, p));
      });
    } else {
      out.push(el('span.crumb', { title: tab.path, onclick: () => O.app.reveal(tab.path) }, tab.path));
    }
    sb.replaceChildren(...out);
  }

  updateStatus() {
    const tab = this.editors.active;
    const m = tab && tab.model;
    const eol = document.getElementById('sb-eol');
    const enc = document.getElementById('sb-enc');
    const ind = document.getElementById('sb-indent');
    const pos = document.getElementById('sb-pos');
    if (!m) {
      eol.textContent = enc.textContent = ind.textContent = pos.textContent = '';
      return;
    }
    eol.textContent = m.getEOL() === '\r\n' ? 'CRLF' : 'LF';
    eol.onclick = () => {
      m.pushEOL(m.getEOL() === '\r\n' ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
      this.updateStatus();
    };
    enc.textContent = { utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', cp949: 'CP949', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE' }[tab.encoding] || tab.encoding;
    enc.title = tab.encoding === 'cp949' ? '저장하면 UTF-8(BOM)로 바뀌어요' : '';
    const o = m.getOptions();
    ind.textContent = o.insertSpaces ? `공백 ${o.indentSize || o.tabSize}칸` : '탭';
    const p = this.editors.editor.getPosition();
    if (p) this.onCursor(p);
  }

  // ======================================================================== LSP
  async startLsp() {
    const res = await this.lsp.start();
    if (res && res.missing && this.settings['setup.dontShow']) {
      toast({
        kind: 'warn', timeout: 0,
        title: 'C# 언어 서버가 없어요',
        message: '자동완성·오류 표시에 필요해요.',
        actions: [{ label: '설정 도우미 열기', action: () => this.setup.open() }],
      });
    }
  }

  async restartLsp() {
    await this.lsp.stop();
    this.startLsp();
  }

  /** Unity writes the project files one by one: restart once after the last of them. */
  restartLspSoon() {
    clearTimeout(this.lspRestartTimer);
    this.lspRestartTimer = setTimeout(() => this.restartLsp(), 2500);
  }

  async installLsp() {
    this.panels.show('output');
    const ok = await O.lsp.install();
    if (ok) {
      toast({ title: 'C# 언어 서버 설치 완료', message: '언어 서버를 시작할게요.' });
      this.restartLsp();
    } else toast({ kind: 'error', title: '설치 실패', message: 'Output 창을 확인해 주세요.', timeout: 0 });
  }

  onLspStatus(st) {
    this.lspState = st.state;
    const sb = document.getElementById('sb-lsp');
    const labels = {
      starting: ['loading', 'C# 시작 중', 'spin'],
      restoring: ['loading', 'C# 패키지 복원 중', 'spin'],
      loading: ['loading', 'C# 프로젝트 로딩 중', 'spin'],
      ready: ['check', 'C#', ''],
      error: ['error', 'C# 오류', ''],
      missing: ['warning', 'C# 언어 서버 없음', ''],
      stopped: ['circle-slash', 'C# 중지됨', ''],
    };
    const [ic, label, spin] = labels[st.state] || ['circle', st.state, ''];
    const i = icon(ic);
    if (spin) i.classList.add('spin');
    sb.replaceChildren(i, label);
    sb.className = 'sb-item' + (st.state === 'error' ? ' err' : st.state === 'missing' ? ' warn' : st.state === 'ready' ? ' ok' : '');
    sb.title = st.detail || '';
    sb.onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.top - 170, [
        { label: '언어 서버 재시작', icon: 'debug-restart', action: () => this.restartLsp() },
        { label: 'dotnet restore 실행', icon: 'package', action: async () => { this.panels.show('output'); await O.lsp.restore(); this.restartLsp(); } },
        { label: '언어 서버 설치/업데이트', icon: 'cloud-download', action: () => this.installLsp() },
        { label: 'Output 보기', icon: 'output', action: () => this.panels.show('output') },
      ]);
    };
    if (st.state === 'ready') {
      this.refreshSymbols();
      this.structure.refreshSoon();
    }
    if (st.state === 'error' && st.detail) this.panels.views.output.append(`[상태] ${st.detail}`);
  }

  async runLspCommand(cmd, uri) {
    if (!cmd) return;
    const name = cmd.command;
    const args = cmd.arguments || [];
    if (name === 'roslyn.client.completionComplexEdit') {
      // [textDocument, textEdit, isSnippet, newOffset]
      const [td, te, isSnippet, newOffset] = args;
      const model = monaco.editor.getModel(monaco.Uri.parse(td.uri || uri));
      const ed = this.editors.editor;
      if (!model || ed.getModel() !== model) return;
      const range = cv.toRange(te.range);
      if (isSnippet) {
        ed.setSelection(range);
        ed.getContribution('snippetController2').insert(te.newText, { overwriteBefore: 0, overwriteAfter: 0 });
      } else {
        ed.executeEdits('lsp', [{ range, text: te.newText }]);
        if (newOffset >= 0) {
          const p = model.getPositionAt(newOffset);
          ed.setPosition(p);
        }
      }
      return;
    }
    if (name === 'roslyn.client.peekReferences' || name === 'editor.action.showReferences') {
      const [u, pos] = args;
      const path = cv.uriToPath(typeof u === 'string' ? u : (u && u.uri) || uri);
      if (path && pos) {
        const at = popupPoint(this.editors.editor); // the lens that was clicked, before the caret moves
        await this.editors.open(path, { line: pos.line + 1, column: pos.character + 1 });
        this.findUsages({ at });
      }
      return;
    }
    if (name === 'papyrus.showImplementations') {
      const [u, pos] = args;
      this.showImplementations({ uri: u, pos, at: popupPoint(this.editors.editor) });
      return;
    }
    if (/nestedCodeAction|fixAllCodeAction/.test(name)) {
      toast({ kind: 'info', title: '이 리팩터링은 아직 지원하지 않아요', message: cmd.title || name });
      return;
    }
    const exec = this.lsp.caps && this.lsp.caps.executeCommandProvider;
    if (exec && (exec.commands || []).includes(name)) {
      await this.lsp.request('workspace/executeCommand', { command: name, arguments: args });
    }
  }

  /**
   * Usages of the symbol at the caret. Opens a popup at the click point / caret (Rider's
   * "Show Usages"); `panel: true` puts them in the bottom Find panel instead.
   */
  async findUsages({ at, panel = false, position } = {}) {
    const ed = this.editors.editor;
    const m = ed.getModel();
    if (!m) return;
    at = at || popupPoint(ed);
    const pos = position || ed.getPosition();
    const w = m.getWordAtPosition(pos);
    if (!this.lsp.running) {
      // fall back to text search
      if (w) { this.panels.show('find'); this.panels.views.find.focus(w.word); this.panels.views.find.search(w.word); }
      return;
    }
    const refs = await this.lsp.references(m, pos);
    const name = w ? w.word : '';
    if (!refs.length) {
      toast({ title: '사용처 없음', message: name, timeout: 2500 });
      return;
    }
    const toPanel = () => { this.panels.show('find'); this.panels.views.find.showUsages(name, refs); };
    if (panel) { toPanel(); return; }
    if (refs.length === 1) { this.openLocation(refs[0]); return; }
    showLocationPopup({
      title: `'${name}' 사용처 ${refs.length}개`,
      locations: refs,
      at,
      project: this.project,
      currentPath: this.editors.active && this.editors.active.path,
      onPick: (path, line, column) => this.editors.open(path, { line, column }),
      onPanel: toPanel,
    });
  }

  /** Derived types / implementations / overrides, in the same popup. Defaults to the caret. */
  async showImplementations({ uri, pos, at } = {}) {
    const ed = this.editors.editor;
    at = at || popupPoint(ed);
    if (!uri) {
      const m = ed.getModel();
      if (!m) return;
      uri = m.uri.toString();
      pos = cv.toPos(ed.getPosition());
    }
    if (!this.lsp.running) return;
    const locs = await this.lsp.implementations(uri, pos);
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    const w = model && model.getWordAtPosition({ lineNumber: pos.line + 1, column: pos.character + 1 });
    const name = w ? w.word : '';
    if (!locs.length) {
      toast({ title: '구현·상속 없음', message: name, timeout: 2500 });
      return;
    }
    if (locs.length === 1) { this.openLocation(locs[0]); return; }
    showLocationPopup({
      title: `'${name}' 구현·상속 ${locs.length}개`,
      locations: locs,
      at,
      project: this.project,
      currentPath: this.editors.active && this.editors.active.path,
      onPick: (path, line, column) => this.editors.open(path, { line, column }),
    });
  }

  /** "리팩터링" group in the editor's right-click menu (C# only; keys come from our keymap). */
  attachRefactorMenu(editor) {
    const isCs = 'editorLangId == csharp';
    const add = (id, label, order, run) => editor.addAction({
      id: 'papyrus.menu.' + id, label, precondition: isCs, contextMenuGroupId: '1_papyrus_refactor', contextMenuOrder: order, run,
    });
    add('refactorThis', '리팩터링…', 1, () => this.refactor.menu());
    add('extractMethod', '메서드 추출…', 2, () => this.refactor.extractMethod());
    add('changeSignature', '시그니처 변경…', 3, () => this.refactor.changeSignature());
    add('moveType', '타입 이동…', 4, () => this.refactor.moveType());
    add('safeDelete', '안전 삭제…', 5, () => this.refactor.safeDelete());
    add('extractInterface', '인터페이스 추출…', 6, () => this.refactor.extractInterface());
    add('adjustNamespaces', '네임스페이스를 폴더에 맞추기', 7, () => this.refactor.adjustCurrentNamespace());
  }

  // Ctrl+click on a declaration shows its usages at the click point (Monaco's own fallback opens
  // the inline peek below the line; that's switched off in the editor options).
  attachCtrlClickUsages(editor) {
    editor.onMouseUp(async (e) => {
      const ev = e.event;
      if (!(ev.ctrlKey || ev.metaKey) || !ev.leftButton || ev.shiftKey || ev.altKey) return;
      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !e.target.position) return;
      const model = editor.getModel();
      if (!model || model.getLanguageId() !== 'csharp' || !this.lsp.running) return;
      const position = e.target.position;
      const at = { x: ev.browserEvent.clientX, y: ev.browserEvent.clientY + 10 };
      const defs = await this.lsp.definitionAt(model, position).catch(() => []);
      const here = model.uri.toString();
      const onDecl = defs.some((d) => monaco.Uri.parse(d.uri).toString() === here
        && cv.toRange(d.range).containsPosition(position));
      if (onDecl && editor.getModel() === model) this.findUsages({ at, position });
    });
  }

  openLocation(l) {
    const path = cv.uriToPath(l.uri);
    if (path) this.editors.open(path, { line: l.range.start.line + 1, column: l.range.start.character + 1 });
  }

  findInFiles() {
    const ed = this.editors.editor;
    const m = ed.getModel();
    let text = '';
    if (m) {
      const sel = ed.getSelection();
      text = sel && !sel.isEmpty() ? m.getValueInRange(sel) : '';
      if (text.includes('\n')) text = '';
    }
    this.panels.show('find');
    this.panels.views.find.focus(text);
  }

  // ======================================================================== Unity
  renderUnity() {
    const st = this.unityStatus;
    const s = this.unityState || {};
    const dot = document.getElementById('unity-dot');
    dot.className = 'unity-dot ' + (st.state || '');
    const label = document.getElementById('unity-label');
    const connected = st.state === 'connected';
    if (connected) label.textContent = s.isCompiling ? '컴파일 중…' : `Unity ${st.unityVersion || ''}`.trim();
    else if (st.state === 'reloading' || st.state === 'connecting') label.textContent = 'Unity 다시 연결 중…';
    else label.textContent = st.packageInstalled === false && st.isUnityProject ? 'Unity 패키지 없음' : 'Unity 연결 안 됨';
    label.title = connected ? `${st.projectName || ''} · PID ${st.pid || ''}` : '클릭해서 Unity 메뉴 열기';
    for (const id of ['btn-play', 'btn-pause', 'btn-step', 'btn-refresh']) document.getElementById(id).disabled = !connected;
    const play = document.getElementById('btn-play');
    play.classList.toggle('playing', !!s.isPlaying);
    play.title = `${s.isPlaying ? '정지' : '플레이'} (${this.kb('unity.play')})`;
    play.querySelector('.codicon').className = 'codicon codicon-' + (s.isPlaying ? 'debug-stop' : 'play');
    document.getElementById('btn-pause').classList.toggle('paused', !!s.isPaused);
    const sbu = document.getElementById('sb-unity');
    sbu.replaceChildren(el('span.unity-dot.' + (st.state || ''), { style: { margin: '0 2px 0 0' } }), connected ? (s.isPlaying ? (s.isPaused ? 'Unity · 일시정지' : 'Unity · 플레이 중') : 'Unity') : 'Unity 꺼짐');
    sbu.onclick = (e) => this.unityMenu(e.currentTarget);
  }

  unityPlay() {
    if (this.unityStatus.state !== 'connected') return;
    if (!this.unityState.isPlaying && this.editors.dirtyTabs.length) {
      this.editors.saveAll();
    }
    O.unity.send({ type: this.unityState.isPlaying ? 'stop' : 'play' });
  }

  unityRefresh(manual) {
    if (this.unityStatus.state !== 'connected') {
      if (manual) toast({ kind: 'warn', title: 'Unity와 연결되지 않았어요', timeout: 3000 });
      return;
    }
    O.unity.send({ type: 'refresh' });
  }

  unityRefreshSoon = debounce(() => this.unityRefresh(false), 350);

  onSaved(tab) {
    if (samePath(tab.path, this.settingsPath)) {
      O.app.reloadSettings().then((s) => {
        const prev = this.settings;
        this.settings = s;
        this.applySettings(prev);
        if (this.settingsView) this.settingsView.render();
        toast({ title: '설정을 적용했어요', timeout: 2000 });
      });
      return;
    }
    if (this.settings['unity.refreshOnSave'] !== false && /\.(cs|shader|hlsl|cginc|compute|asmdef|asmref|uss|uxml|json)$/i.test(tab.path)) this.unityRefreshSoon();
  }

  /**
   * Request/response over the Unity bridge: sends {type, id, ...params} and resolves the "data" of
   * Unity's {type:'reply', id} (PapyrusInspector.cs). Rejects with err.code 'disconnected' |
   * 'timeout' | 'notReady' (Unity compiling / not imported yet) or Unity's error message.
   */
  unityRequest(type, params = {}, timeout = 10000) {
    const fail = (message, code) => Promise.reject(Object.assign(new Error(message), { code }));
    if (this.unityStatus.state !== 'connected') return fail('Unity와 연결돼 있지 않아요.', 'disconnected');
    if (!this.unityPending) this.unityPending = new Map();
    const id = (this.unityReqId = (this.unityReqId || 0) + 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.unityPending.delete(id);
        reject(Object.assign(new Error('Unity가 응답하지 않아요. 컴파일 중이거나 Unity 창이 바쁜 것 같아요.'), { code: 'timeout' }));
      }, timeout);
      this.unityPending.set(id, { resolve, reject, timer });
      O.unity.send({ ...params, type, id });
    });
  }

  rejectUnityRequests(message) {
    if (!this.unityPending) return;
    for (const [id, p] of this.unityPending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(message), { code: 'disconnected' }));
      this.unityPending.delete(id);
    }
  }

  onUnityReply(msg) {
    const p = this.unityPending && this.unityPending.get(msg.id);
    if (!p) return;
    this.unityPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) {
      const data = msg.data;
      if (data && typeof data === 'object' && typeof msg.playMode === 'boolean') data.playMode = msg.playMode;
      p.resolve(data);
    } else {
      p.reject(Object.assign(new Error(msg.error || 'Unity에서 실패했어요.'), { code: msg.code || 'error' }));
    }
  }

  onUnityMessage(msg) {
    const log = this.panels.views.unity;
    if (msg.type === 'reply') {
      this.onUnityReply(msg);
      return;
    }
    const t = msg.type || '';
    if (t.startsWith('inspector.') || t === 'compileFinished' || t === 'state') this.inspector.onUnityMessage(msg);
    switch (msg.type) {
      case 'log':
        log.add(msg);
        break;
      case 'history':
        log.logs = [];
        (msg.logs || []).forEach((l) => log.add(l));
        break;
      case 'clear':
        log.clear();
        break;
      case 'state':
        this.unityState = msg;
        this.renderUnity();
        break;
      case 'playStarting':
        if (this.settings['unity.clearLogOnPlay'] !== false) log.clear();
        break;
      case 'compileFinished':
        if (msg.errors > 0) {
          toast({ kind: 'error', title: `Unity 컴파일 에러 ${msg.errors}개`, message: '', actions: [{ label: 'Unity 로그 보기', action: () => this.panels.show('unity') }], timeout: 5000 });
        }
        // a package was added or updated: its DLL (referenced by the projects) only exists now
        if (this.packagesChanged) {
          this.packagesChanged = false;
          this.restartLspSoon();
        }
        break;
      case 'projectFilesSynced':
        if (!this.slnAtStart) {
          this.slnAtStart = true;
          this.restartLsp();
        }
        break;
      default:
        break;
    }
  }

  async installUnityPackage() {
    if (!this.project) return;
    try {
      const dst = await O.unity.installPackage();
      toast({
        kind: 'info', timeout: 0,
        title: 'Unity 패키지를 설치했어요',
        message: `${relPath(this.project, dst)}\n\nUnity로 돌아가 컴파일이 끝나면 Edit > Preferences > External Tools > External Script Editor에서 'PAPyrus'를 고르세요.`,
      });
    } catch (err) {
      toast({ kind: 'error', title: '설치 실패', message: String(err.message || err) });
    }
  }

  async rootNamespaceFor(dir) {
    // nearest .asmdef rootNamespace
    let d = dir;
    for (let i = 0; i < 20 && this.project && d.length >= this.project.length; i++) {
      const list = await O.fs.listDir(d);
      const asm = list.find((e) => !e.dir && e.name.endsWith('.asmdef'));
      if (asm) {
        try {
          const r = await O.fs.readFile(asm.path);
          const j = JSON.parse(r.text);
          return j.rootNamespace || '';
        } catch {
          return '';
        }
      }
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
    try {
      const r = await O.fs.readFile(joinPath(joinPath(this.project, 'ProjectSettings'), 'EditorSettings.asset'));
      const m = r.text && r.text.match(/m_ProjectGenerationRootNamespace:\s*(\S+)/);
      return m ? m[1] : '';
    } catch {
      return '';
    }
  }

  // ======================================================================== settings & help
  openSettings(section) {
    if (!this.settingsView) this.settingsView = new SettingsView(this);
    this.settingsView.show(section);
    this.editors.openSpecial('settings', '설정', 'settings-gear', this.settingsView.el);
  }

  async openSettingsJson() {
    this.settingsPath = await O.app.settingsPath();
    const exists = await O.fs.exists(this.settingsPath);
    const cur = exists ? await O.fs.readFile(this.settingsPath) : null;
    let obj = {};
    try { obj = cur && cur.text ? JSON.parse(cur.text) : {}; } catch { obj = null; }
    if (obj) {
      const merged = { ...this.settings, ...obj };
      await O.fs.writeFile(this.settingsPath, JSON.stringify(merged, null, 2), 'utf8');
    }
    await this.editors.open(this.settingsPath);
    toast({ title: 'settings.json', message: '저장(Ctrl+S)하면 바로 적용돼요.', timeout: 3500 });
  }

  showAbout() {
    const back = el('div.dialog-back', { onmousedown: (e) => { if (e.target === back) back.remove(); } },
      el('div.dialog.about', { style: { width: '380px' } },
        el('img', { src: logoUrl, alt: '' }),
        el('h2', null, 'PAPyrus'),
        el('div.ver', null, `버전 ${this.version || ''} · Electron ${this.electronVersion || ''}`),
        el('div.credits', null, 'Unity용 가벼운 C# IDE', el('br'),
          'Monaco Editor (MIT) · Roslyn Language Server (MIT)', el('br'),
          'Microsoft.Unity.Analyzers (MIT) · JetBrains Mono / Inter (OFL)', el('br'),
          'Codicons © Microsoft (CC BY 4.0)', el('br'),
          '전체 라이선스: 설치 폴더의 THIRD_PARTY_NOTICES.txt'),
        el('div.row', { style: { justifyContent: 'center' } },
          el('button.btn', { onclick: () => { back.remove(); this.updates.check(); } }, icon('cloud-download'), '업데이트 확인'),
          el('button.btn.primary', { onclick: () => back.remove() }, '닫기'))));
    document.getElementById('overlay-root').append(back);
  }

  // ======================================================================== commands & keys
  editorAction(id) {
    const ed = this.editors.editor;
    if (!ed.getModel()) return;
    ed.focus();
    const a = ed.getAction(id);
    if (a) a.run();
    else ed.trigger('keyboard', id, null);
  }

  // Command palette / Search Everywhere "Actions" list, derived from the command registry.
  actions() {
    return [...this.keys.commands.values()].filter((c) => !c.hidden).map((c) => ({
      id: c.id,
      label: c.label,
      category: c.category,
      key: displayKey(this.keys.primaryKey(c.id)),
      icon: c.icon,
      run: () => this.keys.run(c.id),
    }));
  }

  reformat() {
    const ed = this.editors.editor;
    const sel = ed.getSelection();
    this.editorAction(sel && !sel.isEmpty() ? 'editor.action.formatSelection' : 'editor.action.formatDocument');
  }

  completeStatement() {
    const ed = this.editors.editor;
    const m = ed.getModel();
    if (!m) return;
    const p = ed.getPosition();
    const line = m.getLineContent(p.lineNumber);
    const trimmed = line.trimEnd();
    const end = trimmed.length + 1;
    const needsSemi = trimmed && !/[;{}]$/.test(trimmed) && !/^\s*(\/\/|#|\[)/.test(trimmed) && !/^\s*(if|for|foreach|while|else|switch|using\s*\(|lock|catch|try|finally|do)\b.*\)?$/.test(trimmed) && !/\b(class|struct|interface|enum|namespace|record)\b/.test(trimmed);
    const edits = [];
    if (needsSemi) edits.push({ range: new monaco.Range(p.lineNumber, end, p.lineNumber, end), text: ';' });
    ed.executeEdits('complete', edits);
    ed.setPosition({ lineNumber: p.lineNumber, column: m.getLineMaxColumn(p.lineNumber) });
    if (!needsSemi) ed.trigger('keyboard', 'type', { text: '\n' });
  }

  toggleMaximize() {
    if (this.sidebarVisible || this.panels.visible) {
      this.maxState = { tool: this.sidebarVisible ? this.tool : null, bottom: this.panels.visible ? this.panels.current : null };
      this.hideSidebar();
      if (this.panels.visible) this.panels.hide();
    } else if (this.maxState) {
      if (this.maxState.tool) this.showTool(this.maxState.tool);
      if (this.maxState.bottom) this.panels.show(this.maxState.bottom);
      this.maxState = null;
    }
  }

  toggleSidebar() {
    if (this.sidebarVisible) this.hideSidebar();
    else this.showTool(this.tool || 'explorer');
  }

  togglePanel() {
    if (this.panels.visible) this.panels.hide();
    else this.panels.show(this.panels.current || 'unity');
  }

  newScriptHere() {
    let dir = null;
    if (this.explorer.selected) dir = this.explorer.isDir(this.explorer.selected) ? this.explorer.selected : dirname(this.explorer.selected);
    else if (this.editors.active && !this.editors.active.special) dir = dirname(this.editors.active.path);
    else if (this.project) dir = joinPath(this.project, 'Assets');
    if (dir) this.explorer.newScript(dir);
  }

  setKeyHint(text, timeout) {
    const sb = document.getElementById('sb-key');
    sb.textContent = text || '';
    clearTimeout(this.keyHintTimer);
    if (text && timeout) this.keyHintTimer = setTimeout(() => { sb.textContent = ''; }, timeout);
  }

  setupCommands() {
    monaco.editor.registerCommand('papyrus.lsp.command', (_acc, cmd, uri) => this.runLspCommand(cmd, uri));
    const K = this.keys;
    const G = (id, label, keys, run, extra = {}) => K.register({ id, label, keys, run, scope: 'global', ...extra });
    const E = (id, label, keys, run, extra = {}) => K.register({ id, label, keys, run, scope: 'editor', ...extra });
    // editor command that maps to a Monaco built-in
    const M = (id, label, keys, extra = {}) => E(id, label, keys, () => this.editorAction(id), { monaco: id, ...extra });

    // ---- 이동 / 검색
    let cat = { category: '이동' };
    G('workbench.quickOpen', '파일로 이동', 'Ctrl+P', () => this.search.open('files'), { icon: 'go-to-file', ...cat });
    G('workbench.commandPalette', '명령 팔레트', ['Ctrl+Shift+P', 'F1'], () => this.search.open('actions'), { icon: 'symbol-event', ...cat });
    G('workbench.searchEverywhere', '전체 검색', [], () => this.search.open('all'), { icon: 'search', ...cat });
    G('workbench.gotoSymbol', '작업 영역 심볼로 이동', 'Ctrl+T', () => this.search.open('symbols'), { icon: 'symbol-method', ...cat });
    G('workbench.gotoType', '타입으로 이동', [], () => this.search.open('types'), { icon: 'symbol-class', ...cat });
    G('workbench.recentFiles', '최근 파일', 'Ctrl+E', () => this.search.open('recent'), { icon: 'history', ...cat });
    M('editor.action.gotoLine', '줄로 이동', 'Ctrl+G', cat);
    M('editor.action.quickOutline', '파일의 심볼로 이동', 'Ctrl+Shift+O', cat);
    M('editor.action.revealDefinition', '정의로 이동', 'F12', cat);
    M('editor.action.peekDefinition', '정의 미리 보기', 'Alt+F12', cat);
    E('papyrus.showImplementations', '구현·상속으로 이동', 'Ctrl+F12', () => this.showImplementations(), cat);
    M('editor.action.goToTypeDefinition', '타입 정의로 이동', [], cat);
    E('papyrus.showUsages', '사용처 보기 (팝업)', 'Shift+F12', () => this.findUsages(), cat);
    E('papyrus.findUsages', '모든 참조 찾기 (아래 패널)', 'Shift+Alt+F12', () => this.findUsages({ panel: true }), cat);
    M('editor.action.referenceSearch.trigger', '참조 미리 보기 (인라인)', [], cat);
    M('editor.action.marker.next', '다음 문제', 'F8', cat);
    M('editor.action.marker.prev', '이전 문제', 'Shift+F8', cat);
    M('editor.action.jumpToBracket', '짝 괄호로 이동', 'Ctrl+Shift+\\', cat);
    G('papyrus.navigateBack', '뒤로 이동', 'Alt+Left', () => this.editors.back(), { icon: 'arrow-left', ...cat });
    G('papyrus.navigateForward', '앞으로 이동', 'Alt+Right', () => this.editors.forward(), { icon: 'arrow-right', ...cat });
    G('papyrus.findInFiles', '파일에서 찾기', 'Ctrl+Shift+F', () => this.findInFiles(), { icon: 'search', ...cat });
    M('actions.find', '찾기', 'Ctrl+F', cat);
    M('editor.action.startFindReplaceAction', '바꾸기', 'Ctrl+H', cat);

    // ---- 편집
    cat = { category: '편집' };
    M('editor.action.triggerSuggest', '자동완성 열기', ['Ctrl+Space', 'Ctrl+I'], cat);
    M('editor.action.triggerParameterHints', '파라미터 힌트', 'Ctrl+Shift+Space', cat);
    M('editor.action.showHover', '호버(문서) 보기', 'Ctrl+K Ctrl+I', cat);
    M('editor.action.quickFix', '빠른 수정', 'Ctrl+.', cat);
    M('editor.action.rename', '이름 바꾸기', 'F2', cat);
    // Rider-style refactorings (refactorings.js); Move is F6 in Rider, but F6 pauses Unity here
    E('papyrus.refactorThis', '리팩터링 메뉴 (Refactor This)', 'Ctrl+Shift+R', () => this.refactor.menu(), cat);
    E('papyrus.extractMethod', '메서드 추출', 'Ctrl+Alt+M', () => this.refactor.extractMethod(), cat);
    E('papyrus.changeSignature', '시그니처 변경', 'Ctrl+F6', () => this.refactor.changeSignature(), cat);
    E('papyrus.moveType', '타입 이동', 'Ctrl+Shift+Alt+M', () => this.refactor.moveType(), cat);
    E('papyrus.safeDelete', '안전 삭제', 'Alt+Delete', () => this.refactor.safeDelete(), cat);
    E('papyrus.extractInterface', '인터페이스 추출', null, () => this.refactor.extractInterface(), cat);
    E('papyrus.adjustNamespaces', '네임스페이스를 폴더에 맞추기', null, () => this.refactor.adjustCurrentNamespace(), cat);
    E('papyrus.optimizeUsings', 'using 정리 (안 쓰는 using 지우기)', 'Ctrl+Alt+O', async () => {
      const n = await this.usingCleanup.cleanNow(this.editors.editor.getModel());
      if (n < 0) toast({ kind: 'warn', title: 'using 정리', message: 'C# 언어 서버가 아직 분석 중이에요. 잠시 뒤에 다시 해 보세요.', timeout: 3000 });
      else toast({ title: 'using 정리', message: n ? `using ${n}개를 지웠어요.` : '지울 using이 없어요.', timeout: 2000 });
    }, cat);
    E('papyrus.formatDocument', '문서 서식', 'Shift+Alt+F', () => this.editorAction('editor.action.formatDocument'), { monaco: 'editor.action.formatDocument', ...cat });
    M('editor.action.formatSelection', '선택 영역 서식', 'Ctrl+K Ctrl+F', cat);
    M('editor.action.commentLine', '줄 주석 토글', 'Ctrl+/', cat);
    M('editor.action.addCommentLine', '줄 주석 추가', 'Ctrl+K Ctrl+C', cat);
    M('editor.action.removeCommentLine', '줄 주석 제거', 'Ctrl+K Ctrl+U', cat);
    M('editor.action.blockComment', '블록 주석 토글', 'Shift+Alt+A', cat);
    M('editor.action.copyLinesDownAction', '줄 아래로 복사', 'Shift+Alt+Down', cat);
    M('editor.action.copyLinesUpAction', '줄 위로 복사', 'Shift+Alt+Up', cat);
    M('editor.action.moveLinesDownAction', '줄 아래로 이동', 'Alt+Down', cat);
    M('editor.action.moveLinesUpAction', '줄 위로 이동', 'Alt+Up', cat);
    M('editor.action.deleteLines', '줄 삭제', 'Ctrl+Shift+K', cat);
    M('editor.action.insertLineAfter', '아래에 줄 삽입', 'Ctrl+Enter', cat);
    M('editor.action.insertLineBefore', '위에 줄 삽입', 'Ctrl+Shift+Enter', cat);
    M('editor.action.indentLines', '들여쓰기', 'Ctrl+]', cat);
    M('editor.action.outdentLines', '내어쓰기', 'Ctrl+[', cat);
    M('editor.action.addSelectionToNextFindMatch', '다음 일치 항목 선택 추가', 'Ctrl+D', cat);
    M('editor.action.selectHighlights', '모든 일치 항목 선택', 'Ctrl+Shift+L', cat);
    M('editor.action.insertCursorAbove', '위에 커서 추가', 'Ctrl+Alt+Up', cat);
    M('editor.action.insertCursorBelow', '아래에 커서 추가', 'Ctrl+Alt+Down', cat);
    M('editor.action.smartSelect.expand', '선택 확장', 'Shift+Alt+Right', cat);
    M('editor.action.smartSelect.shrink', '선택 축소', 'Shift+Alt+Left', cat);
    M('editor.action.trimTrailingWhitespace', '줄 끝 공백 제거', 'Ctrl+K Ctrl+X', cat);
    M('editor.action.transformToUppercase', '대문자로', [], cat);
    M('editor.action.transformToLowercase', '소문자로', [], cat);
    M('cursorUndo', '커서 위치 되돌리기', 'Ctrl+U', cat);
    E('papyrus.completeStatement', '문장 완성 (세미콜론 + 줄바꿈)', [], () => this.completeStatement(), cat);
    M('editor.foldAll', '모두 접기', 'Ctrl+K Ctrl+0', cat);
    M('editor.unfoldAll', '모두 펼치기', 'Ctrl+K Ctrl+J', cat);
    M('editor.fold', '접기', 'Ctrl+Shift+[', cat);
    M('editor.unfold', '펼치기', 'Ctrl+Shift+]', cat);
    G('papyrus.toggleWordWrap', '자동 줄 바꿈 전환', 'Alt+Z', () => {
      const cur = this.editors.editor.getOption(monaco.editor.EditorOption.wordWrap);
      this.editors.updateAllOptions({ wordWrap: cur === 'off' ? 'on' : 'off' });
    }, { icon: 'word-wrap', ...cat });

    // ---- 파일
    cat = { category: '파일' };
    G('papyrus.save', '저장', 'Ctrl+S', () => this.editors.save(this.editors.active), { icon: 'save', ...cat });
    G('papyrus.saveAll', '모두 저장', 'Ctrl+K S', () => this.editors.saveAll(), { icon: 'save-all', ...cat });
    G('papyrus.closeTab', '탭 닫기', ['Ctrl+W', 'Ctrl+F4'], () => this.editors.closeTab(this.editors.active), { icon: 'close', ...cat });
    G('papyrus.closeAllTabs', '모든 탭 닫기', 'Ctrl+K Ctrl+W', () => this.editors.closeAll(), { icon: 'close-all', ...cat });
    G('papyrus.reopenClosed', '닫은 탭 다시 열기', 'Ctrl+Shift+T', () => this.editors.reopenClosed(), { icon: 'history', ...cat });
    G('papyrus.nextTab', '다음 탭', ['Ctrl+Tab', 'Ctrl+PageDown'], () => this.editors.nextTab(1), { icon: 'arrow-right', ...cat });
    G('papyrus.prevTab', '이전 탭', ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], () => this.editors.nextTab(-1), { icon: 'arrow-left', ...cat });
    // splits (Rider: Split Vertically / Horizontally, up to 3 editors)
    G('papyrus.splitRight', '오른쪽으로 분할', 'Ctrl+\\', () => this.editors.splitTab(this.editors.active, 'row'), { icon: 'split-horizontal', ...cat });
    G('papyrus.splitDown', '아래로 분할', 'Ctrl+K Ctrl+\\', () => this.editors.splitTab(this.editors.active, 'column'), { icon: 'split-vertical', ...cat });
    G('papyrus.moveToNextGroup', '탭을 다른 분할 창으로 이동', [], () => this.editors.active && this.editors.groups.length > 1 && this.editors.moveTab(this.editors.active, this.editors.nextGroup()), { icon: 'arrow-swap', ...cat });
    G('papyrus.unsplit', '분할 해제 (모두 합치기)', [], () => this.editors.unsplit(), { icon: 'screen-normal', ...cat });
    G('papyrus.focusGroup1', '첫 번째 분할 창으로', 'Ctrl+1', () => this.editors.focusNth(0), cat);
    G('papyrus.focusGroup2', '두 번째 분할 창으로', 'Ctrl+2', () => this.editors.focusNth(1), cat);
    G('papyrus.focusGroup3', '세 번째 분할 창으로', 'Ctrl+3', () => this.editors.focusNth(2), cat);
    G('papyrus.newScript', '새 C# 스크립트', 'Ctrl+N', () => this.newScriptHere(), { icon: 'new-file', ...cat });
    G('papyrus.openFolder', '폴더 열기', 'Ctrl+K Ctrl+O', () => this.pickProject(), { icon: 'folder-opened', ...cat });
    G('papyrus.newWindow', '새 창', 'Ctrl+Shift+N', () => O.app.newWindow(), { icon: 'empty-window', ...cat });
    G('papyrus.revealInExplorer', '탐색기에서 현재 파일 선택', [], () => this.editors.active && !this.editors.active.special && this.explorer.reveal(this.editors.active.path), { icon: 'target', ...cat });

    // ---- 보기
    cat = { category: '보기' };
    G('papyrus.toggleSidebar', '사이드바 전환', 'Ctrl+B', () => this.toggleSidebar(), { icon: 'layout-sidebar-left', ...cat });
    G('papyrus.togglePanel', '하단 패널 전환', 'Ctrl+J', () => this.togglePanel(), { icon: 'layout-panel', ...cat });
    G('papyrus.showExplorer', '탐색기', 'Ctrl+Shift+E', () => this.showTool('explorer'), { icon: 'files', ...cat });
    G('papyrus.searchExplorer', '탐색기에서 스크립트 검색', [], () => { this.showTool('explorer'); this.explorer.focusSearch(); }, { icon: 'search', ...cat });
    G('papyrus.showStructure', '구조', [], () => this.toggleTool('structure'), { icon: 'symbol-structure', ...cat });
    G('papyrus.showInspector', '인스펙터', 'Ctrl+Alt+I', () => this.inspector.toggleDock(), { icon: 'inspect', ...cat });
    G('papyrus.showProblems', '문제', 'Ctrl+Shift+M', () => this.panels.toggle('problems'), { icon: 'warning', ...cat });
    G('papyrus.showOutput', '출력', 'Ctrl+Shift+U', () => this.panels.toggle('output'), { icon: 'output', ...cat });
    G('papyrus.showUnityLog', 'Unity 로그', 'Ctrl+Shift+Y', () => this.panels.toggle('unity'), { icon: 'debug-console', ...cat });
    G('papyrus.showFind', '찾기 창', [], () => this.panels.toggle('find'), { icon: 'search', ...cat });
    G('papyrus.zenMode', '에디터만 보기 (툴 창 숨기기)', 'Ctrl+K Z', () => this.toggleMaximize(), { icon: 'screen-full', ...cat });
    G('papyrus.zoomIn', '글자 크게', ['Ctrl+=', 'Ctrl+Shift+='], () => this.zoom(1), { icon: 'zoom-in', ...cat });
    G('papyrus.zoomOut', '글자 작게', 'Ctrl+-', () => this.zoom(-1), { icon: 'zoom-out', ...cat });
    G('papyrus.zoomReset', '글자 크기 초기화', 'Ctrl+0', () => this.zoom(0), { icon: 'screen-normal', ...cat });
    G('papyrus.toggleTheme', '밝은/어두운 테마 전환', 'Ctrl+K Ctrl+T', () => this.setSetting('workbench.theme', this.effectiveTheme() === 'dark' ? 'light' : 'dark'), { icon: 'color-mode', ...cat });
    G('papyrus.clearCodeMemory', '학습한 자동완성 기록 지우기', [], () => {
      this.codeMemory.clear();
      toast({ title: '자동완성', message: '학습한 줄·단어·스니펫 사용 기록을 지웠어요.', timeout: 3000 });
    }, { icon: 'clear-all', ...cat });

    // ---- Unity
    cat = { category: 'Unity' };
    G('unity.play', 'Unity 플레이 / 정지', 'F5', () => this.unityPlay(), { icon: 'play', ...cat });
    G('unity.stop', 'Unity 정지', 'Shift+F5', () => this.unityState.isPlaying && O.unity.send({ type: 'stop' }), { icon: 'debug-stop', ...cat });
    G('unity.pause', 'Unity 일시정지', 'F6', () => O.unity.send({ type: 'pause' }), { icon: 'debug-pause', ...cat });
    G('unity.step', 'Unity 한 프레임 진행', 'F10', () => O.unity.send({ type: 'step' }), { icon: 'debug-step-over', ...cat });
    G('unity.refresh', 'Unity 에셋 새로고침', 'Ctrl+Alt+R', () => this.unityRefresh(true), { icon: 'refresh', ...cat });
    G('unity.sync', 'Unity 프로젝트 파일 다시 생성', [], () => O.unity.send({ type: 'sync' }), { icon: 'file-code', ...cat });
    G('unity.clearLog', 'Unity 로그 지우기', [], () => this.panels.views.unity.clear(), { icon: 'clear-all', ...cat });
    G('unity.installPackage', 'Unity 패키지 설치/업데이트', [], () => this.installUnityPackage(), { icon: 'package', ...cat });
    G('unity.attachToSelected', '현재 스크립트를 선택한 오브젝트에 붙이기', [], () => {
      const p = this.inspector.currentScript();
      const sel = this.inspector.selected;
      if (!p) toast({ kind: 'warn', title: '.cs 파일을 먼저 여세요', timeout: 2500 });
      else if (!sel || typeof sel.id !== 'number') toast({ kind: 'warn', title: '인스펙터의 Unity 씬에서 오브젝트를 먼저 고르세요', timeout: 2500 });
      else this.inspector.attachScript(sel.id, p);
    }, { icon: 'symbol-class', ...cat });
    G('unity.createObjectWithScript', '현재 스크립트로 새 오브젝트 만들기', [], () => {
      const p = this.inspector.currentScript();
      if (p) this.inspector.createObject({ scriptPath: p });
      else toast({ kind: 'warn', title: '.cs 파일을 먼저 여세요', timeout: 2500 });
    }, { icon: 'add', ...cat });

    // ---- C# / 기타
    cat = { category: 'C#' };
    G('lsp.restart', 'C# 언어 서버 재시작', [], () => this.restartLsp(), { icon: 'debug-restart', ...cat });
    G('lsp.install', 'C# 언어 서버 설치/업데이트', [], () => this.installLsp(), { icon: 'cloud-download', ...cat });
    G('lsp.restore', 'dotnet restore 실행', [], async () => { this.panels.show('output'); await O.lsp.restore(); this.restartLsp(); }, { icon: 'package', ...cat });
    cat = { category: '환경' };
    G('papyrus.settings', '설정', 'Ctrl+,', () => this.openSettings(), { icon: 'settings-gear', ...cat });
    G('papyrus.keybindings', '키보드 단축키 설정', 'Ctrl+K Ctrl+S', () => this.openSettings('keys'), { icon: 'keyboard', ...cat });
    G('papyrus.settingsJson', '설정 파일(settings.json) 열기', [], () => this.openSettingsJson(), { icon: 'json', ...cat });
    G('papyrus.about', 'PAPyrus 정보', [], () => this.showAbout(), { icon: 'info', ...cat });
    G('papyrus.checkUpdate', '업데이트 확인', [], () => this.updates.check(), { icon: 'cloud-download', ...cat });
    G('papyrus.setupWizard', '설정 도우미 (자동 설치)', [], () => this.setup.open(), { icon: 'zap', ...cat });
    G('papyrus.devtools', '개발자 도구', 'Ctrl+Shift+I', () => O.app.toggleDevTools(), { icon: 'tools', ...cat });

    this.keys.setUserBindings(this.settings.keybindings || {});
  }

  zoom(dir) {
    const base = this.settings['editor.fontSize'] || 13;
    const cur = this.editors.editor.getOption(monaco.editor.EditorOption.fontSize);
    const size = dir === 0 ? base : Math.max(8, Math.min(40, cur + dir));
    const lineHeight = Math.round(size * (this.settings['editor.lineHeight'] || 1.45));
    this.editors.updateAllOptions({ fontSize: size, lineHeight, suggestFontSize: size, suggestLineHeight: lineHeight });
  }

  setupKeys() {
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) { e.preventDefault(); this.editors.back(); }
      if (e.button === 4) { e.preventDefault(); this.editors.forward(); }
    });
    // Esc in a tool window returns focus to the editor
    document.getElementById('sidebar').addEventListener('keydown', (e) => { if (e.key === 'Escape') this.editors.editor.focus(); });
    document.getElementById('bottom').addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target.tagName !== 'INPUT') this.editors.editor.focus(); });
    // auto save when the window loses focus
    window.addEventListener('blur', () => {
      if (this.settings['files.autoSave'] === 'onFocusChange') this.editors.saveAll();
    });
  }

  onTabEdited(tab) {
    if (this.settings['files.autoSave'] !== 'afterDelay') return;
    clearTimeout(tab.autoSaveTimer);
    tab.autoSaveTimer = setTimeout(() => {
      if (tab.dirty && this.editors.tabs.includes(tab)) this.editors.save(tab);
    }, Math.max(200, this.settings['files.autoSaveDelay'] || 1000));
  }

  // ======================================================================== theme & settings
  effectiveTheme() {
    const t = this.settings['workbench.theme'] || 'dark';
    if (t === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    return t === 'light' ? 'light' : 'dark'; // 'rainbow' is a dark theme
  }

  isRainbow() {
    return this.settings['workbench.theme'] === 'rainbow';
  }

  monacoTheme() {
    if (this.isRainbow()) return 'papyrus-rainbow';
    return this.effectiveTheme() === 'light' ? 'papyrus-light' : 'papyrus-dark';
  }

  applyTheme() {
    const t = this.effectiveTheme();
    document.body.classList.toggle('light', t === 'light');
    document.body.classList.toggle('rainbow', this.isRainbow());
    monaco.editor.setTheme(this.monacoTheme());
    O.app.setTheme(this.isRainbow() ? 'rainbow' : t, this.settings['workbench.theme'] || 'dark');
  }

  async setSetting(key, value) {
    const prev = this.settings;
    this.settings = await O.app.setSettings({ [key]: value });
    this.applySettings(prev);
  }

  applySettings(prev = {}) {
    const s = this.settings;
    this.applyTheme();
    this.editors.applySettings(s);
    this.lsp.codeLensEnabled = s['editor.codeLens'] !== false;
    if (this.unityFeatures && ['unity.assetLenses', 'unity.stringChecks', 'unity.performanceHints'].some((k) => prev[k] !== s[k])) this.unityFeatures.settingsChanged();
    this.keys.setUserBindings(s.keybindings || {});
    if (JSON.stringify(prev['files.exclude']) !== JSON.stringify(s['files.exclude']) || prev['explorer.hideProjectFiles'] !== s['explorer.hideProjectFiles']) {
      this.explorer.refresh();
      if (this.project) this.indexFiles();
    }
  }

  setupEvents() {
    O.app.onGoto((g) => this.goto(g));
    O.app.onOpenProject(({ project, goto }) => this.openProject(project, goto));
    O.lsp.onLog((line) => this.panels.views.output.append(line));
    O.unity.onStatus((st) => {
      const was = this.unityStatus.state;
      this.unityStatus = st;
      if (st.state !== 'connected') this.unityState = {};
      this.renderUnity();
      this.inspector.onStatus(st, was);
      if (this.panels.current === 'unity' && !this.panels.views.unity.logs.length) this.panels.views.unity.render();
      // Bootstrap a missing solution. Once selected, Unity's external editor handles asset changes.
      if (st.state === 'connected' && was !== 'connected' && !this.slnAtStart) O.unity.send({ type: 'sync' });
      if (st.state === 'connected' && was !== 'connected' && !this.announcedUnity) {
        this.announcedUnity = true;
        toast({ title: 'Unity와 연결됐어요', message: `${st.projectName || ''} · Unity ${st.unityVersion || ''}`, timeout: 2500 });
      }
    });
    O.unity.onMessage((m) => this.onUnityMessage(m));
    O.fs.onChanged(async (changes) => {
      const paths = changes.map((c) => c.path);
      this.explorer.refresh(paths);
      this.inspector.onFilesChanged(paths);
      this.editors.onExternalChange(paths);
      this.unityFeatures.onFilesChanged(paths);
      // keep the file index fresh
      const added = [];
      for (const p of paths) {
        const st = await O.fs.stat(p);
        if (st && !st.dir && !this.fileIndex.some((f) => samePath(f, p))) added.push(p);
        if (!st) this.fileIndex = this.fileIndex.filter((f) => !samePath(f, p));
      }
      this.fileIndex.push(...added);
      // Unity (re)generated the solution or project files: a package was added (DOTween, UniTask...),
      // the package settings in Preferences changed, an asmdef moved... -> reload them in the language server
      const projectFiles = paths.some((p) => samePath(dirname(p), this.project) && /^\.(sln|slnx|csproj)$/i.test(extname(p)));
      if (projectFiles) {
        this.slnAtStart = true;
        this.restartLspSoon();
      }
      if (paths.some((p) => /[\\/]Packages[\\/](manifest|packages-lock)\.json$/i.test(p))) this.packagesChanged = true;
    });
    window.addEventListener('beforeunload', () => this.saveSession());
    // Drop a folder onto the window to open it
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (!f) return;
      const p = O.app.pathForFile(f);
      const st = await O.fs.stat(p);
      if (st && st.dir) this.openProject(p);
      else if (st) this.editors.open(p);
    });
  }
}

function normKey(e) {
  const k = e.key;
  if (k.length === 1) return k.toUpperCase();
  return k;
}

const app = new App();
window.__papyrus = app;
app.init().catch((err) => {
  console.error(err);
  document.body.append(el('pre', { style: { color: '#f77', padding: '20px' } }, String(err && err.stack || err)));
});
