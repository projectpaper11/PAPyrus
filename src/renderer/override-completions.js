// Completion while renaming an override: in `public override void OnSta|(StatusContext ctx)`
// Roslyn treats the name as a declaration and suggests nothing (its override list only appears
// right after `override ` on a fresh line). Here the base classes' virtual / abstract / override
// methods are read from their source and offered; picking one replaces the name and parameter
// list, and fixes the return type and access modifier when they differ from the base method.
//
// Base classes are found through the open tabs, the file index (Unity: class name = file name)
// and then Roslyn's workspace/symbol. Classes without source (MonoBehaviour, ...) are skipped.
import { monaco } from './monaco.js';

const CACHE_MS = 5000;
const MAX_DEPTH = 8;
const cache = new Map(); // base type -> { at, members }

/** Index just past the brace that closes the one at `open`, skipping comments, strings and chars. */
function matchBrace(text, open) {
  let depth = 0;
  const n = text.length;
  for (let i = open; i < n; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); if (e < 0) return n; i = e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return n; i = e + 1; continue; }
    if (c === '"' || c === "'") {
      const verbatim = c === '"' && (text[i - 1] === '@' || (text[i - 1] === '$' && text[i - 2] === '@'));
      for (i++; i < n; i++) {
        if (!verbatim && text[i] === '\\') { i++; continue; }
        if (text[i] === c) { if (verbatim && text[i + 1] === '"') { i++; continue; } break; }
        if (!verbatim && text[i] === '\n') break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return n;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bare = (t) => (t || '').replace(/<.*$/s, '').split('.').pop();

/** Every class/record/struct declaration: { name, base, start (body '{'), end }. */
function classes(text) {
  const re = /\b(?:class|record|struct)\s+(\w+)\s*(?:<[^>{]*>)?\s*(?::\s*([\w.]+)(?:\s*<[^{]*?>)?)?[^{;]*\{/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length - 1;
    out.push({ name: m[1], base: m[2] || '', start, end: matchBrace(text, start) });
  }
  return out;
}

/** virtual / abstract / (non-sealed) override methods declared in a class body. */
function overridable(body, owner) {
  const re = /((?:\b(?:public|protected|internal|private)\s+){1,2})((?:\w+\s+)*?)\b(virtual|abstract|override)\s+((?:\w+\s+)*?)([\w.]+(?:\s*<[^()]*?>)?(?:\[\])*\??)\s+(\w+)\s*(<[^()]*?>)?\s*\(([^)]*)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(body))) {
    if (/\b(sealed|static)\b/.test(m[2] + m[4])) continue;
    out.push({
      access: m[1].trim().replace(/\s+/g, ' '),
      ret: m[5].replace(/\s+/g, ''),
      name: m[6],
      generic: m[7] || '',
      params: m[8].replace(/\s+/g, ' ').trim(),
      owner,
    });
  }
  return out;
}

const signature = (x) => `${x.name}/${x.params ? x.params.split(',').length : 0}`;

export function registerOverrideCompletion(app) {
  const readFile = async (path) => {
    const tab = app.editors.findTab(path);
    if (tab && tab.model) return tab.model.getValue();
    try { return (await window.papyrus.fs.readFile(path)).text || ''; } catch { return ''; }
  };

  /** Source text that declares class `name`, or ''. */
  async function sourceOf(name) {
    const declares = new RegExp(`\\b(?:class|record)\\s+${esc(name)}\\b`);
    for (const m of monaco.editor.getModels()) {
      if (m.getLanguageId() === 'csharp' && declares.test(m.getValue())) return m.getValue();
    }
    const want = ('\\' + name + '.cs').toLowerCase();
    for (const f of app.fileIndex || []) {
      if (!f.replace(/\//g, '\\').toLowerCase().endsWith(want)) continue;
      const t = await readFile(f);
      if (declares.test(t)) return t;
    }
    const lsp = app.lsp;
    if (!lsp || !lsp.running) return '';
    let res = null;
    try { res = await lsp.request('workspace/symbol', { query: name }); } catch { return ''; }
    for (const s of res || []) {
      if (s.name !== name || !s.location || !s.location.uri || !s.location.uri.startsWith('file:')) continue;
      const t = await readFile(monaco.Uri.parse(s.location.uri).fsPath);
      if (declares.test(t)) return t;
    }
    return '';
  }

  /** Overridable methods of `name` and its ancestors, most derived first. */
  async function membersOf(name, seen = new Set(), depth = 0) {
    name = bare(name);
    if (!name || depth > MAX_DEPTH || seen.has(name)) return [];
    seen.add(name);
    const hit = cache.get(name);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.members;
    const text = await sourceOf(name);
    const cls = text ? classes(text).find((c) => c.name === name) : null;
    let members = [];
    if (cls) {
      const own = overridable(text.slice(cls.start, cls.end), name);
      const inherited = await membersOf(cls.base, seen, depth + 1);
      const keys = new Set(own.map(signature));
      members = [...own, ...inherited.filter((x) => !keys.has(signature(x)))];
    }
    cache.set(name, { at: Date.now(), members });
    return members;
  }

  monaco.languages.registerCompletionItemProvider('csharp', {
    async provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const word = model.getWordUntilPosition(position);
      const before = line.slice(0, word.startColumn - 1);
      // `override [modifiers] [ReturnType] ` right before the name being typed
      const m = /\boverride\s+(?:(?:async|unsafe|new)\s+)*(?:([\w.]+(?:<[^()]*>)?(?:\[\])*\??)\s+)?$/.exec(before);
      if (!m) return { suggestions: [] };
      // ...and an existing parameter list after it (renaming); a fresh `override ` is Roslyn's job
      const rest = line.slice(position.column - 1);
      const tail = /^\w*\s*(?:<[^()]*>)?\s*\(/.exec(rest);
      if (!tail) return { suggestions: [] };
      let depth = 0;
      let close = -1;
      for (let i = tail[0].length - 1; i < rest.length; i++) {
        if (rest[i] === '(') depth++;
        else if (rest[i] === ')' && --depth === 0) { close = i; break; }
      }
      if (close < 0) return { suggestions: [] };

      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const own = classes(text).filter((c) => c.start < offset && offset < c.end).sort((a, b) => b.start - a.start)[0];
      if (!own || !own.base) return { suggestions: [] };
      const members = await membersOf(own.base);
      if (!members.length) return { suggestions: [] };
      // already overridden in this class (the method being renamed has a half-typed name, so it stays)
      const taken = new Set(overridable(text.slice(own.start, own.end), own.name).map(signature));

      const L = monaco.languages;
      const ln = position.lineNumber;
      const range = new monaco.Range(ln, word.startColumn, ln, position.column + close + 1);
      const ret = m[1];
      const trailing = m[0].length - m[0].trimEnd().length;
      const retCol = ret ? m.index + m[0].length - trailing - ret.length + 1 : 0;
      const acc = /^(\s*)((?:(?:public|protected|internal|private)\s+){1,2})/.exec(line);
      return {
        suggestions: members.filter((x) => !taken.has(signature(x))).map((x) => {
          const edits = [];
          if (ret && ret.replace(/\s+/g, '') !== x.ret) edits.push({ range: new monaco.Range(ln, retCol, ln, retCol + ret.length), text: x.ret });
          if (acc && acc[2].trim().replace(/\s+/g, ' ') !== x.access) {
            const c = acc[1].length + 1;
            edits.push({ range: new monaco.Range(ln, c, ln, c + acc[2].length), text: x.access + ' ' });
          }
          return {
            label: { label: x.name, detail: `(${x.params})`, description: `${x.ret} · ${x.owner}` },
            kind: L.CompletionItemKind.Method,
            filterText: x.name,
            detail: `${x.access} override ${x.ret} ${x.name}${x.generic}(${x.params})`,
            insertText: (ret ? '' : x.ret + ' ') + x.name + x.generic + '(' + x.params + ')',
            range,
            additionalTextEdits: edits.length ? edits : undefined,
            sortText: '0',
          };
        }),
      };
    },
  });
}
