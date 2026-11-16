// Tabs, models, saving, navigation history.
import { monaco } from './monaco.js';
import { el, icon, basename, dirname, extname, fileIcon, contextMenu, toast, relPath, samePath } from './ui.js';
import * as cv from './conv.js';

const ofs = window.papyrus.fs;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp']);

export class Editors {
  constructor(app) {
    this.app = app;
    this.tabs = [];
    this.active = null;
    this.closedStack = [];
    this.shadow = new Map(); // uri -> model created only for peek / navigation
    this.history = [];
    this.historyIndex = -1;
    this.tabsEl = document.getElementById('tabs');
    this.host = document.getElementById('editor-host');
    this.area = document.getElementById('editor-area');
    this.nontext = document.getElementById('nontext');
    this.onActiveChange = () => {};
    this.onDirtyChange = () => {};
    this.createEditor();
    this.tabsEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.tabsEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
  }

  createEditor() {
    const s = this.app.settings;
    this.editor = monaco.editor.create(this.host, {
      model: null,
      theme: this.app.monacoTheme(),
      automaticLayout: true,
      fontFamily: s['editor.fontFamily'],
      fontSize: s['editor.fontSize'],
      lineHeight: Math.round(s['editor.fontSize'] * s['editor.lineHeight']),
      fontLigatures: !!s['editor.fontLigatures'],
      minimap: { enabled: !!s['editor.minimap'] },
      scrollBeyondLastLine: true,
      renderLineHighlight: 'all',
      renderWhitespace: s['editor.renderWhitespace'] || 'none',
      smoothScrolling: true,
      cursorBlinking: 'blink',
      cursorSmoothCaretAnimation: 'off',
      mouseWheelZoom: true,
      wordWrap: s['editor.wordWrap'] ? 'on' : 'off',
      tabSize: s['editor.tabSize'],
      insertSpaces: s['editor.insertSpaces'],
      detectIndentation: true,
      'semanticHighlighting.enabled': true,
      inlayHints: { enabled: s['editor.inlayHints'] ? 'on' : 'off', fontSize: Math.max(10, s['editor.fontSize'] - 2), padding: true },
      codeLens: s['editor.codeLens'] !== false,
      codeLensFontSize: Math.max(10, s['editor.fontSize'] - 2),
      quickSuggestions: { other: true, comments: false, strings: false },
      quickSuggestionsDelay: 10,
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: 'on',
      acceptSuggestionOnCommitCharacter: true,
      tabCompletion: 'off',
      wordBasedSuggestions: 'off',
      snippetSuggestions: 'bottom',
      suggestSelection: 'first',
      // the list rows get exactly the editor's metrics (a smaller row clipped the labels)
      suggestFontSize: s['editor.fontSize'],
      suggestLineHeight: Math.round(s['editor.fontSize'] * s['editor.lineHeight']),
      suggest: {
        insertMode: 'insert',
        // the first suggestion is always selected, so Tab (and Enter) completes it like in Rider / VS
        selectionMode: 'always',
        showStatusBar: false,
        preview: false,
        localityBonus: true,
        shareSuggestSelections: false,
        showIcons: true,
        filterGraceful: true,
        snippetsPreventQuickSuggestions: false,
      },
      parameterHints: { enabled: true, cycle: true },
      formatOnType: s['editor.formatOnType'] !== false,
      formatOnPaste: false,
      autoClosingBrackets: 'languageDefined',
      autoClosingQuotes: 'languageDefined',
      autoSurround: 'languageDefined',
      bracketPairColorization: { enabled: s['workbench.theme'] === 'rainbow' },
      guides: { indentation: true, bracketPairs: false, highlightActiveIndentation: true },
      stickyScroll: { enabled: s['editor.stickyScroll'] !== false, maxLineCount: 4 },
      glyphMargin: false,
      folding: true,
      foldingHighlight: false,
      showFoldingControls: 'mouseover',
      lineNumbersMinChars: 4,
      lineDecorationsWidth: 12,
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      fixedOverflowWidgets: true,
      links: true,
      colorDecorators: false,
      lightbulb: { enabled: 'onCode' },
      hover: { delay: 400, sticky: true },
      definitionLinkOpensInPeek: false,
      // Ctrl+click on a declaration: our usages popup (app.attachCtrlClickUsages), not the inline peek
      gotoLocation: { multipleDefinitions: 'peek', multipleReferences: 'peek', alternativeDefinitionCommand: '' },
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      'workbench.colorTheme': undefined,
    });

    // Monaco measures glyph widths once. JetBrains Mono is a web font that loads lazily, so the
    // first measurement can use the fallback font (Consolas, narrower) and the caret/selection
    // drift into the middle of the text. Re-measure once the editor fonts have actually loaded.
    this.remeasureFonts(s);
    document.fonts.addEventListener('loadingdone', () => monaco.editor.remeasureFonts());

    this.editor.onDidChangeCursorPosition((e) => this.app.onCursor(e.position));
    this.editor.onDidChangeModelLanguageConfiguration(() => this.app.updateStatus());
    // Tab completes while the suggest list is open (added later, so it wins over Monaco's own Tab).
    this.editor.addCommand(monaco.KeyCode.Tab, () => this.acceptSuggestionWithTab(), 'suggestWidgetVisible && textInputFocus');

    // Let Monaco navigation (Ctrl+click, F12, peek "open") route through our tabs.
    monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, resource, selOrPos) => {
        const path = cv.uriToPath(resource);
        if (!path) return false;
        let line = 1;
        let column = 1;
        if (selOrPos) {
          line = selOrPos.startLineNumber || selOrPos.lineNumber || 1;
          column = selOrPos.startColumn || selOrPos.column || 1;
        }
        await this.open(path, { line, column, pushHistory: true });
        return true;
      },
    });
  }

  /**
   * Monaco's own Tab only accepts a suggestion that is already focused. Roslyn marks most lists
   * incomplete, so every keystroke re-queries and the widget sits in "loading" with nothing focused;
   * a Tab in that moment fell through and inserted a tab. Here Tab waits for the refreshed list
   * (briefly) and accepts its selected (or first) item; it only indents when there is nothing to pick.
   */
  acceptSuggestionWithTab() {
    const ed = this.editor;
    const ctl = ed.getContribution('editor.contrib.suggestController');
    const widget = ctl && ctl.widget && ctl.widget.value;
    const indent = () => ed.trigger('keyboard', 'tab', null);
    if (!ctl || !widget || !ctl.model) return indent();
    const accept = () => {
      if (!widget.getFocusedItem()) widget.selectFirst();
      if (widget.getFocusedItem()) ctl.acceptSelectedSuggestion(true, false);
    };
    if (widget.getFocusedItem()) return accept();
    const LOADING = 1;
    if (ctl.model.state === 0 /* idle */ || widget._state !== LOADING) {
      // list open but nothing focused (e.g. selectionMode) -> first item; empty list -> plain indent
      widget.selectFirst();
      return widget.getFocusedItem() ? accept() : indent();
    }
    const version = ed.getModel() && ed.getModel().getAlternativeVersionId();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sub.dispose();
      cancel.dispose();
      clearTimeout(timer);
      // only if nothing was typed meanwhile, otherwise the result belongs to another word
      if (ok && ed.getModel() && ed.getModel().getAlternativeVersionId() === version) accept();
    };
    // registered after the controller's own listener, so the list is already shown when this runs
    const sub = ctl.model.onDidSuggest(() => finish(true));
    const cancel = ctl.model.onDidCancel((e) => { if (!e.retrigger) finish(false); });
    const timer = setTimeout(() => finish(false), 1500);
  }

  async remeasureFonts(s) {
    const font = `${s['editor.fontSize']}px ${s['editor.fontFamily']}`;
    try {
      await Promise.all([font, `italic ${font}`, `bold ${font}`].map((f) => document.fonts.load(f)));
      await document.fonts.ready;
    } catch { /* bad font string: Monaco keeps its fallback measurement */ }
    monaco.editor.remeasureFonts();
  }

  applySettings(s) {
    for (const t of this.tabs) if (t.model) t.model.updateOptions({ tabSize: s['editor.tabSize'], insertSpaces: s['editor.insertSpaces'] });
    this.editor.updateOptions({
      fontLigatures: !!s['editor.fontLigatures'],
      renderWhitespace: s['editor.renderWhitespace'] || 'none',
      formatOnType: s['editor.formatOnType'] !== false,
      stickyScroll: { enabled: s['editor.stickyScroll'] !== false, maxLineCount: 4 },
      tabSize: s['editor.tabSize'],
      insertSpaces: s['editor.insertSpaces'],
      fontFamily: s['editor.fontFamily'],
      fontSize: s['editor.fontSize'],
      lineHeight: Math.round(s['editor.fontSize'] * s['editor.lineHeight']),
      suggestFontSize: s['editor.fontSize'],
      suggestLineHeight: Math.round(s['editor.fontSize'] * s['editor.lineHeight']),
      minimap: { enabled: !!s['editor.minimap'] },
      wordWrap: s['editor.wordWrap'] ? 'on' : 'off',
      inlayHints: { enabled: s['editor.inlayHints'] ? 'on' : 'off' },
      codeLens: s['editor.codeLens'] !== false,
      bracketPairColorization: { enabled: s['workbench.theme'] === 'rainbow' },
    });
    this.remeasureFonts(s);
  }

  // ------------------------------------------------------------------ open
  findTab(path) {
    return this.tabs.find((t) => samePath(t.path, path));
  }

  async loadModel(path) {
    const uri = monaco.Uri.file(path);
    let model = monaco.editor.getModel(uri);
    const res = await ofs.readFile(path);
    if (res.binary || res.tooLarge) return { res, model: null };
    if (!model) {
      model = monaco.editor.createModel(res.text, undefined, uri);
    } else if (model.getValue() !== res.text) {
      model.setValue(res.text);
    }
    this.shadow.delete(uri.toString());
    return { res, model };
  }

  async ensureModels(uris) {
    for (const uri of uris) {
      const u = typeof uri === 'string' ? monaco.Uri.parse(uri) : uri;
      if (u.scheme !== 'file' || monaco.editor.getModel(u)) continue;
      try {
        const res = await ofs.readFile(u.fsPath);
        if (res.binary || res.tooLarge) continue;
        const m = monaco.editor.createModel(res.text, undefined, u);
        this.shadow.set(u.toString(), m);
      } catch { /* ignore */ }
    }
    // keep the shadow cache small
    if (this.shadow.size > 80) {
      for (const [k, m] of [...this.shadow.entries()].slice(0, this.shadow.size - 80)) {
        if (!this.tabs.some((t) => t.model === m)) m.dispose();
        this.shadow.delete(k);
      }
    }
  }

  async open(path, opts = {}) {
    const { line, column, preview = false, focus = true, pushHistory = true, endLine, endColumn } = opts;
    if (pushHistory) this.recordHistory();
    let tab = this.findTab(path);
    if (!tab) {
      let loaded;
      try {
        loaded = await this.loadModel(path);
      } catch (err) {
        toast({ kind: 'error', title: '파일을 열 수 없어요', message: String(err.message || err) });
        return null;
      }
      const { res, model } = loaded;
      tab = {
        path,
        model,
        kind: model ? 'text' : IMAGE_EXT.has(extname(path)) ? 'image' : 'binary',
        size: res.size,
        encoding: res.encoding || 'utf8',
        mtimeMs: res.mtimeMs,
        savedVersion: model ? model.getAlternativeVersionId() : 0,
        dirty: false,
        preview,
        viewState: null,
        sub: null,
      };
      if (preview) {
        const old = this.tabs.find((t) => t.preview && !t.dirty);
        if (old) this.closeTab(old, { force: true, noHistory: true });
      }
      const idx = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
      this.tabs.splice(idx, 0, tab);
      if (model) {
        tab.sub = model.onDidChangeContent(() => {
          const dirty = model.getAlternativeVersionId() !== tab.savedVersion;
          if (dirty && tab.preview) tab.preview = false;
          if (dirty) this.app.onTabEdited(tab);
          if (dirty !== tab.dirty) {
            tab.dirty = dirty;
            this.renderTabs();
            this.onDirtyChange(tab);
          }
        });
        this.app.lsp.open(model);
      }
    } else if (!preview && tab.preview) {
      tab.preview = false;
    }
    this.activate(tab, focus);
    if (tab.model && line) {
      const pos = { lineNumber: line, column: column || 1 };
      if (endLine) this.editor.setSelection(new monaco.Range(line, column || 1, endLine, endColumn || column || 1));
      else this.editor.setPosition(pos);
      this.editor.revealPositionInCenterIfOutsideViewport(pos, monaco.editor.ScrollType.Immediate);
    }
    if (pushHistory) this.recordHistory();
    return tab;
  }

  // Non-file tabs (Settings, ...)
  openSpecial(id, title, iconName, content) {
    const path = 'papyrus://' + id;
    let tab = this.findTab(path);
    if (!tab) {
      tab = { path, special: true, title, icon: iconName, el: content, model: null, kind: 'special', dirty: false, preview: false };
      const idx = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
      this.tabs.splice(idx, 0, tab);
    }
    this.activate(tab);
    return tab;
  }

  activate(tab, focus = true) {
    if (this.active && this.active !== tab && this.active.model) {
      this.active.viewState = this.editor.saveViewState();
      if (this.active.dirty && this.app.settings['files.autoSave'] === 'onFocusChange') this.save(this.active);
    }
    this.active = tab;
    this.nontext.classList.remove('show');
    this.nontext.replaceChildren();
    if (tab && tab.model) {
      this.host.style.visibility = 'visible';
      this.editor.setModel(tab.model);
      if (tab.viewState) this.editor.restoreViewState(tab.viewState);
      if (focus) this.editor.focus();
    } else {
      this.editor.setModel(null);
      this.host.style.visibility = 'hidden';
      if (tab) this.showNonText(tab);
    }
    this.area.classList.toggle('empty', !tab);
    // keep MRU order for recent files
    this.app.recordRecent(tab && tab.path);
    this.renderTabs();
    this.onActiveChange(tab);
    if (tab) {
      const t = this.tabsEl.querySelector('.tab.active');
      if (t) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  showNonText(tab) {
    this.nontext.classList.add('show');
    if (tab.special) {
      this.nontext.append(tab.el);
      return;
    }
    if (tab.kind === 'image') {
      const url = 'file:///' + tab.path.replace(/\\/g, '/').replace(/^\/+/, '');
      this.nontext.append(el('div.nontext-msg', null, el('div', null, `${basename(tab.path)} · ${(tab.size / 1024).toFixed(1)} KB`), el('img', { src: url })));
    } else {
      this.nontext.append(el('div.nontext-msg', null,
        el('div', null, `${basename(tab.path)}은(는) 텍스트 파일이 아니에요 (${(tab.size / 1024).toFixed(1)} KB).`),
        el('div', { style: { marginTop: '12px' } }, el('button.btn', { onclick: () => window.papyrus.app.reveal(tab.path) }, icon('folder-opened'), '탐색기에서 보기'))));
    }
  }

  // ------------------------------------------------------------------ tabs UI
  renderTabs() {
    const errorUris = new Set(monaco.editor.getModelMarkers({}).filter((m) => m.severity === monaco.MarkerSeverity.Error).map((m) => m.resource.toString()));
    const names = new Map();
    for (const t of this.tabs) names.set(basename(t.path), (names.get(basename(t.path)) || 0) + 1);
    this.tabsEl.replaceChildren(...this.tabs.map((t) => {
      const name = t.special ? t.title : basename(t.path);
      const dup = !t.special && names.get(name) > 1;
      const cls = ['tab', t === this.active && 'active', t.dirty && 'dirty', t.preview && 'preview', t.model && errorUris.has(t.model.uri.toString()) && 'has-error'].filter(Boolean).join('.');
      const tabEl = el('div.' + cls, {
        title: t.path,
        onmousedown: (e) => {
          if (e.button === 1) { e.preventDefault(); this.closeTab(t); return; }
          if (e.button === 0 && !e.target.closest('.tclose')) this.activate(t);
        },
        ondblclick: () => { t.preview = false; this.renderTabs(); },
        oncontextmenu: (e) => { e.preventDefault(); if (!t.special) this.tabMenu(t, e.clientX, e.clientY); },
      },
      t.special ? icon(t.icon || 'gear') : fileIcon(name, false),
      el('span.tname', null, name, dup ? el('span.tdir', null, basename(dirname(t.path))) : null),
      el('span.tclose', { title: `닫기 (${this.app.kb('papyrus.closeTab')})`, onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }, icon('close')));
      return tabEl;
    }));
  }

  tabMenu(t, x, y) {
    contextMenu(x, y, [
      { label: '닫기', icon: 'close', key: this.app.kb('papyrus.closeTab'), action: () => this.closeTab(t) },
      { label: '다른 탭 모두 닫기', action: () => this.closeOthers(t) },
      { label: '모든 탭 닫기', action: () => this.closeAll() },
      { label: '오른쪽 탭 닫기', action: () => this.closeRight(t) },
      '-',
      { label: '경로 복사', icon: 'copy', action: () => navigator.clipboard.writeText(t.path) },
      { label: '상대 경로 복사', action: () => navigator.clipboard.writeText(relPath(this.app.project, t.path)) },
      { label: '탐색기에서 선택', icon: 'target', action: () => this.app.explorer.reveal(t.path) },
      { label: '파일 탐색기에서 열기', icon: 'folder-opened', action: () => window.papyrus.app.reveal(t.path) },
    ]);
  }

  async closeTab(tab, { force = false, noHistory = false } = {}) {
    if (!tab) return true;
    if (tab.dirty && !force && (this.app.settings['files.autoSave'] || 'off') !== 'off') {
      // auto save on: closing saves like switching tabs does, no question (Rider)
      if (!(await this.save(tab))) return false;
    } else if (tab.dirty && !force) {
      const r = await window.papyrus.app.confirm({ message: `${basename(tab.path)}에 저장하지 않은 변경 사항이 있어요.`, buttons: ['저장', '저장 안 함', '취소'], type: 'warning' });
      if (r === 2) return false;
      if (r === 0 && !(await this.save(tab))) return false;
    }
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return true;
    this.tabs.splice(idx, 1);
    if (!noHistory) this.closedStack.push(tab.path);
    if (tab.sub) tab.sub.dispose();
    if (tab.model) {
      this.app.lsp.close(tab.model);
      monaco.editor.setModelMarkers(tab.model, 'lsp', []);
      tab.model.dispose();
    }
    if (this.active === tab) {
      this.active = null;
      const mru = this.app.recentFiles.map((p) => this.findTab(p)).find(Boolean);
      this.activate(mru || this.tabs[Math.min(idx, this.tabs.length - 1)] || null);
    } else this.renderTabs();
    this.app.saveSession();
    return true;
  }

  async closeOthers(keep) {
    for (const t of [...this.tabs]) if (t !== keep) if (!(await this.closeTab(t))) return;
  }
  async closeAll() {
    for (const t of [...this.tabs]) if (!(await this.closeTab(t))) return false;
    return true;
  }
  async closeRight(t) {
    const i = this.tabs.indexOf(t);
    for (const x of this.tabs.slice(i + 1)) if (!(await this.closeTab(x))) return;
  }

  reopenClosed() {
    const p = this.closedStack.pop();
    if (!p) return;
    if (p.startsWith('papyrus://')) this.app.openSettings();
    else this.open(p);
  }

  nextTab(dir) {
    if (!this.tabs.length) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }

  // ------------------------------------------------------------------ save
  async save(tab = this.active, { silent = false } = {}) {
    if (!tab || !tab.model) return true;
    if (!tab.dirty && !silent) return true;
    try {
      if (this.app.settings['editor.formatOnSave'] && tab.model.getLanguageId() === 'csharp' && tab === this.active) {
        await this.editor.getAction('editor.action.formatDocument')?.run();
      }
      const text = tab.model.getValue();
      const r = await ofs.writeFile(tab.path, text, tab.encoding === 'cp949' ? 'utf8bom' : tab.encoding);
      if (tab.encoding === 'cp949') tab.encoding = 'utf8bom'; // Unity expects UTF-8; convert old CP949 files on first save
      tab.mtimeMs = r.mtimeMs;
      tab.savedVersion = tab.model.getAlternativeVersionId();
      tab.dirty = false;
      this.app.lsp.saved(tab.model);
      this.renderTabs();
      this.onDirtyChange(tab);
      this.app.onSaved(tab);
      return true;
    } catch (err) {
      toast({ kind: 'error', title: '저장 실패', message: String(err.message || err) });
      return false;
    }
  }

  async saveAll() {
    let any = false;
    for (const t of this.tabs) {
      if (t.dirty) {
        any = true;
        await this.save(t);
      }
    }
    return any;
  }

  get dirtyTabs() {
    return this.tabs.filter((t) => t.dirty);
  }

  // ------------------------------------------------------------------ external changes
  async onExternalChange(paths) {
    for (const p of paths) {
      const tab = this.findTab(p);
      if (!tab || !tab.model) continue;
      const st = await ofs.stat(p);
      if (!st) continue; // deleted: keep the buffer
      if (Math.abs(st.mtimeMs - (tab.mtimeMs || 0)) < 1) continue;
      const res = await ofs.readFile(p);
      if (res.binary) continue;
      if (res.text === tab.model.getValue()) {
        tab.mtimeMs = res.mtimeMs;
        continue;
      }
      if (tab.dirty) {
        toast({
          kind: 'warn', title: `${basename(p)}이(가) 디스크에서 바뀌었어요`, message: '편집 중인 내용과 다릅니다.', timeout: 0,
          actions: [
            { label: '디스크 버전 불러오기', action: () => this.reloadFromDisk(tab, res) },
            { label: '내 버전 유지', action: () => { tab.mtimeMs = res.mtimeMs; } },
          ],
        });
      } else this.reloadFromDisk(tab, res);
    }
  }

  reloadFromDisk(tab, res) {
    const m = tab.model;
    const full = m.getFullModelRange();
    const sel = tab === this.active ? this.editor.getSelections() : null;
    m.pushEditOperations([], [{ range: full, text: res.text }], () => sel);
    tab.savedVersion = m.getAlternativeVersionId();
    tab.dirty = false;
    tab.mtimeMs = res.mtimeMs;
    tab.encoding = res.encoding;
    this.renderTabs();
  }

  // ------------------------------------------------------------------ workspace edits
  async applyWorkspaceEdit(we) {
    const byUri = new Map();
    const add = (uri, edits) => byUri.set(uri, (byUri.get(uri) || []).concat(edits));
    if (we.documentChanges) {
      for (const dc of we.documentChanges) {
        if (dc.textDocument) add(dc.textDocument.uri, dc.edits);
        else if (dc.kind === 'create') {
          const p = cv.uriToPath(dc.uri);
          if (p && !(await ofs.exists(p))) await ofs.createFile(p, '');
        } else if (dc.kind === 'rename') {
          const from = cv.uriToPath(dc.oldUri);
          const to = cv.uriToPath(dc.newUri);
          if (from && to) {
            const tab = this.findTab(from);
            await ofs.rename(from, to);
            if (tab) { await this.closeTab(tab, { force: true }); await this.open(to); }
          }
        } else if (dc.kind === 'delete') {
          const p = cv.uriToPath(dc.uri);
          if (p) await ofs.trash(p);
        }
      }
    }
    if (we.changes) for (const [uri, edits] of Object.entries(we.changes)) add(uri, edits);

    let wroteClosed = false;
    for (const [uri, edits] of byUri) {
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model && !this.shadow.has(model.uri.toString())) {
        model.pushEditOperations([], edits.map((e) => ({ range: cv.toRange(e.range), text: e.newText })), () => null);
        continue;
      }
      const p = cv.uriToPath(uri);
      if (!p) continue;
      const res = await ofs.readFile(p);
      if (res.binary) continue;
      const text = applyTextEdits(res.text, edits);
      await ofs.writeFile(p, text, res.encoding === 'cp949' ? 'utf8bom' : res.encoding);
      if (model) model.setValue(text);
      this.app.lsp.syncDiskWrite(uri, text);
      wroteClosed = true;
    }
    if (wroteClosed) this.app.lsp.refreshAfterExternalEdit();
  }

  // ------------------------------------------------------------------ history
  currentLocation() {
    if (!this.active || !this.active.model) return null;
    const p = this.editor.getPosition();
    return p ? { path: this.active.path, line: p.lineNumber, column: p.column } : null;
  }

  recordHistory() {
    const loc = this.currentLocation();
    if (!loc) return;
    const last = this.history[this.historyIndex];
    if (last && last.path === loc.path && Math.abs(last.line - loc.line) < 3) {
      this.history[this.historyIndex] = loc;
      return;
    }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(loc);
    if (this.history.length > 100) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  async back() {
    this.recordHistory();
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    const l = this.history[this.historyIndex];
    await this.open(l.path, { line: l.line, column: l.column, pushHistory: false });
  }

  async forward() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    const l = this.history[this.historyIndex];
    await this.open(l.path, { line: l.line, column: l.column, pushHistory: false });
  }
}

// Apply LSP TextEdits to a string (edits may come in any order).
export function applyTextEdits(text, edits) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const off = (p) => Math.min(text.length, (lineStarts[p.line] ?? text.length) + p.character);
  const sorted = edits.map((e) => ({ s: off(e.range.start), e: off(e.range.end), t: e.newText }))
    .sort((a, b) => b.s - a.s || b.e - a.e);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.s) + e.t + out.slice(e.e);
  return out;
}
