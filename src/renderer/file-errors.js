// Which files have errors, for the explorer (Rider: red, underlined file names and folders).
//  - open files: their editor markers (Roslyn's diagnostics for the text being edited)
//  - every other file: Roslyn's workspace diagnostics (LspClient.workspaceErrors, with the
//    lsp.solutionErrors setting the compiler checks the whole solution, not just open files)
// A folder counts the errors of everything under it.
import { monaco } from './monaco.js';

const key = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

export class FileErrors {
  constructor(app) {
    this.app = app;
    this.files = new Map(); // key(path) -> errors
    this.dirs = new Map(); // key(dir) -> errors under it
    this.listeners = [];
    this.timer = 0;
    monaco.editor.onDidChangeMarkers(() => this.schedule());
  }

  /** LspClient: call after it's created. */
  attach(lsp) {
    lsp.onWorkspaceDiagnostics = () => this.schedule();
    // a file opened / closed switches between its own markers and the workspace result, and an open
    // file's empty diagnostics fire no marker event (nothing to remove), so these count too
    lsp.onDocsChange = () => this.schedule();
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.compute(), 200);
  }

  compute() {
    const files = new Map();
    const root = this.app.project ? key(this.app.project) : '';
    const add = (path, n) => {
      const k = key(path);
      // build output (obj/Temp/Library: generated AssemblyAttributes.cs...) isn't the user's code
      if (root && k.startsWith(root + '\\') && /^(temp|obj|library)\\/.test(k.slice(root.length + 1))) return;
      files.set(k, (files.get(k) || 0) + n);
    };
    const lsp = this.app.lsp;
    if (lsp) {
      for (const [uri, n] of lsp.workspaceErrors) {
        if (!lsp.isOpenUri(uri)) add(monaco.Uri.parse(uri).fsPath, n);
      }
    }
    for (const m of monaco.editor.getModelMarkers({})) {
      if (m.severity === monaco.MarkerSeverity.Error && m.resource.scheme === 'file') add(m.resource.fsPath, 1);
    }
    const dirs = new Map();
    for (const [k, n] of files) {
      for (let i = k.lastIndexOf('\\'); i > 2; i = k.lastIndexOf('\\', i - 1)) {
        const d = k.slice(0, i);
        dirs.set(d, (dirs.get(d) || 0) + n);
      }
    }
    const same = files.size === this.files.size && [...files].every(([k, n]) => this.files.get(k) === n);
    this.files = files;
    this.dirs = dirs;
    if (!same) this.listeners.forEach((fn) => fn());
  }

  /** Errors in the file, or under the folder. */
  count(path) {
    const k = key(path);
    return this.files.get(k) || this.dirs.get(k) || 0;
  }
}
