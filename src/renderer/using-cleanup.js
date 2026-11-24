// Rider-like "optimize usings": using directives Roslyn reports as unnecessary (IDE0005 / CS8019,
// shown faded) and ones naming a namespace that doesn't exist (CS0246 / CS0234 on the directive)
// are removed: right away (auto), when the file is saved, or with the "using 정리" command.
//
// Roslyn's "unnecessary" only means "nothing in the code it can see uses it", so nothing is removed
// when it can't see all of the code that matters:
//  - the code has errors: an unresolved name (a class in a file not in the .csproj yet, a package
//    not imported, code half written) could need any of the usings, and code that doesn't parse
//    uses nothing
//  - the file has inactive #if code (#if UNITY_ANDROID, an #else...): a using only that code uses
//    looks unnecessary (Roslyn marks that code as excludedCode)
// and auto / on-save cleaning also waits when the text may be in the middle of something:
//  - the file was rewritten on disk (an AI agent, git...) and not edited here since
//  - lines were cut / deleted / replaced in the last minute: cut code is usually pasted back
//  - auto never removes every using at once (that's an emptied class, not a cleanup)
//  - a using whose namespace isn't found is only removed by the command: while Unity regenerates
//    the .csproj, Roslyn briefly misses package / asmdef namespaces that do exist
// Last, every removal is checked: when Roslyn's next diagnostics show more "not found" names than
// before, the usings were needed after all. They are put back, the file is left alone for the rest
// of the session, and the output panel says so (every removal is logged there).
import { monaco } from './monaco.js';

const UNUSED_CODES = new Set(['IDE0005', 'CS8019']);
const UNRESOLVED_CODES = new Set(['CS0246', 'CS0234']);
// not errors in every setup, but always "something isn't found": some using might be the fix
const UNRESOLVED_REF_CODES = new Set(['CS0246', 'CS0234', 'CS0103', 'CS1061', 'CS0117', 'CS0426', 'CS1069', 'CS1929', 'CS1935', 'CS0308']);
// `using A.B;`, `using X = A.B.C;`, `global using A;` (not `using static`, not using statements / declarations)
const USING_LINE = /^[ \t]*(?:global[ \t]+)?using[ \t]+(?!static\b)(?:@?[A-Za-z_]\w*[ \t]*=[ \t]*)?[\w.:<>, ]+?[ \t]*;[ \t]*(?:\/\/.*)?$/;
const CONDITIONAL = /^[ \t]*#[ \t]*(?:if|elif|else)\b/m;
const AUTO_DELAY_MS = 1500; // after the last diagnostics (typing pauses)
const CUT_HOLD_MS = 60000; // after lines were cut / deleted / replaced
const VERIFY_MS = 20000; // a removal is checked against the diagnostics that arrive this long after it
const codeOf = (d) => String(typeof d.code === 'object' && d.code ? d.code.value : d.code ?? '');
/** "Not found" names in the code (unresolved types, members, extension methods...). */
const unresolvedCount = (diags) => diags.filter((d) => UNRESOLVED_REF_CODES.has(codeOf(d))).length;

/** Lines (1-based) of the using block: before the first namespace / type / attribute. */
export function usingBlock(model) {
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
 * What can go: { lines, kept, block } where kept says why unnecessary usings stayed
 * ('errors' / 'excluded'), from diagnostics that match the model's text. Usings naming a namespace
 * Roslyn can't find go only with badNamespaces (the command).
 */
export function analyzeUsings(model, diags, { excludedCode = false, badNamespaces = false } = {}) {
  const block = new Set(usingBlock(model));
  if (!block.size) return { lines: [], kept: null, block };
  const unused = new Set();
  const badNs = new Set();
  for (const d of diags) {
    const code = codeOf(d);
    const s = d.range.start.line + 1;
    const e = d.range.end.line + 1;
    if (UNRESOLVED_CODES.has(code) && block.has(s)) {
      badNs.add(s); // the using itself names a namespace that doesn't exist
    } else if ((d.severity === 1 || UNRESOLVED_REF_CODES.has(code)) && !block.has(s)) {
      return { lines: [], kept: 'errors', block }; // see the top of the file
    } else if (UNUSED_CODES.has(code)) {
      for (let l = s; l <= e; l++) if (block.has(l)) unused.add(l);
    }
  }
  if (!badNamespaces) badNs.clear();
  if (excludedCode && unused.size) return { lines: [...badNs].sort((a, b) => a - b), kept: 'excluded', block };
  return { lines: [...new Set([...unused, ...badNs])].sort((a, b) => a - b), kept: null, block };
}

export const usingLinesToRemove = (model, diags, opts) => analyzeUsings(model, diags, opts).lines;

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
    this.fromDisk = new WeakMap(); // model -> version id of text that was reloaded from disk (left alone)
    this.cutAt = new WeakMap(); // model -> when lines were last cut / deleted / replaced
    this.watched = new WeakSet();
    this.checks = new WeakMap(); // model -> { at, unresolved, removed: [text], fromSave } of the last removal
    this.distrust = new WeakSet(); // a removal broke this file once: no more auto / on-save cleaning
  }

  log(msg) {
    try { this.app.panels.views.output.append('[using 정리] ' + msg); } catch { /* panels not up yet */ }
  }

  fileName(model) {
    return (model.uri && model.uri.path ? decodeURIComponent(model.uri.path.split('/').pop()) : '') || '(파일)';
  }

  /**
   * The file was rewritten on disk (an AI agent, git, another editor) and reloaded. That writer
   * may be halfway (a using first, the code that needs it in its next edit), so it is not cleaned
   * until it's edited here: removing would also make the tab dirty and autosave would write the
   * trimmed text back over the writer's file.
   */
  reloadedFromDisk(model) {
    this.fromDisk.set(model, model.getAlternativeVersionId());
    this.pendingSave.delete(model);
    clearTimeout(this.timers.get(model));
  }

  untouchedSinceReload(model) {
    return this.fromDisk.get(model) === model.getAlternativeVersionId();
  }

  /** Lines cut / deleted / replaced (the code may come back with a paste): note when. */
  watch(model) {
    if (this.watched.has(model)) return;
    this.watched.add(model);
    model.onDidChangeContent((e) => {
      if (e.isUndoing || e.isRedoing || this.selfEdit) return;
      if (e.changes.some((c) => c.rangeLength > 0 && c.range.endLineNumber > c.range.startLineNumber)) this.cutAt.set(model, Date.now());
    });
  }

  /**
   * removeUsingLines, not counted as a cut, logged, and checked once Roslyn has looked at the
   * result (verify) so a wrong removal is undone.
   */
  remove(model, lines, { why = 'auto', fromSave = false } = {}) {
    if (!lines.length) return 0;
    const removed = lines.map((l) => model.getLineContent(l).trim());
    const unresolved = unresolvedCount(this.app.lsp.diagnosticsFor(model));
    let n;
    this.selfEdit = true;
    try { n = removeUsingLines(model, lines); } finally { this.selfEdit = false; }
    this.checks.set(model, { at: Date.now(), unresolved, removed, fromSave: fromSave || why === 'save' });
    const how = why === 'save' ? '저장할 때' : why === 'command' ? 'using 정리 명령' : '자동';
    this.log(`${this.fileName(model)}: ${removed.join(' ')} 지움 (${how})`);
    return n;
  }

  /**
   * After a removal: Roslyn's diagnostics for the new text. More "not found" names than before means
   * a removed using was needed (Roslyn had called it unnecessary for a reason it couldn't see): the
   * usings go back, and this file isn't cleaned automatically again this session. Typing may add
   * "not found" names too; then usings that were unused come back, which breaks nothing.
   */
  verify(model) {
    const c = this.checks.get(model);
    if (!c || model.isDisposed() || !this.app.lsp.diagnosticsFresh(model)) return;
    if (Date.now() - c.at > VERIFY_MS) { this.checks.delete(model); return; }
    if (unresolvedCount(this.app.lsp.diagnosticsFor(model)) <= c.unresolved) return; // fine so far
    this.checks.delete(model);
    this.restore(model, c);
  }

  restore(model, c) {
    const have = new Set(usingBlock(model).map((l) => model.getLineContent(l).trim()));
    const back = c.removed.filter((u) => !have.has(u));
    if (!back.length) return;
    const eol = model.getEOL ? model.getEOL() : '\n';
    const block = usingBlock(model);
    const at = block.length ? block[0] : 1;
    const text = back.join(eol) + eol + (block.length || !model.getLineContent(1).trim() ? '' : eol);
    this.selfEdit = true;
    try {
      model.pushStackElement();
      model.pushEditOperations(null, [{ range: new monaco.Range(at, 1, at, 1), text }], () => null);
      model.pushStackElement();
    } finally { this.selfEdit = false; }
    this.distrust.add(model);
    this.snapshot(model);
    this.log(`${this.fileName(model)}: 지운 뒤 찾을 수 없는 이름이 생겨서 되돌림 (${back.join(' ')}). 이 파일은 이번 실행 동안 자동 정리하지 않아요.`);
    if (c.fromSave) {
      const tab = this.app.editors.tabsOfModel(model)[0];
      if (tab && tab.dirty) this.app.editors.save(tab, { skipUsings: true });
    }
  }

  recentlyCut(model) {
    return Date.now() - (this.cutAt.get(model) || 0) < CUT_HOLD_MS;
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

  /** Does the file have #if code Roslyn treats as inactive? (unknown counts as yes) */
  async excludedCode(model) {
    if (!CONDITIONAL.test(model.getValue())) return false;
    const r = await this.app.lsp.hasExcludedCode(model).catch(() => null);
    return r !== false;
  }

  /**
   * analyzeUsings for the model's current text, or null when Roslyn's diagnostics are for another
   * version (also when the text changed while the inactive-code check ran).
   */
  async analyze(model, { badNamespaces = false } = {}) {
    if (!this.app.lsp.diagnosticsFresh(model)) return null;
    const version = model.getVersionId();
    const excludedCode = await this.excludedCode(model);
    if (model.isDisposed() || model.getVersionId() !== version || !this.app.lsp.diagnosticsFresh(model)) return null;
    return analyzeUsings(model, this.app.lsp.diagnosticsFor(model), { excludedCode, badNamespaces });
  }

  onDiagnostics(model) {
    this.verify(model);
    if (this.mode() === 'off' || !this.enabledFor(model) || this.distrust.has(model)) return;
    this.watch(model);
    if (!this.baseline.has(model)) this.snapshot(model);
    clearTimeout(this.timers.get(model));
    // a save waiting for diagnostics goes at once; auto waits for a pause in typing
    this.timers.set(model, setTimeout(() => this.run(model), this.pendingSave.has(model) ? 100 : AUTO_DELAY_MS));
  }

  async run(model) {
    if (!this.enabledFor(model)) return 0;
    const all = this.pendingSave.has(model);
    if (!all && (this.mode() !== 'auto' || this.untouchedSinceReload(model))) return 0;
    if (this.recentlyCut(model)) { this.pendingSave.delete(model); return 0; }
    const a = await this.analyze(model);
    if (!a) return 0; // stale: the next diagnostics run this again
    let lines = a.lines;
    if (!all) {
      // auto: a using just typed (code that uses it not written yet) stays until the file is saved,
      // and so does the one the caret is on
      const base = this.baseline.get(model) || new Set();
      const caretLines = new Set(this.app.editors.groups.filter((g) => g.editor.getModel() === model).map((g) => g.editor.getPosition()?.lineNumber));
      lines = lines.filter((l) => base.has(model.getLineContent(l).trim()) && !caretLines.has(l));
      if (lines.length >= a.block.size) return 0; // every using unused: an emptied file, not a cleanup
    }
    this.pendingSave.delete(model);
    if (!lines.length) return 0;
    const n = this.remove(model, lines, { why: all ? 'save' : 'auto' });
    // removed after a save: save that too, so the file on disk is the clean one
    if (all) {
      const tab = this.app.editors.tabsOfModel(model)[0];
      if (tab && tab.dirty) this.app.editors.save(tab, { skipUsings: true });
    }
    return n;
  }

  /** Before writing the file (save): clean now if the diagnostics match the text, else right after. */
  async beforeSave(model) {
    if (this.mode() === 'off' || !this.enabledFor(model) || this.distrust.has(model)) return;
    this.watch(model);
    if (this.untouchedSinceReload(model) || this.recentlyCut(model)) return;
    const a = await this.analyze(model);
    if (!a) { this.pendingSave.add(model); return; }
    if (a.lines.length) this.remove(model, a.lines, { why: 'save' });
  }

  afterSave(model) {
    this.snapshot(model);
  }

  /**
   * "using 정리" command: the open file, now. Returns the number removed, -1 while Roslyn is still
   * working, or { removed, kept } when unnecessary usings were kept on purpose.
   */
  async cleanNow(model) {
    if (!model || model.getLanguageId() !== 'csharp') return 0;
    let a = null;
    for (let i = 0; i < 10 && !a; i++) {
      if (i === 0 && !this.app.lsp.diagnosticsFresh(model)) this.app.lsp.pullNow(model);
      a = await this.analyze(model, { badNamespaces: true });
      if (!a) await new Promise((r) => setTimeout(r, 300));
    }
    if (!a) return -1;
    const removed = this.remove(model, a.lines, { why: 'command' });
    return a.kept ? { removed, kept: a.kept } : removed;
  }
}
