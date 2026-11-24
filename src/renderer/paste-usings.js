// Rider-like "add usings on paste": C# code pasted into a file that lacks some of its using directives
// gets them added. After the paste, Roslyn's next diagnostics show the names it can't find inside the
// pasted text (CS0246, CS0103, CS1061...); for each, its own "using X;" quick fix says which namespace
// has it. One namespace: the using is added. Several (Random: System / UnityEngine): the one the file
// the code was copied from used wins (copied in PAPyrus), otherwise a toast lets the user pick.
// Adding a using can surface more (`List<int>` found, then its `.Where` needs System.Linq), so a
// second round runs on the diagnostics after the first.
import { monaco } from './monaco.js';
import { toast } from './ui.js';
import { usingBlock } from './using-cleanup.js';

const FIX_CODES = new Set(['CS0246', 'CS0103', 'CS1061', 'CS1935', 'CS0117', 'CS0308', 'CS1069']);
const USING_TITLE = /^using ([A-Za-z_][\w.]*);$/;
const NAMESPACE_OF = /^[ \t]*(?:global[ \t]+)?using[ \t]+(?!static\b)([A-Za-z_][\w.]*)[ \t]*;/;
const WAIT_MS = 20000; // a paste waits this long for Roslyn's diagnostics
const ROUNDS = 2;
const codeOf = (d) => String(typeof d.code === 'object' && d.code ? d.code.value : d.code ?? '');
const squash = (s) => s.replace(/\s+/g, '');

/** Namespaces of the using block. */
function namespacesOf(model) {
  const out = new Set();
  for (const l of usingBlock(model)) {
    const m = NAMESPACE_OF.exec(model.getLineContent(l));
    if (m) out.add(m[1]);
  }
  return out;
}

/** System first, then alphabetical (VS / Rider "sort usings"). */
function compareNs(a, b) {
  const sa = a === 'System' || a.startsWith('System.');
  const sb = b === 'System' || b.startsWith('System.');
  if (sa !== sb) return sa ? -1 : 1;
  return a.localeCompare(b, 'en');
}

export class PasteUsings {
  constructor(app) {
    this.app = app;
    this.pending = new Map(); // model -> { deco, round, copied: Set | null, since, busy }
    this.lastCopy = null; // { text, usings, at }
  }

  enabled() {
    return this.app.settings['editor.addUsingsOnPaste'] !== false;
  }

  attach(editor) {
    editor.onDidPaste((e) => this.onPaste(editor, e));
    // copy / cut in a C# file: remember its usings, so an ambiguous name pasted elsewhere picks the same
    const remember = () => {
      const model = editor.getModel();
      if (!model || model.getLanguageId() !== 'csharp') return;
      const sels = editor.getSelections() || [];
      const text = sels.map((s) => (s.isEmpty() ? model.getLineContent(s.startLineNumber) : model.getValueInRange(s))).join('\n');
      this.lastCopy = { text: squash(text), usings: namespacesOf(model), at: Date.now() };
    };
    const node = editor.getDomNode();
    if (node) {
      node.addEventListener('copy', remember, true);
      node.addEventListener('cut', remember, true);
    }
  }

  onPaste(editor, e) {
    const model = editor.getModel();
    if (!model || model.getLanguageId() !== 'csharp' || !this.enabled() || !e.range) return;
    const pasted = model.getValueInRange(e.range);
    if (!/[A-Za-z_]/.test(pasted)) return;
    const old = this.pending.get(model);
    if (old) model.deltaDecorations([old.deco], []);
    const [deco] = model.deltaDecorations([], [{
      range: e.range,
      options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    }]);
    const c = this.lastCopy;
    const copied = c && Date.now() - c.at < 30 * 60 * 1000 && c.text && c.text === squash(pasted) ? c.usings : null;
    this.pending.set(model, { deco, round: 0, copied, since: Date.now(), busy: false });
  }

  /** From the LSP client, every time a model's diagnostics are shown. */
  onDiagnostics(model, diags) {
    const p = this.pending.get(model);
    if (!p || p.busy) return;
    if (model.isDisposed() || Date.now() - p.since > WAIT_MS) { this.finish(model); return; }
    if (!this.app.lsp.diagnosticsFresh(model)) return; // the next ones are for the current text
    p.busy = true;
    this.round(model, p, diags).catch(() => this.finish(model)).finally(() => { p.busy = false; });
  }

  finish(model) {
    const p = this.pending.get(model);
    if (!p) return;
    this.pending.delete(model);
    if (!model.isDisposed()) model.deltaDecorations([p.deco], []);
  }

  async round(model, p, diags) {
    const range = model.getDecorationRange(p.deco);
    if (!range) { this.finish(model); return; }
    const version = model.getVersionId();
    const inPaste = diags.filter((d) => d.severity === 1 && FIX_CODES.has(codeOf(d))
      && monaco.Range.areIntersectingOrTouching(range, new monaco.Range(d.range.start.line + 1, d.range.start.character + 1, d.range.end.line + 1, d.range.end.character + 1)));
    // one request per name (List<int> twice in the pasted code is one using)
    const byName = new Map();
    for (const d of inPaste) {
      const name = model.getValueInRange(new monaco.Range(d.range.start.line + 1, d.range.start.character + 1, d.range.end.line + 1, d.range.end.character + 1));
      if (name && !byName.has(name)) byName.set(name, d);
    }
    if (!byName.size) { this.finish(model); return; }

    const have = namespacesOf(model);
    const add = new Set();
    const ambiguous = [];
    for (const [name, d] of byName) {
      const acts = await this.app.lsp.request('textDocument/codeAction', {
        textDocument: { uri: model.uri.toString() },
        range: d.range,
        context: { diagnostics: [d], only: ['quickfix'], triggerKind: 1 },
      }).catch(() => null);
      const nss = [...new Set((acts || []).map((a) => (USING_TITLE.exec(a && a.title || '') || [])[1]).filter(Boolean))].filter((ns) => !have.has(ns));
      if (!nss.length) continue;
      let pick = nss.length === 1 ? nss[0] : null;
      if (!pick && p.copied) {
        const same = nss.filter((ns) => p.copied.has(ns));
        if (same.length === 1) pick = same[0];
      }
      if (pick) add.add(pick);
      else ambiguous.push({ name, nss });
    }
    if (model.isDisposed() || model.getVersionId() !== version) {
      // typed meanwhile: these names may be gone; look again on the next diagnostics
      return;
    }
    const added = this.insertUsings(model, [...add]);
    if (ambiguous.length) this.askAmbiguous(model, ambiguous);
    p.round++;
    if (added.length) {
      toast({ title: 'using 추가', message: added.map((ns) => `using ${ns};`).join('\n'), timeout: 3000 });
      if (p.round < ROUNDS) { p.since = Date.now(); return; } // more may show up now (extension methods)
    }
    this.finish(model);
  }

  askAmbiguous(model, list) {
    for (const { name, nss } of list.slice(0, 3)) {
      toast({
        title: `'${name}'의 using을 고르세요`,
        message: '여러 네임스페이스에 같은 이름이 있어요.',
        timeout: 12000,
        actions: nss.slice(0, 4).map((ns) => ({ label: ns, action: () => { if (!model.isDisposed()) this.insertUsings(model, [ns]); } })),
      });
    }
  }

  /** Insert `using ns;` lines in sorted place in the using block. Returns the namespaces added. */
  insertUsings(model, list) {
    const have = namespacesOf(model);
    const todo = [...new Set(list)].filter((ns) => !have.has(ns)).sort(compareNs);
    if (!todo.length) return [];
    const eol = model.getEOL();
    const block = usingBlock(model).filter((l) => NAMESPACE_OF.test(model.getLineContent(l)));
    const edits = [];
    if (!block.length) {
      // no usings yet: on top, a blank line before the code
      const first = model.getLineContent(1);
      edits.push({ range: new monaco.Range(1, 1, 1, 1), text: todo.map((ns) => `using ${ns};`).join(eol) + eol + (first.trim() ? eol : '') });
    } else {
      const existing = block.map((l) => ({ line: l, ns: NAMESPACE_OF.exec(model.getLineContent(l))[1] }));
      const indent = /^[ \t]*/.exec(model.getLineContent(block[0]))[0];
      const at = new Map(); // line to insert before (or after the last: lastLine + 1) -> namespaces
      for (const ns of todo) {
        const next = existing.find((e) => compareNs(ns, e.ns) < 0);
        const line = next ? next.line : block[block.length - 1] + 1;
        if (!at.has(line)) at.set(line, []);
        at.get(line).push(ns);
      }
      const lastLine = model.getLineCount();
      for (const [line, nss] of at) {
        const text = nss.map((ns) => `${indent}using ${ns};`).join(eol);
        if (line > lastLine) edits.push({ range: new monaco.Range(lastLine, model.getLineMaxColumn(lastLine), lastLine, model.getLineMaxColumn(lastLine)), text: eol + text });
        else edits.push({ range: new monaco.Range(line, 1, line, 1), text: text + eol });
      }
    }
    model.pushEditOperations([], edits, () => null);
    return todo;
  }
}
