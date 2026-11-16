// Rider-like "optimize usings": using directives Roslyn reports as unnecessary (IDE0005 / CS8019,
// shown faded) and ones naming a namespace that doesn't exist (CS0246 / CS0234 on the directive)
// are removed: right away, or when the file is saved.
import { monaco } from './monaco.js';

const UNUSED_CODES = new Set(['IDE0005', 'CS8019']);
const UNRESOLVED_CODES = new Set(['CS0246', 'CS0234']);
// `using A.B;`, `using X = A.B.C;`, `global using A;` (not `using static`, not using statements / declarations)
const USING_LINE = /^[ \t]*(?:global[ \t]+)?using[ \t]+(?!static\b)(?:@?[A-Za-z_]\w*[ \t]*=[ \t]*)?[\w.:<>, ]+?[ \t]*;[ \t]*(?:\/\/.*)?$/;
const codeOf = (d) => String(typeof d.code === 'object' && d.code ? d.code.value : d.code ?? '');

/** Lines (1-based) of the using block: before the first namespace / type / attribute. */
function usingBlock(model) {
  const lines = [];
  const n = model.getLineCount();
  let inComment = false;
  for (let i = 1; i <= n; i++) {
    const t = model.getLineContent(i).trim();
    if (inComment) { if (t.includes('*/')) inComment = false; continue; }
    if (!t || t.startsWith('//') || t.startsWith('#')) continue;
    if (t.startsWith('/*')) { if (!t.includes('*/')) inComment = true; continue; }
    if (USING_LINE.test(model.getLineContent(i))) { lines.push(i); continue; }
    break; // namespace, class, [assembly: ...]: the block is over
  }
  return lines;
}

/**
 * Using lines to remove, from the model's diagnostics. Unresolvable ones only when nothing else in
 * the file is unresolved: a missing reference (Unity regenerating the .csproj, a package not
 * imported yet) also breaks the code that uses it, and then those usings are not garbage.
 */
export function usingLinesToRemove(model, diags) {
  const block = new Set(usingBlock(model));
  if (!block.size) return [];
  const out = new Set();
  const unresolved = [];
  let otherErrors = false;
  for (const d of diags) {
    const code = codeOf(d);
    const s = d.range.start.line + 1;
    const e = d.range.end.line + 1;
    if (UNUSED_CODES.has(code)) {
      for (let l = s; l <= e; l++) if (block.has(l)) out.add(l);
    } else if (UNRESOLVED_CODES.has(code) || code === 'CS0103' || code === 'CS1061') {
      if (UNRESOLVED_CODES.has(code) && block.has(s)) unresolved.push(s);
      else otherErrors = true;
    }
  }
  if (!otherErrors) unresolved.forEach((l) => out.add(l));
  return [...out].sort((a, b) => a - b);
}

/** Deletes those lines in one undoable edit; returns how many were removed. */
export function removeUsingLines(model, lines) {
  if (!lines.length) return 0;
  const edits = lines.map((l) => ({
    range: l < model.getLineCount() ? new monaco.Range(l, 1, l + 1, 1) : new monaco.Range(l - 1, model.getLineMaxColumn(l - 1), l, model.getLineMaxColumn(l)),
    text: '',
  }));
  model.pushStackElement();
  model.pushEditOperations(null, edits, () => null);
  // every using gone: the blank line that separated them from the code goes too
  if (!usingBlock(model).length && model.getLineCount() > 1 && !model.getLineContent(1).trim()) model.pushEditOperations(null, [{ range: new monaco.Range(1, 1, 2, 1), text: '' }], () => null);
  model.pushStackElement();
  return lines.length;
}

export class UsingCleanup {
  constructor(app) {
    this.app = app;
    this.timers = new Map(); // model -> timeout
    this.baseline = new WeakMap(); // model -> using lines that were there before the user typed (auto mode keeps new ones)
    this.pendingSave = new WeakSet(); // saved while diagnostics were stale: clean (and save again) when they arrive
  }

  mode() {
    return this.app.settings['editor.removeUnusedUsings'] || 'auto';
  }

  enabledFor(model) {
    return model && !model.isDisposed() && model.getLanguageId() === 'csharp' && this.app.lspState === 'ready'
      && this.app.editors.tabsOfModel(model).length > 0;
  }

  /** The using lines as they are when the file is opened / saved: auto mode only removes those. */
  snapshot(model) {
    this.baseline.set(model, new Set(usingBlock(model).map((l) => model.getLineContent(l).trim())));
  }

  onDiagnostics(model, diags) {
    if (this.mode() === 'off' || !this.enabledFor(model)) return;
    if (!this.baseline.has(model)) this.snapshot(model);
    clearTimeout(this.timers.get(model));
    this.timers.set(model, setTimeout(() => this.run(model, diags), 700));
  }

  run(model, diags, { fromSave = false } = {}) {
    if (!this.enabledFor(model) || !this.app.lsp.diagnosticsFresh(model)) return 0;
    const pending = this.pendingSave.has(model);
    const all = fromSave || pending;
    if (!all && this.mode() !== 'auto') return 0;
    let lines = usingLinesToRemove(model, diags);
    if (!all) {
      // auto: a using just typed (code that uses it not written yet) stays until the file is saved,
      // and so does the one the caret is on
      const base = this.baseline.get(model) || new Set();
      const caretLines = new Set(this.app.editors.groups.filter((g) => g.editor.getModel() === model).map((g) => g.editor.getPosition()?.lineNumber));
      lines = lines.filter((l) => base.has(model.getLineContent(l).trim()) && !caretLines.has(l));
    }
    this.pendingSave.delete(model);
    if (!lines.length) return 0;
    const n = removeUsingLines(model, lines);
    // removed after a save: save that too, so the file on disk is the clean one
    if (all) {
      const tab = this.app.editors.tabsOfModel(model)[0];
      if (tab && tab.dirty) this.app.editors.save(tab, { skipUsings: true });
    }
    return n;
  }

  /** Before writing the file (save): clean now if the diagnostics match the text, else right after. */
  beforeSave(model) {
    if (this.mode() === 'off' || !this.enabledFor(model)) return;
    if (this.app.lsp.diagnosticsFresh(model)) {
      const lines = usingLinesToRemove(model, this.app.lsp.diagnosticsFor(model));
      if (lines.length) removeUsingLines(model, lines);
    } else this.pendingSave.add(model);
  }

  afterSave(model) {
    this.snapshot(model);
  }

  /** "using 정리" command: the open file, now. */
  async cleanNow(model) {
    if (!model || model.getLanguageId() !== 'csharp') return 0;
    for (let i = 0; i < 10 && !this.app.lsp.diagnosticsFresh(model); i++) {
      if (i === 0) this.app.lsp.pullNow(model);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!this.app.lsp.diagnosticsFresh(model)) return -1;
    return removeUsingLines(model, usingLinesToRemove(model, this.app.lsp.diagnosticsFor(model)));
  }
}
