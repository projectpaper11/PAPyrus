'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const defaults = {
  'update.checkOnStartup': true,
  'update.repo': '',
  'setup.dontShow': false,
  'workbench.theme': 'dark',
  'keyboard.doubleShift': true,
  'keyboard.keymap': 'vscode', // 'vscode' | 'vs' (Visual Studio): default keys, see src/renderer/keymaps.js
  keybindings: {},
  'files.autoSave': 'onFocusChange', // save when switching tabs or leaving the window, like Rider
  'files.autoSaveDelay': 1000,
  'editor.fontLigatures': false,
  'editor.renderWhitespace': 'none',
  'editor.stickyScroll': true,
  'editor.formatOnType': true,
  'editor.formatOnPaste': true, // pasted code is formatted (Roslyn): indentation, braces on their own line
  'editor.allmanBraces': true, // Enter after `{` moves it to its own line and opens the block, like Rider
  'csharp.namespaceCheck': true, // warn when a script's namespace doesn't match its folder (Rider), Ctrl+. fixes it
  'editor.removeUnusedUsings': 'auto', // 'auto' | 'onSave' | 'off': unused / unresolvable using directives are removed (Rider's optimize usings)
  'editor.learnedCompletions': true,
  'editor.codeLens': true,
  'editor.fontSize': 13,
  'editor.fontFamily': "'JetBrains Mono', Consolas, monospace",
  'editor.lineHeight': 1.45,
  'editor.tabSize': 4,
  'editor.insertSpaces': true,
  'editor.minimap': false,
  'editor.inlayHints': true,
  'editor.wordWrap': false,
  'editor.formatOnSave': false,
  'unity.refreshOnSave': true,
  'unity.clearLogOnPlay': true,
  'unity.assetLenses': true, // "used in 2 prefabs" lenses on scripts and UnityEvent methods
  'unity.formerlySerializedAs': true, // renaming a serialized field adds [FormerlySerializedAs("old")]
  'unity.stringChecks': true, // completion + typo warnings for tags, layers, scenes, animator parameters...
  'history.enabled': true, // local history: a snapshot of each file before/after PAPyrus writes it
  'history.days': 30, // how long local history is kept
  'unity.performanceHints': true, // GetComponent / Find ... in Update-like methods
  // "auto" = roslyn-language-server dotnet tool. Set a path to use another server (e.g. OmniSharp).
  'lsp.path': 'auto',
  'lsp.args': [],
  'lsp.autoRestore': true,
  'explorer.hideProjectFiles': true,
  'explorer.renameClassWithFile': false, // remembered "rename the class too" checkbox of file rename
  'files.exclude': ['Library', 'Temp', 'Logs', 'obj', 'UserSettings', 'Build', 'Builds', '.git', '.vs', '.idea', '.vscode', 'MemoryCaptures'],
  // third-party code left out of name search / find in files (still in the explorer). A folder name
  // matches at any depth; "Assets/Some/Path" matches that path only.
  'search.excludeFolders': ['Plugins', 'TextMesh Pro', 'Feel', 'DamageNumbersPro'],
  reopenLastProject: true,
};

// Window bounds / recent projects live in state.json so editing settings.json never loses them.
const STATE_KEYS = new Set(['window', 'recentProjects', 'lastTheme', 'update.skipVersion']);
let file = null;
let stateFile = null;
let data = null;
let state = null;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function ensure() {
  if (data) return;
  const dir = app.getPath('userData');
  file = path.join(dir, 'settings.json');
  stateFile = path.join(dir, 'state.json');
  data = readJson(file);
  state = readJson(stateFile);
}

function write(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  } catch { /* ignore */ }
}

module.exports = {
  get file() { ensure(); return file; },
  get(key) {
    ensure();
    if (STATE_KEYS.has(key)) return state[key];
    return key in data ? data[key] : defaults[key];
  },
  set(key, value) {
    ensure();
    if (STATE_KEYS.has(key)) { state[key] = value; write(stateFile, state); return; }
    data[key] = value;
    write(file, data);
  },
  all() { ensure(); return { ...defaults, ...data }; },
  reload() { data = null; ensure(); },
  defaults,
};
