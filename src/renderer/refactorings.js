// Rider-style refactorings on top of the Roslyn language server:
//   Refactor This menu (Ctrl+Shift+R), Extract Method (Ctrl+Alt+M), Change Signature (Ctrl+F6),
//   Move Type (Ctrl+Shift+Alt+M), Safe Delete (Alt+Delete).
//
// Roslyn's LSP only ships the refactorings that need no dialog (extract method, move type to file,
// introduce variable...). Change Signature, moving a type to another folder/namespace and safe delete
// of a member are done here: the dialog is ours, the symbol facts (references, overrides, renames)
// come from Roslyn, and the edits are computed on the source text and applied as one workspace edit.
import { monaco } from './monaco.js';
import * as cv from './conv.js';
import { popupPoint } from './location-popup.js';
import { maskCode, topLevelTypes } from './script-copy.js';
import { el, icon, basename, dirname, joinPath, relPath, samePath, fileIcon, contextMenu, prompt, toast } from './ui.js';

const ofs = window.papyrus.fs;
const TYPE_KINDS = new Set([5, 10, 11, 23]); // LSP SymbolKind: class, enum, interface, struct
const METHOD_KINDS = new Set([6, 9, 12]); // method, constructor, function
const KIND_LABEL = {
  5: '클래스', 6: '메서드', 7: '속성', 8: '필드', 9: '생성자', 10: '열거형', 11: '인터페이스', 12: '함수',
  13: '변수', 14: '상수', 22: '열거형 멤버', 23: '구조체', 24: '이벤트',
};
const MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'virtual', 'override', 'abstract',
  'sealed', 'async', 'extern', 'unsafe', 'new', 'partial', 'readonly']);
const IDENT = /^@?[A-Za-z_][A-Za-z0-9_]*$/;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Packages/, Plugins/, ThirdParty/...: library code whose namespaces bulk refactorings must not rewrite. */
export function isThirdPartyPath(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!/^Assets\//i.test(r)) return true; // Packages, Library, anything outside Assets
  return /(^|\/)(Plugins|Third[ _-]?Party|External|Vendor|TextMesh Pro|Samples)(\/|$)/i.test(r);
}

// ====================================================================== text helpers

function lineStarts(text) {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) s.push(i + 1);
  return s;
}
function offsetAt(text, pos) {
  const s = lineStarts(text);
  return Math.min(text.length, (s[pos.line] ?? text.length) + pos.character);
}
function posAt(text, offset) {
  const s = lineStarts(text);
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, character: offset - s[lo] };
}
const contains = (r, p) => (p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character))
  && (p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character));

/** Index after a string / char literal / comment starting at i, or -1 if there is none at i. */
function skipLiteral(text, i) {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); return e < 0 ? text.length : e; }
  if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); return e < 0 ? text.length : e + 2; }
  if (c !== '"' && c !== "'") return -1;
  const verbatim = c === '"' && (text[i - 1] === '@' || (text[i - 1] === '$' && text[i - 2] === '@'));
  for (let j = i + 1; j < text.length; j++) {
    if (!verbatim && text[j] === '\\') { j++; continue; }
    if (text[j] === c) { if (verbatim && text[j + 1] === '"') { j++; continue; } return j + 1; }
    if (!verbatim && text[j] === '\n') return j;
  }
  return text.length;
}

const OPEN = { '(': ')', '[': ']', '{': '}', '<': '>' };

/**
 * Walks `s` from `from`, keeping a bracket stack; calls onTop(i) for each top-level comma and
 * returns the index of the bracket closing the stack's first entry (or -1). `<` only counts as a
 * bracket right after an identifier (generics), so `a < b` stays a comparison; a `<` that never
 * closes is dropped when an outer bracket closes.
 */
function walkBrackets(s, from, onComma) {
  const stack = [];
  for (let i = from; i < s.length; i++) {
    const k = skipLiteral(s, i);
    if (k >= 0) { i = k - 1; continue; }
    const c = s[i];
    if (c === '<') {
      if (/\w/.test(s[i - 1] || '') || (i === from)) stack.push('>');
      continue;
    }
    if (c === '>') {
      if (stack[stack.length - 1] === '>' && s[i - 1] !== '=') { stack.pop(); if (!onComma && !stack.length && i > from) return i; }
      continue;
    }
    if (OPEN[c]) { stack.push(OPEN[c]); continue; }
    if (c === ')' || c === ']' || c === '}') {
      while (stack[stack.length - 1] === '>') stack.pop(); // stray "<" was a comparison
      if (stack[stack.length - 1] === c) { stack.pop(); if (!onComma && !stack.length && i > from) return i; }
      continue;
    }
    if (c === ',' && onComma && !stack.length) onComma(i);
  }
  return -1;
}

/** Index of the bracket closing the one at `open` (any of ( [ { <), or -1. */
const matchClose = (text, open) => walkBrackets(text, open, null);

/** Number of top-level commas in `s` (which bracket we are in, for a caret inside a list). */
function topCommas(s) {
  let n = 0;
  walkBrackets(s, 0, () => { n++; });
  return n;
}

/** Split at top-level commas: [{ text, start }] with `start` relative to `s`. */
function splitTop(s) {
  const cuts = [];
  walkBrackets(s, 0, (i) => cuts.push(i));
  const out = [];
  let from = 0;
  for (const i of cuts) { out.push({ text: s.slice(from, i), start: from }); from = i + 1; }
  out.push({ text: s.slice(from), start: from });
  return out.filter((x, i, all) => x.text.trim() || all.length > 1);
}

/** "[A] ref int x = 5" -> { attrs, mods, type, name, def, nameOffset } (offsets relative to the segment). */
function parseParam(seg) {
  const lead = seg.text.length - seg.text.trimStart().length;
  const t = seg.text.trim();
  const m = /^((?:\[[^\]]*\]\s*)*)((?:(?:this|ref|out|in|params|scoped|readonly)\s+)*)([\s\S]+?)(\s+)(@?\w+)\s*(?:=\s*([\s\S]+))?$/.exec(t);
  if (!m) return null;
  return {
    attrs: m[1].trim(),
    mods: m[2].trim().replace(/\s+/g, ' '),
    type: m[3].trim(),
    name: m[5],
    def: m[6] ? m[6].trim() : '',
    nameOffset: seg.start + lead + m[1].length + m[2].length + m[3].length + m[4].length,
  };
}

/**
 * The method/constructor declared with its name at `nameOffset`:
 * { name, ret: {text,start,end}|null, open, close, params[], isCtor }. Offsets are absolute.
 */
function parseSignature(text, nameOffset) {
  const nm = /^@?\w+/.exec(text.slice(nameOffset, nameOffset + 300));
  if (!nm) return null;
  let i = nameOffset + nm[0].length;
  while (/\s/.test(text[i] || '')) i++;
  if (text[i] === '<') { const g = matchClose(text, i); if (g < 0) return null; i = g + 1; while (/\s/.test(text[i] || '')) i++; }
  if (text[i] !== '(') return null;
  const open = i;
  const close = matchClose(text, open);
  if (close < 0) return null;
  const inner = text.slice(open + 1, close);
  const params = inner.trim() ? splitTop(inner).map(parseParam) : [];
  if (params.some((p) => !p)) return null;
  for (const p of params) p.nameOffset += open + 1;
  const before = text.slice(Math.max(0, nameOffset - 300), nameOffset);
  const base = Math.max(0, nameOffset - 300);
  const rm = /([\w.]+(?:<[^(){};]*?>)?(?:\[[,\s]*\])*\??)(\s+)$/.exec(before);
  const ret = rm && !MODIFIERS.has(rm[1]) ? { text: rm[1], start: base + rm.index, end: base + rm.index + rm[1].length } : null;
  return { name: nm[0], ret, open, close, params, isCtor: !ret };
}

const paramText = (p, keepAttrs) => `${keepAttrs && p.attrs ? p.attrs + ' ' : ''}${p.mods ? p.mods + ' ' : ''}${p.type} ${p.name}${p.def ? ' = ' + p.def : ''}`;

function flatten(symbols, parent = null, out = []) {
  for (const s of symbols || []) {
    const item = { ...s, parent };
    out.push(item);
    flatten(s.children, item, out);
  }
  return out;
}
const span = (r) => (r.end.line - r.start.line) * 100000 + (r.end.character - r.start.character);
const innermost = (list) => list.sort((a, b) => span(a.range) - span(b.range))[0] || null;
const bareName = (n) => String(n || '').replace(/[<(].*$/s, '').trim();

/** `namespace X {` / `namespace X;` of the file: { name, fileScoped, start (line start), open, close } */
function namespaceInfo(text) {
  const m = /^[ \t]*namespace\s+([\w.]+)\s*(;|\{)/m.exec(text);
  if (!m) return null;
  const sym = m.index + m[0].length - 1;
  if (m[2] === ';') return { name: m[1], fileScoped: true, start: m.index, open: sym, close: -1 };
  return { name: m[1], fileScoped: false, start: m.index, open: sym, close: matchClose(text, sym) };
}

/** Start of the statement holding `at` (after the previous ; { } in masked text). */
function statementStart(m, at) {
  let i = at - 1;
  while (i >= 0 && m[i] !== ';' && m[i] !== '{' && m[i] !== '}') i--;
  return i + 1;
}

/** Index after the attribute lists `[...]` (and whitespace) starting at i. */
function skipAttributes(m, i) {
  for (;;) {
    while (i < m.length && /\s/.test(m[i])) i++;
    if (m[i] !== '[') return i;
    let d = 0;
    for (; i < m.length; i++) {
      if (m[i] === '[') d++;
      else if (m[i] === ']' && --d === 0) { i++; break; }
    }
  }
}

/** Where a member declaration's body starts: `{`, `=>` or `;` outside parentheses/brackets. */
function bodyStart(m, i) {
  let d = 0;
  for (; i < m.length; i++) {
    const ch = m[i];
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d--;
    else if (!d && (ch === '{' || ch === ';' || (ch === '=' && m[i + 1] === '>'))) return i;
  }
  return m.length;
}

/**
 * The declaration of a class/struct around its name: type parameters, where-clauses, base list
 * and where to add one more base type.
 */
function typeHeader(text, m, nameStart, nameEnd) {
  const start = statementStart(m, nameStart);
  const body = m.indexOf('{', nameEnd);
  const end = body < 0 ? m.length : body;
  let k = nameEnd;
  let typeParams = '';
  if (m[k] === '<') {
    let d = 0;
    const s = k;
    for (; k < end; k++) { if (m[k] === '<') d++; else if (m[k] === '>' && --d === 0) { k++; break; } }
    typeParams = text.slice(s, k).replace(/\s+/g, ' ');
  }
  let p = k;
  while (p < end && /\s/.test(m[p])) p++;
  if (m[p] === '(') { // primary constructor
    let d = 0;
    for (; p < end; p++) { if (m[p] === '(') d++; else if (m[p] === ')' && --d === 0) { p++; break; } }
    k = p;
    while (p < end && /\s/.test(m[p])) p++;
  }
  const whereAt = (() => { const r = /\bwhere\b/.exec(m.slice(p, end)); return r ? p + r.index : -1; })();
  const listEnd = whereAt >= 0 ? whereAt : end;
  let baseEnd = listEnd;
  while (baseEnd > p && /\s/.test(m[baseEnd - 1])) baseEnd--;
  const mods = m.slice(skipAttributes(m, start), nameStart);
  return {
    start,
    typeParams,
    typeArgs: typeParams.replace(/\b(in|out)\s+/g, ''),
    where: whereAt >= 0 ? text.slice(whereAt, end).trim().replace(/\s+/g, ' ') : '',
    hasBase: m[p] === ':',
    baseEnd,
    afterName: k,
    isPublic: /\bpublic\b/.test(mods),
  };
}

/** A public instance method/property/event as an interface member: { sig, icon }, or null. */
function interfaceMember(text, m, nameStart, sym) {
  const start = skipAttributes(m, statementStart(m, nameStart));
  const b = bodyStart(m, nameStart);
  const head = text.slice(start, b).replace(/\s+/g, ' ').trim();
  const mods = [];
  let rest = head;
  for (;;) {
    const w = /^(\w+)\s+/.exec(rest);
    if (!w || !MODIFIERS.has(w[1])) break;
    mods.push(w[1]);
    rest = rest.slice(w[0].length);
  }
  if (!mods.includes('public') || mods.includes('static')) return null;
  // constructors / destructors (Roslyn reports them as methods too): a name right before "(" with no
  // return type, or "~Name(". They can't be interface members.
  if (sym.kind === 9 || /^~/.test(rest) || /^@?\w+\s*\(/.test(rest)) return null;
  if (sym.kind === 6) return { sig: `${rest};`, icon: 'symbol-method' };
  if (sym.kind === 24) return { sig: `${rest.replace(/=.*$/, '').trim()};`, icon: 'symbol-event' };
  // property / indexer: the accessors anyone can call
  if (m.startsWith('=>', b)) return { sig: `${rest} { get; }`, icon: 'symbol-property' };
  if (m[b] !== '{') return null;
  let d = 0;
  let flat = '';
  for (let i = b; i < m.length; i++) {
    if (m[i] === '{') { d++; if (d === 1) continue; }
    if (m[i] === '}') { d--; if (d === 0) break; continue; }
    if (d === 1) flat += m[i];
  }
  const acc = [];
  for (const a of flat.replace(/=>[^;]*;/g, ';').matchAll(/((?:private|protected|internal)(?:\s+(?:private|protected|internal))?\s+)?\b(get|set|init)\b/g)) {
    if (!a[1]) acc.push(a[2]);
  }
  if (!acc.length) return null;
  return { sig: `${rest} { ${acc.map((a) => a + ';').join(' ')} }`, icon: 'symbol-property' };
}

/** Offset of a top-level type's name (from script-copy's topLevelTypes) in text, or -1. */
function typeNameOffset(text, t) {
  const seg = text.slice(t.start, t.end);
  const n = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const r = t.kind === 'delegate'
    ? new RegExp(`\\bdelegate\\b[^;]*?\\b(${n})\\s*[<(]`).exec(seg)
    : new RegExp(`\\b(?:class|struct|interface|enum|record)\\s+@?(${n})\\b`).exec(seg);
  return r ? t.start + r.index + r[0].lastIndexOf(r[1]) : -1;
}

/** End offset of the leading `using ...;` block (0 if there is none). */
function usingsEnd(text) {
  const re = /^[ \t]*(?:global\s+)?using\s+(?!\()[^;\n]+;[ \t]*\r?\n?/gm;
  let end = 0;
  let m;
  while ((m = re.exec(text))) {
    // only directives before the first type / namespace
    const between = text.slice(end, m.index);
    if (/\b(namespace|class|struct|interface|enum|record)\b/.test(between.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''))) break;
    end = m.index + m[0].length;
  }
  return end;
}

function addUsing(text, ns) {
  if (!ns) return null;
  if (new RegExp(`^[ \\t]*using\\s+${ns.replace(/\./g, '\\.')}\\s*;`, 'm').test(text)) return null;
  const at = usingsEnd(text);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  return { at, text: `using ${ns};${nl}${at ? '' : nl}` };
}

/** Full lines from `start`..`end`, plus doc comments / attributes right above and a doubled blank line. */
function wholeLines(text, start, end) {
  let s = text.lastIndexOf('\n', start - 1) + 1;
  if (text.slice(s, start).trim()) s = start;
  let e = text.indexOf('\n', end);
  e = e < 0 ? text.length : e + 1;
  if (text.slice(end, e).trim()) e = end;
  // comments / attributes directly above belong to the declaration
  while (s > 0 && s !== start) {
    const ps = text.lastIndexOf('\n', s - 2) + 1;
    const line = text.slice(ps, s).trim();
    if (/^(\/\/|\[.*\]$)/.test(line)) s = ps; else break;
  }
  // don't leave two blank lines behind
  const prev = text.slice(text.lastIndexOf('\n', s - 2) + 1, s);
  const nextEnd = text.indexOf('\n', e);
  const next = text.slice(e, nextEnd < 0 ? text.length : nextEnd + 1);
  if (!prev.trim() && !next.trim() && next.length) e += next.length;
  return [s, e];
}

// ====================================================================== the dialogs' frame

function modal({ title, width = 460 }) {
  let done;
  const result = new Promise((r) => { done = r; });
  const body = el('div.cd-body');
  const foot = el('div.cd-foot');
  const prevFocus = document.activeElement;
  const titleEl = el('span.cd-title', null, title);
  const close = (v) => {
    if (!back.isConnected) return;
    back.remove();
    if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus();
    done(v);
  };
  const back = el('div.dialog-back.cd-back', {
    tabindex: '-1',
    onmousedown: (e) => { if (e.target === back) close(null); },
    onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); } },
  }, el('div.cd-dialog', { role: 'dialog', style: { width: width + 'px' } },
    el('div.cd-head', null, titleEl, el('button.cd-x', { title: '닫기 (Esc)', onclick: () => close(null) }, icon('close'))),
    body, foot));
  document.getElementById('overlay-root').append(back);
  return { body, foot, close, result, back };
}

// ====================================================================== refactorings

export class Refactorings {
  constructor(app) {
    this.app = app;
  }

  get lsp() { return this.app.lsp; }

  /** Current C# editor + running language server, or a toast and null. */
  ctx() {
    const ed = this.app.editors.editor;
    const model = ed.getModel();
    const tab = this.app.editors.active;
    if (!model || !tab || model.getLanguageId() !== 'csharp') {
      toast({ kind: 'warn', title: '리팩터링', message: 'C# 파일에서 쓸 수 있어요.', timeout: 2500 });
      return null;
    }
    if (!this.lsp.running) {
      toast({ kind: 'warn', title: '리팩터링', message: 'C# 언어 서버가 준비된 뒤에 다시 시도하세요.', timeout: 3000 });
      return null;
    }
    return { ed, model, path: tab.path, uri: model.uri.toString() };
  }

  fail(title, err) {
    toast({ kind: 'error', title, message: String((err && err.message) || err) });
  }

  async textOf(uri) {
    const m = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (m) return m.getValue();
    const p = cv.uriToPath(uri);
    if (!p) return '';
    try { return (await ofs.readFile(p)).text || ''; } catch { return ''; }
  }

  async symbols(model) {
    return flatten(await this.lsp.documentSymbols(model));
  }

  async codeActions(model, range, only) {
    const r = await this.lsp.request('textDocument/codeAction', {
      textDocument: { uri: model.uri.toString() },
      range: cv.toLspRange(range),
      context: { diagnostics: [], only: only || undefined, triggerKind: 1 },
    });
    return (r || []).filter((a) => a && a.title && typeof a.command !== 'string');
  }

  async runCodeAction(a) {
    let act = a;
    if (!act.edit && !act.command) act = (await this.lsp.request('codeAction/resolve', a)) || a;
    if (act.edit) await this.app.editors.applyWorkspaceEdit(act.edit);
    if (act.command) await this.app.runLspCommand(act.command, a.data && a.data.TextDocument && a.data.TextDocument.uri);
    return act;
  }

  async rename(uri, offset, newName) {
    const text = await this.textOf(uri);
    const we = await this.lsp.request('textDocument/rename', { textDocument: { uri }, position: posAt(text, offset), newName });
    if (!we) throw new Error(`'${newName}'(으)로 이름을 바꾸지 못했어요`);
    await this.app.editors.applyWorkspaceEdit(we);
    await delay(250); // let closed files written to disk reach the server
  }

  async referencesAt(uri, offset, includeDeclaration = false) {
    const text = await this.textOf(uri);
    const r = await this.lsp.request('textDocument/references', {
      textDocument: { uri }, position: posAt(text, offset), context: { includeDeclaration },
    });
    return r || [];
  }

  /** Locations as { path, uri, line, character, text } rows for the usages lists. */
  async rows(locs) {
    const cache = new Map();
    const out = [];
    for (const l of locs) {
      const uri = l.uri.toString();
      if (!cache.has(uri)) cache.set(uri, (await this.textOf(uri)).split(/\r?\n/));
      const path = cv.uriToPath(uri);
      if (!path) continue;
      out.push({ path, uri, line: l.range.start.line, character: l.range.start.character, text: cache.get(uri)[l.range.start.line] || '' });
    }
    return out;
  }

  usageList(rows, close) {
    return el('div.cd-list', null, rows.slice(0, 200).map((r) => el('div.cd-use', {
      title: `${relPath(this.app.project, r.path)}:${r.line + 1}`,
      onclick: () => { close(null); this.app.editors.open(r.path, { line: r.line + 1, column: r.character + 1, pushHistory: true }); },
    }, fileIcon(basename(r.path), false), el('span.cd-file', null, basename(r.path)), el('span.cd-ln', null, `:${r.line + 1}`),
    el('span.cd-code', null, r.text.trim()))));
  }

  // -------------------------------------------------------------------- Refactor This

  async menu() {
    const c = this.ctx();
    if (!c) return;
    const at = popupPoint(c.ed);
    const sel = c.ed.getSelection();
    const kb = (id) => this.app.kb(id);
    const items = [
      { label: '이름 바꾸기…', icon: 'edit', key: kb('editor.action.rename'), action: () => this.app.editorAction('editor.action.rename') },
      { label: '메서드 추출…', icon: 'symbol-method', key: kb('papyrus.extractMethod'), disabled: sel.isEmpty(), action: () => this.extractMethod() },
      { label: '시그니처 변경…', icon: 'symbol-parameter', key: kb('papyrus.changeSignature'), action: () => this.changeSignature() },
      { label: '타입 이동…', icon: 'file-symlink-file', key: kb('papyrus.moveType'), action: () => this.moveType() },
      { label: '안전 삭제…', icon: 'trash', key: kb('papyrus.safeDelete'), action: () => this.safeDelete() },
      { label: '인터페이스 추출…', icon: 'symbol-interface', key: kb('papyrus.extractInterface'), action: () => this.extractInterface() },
      { label: '네임스페이스를 폴더에 맞추기', icon: 'symbol-namespace', key: kb('papyrus.adjustNamespaces'), action: () => this.adjustNamespaces([c.path]) },
    ];
    // Roslyn's own refactorings at the caret (introduce variable, inline, convert...)
    let more = [];
    try {
      const acts = await Promise.race([this.codeActions(c.model, sel, ['refactor']), delay(1500).then(() => [])]);
      more = acts.filter((a) => !/extract method|메서드 추출|move type to|형식.*이동/i.test(a.title)).slice(0, 14);
    } catch { /* menu without them */ }
    if (more.length) {
      items.push('-');
      for (const a of more) items.push({ label: a.title, icon: 'lightbulb', disabled: !!a.disabled, action: () => this.runCodeAction(a).catch((e) => this.fail('리팩터링 실패', e)) });
    }
    contextMenu(at.x, at.y, items);
  }

  // -------------------------------------------------------------------- Extract Method

  async extractMethod() {
    const c = this.ctx();
    if (!c) return;
    const sel = c.ed.getSelection();
    if (!sel || sel.isEmpty()) {
      toast({ kind: 'warn', title: '메서드 추출', message: '메서드로 뺄 코드를 먼저 선택하세요.', timeout: 3000 });
      return;
    }
    const isExtract = (a) => /extract method|메서드 추출/i.test(a.title) && !/local function|로컬 함수/i.test(a.title);
    let act = (await this.codeActions(c.model, sel, ['refactor.extract'])).find(isExtract);
    if (!act) act = (await this.codeActions(c.model, sel, null)).find(isExtract);
    if (!act) {
      toast({ kind: 'warn', title: '메서드 추출', message: '이 선택 영역은 메서드로 뺄 수 없어요. 완전한 문장(들)이나 식을 선택하세요.' });
      return;
    }
    const name = await prompt({ title: '메서드 추출', sub: '새 메서드 이름', value: 'NewMethod' });
    if (name == null) return;
    const newName = name.trim();
    if (!IDENT.test(newName)) { toast({ kind: 'warn', title: '메서드 추출', message: `'${newName}'은(는) 메서드 이름으로 쓸 수 없어요.` }); return; }
    try {
      const done = await this.runCodeAction(act);
      // Roslyn names it NewMethod(1, 2...): find it in the edit, then rename it to what was asked
      const texts = JSON.stringify(done.edit || {});
      const gen = (/\b(NewMethod\d*)\b/.exec(texts) || [])[1];
      if (gen && gen !== newName) {
        await delay(150);
        const text = c.model.getValue();
        const re = new RegExp(`[\\w>\\]?]\\s+(${gen})\\s*\\(`, 'g');
        const m = re.exec(text);
        if (m) await this.rename(c.uri, m.index + m[0].indexOf(gen), newName);
      }
      toast({ title: '메서드 추출', message: `'${newName}' 메서드를 만들었어요.`, timeout: 2500 });
    } catch (err) {
      this.fail('메서드 추출 실패', err);
    }
  }

  // -------------------------------------------------------------------- Change Signature

  /** Declaration of the method at the caret (on its name, a call, or anywhere inside it). */
  async findMethodDecl(c) {
    const pos = c.ed.getPosition();
    const text = c.model.getValue();
    const word = c.model.getWordAtPosition(pos);
    if (word) {
      const after = text.slice(c.model.getOffsetAt({ lineNumber: pos.lineNumber, column: word.endColumn }));
      if (/^\s*(<[^()]*>)?\s*\(/.test(after)) {
        const defs = await this.lsp.definitionAt(c.model, pos).catch(() => []);
        const d = defs.find((x) => String(x.uri).startsWith('file:'));
        if (d) {
          const uri = monaco.Uri.parse(d.uri).toString();
          const t = await this.textOf(uri);
          const off = offsetAt(t, d.range.start);
          const sig = parseSignature(t, off);
          if (sig) return { uri, nameOffset: off, sig };
        }
      }
    }
    const lp = cv.toPos(pos);
    const m = innermost((await this.symbols(c.model)).filter((s) => METHOD_KINDS.has(s.kind) && contains(s.range, lp)));
    if (!m) return null;
    const off = offsetAt(text, m.selectionRange.start);
    const sig = parseSignature(text, off);
    return sig ? { uri: c.uri, nameOffset: off, sig } : null;
  }

  async changeSignature() {
    const c = this.ctx();
    if (!c) return;
    let decl;
    try { decl = await this.findMethodDecl(c); } catch (err) { this.fail('시그니처 변경', err); return; }
    if (!decl) {
      toast({ kind: 'warn', title: '시그니처 변경', message: '메서드나 생성자(이름, 호출부, 본문 안)에 커서를 두세요.', timeout: 3500 });
      return;
    }
    // an override must keep its base's signature: change it where it is declared first
    const declText = await this.textOf(decl.uri);
    const lineStart = declText.lastIndexOf('\n', decl.nameOffset) + 1;
    if (/\boverride\b/.test(declText.slice(lineStart, decl.nameOffset))) {
      toast({ kind: 'warn', title: '시그니처 변경', message: '재정의(override) 메서드예요. 부모 클래스의 원래 메서드에서 실행하면 재정의까지 함께 바뀌어요.', timeout: 5000 });
      return;
    }
    const plan = await this.signatureDialog(decl.sig);
    if (!plan) return;
    await this.applySignature(decl, plan);
  }

  signatureDialog(sig) {
    const { body, foot, close, result } = modal({ title: '시그니처 변경', width: 680 });
    const rows = sig.params.map((p, i) => ({ orig: i, mods: p.mods, type: p.type, name: p.name, def: p.def, call: '', attrs: p.attrs }));
    let selected = rows.length ? 0 : -1;
    const ret = el('input.rf-in.mono', { value: sig.ret ? sig.ret.text : '', disabled: sig.isCtor, spellcheck: 'false' });
    const name = el('input.rf-in.mono', { value: sig.name, disabled: sig.isCtor, spellcheck: 'false' });
    const table = el('div.rf-table');
    const preview = el('div.rf-preview');
    const error = el('div.rf-error');
    const ok = el('button.btn.primary', null, '리팩터링');

    const validate = () => {
      const names = new Set();
      for (const r of rows) {
        if (!r.type.trim()) return '타입이 비어 있는 매개변수가 있어요.';
        if (!IDENT.test(r.name.trim())) return `'${r.name}'은(는) 매개변수 이름으로 쓸 수 없어요.`;
        if (names.has(r.name.trim())) return `매개변수 이름 '${r.name}'이(가) 겹쳐요.`;
        names.add(r.name.trim());
      }
      const firstOpt = rows.findIndex((r) => r.def.trim() || /\bparams\b/.test(r.mods));
      if (firstOpt >= 0 && rows.slice(firstOpt).some((r) => !r.def.trim() && !/\bparams\b/.test(r.mods))) return '기본값이 있는 매개변수는 뒤쪽에 와야 해요.';
      const pi = rows.findIndex((r) => /\bparams\b/.test(r.mods));
      if (pi >= 0 && pi !== rows.length - 1) return 'params 매개변수는 마지막이어야 해요.';
      if (!sig.isCtor && (!IDENT.test(name.value.trim()) || !ret.value.trim())) return '메서드 이름과 반환 타입을 확인하세요.';
      return '';
    };
    const update = () => {
      const params = rows.map((r) => paramText({ ...r, mods: r.mods.trim(), type: r.type.trim(), name: r.name.trim(), def: r.def.trim() })).join(', ');
      preview.textContent = sig.isCtor ? `${sig.name}(${params})` : `${ret.value.trim()} ${name.value.trim()}(${params})`;
      const err = validate();
      error.textContent = err;
      ok.disabled = !!err;
    };
    const field = (r, key, placeholder, cls = '') => {
      const inp = el('input.rf-cell' + cls, { value: r[key], placeholder: placeholder || '', spellcheck: 'false' });
      inp.addEventListener('input', () => { r[key] = inp.value; update(); });
      inp.addEventListener('focus', () => { selected = rows.indexOf(r); mark(); });
      return inp;
    };
    const mark = () => table.querySelectorAll('.rf-row').forEach((x, i) => x.classList.toggle('sel', i === selected));
    const render = () => {
      table.replaceChildren(el('div.rf-row.head', null,
        el('span', null, '수식어'), el('span', null, '타입'), el('span', null, '이름'), el('span', null, '기본값'),
        el('span', { title: '새 매개변수: 기존 호출부에 넣을 값' }, '호출부 값')));
      rows.forEach((r) => {
        const row = el('div.rf-row' + (r.orig == null ? '.new' : ''), { onmousedown: () => { selected = rows.indexOf(r); mark(); } },
          field(r, 'mods', 'ref/out/params', '.mono'), field(r, 'type', 'int', '.mono'), field(r, 'name', 'name', '.mono'),
          field(r, 'def', '없음', '.mono'),
          r.orig == null ? field(r, 'call', r.def.trim() ? '(기본값 사용)' : 'default', '.mono') : el('span.rf-dim', null, '기존'));
        table.append(row);
      });
      if (!rows.length) table.append(el('div.rf-empty', null, '매개변수가 없어요. "추가"로 만들 수 있어요.'));
      mark();
      update();
    };
    const move = (d) => {
      const j = selected + d;
      if (selected < 0 || j < 0 || j >= rows.length) return;
      [rows[selected], rows[j]] = [rows[j], rows[selected]];
      selected = j;
      render();
      const inp = table.querySelectorAll('.rf-row:not(.head)')[selected];
      if (inp) inp.querySelector('input').focus();
    };
    const tools = el('div.rf-tools', null,
      el('button.btn.small', { onclick: () => { rows.push({ orig: null, mods: '', type: 'int', name: 'value' + (rows.length + 1), def: '', call: '' }); selected = rows.length - 1; render(); table.querySelectorAll('.rf-row:not(.head)')[selected].querySelector('input:nth-child(2)').select(); } }, icon('add'), '추가'),
      el('button.btn.small', { onclick: () => { if (selected < 0) return; rows.splice(selected, 1); selected = Math.min(selected, rows.length - 1); render(); } }, icon('remove'), '삭제'),
      el('button.btn.small', { title: '위로 (Alt+↑)', onclick: () => move(-1) }, icon('arrow-up')),
      el('button.btn.small', { title: '아래로 (Alt+↓)', onclick: () => move(1) }, icon('arrow-down')));
    table.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); e.stopPropagation(); move(e.key === 'ArrowUp' ? -1 : 1); }
    });
    ret.addEventListener('input', update);
    name.addEventListener('input', update);
    body.replaceChildren(
      sig.isCtor ? null : el('div.rf-line', null, el('label.rf-lab', null, '반환 타입', ret), el('label.rf-lab.grow', null, '이름', name)),
      el('div.rf-sub', null, '매개변수'), table, tools,
      el('div.rf-sub', null, '미리 보기'), preview, error,
      el('div.cd-note', null, icon('info'), el('span', null, '호출부와 재정의(override)도 함께 바뀌어요. 이름만 바꾼 매개변수는 명명된 인수까지 Roslyn이 바꿔요.')));
    ok.onclick = () => {
      if (validate()) return;
      close({
        name: name.value.trim(),
        ret: ret.value.trim(),
        params: rows.map((r) => ({ orig: r.orig, mods: r.mods.trim(), type: r.type.trim(), name: r.name.trim(), def: r.def.trim(), call: (r.call || '').trim(), attrs: r.attrs || '' })),
      });
    };
    foot.replaceChildren(el('button.btn', { onclick: () => close(null) }, '취소'), ok);
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !ok.disabled) { e.preventDefault(); ok.click(); } });
    render();
    const first = table.querySelector('.rf-row:not(.head) input') || name;
    first.focus();
    return result;
  }

  /**
   * 1. method rename and parameter renames go through Roslyn (usages, named arguments);
   * 2. the rest (order, added/removed parameters, types, modifiers, defaults, return type) is
   *    rewritten in the declaration, in every override/implementation and at every call site.
   */
  async applySignature(decl, plan) {
    const { uri, nameOffset } = decl;
    let sig = decl.sig;
    const status = toast({ title: '시그니처 변경', message: '바꾸는 중…', timeout: 0 });
    let calls = 0;
    let decls = 0;
    const skipped = [];
    try {
      // --- renames
      if (!sig.isCtor && plan.name !== sig.name) await this.rename(uri, nameOffset, plan.name);
      for (const p of plan.params) {
        if (p.orig == null) continue;
        sig = parseSignature(await this.textOf(uri), nameOffset);
        const cur = sig && sig.params[p.orig];
        if (cur && cur.name !== p.name) await this.rename(uri, cur.nameOffset, p.name);
      }
      const text = await this.textOf(uri);
      sig = parseSignature(text, nameOffset);
      if (!sig) throw new Error('선언을 다시 찾지 못했어요');
      const methodName = sig.name;
      const structural = plan.params.length !== sig.params.length
        || plan.params.some((p, i) => {
          const o = p.orig == null ? null : sig.params[p.orig];
          return !o || p.orig !== i || o.type !== p.type || o.mods !== p.mods || o.def !== p.def;
        })
        || (!sig.isCtor && sig.ret && sig.ret.text !== plan.ret);
      if (!structural) {
        status.remove();
        toast({ title: '시그니처 변경', message: '이름만 바꿨어요.', timeout: 2500 });
        return;
      }

      // --- where: this declaration, overrides / implementations, calls
      const lp = posAt(text, nameOffset);
      const impls = sig.isCtor ? [] : await this.lsp.implementations(uri, lp).catch(() => []);
      const refs = await this.referencesAt(uri, nameOffset, false);
      const key = (u, o) => `${monaco.Uri.parse(u).toString()}#${o}`;
      const texts = new Map([[uri, text]]);
      const getText = async (u) => { if (!texts.has(u)) texts.set(u, await this.textOf(u)); return texts.get(u); };
      const declKeys = new Set([key(uri, nameOffset)]);
      const targets = [{ uri, offset: nameOffset, isDecl: true, main: true }];
      for (const l of impls) {
        const u = monaco.Uri.parse(l.uri).toString();
        const o = offsetAt(await getText(u), l.range.start);
        if (declKeys.has(key(u, o))) continue;
        declKeys.add(key(u, o));
        targets.push({ uri: u, offset: o, isDecl: true });
      }
      for (const l of refs) {
        const u = monaco.Uri.parse(String(l.uri)).toString();
        const o = offsetAt(await getText(u), l.range.start);
        if (declKeys.has(key(u, o))) continue;
        declKeys.add(key(u, o));
        targets.push({ uri: u, offset: o, isDecl: false });
      }

      const isExt = sig.params[0] && /\bthis\b/.test(sig.params[0].mods);
      const oldIndex = new Map(sig.params.map((p, i) => [p.name, i]));
      const edits = new Map(); // uri -> [{start, end, text}]
      const push = (u, start, end, t) => { if (!edits.has(u)) edits.set(u, []); edits.get(u).push({ start, end, text: t }); };

      for (const t of targets) {
        const tx = await getText(t.uri);
        const word = (/^@?\w+/.exec(tx.slice(t.offset, t.offset + 200)) || [''])[0];
        const okWord = word === methodName || (sig.isCtor && (word === 'base' || word === 'this'));
        if (!okWord) { skipped.push(t); continue; }
        if (t.isDecl) {
          const s = parseSignature(tx, t.offset);
          if (!s) { skipped.push(t); continue; }
          const list = plan.params.map((p) => {
            const own = p.orig != null ? s.params[p.orig] : null;
            // overrides keep their own parameter names
            const nm = t.main || !own ? p.name : own.name;
            return paramText({ ...p, name: nm, attrs: own ? own.attrs : '' }, true);
          }).join(', ');
          push(t.uri, s.open + 1, s.close, list);
          if (!sig.isCtor && s.ret && plan.ret && s.ret.text !== plan.ret) push(t.uri, s.ret.start, s.ret.end, plan.ret);
          decls++;
          continue;
        }
        // call site: Name<T>( args )
        let i = t.offset + word.length;
        while (/\s/.test(tx[i] || '')) i++;
        if (tx[i] === '<') { const g = matchClose(tx, i); if (g > 0) { i = g + 1; while (/\s/.test(tx[i] || '')) i++; } }
        if (tx[i] !== '(') { skipped.push(t); continue; } // method group (AddListener(Foo)): left as is
        const open = i;
        const close = matchClose(tx, open);
        if (close < 0) { skipped.push(t); continue; }
        const inner = tx.slice(open + 1, close);
        const args = inner.trim() ? splitTop(inner).map((a) => a.text.trim()) : [];
        const shift = isExt && /\.\s*$/.test(tx.slice(Math.max(0, t.offset - 60), t.offset)) ? 1 : 0;
        const byOld = new Map();
        let posi = 0;
        for (let k = 0; k < args.length; k++) {
          const named = /^(@?\w+)\s*:(?!:)\s*([\s\S]*)$/.exec(args[k]);
          if (named && oldIndex.has(named[1])) { byOld.set(oldIndex.get(named[1]), args[k].slice(args[k].indexOf(':') + 1).trim()); continue; }
          const idx = posi + shift;
          const op = sig.params[idx];
          if (op && /\bparams\b/.test(op.mods) && idx === sig.params.length - 1) { byOld.set(idx, args.slice(k).join(', ')); break; }
          byOld.set(idx, args[k]);
          posi++;
        }
        const out = [];
        let named = false;
        plan.params.forEach((p, k) => {
          if (shift && k === 0 && p.orig === 0) return; // the extension receiver stays before the dot
          let v = p.orig != null ? byOld.get(p.orig) : (p.call || (p.def ? undefined : 'default'));
          if (v === undefined && p.orig != null && !p.def) v = 'default';
          if (v === undefined) { named = true; return; } // omitted: its default value applies
          out.push(named ? `${p.name}: ${v}` : v);
        });
        push(t.uri, open + 1, close, out.join(', '));
        calls++;
      }

      // --- one workspace edit (overlapping edits, e.g. Foo(Foo(1)), keep the outer one)
      const changes = {};
      for (const [u, list] of edits) {
        const tx = await getText(u);
        list.sort((a, b) => a.start - b.start);
        const kept = [];
        for (const e of list) {
          const last = kept[kept.length - 1];
          if (last && e.start < last.end) { skipped.push({ uri: u, offset: e.start }); continue; }
          kept.push(e);
        }
        changes[u] = kept.map((e) => ({ range: { start: posAt(tx, e.start), end: posAt(tx, e.end) }, newText: e.text }));
      }
      await this.app.editors.applyWorkspaceEdit({ changes });
      status.remove();
      toast({
        kind: skipped.length ? 'warn' : 'info',
        title: '시그니처 변경',
        message: `선언 ${decls}곳, 호출 ${calls}곳을 바꿨어요.` + (skipped.length ? ` ${skipped.length}곳은 직접 확인하세요 (메서드 그룹 참조 등).` : ''),
        timeout: skipped.length ? 8000 : 3500,
      });
    } catch (err) {
      status.remove();
      this.fail('시그니처 변경 실패', err);
    }
  }

  // -------------------------------------------------------------------- Move Type

  async moveType() {
    const c = this.ctx();
    if (!c) return;
    const lp = cv.toPos(c.ed.getPosition());
    const syms = await this.symbols(c.model);
    const isTop = (s) => !s.parent || s.parent.kind === 3 || s.parent.kind === 4; // namespace / package
    const tops = syms.filter((s) => TYPE_KINDS.has(s.kind) && isTop(s));
    let type = innermost(syms.filter((s) => TYPE_KINDS.has(s.kind) && contains(s.range, lp)));
    if (!type && tops.length === 1) type = tops[0];
    if (!type) { toast({ kind: 'warn', title: '타입 이동', message: '옮길 클래스·구조체·인터페이스·열거형에 커서를 두세요.' }); return; }
    if (!isTop(type)) { toast({ kind: 'warn', title: '타입 이동', message: '중첩된 타입은 아직 옮길 수 없어요. 바깥 타입에서 실행하세요.' }); return; }
    const tname = bareName(type.name);
    const text = c.model.getValue();
    const ns = namespaceInfo(text);
    const fileBase = basename(c.path).replace(/\.cs$/i, '');
    const canSplit = tops.length > 1;
    const canRenameFile = !canSplit && fileBase !== tname;
    const dirs = this.projectDirs();

    const { body, foot, close, result } = modal({ title: `타입 이동: ${tname}`, width: 540 });
    const split = el('input', { type: 'checkbox', checked: canSplit });
    const renameFile = el('input', { type: 'checkbox', checked: canRenameFile });
    const folder = el('input.rf-in.mono', { value: relPath(this.app.project, dirname(c.path)), spellcheck: 'false' });
    const list = el('div.rf-dirs');
    const nsIn = el('input.rf-in.mono', { value: ns ? ns.name : '', placeholder: '(전역 네임스페이스)', spellcheck: 'false' });
    const fillDirs = () => {
      const q = folder.value.trim().toLowerCase().replace(/\\/g, '/');
      const hits = dirs.filter((d) => d.rel.toLowerCase().includes(q)).slice(0, 8);
      list.replaceChildren(...hits.map((d) => el('div.rf-dir', { onmousedown: (e) => { e.preventDefault(); folder.value = d.rel; list.replaceChildren(); } }, icon('folder'), d.rel)));
      list.style.display = hits.length && document.activeElement === folder ? '' : 'none';
    };
    folder.addEventListener('input', fillDirs);
    folder.addEventListener('focus', fillDirs);
    folder.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 100));
    const suggest = el('button.btn.small', {
      title: '폴더 경로(와 asmdef의 rootNamespace)로 네임스페이스 만들기',
      onclick: async () => { nsIn.value = await this.namespaceForDir(joinPath(this.app.project, folder.value.trim())); },
    }, icon('wand'), '폴더에 맞추기');

    body.replaceChildren(
      el('div.cd-main', null, fileIcon(basename(c.path), false), el('div.cd-text', null,
        el('div.cd-msg', null, `'${tname}' ${KIND_LABEL[type.kind] || '타입'}`),
        el('div.cd-path', null, relPath(this.app.project, c.path)))),
      canSplit ? el('label.cd-check', null, split, el('span', null, `별도 파일로 분리: ${tname}.cs`)) : null,
      canRenameFile ? el('label.cd-check', null, renameFile, el('span', null, `파일 이름을 ${tname}.cs로 맞추기`)) : null,
      el('div.rf-sub', null, '폴더'), el('div.rf-dirwrap', null, folder, list),
      el('div.rf-sub', null, '네임스페이스'), el('div.rf-line', null, nsIn, suggest),
      el('div.cd-note', null, icon('info'), el('span', null, '.meta 파일과 함께 옮겨서 씬·프리팹의 스크립트 연결(GUID)이 유지돼요. 네임스페이스를 바꾸면 이 타입을 쓰는 파일에 using을 추가해요.')));
    const ok = el('button.btn.primary', {
      onclick: () => close({ split: canSplit && split.checked, renameFile: canRenameFile && renameFile.checked, folder: folder.value.trim(), ns: nsIn.value.trim() }),
    }, '이동');
    foot.replaceChildren(el('button.btn', { onclick: () => close(null) }, '취소'), ok);
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.target !== folder) { e.preventDefault(); ok.click(); } });
    folder.focus();
    folder.select();
    const opt = await result;
    if (!opt) return;
    if (opt.ns && !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(opt.ns)) { toast({ kind: 'warn', title: '타입 이동', message: `'${opt.ns}'은(는) 네임스페이스 이름으로 쓸 수 없어요.` }); return; }
    if (!opt.split && tops.length > 1 && (opt.ns !== (ns ? ns.name : '') || !samePath(joinPath(this.app.project, opt.folder), dirname(c.path)))) {
      toast({ kind: 'warn', title: '타입 이동', message: '이 파일에는 다른 타입도 있어요. 폴더·네임스페이스를 바꾸려면 "별도 파일로 분리"를 켜세요.' });
      return;
    }

    try {
      // users of the type, before anything moves
      const users = new Set((await this.referencesAt(c.uri, offsetAt(text, type.selectionRange.start), false))
        .map((l) => monaco.Uri.parse(String(l.uri)).toString()));
      let path = c.path;

      if (opt.split) path = await this.splitType(c, type, tname, ns);
      else if (opt.renameFile) path = await this.renameFileTo(path, joinPath(dirname(path), tname + '.cs'));

      const oldNs = ns ? ns.name : '';
      if (opt.ns !== oldNs) await this.changeNamespace(path, oldNs, opt.ns, users);

      const target = joinPath(this.app.project, opt.folder);
      if (opt.folder && !samePath(target, dirname(path))) {
        if (!(await ofs.exists(target))) await ofs.createFolder(target);
        await this.app.explorer.moveTo(path, target, { offerNamespace: false }); // the dialog chose the namespace
      }
      this.app.unityRefreshSoon();
      toast({ title: '타입 이동', message: `'${tname}'을(를) 옮겼어요.`, timeout: 3000 });
    } catch (err) {
      this.fail('타입 이동 실패', err);
    }
  }

  projectDirs() {
    const set = new Set();
    for (const f of this.app.fileIndex || []) {
      let d = dirname(f);
      while (d && d.length > this.app.project.length && !set.has(d)) { set.add(d); d = dirname(d); }
    }
    return [...set].map((d) => ({ abs: d, rel: relPath(this.app.project, d).replace(/\\/g, '/') }))
      .filter((d) => /^(Assets|Packages)\b/.test(d.rel)).sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** rootNamespace of the nearest .asmdef (if any) + the folders below it (below Assets/Scripts otherwise). */
  async namespaceForDir(dir) {
    // compare paths in one form ("c:/a/b"): fileIndex, listAllFiles and the project path don't
    // always agree on slashes / drive letter case
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const under = (p, base) => norm(p) === norm(base) || norm(p).startsWith(norm(base) + '/');
    const asmdefs = (this.app.fileIndex || []).filter((f) => /\.asmdef$/i.test(f));
    let best = null;
    for (const a of asmdefs) {
      const ad = dirname(a);
      if (under(dir, ad) && (!best || norm(ad).length > norm(dirname(best)).length)) best = a;
    }
    let root = '';
    let base = joinPath(this.app.project, 'Assets');
    if (best) {
      base = dirname(best);
      try { root = JSON.parse((await ofs.readFile(best)).text || '{}').rootNamespace || ''; } catch { /* none */ }
    }
    // outside Assets / the asmdef: no folder-based name (an absolute path made "C_.Develop.….Assets…")
    if (!under(dir, base)) return null;
    let rel = norm(dir) === norm(base) ? '' : dir.replace(/\\/g, '/').slice(norm(base).length + 1);
    if (!best) rel = rel.replace(/^Scripts(\/|$)/i, '');
    // like Rider: "00.Scripts" -> "_00.Scripts", "TextMesh Pro" -> "TextMesh_Pro"
    const parts = rel.split('/').filter((s) => s && s !== '.' && s !== '..')
      .flatMap((s) => s.split('.')).filter(Boolean)
      .map((s) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1'));
    return [root, ...parts].filter(Boolean).join('.');
  }

  /** Moves the type (with the file's usings and namespace) into <Type>.cs next to the file. */
  async splitType(c, type, tname, ns) {
    const text = c.model.getValue();
    const to = joinPath(dirname(c.path), tname + '.cs');
    if (await ofs.exists(to)) throw new Error(`${tname}.cs 파일이 이미 있어요`);
    const [s, e] = wholeLines(text, offsetAt(text, type.range.start), offsetAt(text, type.range.end));
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const usings = text.slice(0, usingsEnd(text)).trimEnd();
    let typeText = text.slice(s, e).replace(/\s+$/, '');
    let content;
    if (ns && !ns.fileScoped) content = `${usings ? usings + nl + nl : ''}namespace ${ns.name}${nl}{${nl}${typeText}${nl}}${nl}`;
    else if (ns) content = `${usings ? usings + nl + nl : ''}namespace ${ns.name};${nl}${nl}${typeText.replace(/^\s*\n/, '')}${nl}`;
    else { typeText = typeText.replace(/^\s*\n/, ''); content = `${usings ? usings + nl + nl : ''}${typeText}${nl}`; }
    await ofs.createFile(to, content);
    await this.app.editors.applyWorkspaceEdit({ changes: { [c.uri]: [{ range: { start: posAt(text, s), end: posAt(text, e) }, newText: '' }] } });
    const tab = this.app.editors.active;
    if (tab && tab.dirty) await this.app.editors.save(tab);
    await this.app.explorer.refresh([to]);
    return to;
  }

  async renameFileTo(from, to) {
    if (await ofs.exists(to)) throw new Error(`${basename(to)} 파일이 이미 있어요`);
    const tab = this.app.editors.findTab(from);
    if (tab && tab.dirty) await this.app.editors.save(tab);
    await ofs.rename(from, to); // .meta follows
    if (tab) { await this.app.editors.closeTab(tab, { force: true, noHistory: true }); await this.app.editors.open(to); }
    await this.app.explorer.refresh([from, to]);
    return to;
  }

  /**
   * Rewrites the file's namespace (wrap / rename / unwrap) and adds `using New;` where the type is used.
   * `known` (namespaces that exist in the project): the file also gets usings for the old namespace's
   * parents, whose types it could use without one before.
   */
  async changeNamespace(path, oldNs, newNs, users, known) {
    const uri = monaco.Uri.file(path).toString();
    const text = await this.textOf(uri);
    const ns = namespaceInfo(text);
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const indentUnit = /\n\t/.test(text) ? '\t' : '    ';
    let out = text;
    if (ns && newNs) {
      const nameAt = text.indexOf(ns.name, ns.start);
      out = text.slice(0, nameAt) + newNs + text.slice(nameAt + ns.name.length);
    } else if (ns && !newNs) {
      if (ns.fileScoped) {
        const lineEnd = text.indexOf('\n', ns.open);
        out = text.slice(0, ns.start) + text.slice(lineEnd < 0 ? text.length : lineEnd + 1).replace(/^\s*\n/, '');
      } else {
        const inner = text.slice(ns.open + 1, ns.close).replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
        const dedented = inner.split(/\r?\n/).map((l) => (l.startsWith(indentUnit) ? l.slice(indentUnit.length) : l.replace(/^\t/, ''))).join(nl);
        const tailEnd = text.indexOf('\n', ns.close);
        out = text.slice(0, ns.start) + dedented + nl + text.slice(tailEnd < 0 ? text.length : tailEnd + 1);
      }
    } else if (!ns && newNs) {
      const at = usingsEnd(text);
      const head = text.slice(0, at);
      const rest = text.slice(at).replace(/^\s*\n/, '');
      const indented = rest.replace(/\s+$/, '').split(/\r?\n/).map((l) => (l.trim() ? indentUnit + l : l)).join(nl);
      out = `${head}${head && !/\n\s*\n$/.test(head) ? nl : ''}namespace ${newNs}${nl}{${nl}${indented}${nl}}${nl}`;
    }
    // the moved type may use the rest of its old namespace
    if (oldNs && newNs && !newNs.startsWith(oldNs + '.') && newNs !== oldNs) {
      const u = addUsing(out, oldNs);
      if (u) out = out.slice(0, u.at) + u.text + out.slice(u.at);
    }
    if (known && oldNs && newNs !== oldNs) {
      const parts = oldNs.split('.');
      for (let k = parts.length - 1; k >= 1; k--) {
        const p = parts.slice(0, k).join('.');
        if (!(known.declared || known).has(p) || newNs === p || newNs.startsWith(p + '.')) continue;
        const u = addUsing(out, p);
        if (u) out = out.slice(0, u.at) + u.text + out.slice(u.at);
      }
    }
    const edits = {};
    if (out !== text) edits[uri] = [{ range: { start: { line: 0, character: 0 }, end: posAt(text, text.length) }, newText: out }];
    if (newNs) {
      for (const u of users) {
        if (u === uri) continue;
        const t = await this.textOf(u);
        const theirs = namespaceInfo(t);
        if (theirs && (theirs.name === newNs || theirs.name.startsWith(newNs + '.'))) continue;
        const add = addUsing(t, newNs);
        if (add) edits[u] = [{ range: { start: posAt(t, add.at), end: posAt(t, add.at) }, newText: add.text }];
      }
    }
    if (Object.keys(edits).length) await this.app.editors.applyWorkspaceEdit({ changes: edits });
    const tab = this.app.editors.findTab(path);
    if (tab && tab.dirty) await this.app.editors.save(tab);
  }

  // -------------------------------------------------------------------- Extract Interface

  async extractInterface() {
    const c = this.ctx();
    if (!c) return;
    const lp = cv.toPos(c.ed.getPosition());
    const syms = await this.symbols(c.model);
    const isClass = (s) => s.kind === 5 || s.kind === 23;
    let type = innermost(syms.filter((s) => isClass(s) && contains(s.range, lp)));
    if (!type && syms.filter(isClass).length === 1) type = syms.find(isClass);
    if (!type) { toast({ kind: 'warn', title: '인터페이스 추출', message: '클래스나 구조체 안에 커서를 두세요.' }); return; }
    const text = c.model.getValue();
    const m = maskCode(text);
    const tname = bareName(type.name);
    const head = typeHeader(text, m, offsetAt(text, type.selectionRange.start), offsetAt(text, type.selectionRange.end));
    const members = syms.filter((s) => s.parent === type && (s.kind === 6 || s.kind === 7 || s.kind === 24))
      .map((s) => interfaceMember(text, m, offsetAt(text, s.selectionRange.start), s))
      .filter(Boolean);
    if (!members.length) { toast({ kind: 'warn', title: '인터페이스 추출', message: `'${tname}'에 인터페이스로 뺄 public 메서드·속성·이벤트가 없어요.` }); return; }

    const { body, foot, close, result } = modal({ title: `인터페이스 추출: ${tname}`, width: 560 });
    const nameIn = el('input.rf-in.mono', { value: `I${tname}`, spellcheck: 'false' });
    const checks = members.map((mb) => ({ mb, box: el('input', { type: 'checkbox', checked: true }) }));
    const where = el('select.rf-in', null,
      el('option', { value: 'file' }, '새 파일 (같은 폴더)'), el('option', { value: 'same' }, `같은 파일 ('${tname}' 위)`));
    const preview = el('pre.rf-preview', { style: { maxHeight: '160px', overflow: 'auto', whiteSpace: 'pre', wordBreak: 'normal', margin: 0 } });
    const err = el('div.rf-error');
    const ok = el('button.btn.primary', null, '추출');
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const unit = /\n\t/.test(text) ? '\t' : '    ';
    const build = (name, indent) => {
      const picked = checks.filter((x) => x.box.checked).map((x) => x.mb);
      const lines = picked.map((mb) => indent + unit + mb.sig);
      return `${indent}${head.isPublic ? 'public ' : ''}interface ${name}${head.typeParams}${head.where ? ' ' + head.where : ''}${nl}${indent}{${nl}${lines.join(nl)}${nl}${indent}}`;
    };
    const refresh = () => {
      const name = nameIn.value.trim();
      const bad = !IDENT.test(name) ? '인터페이스 이름으로 쓸 수 없어요.'
        : !checks.some((x) => x.box.checked) ? '멤버를 하나 이상 고르세요.'
          : syms.some((s) => s.parent == null && bareName(s.name) === name) ? `'${name}'이(가) 이 파일에 이미 있어요.` : '';
      err.textContent = bad;
      ok.disabled = !!bad;
      preview.textContent = build(name || 'I', '');
    };
    nameIn.addEventListener('input', refresh);
    const all = el('input', { type: 'checkbox', checked: true, onchange: () => { checks.forEach((x) => { x.box.checked = all.checked; }); refresh(); } });
    body.replaceChildren(
      el('div.rf-line', null, el('label.rf-lab.grow', null, '인터페이스 이름', nameIn), el('label.rf-lab', null, '위치', where)),
      el('div.rf-sub', null, '멤버 (public)'),
      el('div.rf-table', { style: { padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: '6px' } },
        el('label.cd-check', null, all, el('span', null, '전체')),
        ...checks.map((x) => {
          x.box.addEventListener('change', refresh);
          return el('label.cd-check', null, x.box, icon(x.mb.icon), el('span.mono', null, x.mb.sig));
        })),
      el('div.rf-sub', null, '미리보기'), preview, err,
      el('div.cd-note', null, icon('info'), el('span', null, `'${tname}'의 상속 목록에 인터페이스를 추가해요. 필드는 인터페이스에 넣을 수 없어서 목록에 없어요.`)));
    ok.onclick = () => close({ name: nameIn.value.trim(), where: where.value });
    foot.replaceChildren(el('button.btn', { onclick: () => close(null) }, '취소'), ok);
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !ok.disabled) { e.preventDefault(); ok.click(); } });
    refresh();
    nameIn.focus();
    nameIn.select();
    const opt = await result;
    if (!opt) return;

    try {
      const ref = `${opt.name}${head.typeArgs}`;
      const baseEdit = head.hasBase
        ? { range: { start: posAt(text, head.baseEnd), end: posAt(text, head.baseEnd) }, newText: `, ${ref}` }
        : { range: { start: posAt(text, head.afterName), end: posAt(text, head.afterName) }, newText: ` : ${ref}` };
      if (opt.where === 'same') {
        const decl = head.start + Math.max(0, m.slice(head.start).search(/\S/)); // attributes / modifiers
        const [s] = wholeLines(text, decl, decl);
        const indent = /^[ \t]*/.exec(text.slice(s))[0];
        const iface = build(opt.name, indent);
        await this.app.editors.applyWorkspaceEdit({ changes: { [c.uri]: [
          { range: { start: posAt(text, s), end: posAt(text, s) }, newText: iface + nl + nl },
          baseEdit,
        ] } });
      } else {
        const to = joinPath(dirname(c.path), opt.name + '.cs');
        if (await ofs.exists(to)) throw new Error(`${opt.name}.cs 파일이 이미 있어요`);
        const ns = namespaceInfo(text);
        const usings = text.slice(0, usingsEnd(text)).trimEnd();
        const pre = usings ? usings + nl + nl : '';
        let content;
        if (ns && !ns.fileScoped) content = `${pre}namespace ${ns.name}${nl}{${nl}${build(opt.name, unit)}${nl}}${nl}`;
        else if (ns) content = `${pre}namespace ${ns.name};${nl}${nl}${build(opt.name, '')}${nl}`;
        else content = `${pre}${build(opt.name, '')}${nl}`;
        await ofs.createFile(to, content);
        await this.app.editors.applyWorkspaceEdit({ changes: { [c.uri]: [baseEdit] } });
        await this.app.explorer.refresh([to]);
        toast({ title: '인터페이스 추출', message: `${relPath(this.app.project, to)}을(를) 만들었어요.`, actions: [{ label: '열기', action: () => this.app.editors.open(to) }], timeout: 5000 });
      }
      const tab = this.app.editors.findTab(c.path);
      if (tab && tab.dirty) await this.app.editors.save(tab);
      this.app.unityRefreshSoon();
    } catch (e) {
      this.fail('인터페이스 추출 실패', e);
    }
  }

  // -------------------------------------------------------------------- Namespace = folder

  /**
   * Namespace for a new script in `dir`: when the scripts around follow the folder convention
   * (Rider's "_00_WorkFolder.PAP._02_Scripts.UI"), the folder namespace; when the folder's scripts
   * share another namespace, that one; when they have none, none. undefined = nothing to go by.
   */
  async suggestNamespace(dir) {
    let d = dir;
    for (let k = 0; k < 6 && d && d.length >= this.app.project.length; k++) {
      const sibs = (this.app.fileIndex || []).filter((f) => /\.cs$/i.test(f) && samePath(dirname(f), d)).slice(0, 8);
      if (sibs.length) {
        const conv = await this.namespaceForDir(d);
        let none = 0;
        const other = new Map();
        for (const f of sibs) {
          const ns = namespaceInfo(await this.textOf(monaco.Uri.file(f).toString()));
          if (!ns) none++;
          else if (ns.name === conv) return (await this.namespaceForDir(dir)) ?? undefined;
          else other.set(ns.name, (other.get(ns.name) || 0) + 1);
        }
        if (none === sibs.length) return '';
        if (samePath(d, dir) && other.size) return [...other].sort((a, b) => b[1] - a[1])[0][0];
        return undefined;
      }
      d = dirname(d);
    }
    return undefined;
  }

  /** Namespaces declared by the project's scripts, with their parents ("A.B.C" -> A, A.B, A.B.C). */
  async projectNamespaces(overrides = new Map()) {
    const files = (this.app.fileIndex || []).filter((f) => /\.cs$/i.test(f));
    const set = new Set(); // with parents: what `using X;` can name
    set.declared = new Set(); // declared by some file (has types)
    const add = (n) => { set.declared.add(n); const p = n.split('.'); for (let k = 1; k <= p.length; k++) set.add(p.slice(0, k).join('.')); };
    for (let i = 0; i < files.length; i += 48) {
      await Promise.all(files.slice(i, i + 48).map(async (f) => {
        const key = f.toLowerCase();
        if (overrides.has(key)) { if (overrides.get(key)) add(overrides.get(key)); return; }
        const t = await this.textOf(monaco.Uri.file(f).toString());
        for (const mm of t.matchAll(/^[ \t]*namespace\s+([\w.]+)/gm)) add(mm[1]);
      }));
    }
    return set;
  }

  /** Rider's "Adjust Namespaces": each script's namespace follows its folder, usings follow the types. */
  async adjustNamespaces(paths, { title = '네임스페이스를 폴더에 맞추기', tickAll = paths.length === 1 } = {}) {
    if (!this.lsp.running) {
      toast({ kind: 'warn', title, message: 'C# 언어 서버가 준비된 뒤에 다시 시도하세요. (사용처에 using을 추가하려면 필요해요)', timeout: 4000 });
      return;
    }
    const plan = [];
    let skipped = 0;
    for (const path of paths.filter((p) => /\.cs$/i.test(p))) {
      // store assets / plugins keep their own namespaces (Feel, Text Animator, DOTween...): never touched
      if (isThirdPartyPath(relPath(this.app.project, path))) { skipped++; continue; }
      const text = await this.textOf(monaco.Uri.file(path).toString());
      const types = topLevelTypes(text);
      if (!types.length || (text.match(/^[ \t]*namespace\s/gm) || []).length > 1) continue;
      const ns = namespaceInfo(text);
      const oldNs = ns ? ns.name : '';
      const newNs = await this.namespaceForDir(dirname(path));
      if (newNs == null || oldNs === newNs) continue;
      // a whole folder at once: a script that already has a namespace ("MoreMountains.Feedbacks" in
      // Assets/Feel/...) is listed but not ticked; it's most likely an asset store library's
      const foreign = !tickAll && !!oldNs;
      plan.push({ path, text, types, oldNs, newNs, foreign, box: el('input', { type: 'checkbox', checked: !foreign }) });
    }
    plan.sort((a, b) => a.foreign - b.foreign);
    if (!plan.length) {
      toast({ title, message: `모든 스크립트의 네임스페이스가 이미 폴더와 맞아요.${skipped ? ` (플러그인·외부 에셋 ${skipped}개는 건너뜀)` : ''}`, timeout: 3000 });
      return;
    }

    const { body, foot, close, result } = modal({ title, width: 640 });
    body.replaceChildren(
      el('div.rf-table', { style: { padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '320px' } },
        ...plan.map((p) => el('label.cd-check', { style: { alignItems: 'flex-start' } }, p.box, el('span', null,
          el('div', null, relPath(this.app.project, p.path)),
          el('div.mono', { style: { fontSize: '11.5px', color: 'var(--fg-dim)' } }, `${p.oldNs || '(전역)'}  →  ${p.newNs || '(전역)'}`),
          p.foreign ? el('div', { style: { fontSize: '11.5px', color: 'var(--warn-text, #d7a84a)' } }, '이미 네임스페이스가 있어서 기본으로 선택하지 않았어요 (외부 에셋일 수 있어요)') : null)))),
      el('div.cd-note', null, icon('info'), el('span', null, `폴더 경로(와 asmdef의 rootNamespace)로 네임스페이스를 정해요. 이 타입들을 쓰는 파일에는 using을 추가하고, 더는 없는 네임스페이스의 using은 지워요.${skipped ? ` Plugins·외부 에셋 폴더의 스크립트 ${skipped}개는 건너뛰었어요.` : ''}`)));
    const ok = el('button.btn.primary', { onclick: () => close(true) }, `바꾸기 (${plan.filter((x) => x.box.checked).length})`);
    const recount = () => { ok.textContent = `바꾸기 (${plan.filter((x) => x.box.checked).length})`; ok.disabled = !plan.some((x) => x.box.checked); };
    plan.forEach((p) => p.box.addEventListener('change', recount));
    recount();
    const all = el('button.btn', { style: { marginRight: 'auto' }, onclick: () => { const on = !plan.every((x) => x.box.checked); plan.forEach((x) => { x.box.checked = on; }); recount(); } }, '모두 선택/해제');
    foot.replaceChildren(...(plan.length > 1 ? [all] : []), el('button.btn', { onclick: () => close(null) }, '취소'), ok);
    ok.focus();
    if (!(await result)) return;
    const todo = plan.filter((p) => p.box.checked);
    if (!todo.length) return;

    try {
      const before = await this.projectNamespaces();
      const touched = new Set();
      for (const p of todo) {
        const uri = monaco.Uri.file(p.path).toString();
        // re-read: an earlier script of this run may have added a using here, and the old text's
        // offsets then pointed at another symbol (whose usages all got a wrong using)
        const text = await this.textOf(uri);
        const types = topLevelTypes(text);
        const users = new Set();
        for (const t of types) {
          const off = typeNameOffset(text, t);
          if (off < 0) continue;
          const name = text.slice(off).match(/^\w+/)?.[0];
          const word = name ? new RegExp(`\\b${name}\\b`) : null;
          for (const l of await this.referencesAt(uri, off, false)) {
            const u = monaco.Uri.parse(String(l.uri)).toString();
            // only files that really name the type get a using
            if (word && u !== uri && !word.test(await this.textOf(u))) continue;
            users.add(u);
          }
        }
        users.forEach((u) => touched.add(u));
        await this.changeNamespace(p.path, p.oldNs, p.newNs, [...users], before);
      }
      // `using Old;` where Old is gone now doesn't compile (CS0246): drop it
      const after = await this.projectNamespaces(new Map(todo.map((p) => [p.path.toLowerCase(), p.newNs])));
      const gone = [...new Set(todo.map((p) => p.oldNs).filter(Boolean))].filter((n) => before.has(n) && !after.has(n));
      if (gone.length) {
        const re = new RegExp(`^[ \\t]*using\\s+(?:${gone.map((g) => g.replace(/\./g, '\\.')).join('|')})\\s*;[ \\t]*\\r?\\n`, 'gm');
        const edits = {};
        for (const f of (this.app.fileIndex || []).filter((x) => /\.cs$/i.test(x))) {
          const u = monaco.Uri.file(f).toString();
          const t = await this.textOf(u);
          const hits = [...t.matchAll(re)];
          if (hits.length) edits[u] = hits.map((h) => ({ range: { start: posAt(t, h.index), end: posAt(t, h.index + h[0].length) }, newText: '' }));
        }
        if (Object.keys(edits).length) await this.app.editors.applyWorkspaceEdit({ changes: edits });
      }
      for (const t of this.app.editors.tabs || []) if (t.dirty && t.path && /\.cs$/i.test(t.path)) await this.app.editors.save(t);
      this.app.unityRefreshSoon();
      toast({ title, message: `스크립트 ${todo.length}개의 네임스페이스를 바꿨어요${touched.size ? `, 사용하는 파일 ${touched.size}개 확인` : ''}.`, timeout: 4000 });
    } catch (e) {
      this.fail(`${title} 실패`, e);
    }
  }

  /** "Adjust Namespaces" for the open script. */
  adjustCurrentNamespace() {
    const c = this.ctx();
    if (c) this.adjustNamespaces([c.path]);
  }

  // -------------------------------------------------------------------- Safe Delete

  async safeDelete() {
    const c = this.ctx();
    if (!c) return;
    const pos = c.ed.getPosition();
    const lp = cv.toPos(pos);
    const text = c.model.getValue();
    const caret = c.model.getOffsetAt(pos);
    const syms = await this.symbols(c.model);

    // a parameter: remove it from the signature (and every call)
    const method = innermost(syms.filter((s) => METHOD_KINDS.has(s.kind) && contains(s.range, lp)));
    if (method) {
      const off = offsetAt(text, method.selectionRange.start);
      const sig = parseSignature(text, off);
      if (sig && caret > sig.open && caret <= sig.close) {
        const idx = topCommas(text.slice(sig.open + 1, caret));
        if (idx < sig.params.length) return this.safeDeleteParam(c, { uri: c.uri, nameOffset: off, sig }, idx);
      }
    }

    const onName = syms.filter((s) => contains(s.selectionRange, lp));
    const s = onName[onName.length - 1] || innermost(syms.filter((x) => x.kind !== 3 && x.kind !== 4 && contains(x.range, lp)));
    if (!s) { toast({ kind: 'warn', title: '안전 삭제', message: '지울 선언(클래스·메서드·필드·속성…)에 커서를 두세요.' }); return; }
    const isTop = !s.parent || s.parent.kind === 3 || s.parent.kind === 4;
    if (TYPE_KINDS.has(s.kind) && isTop && syms.filter((x) => TYPE_KINDS.has(x.kind) && (!x.parent || x.parent.kind === 3)).length === 1) {
      return this.app.explorer.remove(c.path); // the file's only type: delete the file (with its usages check)
    }
    const name = bareName(s.name);
    const nameOff = offsetAt(text, s.selectionRange.start);
    const refs = await this.referencesAt(c.uri, nameOff, false);
    const impls = METHOD_KINDS.has(s.kind) || s.kind === 7 ? await this.lsp.implementations(c.uri, s.selectionRange.start).catch(() => []) : [];
    const [rs, start, end] = [await this.rows([...refs, ...impls]), ...this.declarationRange(text, s)];
    const ok = await this.confirmUsages({
      title: '안전 삭제',
      what: `'${name}' ${KIND_LABEL[s.kind] || '선언'}을(를) 삭제할까요?`,
      rows: rs,
      warn: impls.length ? `재정의·구현 ${impls.length}곳 포함` : '',
    });
    if (!ok) return;
    await this.app.editors.applyWorkspaceEdit({ changes: { [c.uri]: [{ range: { start: posAt(text, start), end: posAt(text, end) }, newText: '' }] } });
  }

  async safeDeleteParam(c, decl, idx) {
    const p = decl.sig.params[idx];
    const used = (await this.referencesAt(decl.uri, p.nameOffset, false));
    const ok = await this.confirmUsages({
      title: '안전 삭제',
      what: `매개변수 '${p.name}'을(를) 지울까요? 모든 호출부에서 해당 인수도 빠져요.`,
      rows: await this.rows(used),
      usedLabel: `메서드 본문에서 '${p.name}'을(를) ${used.length}곳 쓰고 있어요`,
    });
    if (!ok) return;
    const params = decl.sig.params.map((q, i) => ({ orig: i, mods: q.mods, type: q.type, name: q.name, def: q.def, call: '', attrs: q.attrs }))
      .filter((_, i) => i !== idx);
    await this.applySignature(decl, { name: decl.sig.name, ret: decl.sig.ret ? decl.sig.ret.text : '', params });
  }

  /** Offsets to remove for a member: whole lines, or one declarator of `int a, b;`. */
  declarationRange(text, s) {
    let start = offsetAt(text, s.range.start);
    let end = offsetAt(text, s.range.end);
    if (s.kind === 8 || s.kind === 14 || s.kind === 24) { // field / constant / event field
      let st = start;
      while (st > 0 && !/[;{}]/.test(text[st - 1])) st--;
      while (/\s/.test(text[st])) st++;
      let en = end;
      for (; en < text.length; en++) {
        const k = skipLiteral(text, en);
        if (k >= 0) { en = k - 1; continue; }
        if (text[en] === ';') { en++; break; }
        if (text[en] === '{' || text[en] === '}') break;
      }
      const stmt = text.slice(st, en);
      const declarators = splitTop(stmt.replace(/;\s*$/, '')).length;
      if (declarators > 1) {
        // only "b = 2" (and one comma) out of "int a = 1, b = 2;"
        let e2 = end;
        while (/\s/.test(text[e2])) e2++;
        if (text[e2] === ',') { e2++; while (text[e2] === ' ') e2++; return [start, e2]; }
        let s2 = start;
        while (s2 > 0 && /\s/.test(text[s2 - 1])) s2--;
        if (text[s2 - 1] === ',') s2--;
        return [s2, end];
      }
      start = st;
      end = en;
    } else if (s.kind === 22) { // enum member: take its comma too
      let e2 = end;
      while (/[ \t]/.test(text[e2])) e2++;
      if (text[e2] === ',') end = e2 + 1;
    }
    return wholeLines(text, start, end);
  }

  confirmUsages({ title, what, rows, warn, usedLabel }) {
    const { body, foot, close, result } = modal({ title, width: 500 });
    const kids = [el('div.cd-msg', null, what)];
    if (rows.length) {
      const files = new Set(rows.map((r) => r.path.toLowerCase())).size;
      kids.push(el('div.cd-warn', null, icon('warning'), el('div', null,
        el('div.cd-msg', null, usedLabel || `사용하는 곳이 ${rows.length}곳 있어요`),
        el('div.cd-sub', null, `파일 ${files}개${warn ? ' · ' + warn : ''} · 지우면 이 코드는 컴파일되지 않아요.`))));
      kids.push(this.usageList(rows, close));
    } else {
      kids.push(el('div.cd-note', null, icon('pass'), el('span', null, '사용하는 곳이 없어요. 안전하게 지울 수 있어요.')));
    }
    body.replaceChildren(...kids);
    const cancel = el('button.btn', { onclick: () => close(false) }, '취소');
    const del = el(rows.length ? 'button.btn.danger' : 'button.btn.primary', { onclick: () => close(true) }, rows.length ? '그래도 삭제' : '삭제');
    foot.replaceChildren(cancel, del);
    (rows.length ? cancel : del).focus();
    return result.then((v) => !!v);
  }
}
