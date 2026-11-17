// Rider's "Namespace does not correspond to file location": a yellow squiggle on a script whose
// namespace isn't the one its folder gives (Assets/Scripts/Player/Foo.cs -> Player, an asmdef's
// rootNamespace first), or that has none at all. Ctrl+. on it offers to adjust it (refactorings.js
// adjustNamespaces: the namespace changes and the scripts using its types get the using).
import { monaco } from './monaco.js';
import { maskCode, topLevelTypes } from './script-copy.js';
import { isThirdPartyPath } from './refactorings.js';
import { dirname, relPath } from './ui.js';

const OWNER = 'namespace';
const FIX = 'papyrus.fixNamespace';

/** { name, nameStart, nameEnd } of the file's single namespace, null when none, false when several. */
export function namespaceDecl(text) {
  const m = maskCode(text);
  const re = /(^|[\s;{}])namespace\s+([A-Za-z_][\w.]*)\s*[;{]/g;
  const all = [...m.matchAll(re)];
  if (all.length > 1) return false;
  if (!all.length) return null;
  const x = all[0];
  const nameStart = x.index + x[0].indexOf(x[2], x[1].length + 'namespace'.length);
  return { name: x[2], nameStart, nameEnd: nameStart + x[2].length };
}

/** Where a missing namespace is reported: the first top-level type's name. */
function firstTypeName(text, types) {
  const m = maskCode(text);
  for (const t of types) {
    const re = new RegExp(`\\b(?:class|struct|interface|enum|record(?:\\s+(?:class|struct))?|delegate\\s+[\\w<>,.?\\[\\] ]+?)\\s+(${t.name})\\b`, 'g');
    const hit = re.exec(m);
    if (hit) {
      const s = hit.index + hit[0].length - hit[1].length;
      return { start: s, end: s + hit[1].length };
    }
  }
  return null;
}

export class NamespaceCheck {
  constructor(app) {
    this.app = app;
    this.timers = new Map();
    this.expected = new Map(); // uri -> namespace the folder gives (for the quick fix)
    monaco.editor.registerCommand(FIX, (_acc, path) => this.fix(path));
    monaco.languages.registerCodeActionProvider('csharp', {
      provideCodeActions: (model, range, context) => {
        const marks = (context.markers || []).filter((mk) => mk.owner === OWNER || mk.source === 'PAPyrus 네임스페이스');
        const mine = marks.length ? marks : monaco.editor.getModelMarkers({ owner: OWNER, resource: model.uri })
          .filter((mk) => mk.startLineNumber <= range.endLineNumber && mk.endLineNumber >= range.startLineNumber);
        if (!mine.length) return { actions: [], dispose() {} };
        const want = this.expected.get(model.uri.toString());
        const path = model.uri.fsPath;
        return {
          actions: [{
            title: want ? `네임스페이스를 '${want}'(으)로 맞추기 (폴더 위치 기준)` : '네임스페이스를 폴더에 맞추기',
            kind: 'quickfix',
            diagnostics: mine,
            isPreferred: true,
            command: { id: FIX, title: '네임스페이스를 폴더에 맞추기', arguments: [path] },
          }],
          dispose() {},
        };
      },
    });
    const watch = (m) => {
      if (m.getLanguageId() !== 'csharp' || m.uri.scheme !== 'file') return;
      this.soon(m, 300);
      const sub = m.onDidChangeContent(() => this.soon(m, 600));
      m.onWillDispose(() => { sub.dispose(); this.expected.delete(m.uri.toString()); clearTimeout(this.timers.get(m.uri.toString())); });
    };
    monaco.editor.getModels().forEach(watch);
    monaco.editor.onDidCreateModel(watch);
  }

  enabled() {
    return this.app.settings['csharp.namespaceCheck'] !== false;
  }

  soon(model, ms) {
    const k = model.uri.toString();
    clearTimeout(this.timers.get(k));
    this.timers.set(k, setTimeout(() => this.check(model).catch(() => {}), ms));
  }

  /** Re-checks every open script (settings, asmdef or project changes). */
  recheckAll() {
    for (const m of monaco.editor.getModels()) if (m.getLanguageId() === 'csharp' && m.uri.scheme === 'file') this.soon(m, 100);
  }

  async check(model, retry = true) {
    if (model.isDisposed()) return;
    const set = (marks) => monaco.editor.setModelMarkers(model, OWNER, marks);
    // only scripts open in a tab (not the language server's background copies of closed files)
    if (!this.app.editors.tabs.some((t) => t.model === model)) {
      set([]);
      if (retry) setTimeout(() => this.check(model, false).catch(() => {}), 1500);
      return;
    }
    const path = model.uri.fsPath;
    const project = this.app.project;
    // only this project's own scripts (store assets / plugins keep their namespaces)
    if (!this.enabled() || !project || !relPath(project, path) || relPath(project, path) === path.replace(/\\/g, '/')
      || isThirdPartyPath(relPath(project, path))) { set([]); return; }
    const version = model.getVersionId();
    const want = await this.app.refactor.namespaceForDir(dirname(path));
    if (model.isDisposed() || model.getVersionId() !== version) return;
    this.expected.set(model.uri.toString(), want);
    const text = model.getValue();
    const types = topLevelTypes(text);
    const decl = namespaceDecl(text);
    // outside Assets / an asmdef, several namespaces, or nothing to put in one: nothing to say
    if (want == null || decl === false || !types.length) { set([]); return; }
    const mark = (start, end, message) => {
      const a = model.getPositionAt(start);
      const b = model.getPositionAt(end);
      set([{
        severity: monaco.MarkerSeverity.Warning,
        message,
        source: 'PAPyrus 네임스페이스',
        startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column,
      }]);
    };
    if (decl) {
      if (decl.name === want || !want) { set([]); return; } // a namespace in a folder that gives none: leave it
      mark(decl.nameStart, decl.nameEnd, `네임스페이스가 파일 위치와 맞지 않아요. '${want}'이어야 해요. (Ctrl+.로 맞추기)`);
      return;
    }
    if (!want) { set([]); return; }
    const at = firstTypeName(text, types);
    if (!at) { set([]); return; }
    mark(at.start, at.end, `네임스페이스가 없어요. 폴더 위치에 맞는 네임스페이스는 '${want}'예요. (Ctrl+.로 넣기)`);
  }

  async fix(path) {
    await this.app.refactor.adjustNamespaces([path], { tickAll: true, confirm: false });
    const m = monaco.editor.getModel(monaco.Uri.file(path));
    if (m) this.soon(m, 300);
  }
}
