// Tabs, models, saving, navigation history.
import { monaco } from './monaco.js';
import { el, icon, basename, dirname, extname, fileIcon, contextMenu, toast, relPath, samePath } from './ui.js';
import * as cv from './conv.js';
import { allmanEnter, singleStatementIndent } from './brace-enter.js';
import { maskCode } from './script-copy.js';

const ofs = window.papyrus.fs;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp']);

const MAX_GROUPS = 3; // Rider-like splits: 2 or 3 editors side by side (or stacked)
const TAB_MIME = 'application/x-papyrus-tab';

/**
 * Editor groups (splits). Each group has its own tab bar and Monaco editor; a file open in two
 * groups shares one model (edits show in both, saved once). `editor` / `active` are the focused
 * group's, `tabs` lists every group's tabs, so the rest of the app keeps working with "the editor".
 */
export class Editors {
  constructor(app) {
    this.app = app;
    this.groups = [];
    this.group = null; // the focused group
    this.splitDir = 'row'; // 'row': side by side, 'column': stacked
    this.closedStack = [];
    this.shadow = new Map(); // uri -> model created only for peek / navigation
    this.history = [];
    this.historyIndex = -1;
    this.area = document.getElementById('editor-area');
    this.groupsEl = document.getElementById('editor-groups');
    this.onActiveChange = () => {};
    this.onDirtyChange = () => {};
    this.editorHooks = [];
    // Monaco measures glyph widths once. JetBrains Mono is a web font that loads lazily, so the
    // first measurement can use the fallback font (Consolas, narrower) and the caret/selection
    // drift into the middle of the text. Re-measure once the editor fonts have actually loaded.
    this.remeasureFonts(app.settings);
    document.fonts.addEventListener('loadingdone', () => monaco.editor.remeasureFonts());
    this.registerOpener();
    this.addGroup();
  }

  get editor() { return this.group.editor; }
  get active() { return this.group ? this.group.active : null; }
  get tabs() { return this.groups.flatMap((g) => g.tabs); }

  /** fn(editor) for every editor, now and for splits made later (context menus, code memory...). */
  forEachEditor(fn) {
    this.editorHooks.push(fn);
    for (const g of this.groups) fn(g.editor);
  }

  /** Same options in every split (zoom, word wrap toggles...). */
  updateAllOptions(opts) {
    for (const g of this.groups) g.editor.updateOptions(opts);
  }

  tabsOfModel(model) {
    return model ? this.tabs.filter((t) => t.model === model) : [];
  }

  // ------------------------------------------------------------------ groups (splits)
  addGroup(index = this.groups.length) {
    const g = { tabs: [], active: null, flex: 1 };
    g.tabsEl = el('div.ed-tabs');
    g.host = el('div.ed-host');
    g.nontext = el('div.ed-nontext');
    g.el = el('div.ed-group', null, g.tabsEl, g.host, g.nontext);
    g.tabsEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        g.tabsEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    // a tab dragged onto another group's tab bar / editor moves there
    const over = (e) => { if (e.dataTransfer.types.includes(TAB_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; g.el.classList.add('drop'); } };
    g.el.addEventListener('dragover', over);
    g.el.addEventListener('dragleave', (e) => { if (!g.el.contains(e.relatedTarget)) g.el.classList.remove('drop'); });
    g.el.addEventListener('drop', (e) => {
      g.el.classList.remove('drop');
      const t = this.dragTab;
      this.dragTab = null;
      if (!t || !e.dataTransfer.types.includes(TAB_MIME)) return;
      e.preventDefault();
      const target = e.target.closest('.tab');
      const before = target ? g.tabs.find((x) => x.tabEl === target) : null;
      this.moveTab(t, g, before);
    });
    g.el.addEventListener('mousedown', () => this.focusGroup(g), true);
    this.groups.splice(index, 0, g);
    g.editor = this.createEditor(g);
    if (!this.group) this.group = g;
    this.layoutGroups();
    for (const fn of this.editorHooks) fn(g.editor);
    return g;
  }

  removeGroup(g) {
    if (this.groups.length < 2) return;
    const i = this.groups.indexOf(g);
    this.groups.splice(i, 1);
    g.editor.dispose();
    g.el.remove();
    if (this.group === g) this.group = this.groups[Math.max(0, i - 1)];
    this.layoutGroups();
    this.focusGroup(this.group, true);
  }

  /** Puts the groups (and the drag handles between them) into the editor area. */
  layoutGroups() {
    const kids = [];
    this.groups.forEach((g, i) => {
      if (i) kids.push(this.sash(this.groups[i - 1], g));
      g.el.style.flex = `${g.flex} 1 0`;
      kids.push(g.el);
    });
    this.groupsEl.replaceChildren(...kids);
    this.groupsEl.style.flexDirection = this.splitDir;
    this.groupsEl.classList.toggle('multi', this.groups.length > 1);
    this.groupsEl.classList.toggle('column', this.splitDir === 'column');
    for (const x of this.groups) x.el.classList.toggle('focused', x === this.group);
  }

  sash(a, b) {
    const s = el('div.ed-sash');
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const row = this.splitDir === 'row';
      const start = row ? e.clientX : e.clientY;
      const ra = a.el.getBoundingClientRect();
      const rb = b.el.getBoundingClientRect();
      const sa = row ? ra.width : ra.height;
      const sb = row ? rb.width : rb.height;
      const total = a.flex + b.flex;
      const move = (ev) => {
        const d = (row ? ev.clientX : ev.clientY) - start;
        const na = Math.max(120, Math.min(sa + sb - 120, sa + d));
        a.flex = (total * na) / (sa + sb);
        b.flex = total - a.flex;
        a.el.style.flex = `${a.flex} 1 0`;
        b.el.style.flex = `${b.flex} 1 0`;
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
        this.app.saveSessionSoon();
      };
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    s.addEventListener('dblclick', () => { for (const g of this.groups) g.flex = 1; this.layoutGroups(); }); // equal sizes
    return s;
  }

  focusGroup(g, focusEditor = false) {
    if (!g) return;
    const changed = this.group !== g;
    this.group = g;
    for (const x of this.groups) x.el.classList.toggle('focused', x === g);
    if (focusEditor && g.active && g.active.model) g.editor.focus();
    if (changed) this.onActiveChange(g.active); // no tab re-render here: a press on a tab must stay draggable
  }

  /** Opens the tab's file in a new split next to its group (Rider: Split Vertically / Horizontally). */
  async splitTab(t = this.active, dir = 'row') {
    if (!t) return;
    const from = t.group;
    if (this.groups.length >= MAX_GROUPS) {
      toast({ title: '화면 분할', message: `최대 ${MAX_GROUPS}개까지 나눌 수 있어요. 옆 그룹에서 열었어요.`, timeout: 2500 });
      const next = this.groups[(this.groups.indexOf(from) + 1) % this.groups.length];
      return this.openTabIn(t, next);
    }
    if (this.groups.length > 1 && dir !== this.splitDir) for (const g of this.groups) g.flex = 1;
    this.splitDir = dir;
    const g = this.addGroup(this.groups.indexOf(from) + 1);
    const view = from.active === t && t.model ? from.editor.saveViewState() : null;
    await this.openTabIn(t, g);
    if (view && g.active && g.active.model) g.editor.restoreViewState(view);
    this.app.saveSessionSoon();
  }

  /** The same file (shared model) or settings page as `t`, in group g. */
  async openTabIn(t, g) {
    if (t.special) return this.moveTab(t, g);
    return this.open(t.path, { group: g, pushHistory: false, preview: false });
  }

  /** Moves a tab to another group (drag & drop / menu); an emptied group closes. */
  moveTab(t, g, before = null) {
    const from = t.group;
    if (!g || !from) return;
    if (from === g) {
      // reorder inside the bar
      if (before && before !== t) {
        from.tabs.splice(from.tabs.indexOf(t), 1);
        from.tabs.splice(from.tabs.indexOf(before), 0, t);
        this.renderTabs();
        this.app.saveSessionSoon();
      }
      return;
    }
    const existing = g.tabs.find((x) => samePath(x.path, t.path));
    if (from.active === t && t.model) t.viewState = from.editor.saveViewState();
    from.tabs.splice(from.tabs.indexOf(t), 1);
    if (existing) {
      // already open there: keep that one (same model), drop this view
      if (t.sub) t.sub.dispose();
      this.activate(existing);
    } else {
      t.group = g;
      const idx = before ? g.tabs.indexOf(before) : g.active ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
      g.tabs.splice(idx < 0 ? g.tabs.length : idx, 0, t);
      this.activate(t);
    }
    if (from.active === t) {
      from.active = null;
      const next = from.tabs[from.tabs.length - 1] || null;
      if (next) this.showInGroup(from, next);
      else this.showInGroup(from, null);
    }
    if (!from.tabs.length) this.removeGroup(from);
    this.renderTabs();
    this.app.saveSessionSoon();
  }

  nextGroup(g = this.group) {
    return this.groups[(this.groups.indexOf(g) + 1) % this.groups.length];
  }

  /** Back to one editor: every tab goes into the first group. */
  unsplit() {
    if (this.groups.length < 2) return;
    const first = this.groups[0];
    for (const g of this.groups.slice(1)) for (const t of [...g.tabs]) this.moveTab(t, first);
    for (const g of this.groups) g.flex = 1;
    this.layoutGroups();
    this.app.saveSessionSoon();
  }

  /** Focus the n-th split (Ctrl+1/2/3). */
  focusNth(n) {
    const g = this.groups[n];
    if (g) this.focusGroup(g, true);
  }

  /** For the session: the groups' tabs, active tabs, direction and sizes. */
  serialize() {
    return {
      dir: this.splitDir,
      groups: this.groups.map((g) => ({
        tabs: g.tabs.filter((t) => !t.preview && !t.special).map((t) => t.path),
        active: g.active && !g.active.special ? g.active.path : null,
        flex: Math.round(g.flex * 1000) / 1000,
      })),
      focused: this.groups.indexOf(this.group),
    };
  }

  async restore(state, exists) {
    if (!state || !Array.isArray(state.groups) || !state.groups.length) return;
    this.splitDir = state.dir === 'column' ? 'column' : 'row';
    const list = state.groups.slice(0, MAX_GROUPS);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const paths = [];
      for (const p of s.tabs || []) if (typeof p === 'string' && (await exists(p))) paths.push(p);
      if (!paths.length) continue;
      const g = this.groups[0].tabs.length ? this.addGroup() : this.groups[0];
      g.flex = s.flex > 0 ? s.flex : 1;
      for (const p of paths) await this.open(p, { group: g, focus: false, pushHistory: false });
      const act = s.active && g.tabs.find((t) => samePath(t.path, s.active));
      if (act) this.activate(act, false);
    }
    this.layoutGroups();
    const f = this.groups[state.focused] || this.groups[0];
    this.focusGroup(f);
  }

  registerOpener() {
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

  createEditor(g) {
    const s = this.app.settings;
    const editor = monaco.editor.create(g.host, {
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
      formatOnPaste: s['editor.formatOnPaste'] !== false, // Roslyn range formatting: pasted blocks get indented and Allman braces
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

    // clicking / typing in a split makes it the focused group (keyboard commands act on it)
    editor.onDidFocusEditorText(() => this.focusGroup(g));
    editor.onDidChangeCursorPosition((e) => { if (this.group === g) this.app.onCursor(e.position); });
    editor.onDidChangeModelLanguageConfiguration(() => this.app.updateStatus());
    // Tab completes while the suggest list is open (added later, so it wins over Monaco's own Tab).
    editor.addCommand(monaco.KeyCode.Tab, () => this.acceptSuggestionWithTab(), 'suggestWidgetVisible && textInputFocus');
    // Enter after `{` in C#: the brace on its own line and the block opened (brace-enter.js)
    editor.addCommand(monaco.KeyCode.Enter, () => this.braceEnter(),
      'editorTextFocus && !editorReadonly && !suggestWidgetVisible && editorLangId == csharp');
    return editor;
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

  braceEnter() {
    const ed = this.editor;
    const model = ed.getModel();
    const plain = () => ed.trigger('keyboard', 'type', { text: '\n' }); // Monaco's own Enter
    const sels = ed.getSelections() || [];
    if (!model || sels.length !== 1 || !sels[0].isEmpty()) return plain();
    const pos = sels[0].getPosition();
    const line = model.getLineContent(pos.lineNumber);
    const o = model.getOptions();
    const unit = o.insertSpaces ? ' '.repeat(o.indentSize || o.tabSize) : '\t';
    // after the one statement of a brace-less if / else / loop: back to the header's indentation
    const lineAt = (i) => maskCode(model.getLineContent(i + 1));
    const back = singleStatementIndent(lineAt, pos.lineNumber - 1, line.slice(0, pos.column - 1), line.slice(pos.column - 1));
    if (back !== null) {
      const nl = model.getEOL();
      const keep = line.slice(0, pos.column - 1).replace(/[ \t]+$/, '');
      const ln = pos.lineNumber + 1;
      ed.pushUndoStop();
      ed.executeEdits('papyrus.singleStatementEnter', [{
        range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, line.length + 1),
        text: keep + nl + back,
        forceMoveMarkers: true,
      }], [new monaco.Selection(ln, back.length + 1, ln, back.length + 1)]);
      ed.pushUndoStop();
      ed.revealPosition({ lineNumber: ln, column: back.length + 1 });
      return;
    }
    if (this.app.settings['editor.allmanBraces'] === false) return plain();
    const r = allmanEnter(line.slice(0, pos.column - 1), line.slice(pos.column - 1), unit);
    if (!r) return plain();
    const ln = pos.lineNumber + r.caretLine;
    ed.pushUndoStop();
    ed.executeEdits('papyrus.braceEnter', [{
      range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, line.length + 1),
      text: r.lines.join(model.getEOL()),
      forceMoveMarkers: true,
    }], [new monaco.Selection(ln, r.caretColumn, ln, r.caretColumn)]);
    ed.pushUndoStop();
    ed.revealPosition({ lineNumber: ln, column: r.caretColumn });
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
    this.updateAllOptions({
      fontLigatures: !!s['editor.fontLigatures'],
      renderWhitespace: s['editor.renderWhitespace'] || 'none',
      formatOnType: s['editor.formatOnType'] !== false,
      formatOnPaste: s['editor.formatOnPaste'] !== false,
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
  /** The tab for path: in the focused group first, then any split. */
  findTab(path) {
    return (this.group && this.group.tabs.find((t) => samePath(t.path, path))) || this.tabs.find((t) => samePath(t.path, path));
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
    const g = opts.group || this.group; // opens in the focused split (like Rider), or the one asked for
    if (pushHistory) this.recordHistory();
    let tab = g.tabs.find((t) => samePath(t.path, path));
    if (!tab) {
      // open in another split already: same model (and its unsaved edits), nothing read from disk
      const twin = this.tabs.find((t) => samePath(t.path, path) && !t.special);
      let res;
      let model;
      if (twin) {
        model = twin.model;
        res = { size: twin.size, encoding: twin.encoding, mtimeMs: twin.mtimeMs };
      } else {
        try {
          ({ res, model } = await this.loadModel(path));
        } catch (err) {
          toast({ kind: 'error', title: '파일을 열 수 없어요', message: String(err.message || err) });
          return null;
        }
      }
      tab = {
        path,
        model,
        group: g,
        kind: model ? 'text' : IMAGE_EXT.has(extname(path)) ? 'image' : 'binary',
        size: res.size,
        encoding: res.encoding || 'utf8',
        mtimeMs: res.mtimeMs,
        savedVersion: twin ? twin.savedVersion : model ? model.getAlternativeVersionId() : 0,
        dirty: twin ? twin.dirty : false,
        preview,
        viewState: null,
        sub: null,
      };
      if (preview) {
        const old = g.tabs.find((t) => t.preview && !t.dirty);
        if (old) this.closeTab(old, { force: true, noHistory: true });
      }
      const idx = g.active ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
      g.tabs.splice(idx, 0, tab);
      if (model) {
        tab.sub = model.onDidChangeContent(() => {
          const dirty = model.getAlternativeVersionId() !== tab.savedVersion;
          if (dirty && tab.preview) tab.preview = false;
          // the same file in two splits: auto save etc. once, from its first tab
          if (dirty && this.tabsOfModel(model)[0] === tab) this.app.onTabEdited(tab);
          if (dirty !== tab.dirty) {
            tab.dirty = dirty;
            this.renderTabs();
            this.onDirtyChange(tab);
          }
        });
        if (!twin) this.app.lsp.open(model); // one didOpen per file, however many splits show it
      }
    } else if (!preview && tab.preview) {
      tab.preview = false;
    }
    this.activate(tab, focus);
    if (tab.model && line) {
      const ed = g.editor;
      const pos = { lineNumber: line, column: column || 1 };
      if (endLine) ed.setSelection(new monaco.Range(line, column || 1, endLine, endColumn || column || 1));
      else ed.setPosition(pos);
      ed.revealPositionInCenterIfOutsideViewport(pos, monaco.editor.ScrollType.Immediate);
    }
    if (pushHistory) this.recordHistory();
    return tab;
  }

  // Non-file tabs (Settings, ...)
  openSpecial(id, title, iconName, content) {
    const path = 'papyrus://' + id;
    let tab = this.findTab(path); // one settings page, in whichever split it is
    if (!tab) {
      const g = this.group;
      tab = { path, special: true, title, icon: iconName, el: content, model: null, kind: 'special', dirty: false, preview: false, group: g };
      const idx = g.active ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
      g.tabs.splice(idx, 0, tab);
    }
    this.activate(tab);
    return tab;
  }

  /** Shows `tab` in its group (null: the group's empty state) and focuses that group. */
  activate(tab, focus = true, group = null) {
    const g = (tab && tab.group) || group || this.group;
    this.showInGroup(g, tab, focus);
    this.group = g;
    for (const x of this.groups) x.el.classList.toggle('focused', x === g);
    this.area.classList.toggle('empty', !this.tabs.length);
    // keep MRU order for recent files
    this.app.recordRecent(tab && tab.path);
    this.renderTabs();
    this.onActiveChange(tab);
    if (tab && tab.tabEl) tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  showInGroup(g, tab, focus = false) {
    if (g.active && g.active !== tab && g.active.model) {
      g.active.viewState = g.editor.saveViewState();
      if (g.active.dirty && this.app.settings['files.autoSave'] === 'onFocusChange') this.save(g.active);
    }
    g.active = tab;
    g.nontext.classList.remove('show');
    g.nontext.replaceChildren();
    if (tab && tab.model) {
      g.host.style.visibility = 'visible';
      if (g.editor.getModel() !== tab.model) g.editor.setModel(tab.model);
      if (tab.viewState) g.editor.restoreViewState(tab.viewState);
      if (focus) g.editor.focus();
    } else {
      g.editor.setModel(null);
      g.host.style.visibility = 'hidden';
      if (tab) this.showNonText(tab, g);
    }
  }

  showNonText(tab, g = tab.group || this.group) {
    const box = g.nontext;
    box.classList.add('show');
    if (tab.special) {
      box.append(tab.el);
      return;
    }
    if (tab.kind === 'image') {
      const url = 'file:///' + tab.path.replace(/\\/g, '/').replace(/^\/+/, '');
      box.append(el('div.nontext-msg', null, el('div', null, `${basename(tab.path)} · ${(tab.size / 1024).toFixed(1)} KB`), el('img', { src: url })));
    } else {
      box.append(el('div.nontext-msg', null,
        el('div', null, `${basename(tab.path)}은(는) 텍스트 파일이 아니에요 (${(tab.size / 1024).toFixed(1)} KB).`),
        el('div', { style: { marginTop: '12px' } }, el('button.btn', { onclick: () => window.papyrus.app.reveal(tab.path) }, icon('folder-opened'), '탐색기에서 보기'))));
    }
  }

  // ------------------------------------------------------------------ tabs UI
  renderTabs() {
    const errorUris = new Set(monaco.editor.getModelMarkers({}).filter((m) => m.severity === monaco.MarkerSeverity.Error).map((m) => m.resource.toString()));
    for (const g of this.groups) {
      const names = new Map();
      for (const t of g.tabs) names.set(basename(t.path), (names.get(basename(t.path)) || 0) + 1);
      // tab elements are kept (only class / label updated): re-creating them on the mousedown that
      // activates a tab would cancel dragging it to another split
      const els = g.tabs.map((t) => {
        const name = t.special ? t.title : basename(t.path);
        const dup = !t.special && names.get(name) > 1;
        const cls = ['tab', t === g.active && 'active', t.dirty && 'dirty', t.preview && 'preview', t.model && errorUris.has(t.model.uri.toString()) && 'has-error'].filter(Boolean).join(' ');
        const key = `${name}|${dup ? basename(dirname(t.path)) : ''}`;
        if (!t.tabEl) t.tabEl = this.tabElement(t);
        t.tabEl.className = cls;
        if (t.tabKey !== key) {
          t.tabKey = key;
          t.tabEl.replaceChildren(
            t.special ? icon(t.icon || 'gear') : fileIcon(name, false),
            el('span.tname', null, name, dup ? el('span.tdir', null, basename(dirname(t.path))) : null),
            el('span.tclose', { title: `닫기 (${this.app.kb('papyrus.closeTab')})`, onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }, icon('close')));
        }
        return t.tabEl;
      });
      const cur = g.tabsEl.children;
      if (cur.length !== els.length || els.some((x, i) => cur[i] !== x)) g.tabsEl.replaceChildren(...els);
    }
  }

  tabElement(t) {
    return el('div.tab', {
      title: t.path,
      draggable: 'true',
      onmousedown: (e) => {
        if (e.button === 1) { e.preventDefault(); this.closeTab(t); return; }
        if (e.button === 0 && !e.target.closest('.tclose')) this.activate(t);
      },
      ondblclick: () => { t.preview = false; this.renderTabs(); },
      oncontextmenu: (e) => { e.preventDefault(); this.tabMenu(t, e.clientX, e.clientY); },
      // drag to another split's tab bar / editor to move it there, or along the bar to reorder
      ondragstart: (e) => {
        this.dragTab = t;
        e.dataTransfer.setData(TAB_MIME, t.path);
        if (!t.special) e.dataTransfer.setData('text/plain', t.path);
        e.dataTransfer.effectAllowed = 'move';
      },
      ondragend: () => { this.dragTab = null; for (const x of this.groups) x.el.classList.remove('drop'); },
    });
  }

  tabMenu(t, x, y) {
    const multi = this.groups.length > 1;
    const full = this.groups.length >= MAX_GROUPS;
    const splitItems = [
      { label: '오른쪽으로 분할', icon: 'split-horizontal', key: this.app.kb('papyrus.splitRight'), disabled: full, action: () => this.splitTab(t, 'row') },
      { label: '아래로 분할', icon: 'split-vertical', key: this.app.kb('papyrus.splitDown'), disabled: full, action: () => this.splitTab(t, 'column') },
    ];
    const groupItems = multi ? [
      { label: '다른 분할 창으로 이동', icon: 'arrow-swap', key: this.app.kb('papyrus.moveToNextGroup'), action: () => this.moveTab(t, this.nextGroup(t.group)) },
      { label: '분할 해제 (모두 합치기)', icon: 'screen-normal', key: this.app.kb('papyrus.unsplit'), action: () => this.unsplit() },
    ] : [];
    if (t.special) {
      // one settings page: it can move between splits, not be duplicated
      contextMenu(x, y, [{ label: '닫기', icon: 'close', key: this.app.kb('papyrus.closeTab'), action: () => this.closeTab(t) }, ...(groupItems.length ? ['-', ...groupItems] : [])]);
      return;
    }
    contextMenu(x, y, [
      { label: '닫기', icon: 'close', key: this.app.kb('papyrus.closeTab'), action: () => this.closeTab(t) },
      { label: '다른 탭 모두 닫기', action: () => this.closeOthers(t) },
      { label: '모든 탭 닫기', action: () => this.closeAll() },
      { label: '오른쪽 탭 닫기', action: () => this.closeRight(t) },
      '-',
      ...splitItems,
      ...groupItems,
      '-',
      ...(t.special || !t.path ? [] : [{ label: '로컬 히스토리…', icon: 'history', action: () => this.app.localHistory.showFile(t.path) }, '-']),
      { label: '경로 복사', icon: 'copy', action: () => navigator.clipboard.writeText(t.path) },
      { label: '상대 경로 복사', action: () => navigator.clipboard.writeText(relPath(this.app.project, t.path)) },
      { label: '탐색기에서 선택', icon: 'target', action: () => this.app.explorer.reveal(t.path) },
      { label: '파일 탐색기에서 열기', icon: 'folder-opened', action: () => window.papyrus.app.reveal(t.path) },
    ]);
  }

  async closeTab(tab, { force = false, noHistory = false } = {}) {
    if (!tab) return true;
    const g = tab.group;
    if (!g || !g.tabs.includes(tab)) return true;
    // the same file still open in another split: closing this view loses nothing
    const shared = this.tabsOfModel(tab.model).filter((t) => t !== tab);
    if (!shared.length) {
      if (tab.dirty && !force && (this.app.settings['files.autoSave'] || 'off') !== 'off') {
        // auto save on: closing saves like switching tabs does, no question (Rider)
        if (!(await this.save(tab))) return false;
      } else if (tab.dirty && !force) {
        const r = await window.papyrus.app.confirm({ message: `${basename(tab.path)}에 저장하지 않은 변경 사항이 있어요.`, buttons: ['저장', '저장 안 함', '취소'], type: 'warning' });
        if (r === 2) return false;
        if (r === 0 && !(await this.save(tab))) return false;
      }
    }
    const idx = g.tabs.indexOf(tab);
    if (idx < 0) return true;
    g.tabs.splice(idx, 1);
    if (!noHistory) this.closedStack.push(tab.path);
    if (tab.sub) tab.sub.dispose();
    if (tab.model && !shared.length) {
      this.app.lsp.close(tab.model);
      monaco.editor.setModelMarkers(tab.model, 'lsp', []);
      tab.model.dispose();
    }
    if (!g.tabs.length && this.groups.length > 1) {
      // an emptied split closes (Rider)
      g.active = null;
      this.removeGroup(g);
    } else if (g.active === tab) {
      g.active = null;
      const mru = this.app.recentFiles.map((p) => g.tabs.find((t) => samePath(t.path, p))).find(Boolean);
      this.activate(mru || g.tabs[Math.min(idx, g.tabs.length - 1)] || null, true, g);
    } else this.renderTabs();
    this.app.saveSession();
    return true;
  }

  async closeOthers(keep) {
    for (const t of [...keep.group.tabs]) if (t !== keep) if (!(await this.closeTab(t))) return;
  }
  /** Every tab of every split (e.g. opening another project): back to one editor. */
  async closeAll() {
    for (const t of [...this.tabs]) if (!(await this.closeTab(t))) return false;
    while (this.groups.length > 1) this.removeGroup(this.groups[this.groups.length - 1]);
    return true;
  }
  async closeRight(t) {
    const list = t.group.tabs;
    for (const x of list.slice(list.indexOf(t) + 1)) if (!(await this.closeTab(x))) return;
  }

  reopenClosed() {
    const p = this.closedStack.pop();
    if (!p) return;
    if (p.startsWith('papyrus://')) this.app.openSettings();
    else this.open(p);
  }

  nextTab(dir) {
    const list = this.group.tabs;
    if (!list.length) return;
    const i = list.indexOf(this.active);
    this.activate(list[(i + dir + list.length) % list.length]);
  }

  // ------------------------------------------------------------------ save
  async save(tab = this.active, { silent = false, skipUsings = false } = {}) {
    if (!tab || !tab.model) return true;
    if (!tab.dirty && !silent) return true;
    try {
      const g = tab.group;
      // unused / broken usings out first (Rider's optimize usings on save)
      if (!skipUsings && this.app.usingCleanup && tab.model.getLanguageId() === 'csharp') await this.app.usingCleanup.beforeSave(tab.model);
      if (this.app.settings['editor.formatOnSave'] && tab.model.getLanguageId() === 'csharp' && g && g.active === tab) {
        await g.editor.getAction('editor.action.formatDocument')?.run();
      }
      const text = tab.model.getValue();
      const r = await ofs.writeFile(tab.path, text, tab.encoding === 'cp949' ? 'utf8bom' : tab.encoding);
      // every split showing this file is saved with it
      for (const t of this.tabsOfModel(tab.model)) {
        if (t.encoding === 'cp949') t.encoding = 'utf8bom'; // Unity expects UTF-8; convert old CP949 files on first save
        t.mtimeMs = r.mtimeMs;
        t.savedVersion = tab.model.getAlternativeVersionId();
        t.dirty = false;
      }
      this.app.lsp.saved(tab.model);
      if (this.app.usingCleanup) this.app.usingCleanup.afterSave(tab.model);
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
    for (const t of this.dirtyTabs) {
      any = true;
      await this.save(t);
    }
    return any;
  }

  /** Unsaved files (one tab per file, even when it's open in two splits). */
  get dirtyTabs() {
    return this.tabs.filter((t, i, all) => t.dirty && all.findIndex((x) => x.model === t.model) === i);
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
      const keepMine = () => { for (const t of this.tabsOfModel(tab.model)) t.mtimeMs = res.mtimeMs; };
      if (res.text === tab.model.getValue()) {
        keepMine();
        continue;
      }
      if (tab.dirty) {
        toast({
          kind: 'warn', title: `${basename(p)}이(가) 디스크에서 바뀌었어요`, message: '편집 중인 내용과 다릅니다.', timeout: 0,
          actions: [
            { label: '디스크 버전 불러오기', action: () => this.reloadFromDisk(tab, res) },
            { label: '내 버전 유지', action: keepMine },
          ],
        });
      } else this.reloadFromDisk(tab, res);
    }
  }

  reloadFromDisk(tab, res) {
    const m = tab.model;
    const full = m.getFullModelRange();
    const shown = this.tabsOfModel(m).find((t) => t.group && t.group.active === t);
    const sel = shown ? shown.group.editor.getSelections() : null;
    m.pushEditOperations([], [{ range: full, text: res.text }], () => sel);
    // written by someone else (an AI agent...): its usings are left alone until edited here
    if (this.app.usingCleanup) this.app.usingCleanup.reloadedFromDisk(m);
    for (const t of this.tabsOfModel(m)) {
      t.savedVersion = m.getAlternativeVersionId();
      t.dirty = false;
      t.mtimeMs = res.mtimeMs;
      t.encoding = res.encoding;
    }
    this.renderTabs();
  }

  // ------------------------------------------------------------------ workspace edits
  async applyWorkspaceEdit(we) {
    // several files at once: a local history label first, so the whole edit can be undone in one go
    const uris = new Set([...(we.documentChanges || []).map((d) => (d.textDocument ? d.textDocument.uri : d.uri || d.oldUri)), ...Object.keys(we.changes || {})]);
    if (uris.size > 1) await this.app.localHistory.label('여러 파일 수정');
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
            // the file may be open in several splits: reopen it in each
            const open = this.tabs.filter((t) => !t.special && samePath(t.path, from));
            await ofs.rename(from, to);
            const groups = open.map((t) => t.group);
            for (const t of open) await this.closeTab(t, { force: true, noHistory: true });
            for (const g of groups) if (this.groups.includes(g)) await this.open(to, { group: g });
            if (open.length && !groups.some((g) => this.groups.includes(g))) await this.open(to);
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
