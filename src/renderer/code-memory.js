// Learned completions that sit next to Roslyn's symbol completions:
//   1. Lines you type are remembered across sessions (localStorage); the more often a line is
//      typed or picked, the higher it ranks. Typing the first word of such a line offers the rest.
//   2. Lines that repeat in the open files are offered the same way, so copy-pasted patterns
//      complete even before they've been learned.
//   3. Words from the open files and from what you've typed: in every language, and in C#
//      while the language server is still loading (Roslyn covers symbols once it's ready).
//   4. Built-in Unity C# snippets; the ones you pick move up.
import { monaco } from './monaco.js';

const STORE_KEY = 'papyrus.codeMemory.v1';
const MAX_LINES = 4000;
const MAX_WORDS = 6000;
const MIN_LINE_LEN = 6;
const MAX_LINE_LEN = 200;
const MIN_LINE_PREFIX = 3; // characters of the first word before whole-line suggestions show
const MIN_WORD_PREFIX = 2;
const MAX_LINE_ITEMS = 6;
const MAX_WORD_ITEMS = 30;
const MIN_FILE_REPEATS = 2; // a line must appear this often in open files to count as "repeated"
const MAX_PASTE_LINES = 20; // bigger multi-line inserts are pastes/formatting: don't learn them
const SAVE_DELAY_MS = 2000;
const SCAN_TTL_MS = 1500; // reuse the open-file index for this long instead of rescanning on every key
const USED_COMMAND = 'papyrus.codeMemory.used';

const WORD_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const ONLY_PUNCT_RE = /^[\s{}()[\];,.]*$/;
// A line ending like this continues on the next line (`Foo(a,`, `x =`, `a &&`, `=>`): it's a
// fragment, and offering it as a whole line would insert a cut-off statement.
const CONTINUES_RE = /(?:[,(\[+\-*/%=&|.?:!<^~]|=>)$/;
const CLOSERS_RE = /^[\s)\]}"';]*$/;

// Unity C# snippets. `line: true` = only offered as the first word on a line.
const SNIPPETS = [
  { key: 'sf', title: '[SerializeField] 필드', body: '[SerializeField] private ${1:float} ${2:value};', line: true },
  { key: 'sfh', title: '[Header] + [SerializeField] 필드', body: '[Header("${1:Settings}")]\n[SerializeField] private ${2:float} ${3:value};', line: true },
  { key: 'awake', title: 'Awake()', body: 'private void Awake()\n{\n\t$0\n}', line: true },
  { key: 'start', title: 'Start()', body: 'private void Start()\n{\n\t$0\n}', line: true },
  { key: 'update', title: 'Update()', body: 'private void Update()\n{\n\t$0\n}', line: true },
  { key: 'fixedupdate', title: 'FixedUpdate()', body: 'private void FixedUpdate()\n{\n\t$0\n}', line: true },
  { key: 'lateupdate', title: 'LateUpdate()', body: 'private void LateUpdate()\n{\n\t$0\n}', line: true },
  { key: 'onenable', title: 'OnEnable()', body: 'private void OnEnable()\n{\n\t$0\n}', line: true },
  { key: 'ondisable', title: 'OnDisable()', body: 'private void OnDisable()\n{\n\t$0\n}', line: true },
  { key: 'ondestroy', title: 'OnDestroy()', body: 'private void OnDestroy()\n{\n\t$0\n}', line: true },
  { key: 'ontriggerenter2d', title: 'OnTriggerEnter2D()', body: 'private void OnTriggerEnter2D(Collider2D other)\n{\n\t$0\n}', line: true },
  { key: 'ontriggerexit2d', title: 'OnTriggerExit2D()', body: 'private void OnTriggerExit2D(Collider2D other)\n{\n\t$0\n}', line: true },
  { key: 'oncollisionenter2d', title: 'OnCollisionEnter2D()', body: 'private void OnCollisionEnter2D(Collision2D collision)\n{\n\t$0\n}', line: true },
  { key: 'ontriggerenter', title: 'OnTriggerEnter()', body: 'private void OnTriggerEnter(Collider other)\n{\n\t$0\n}', line: true },
  { key: 'oncollisionenter', title: 'OnCollisionEnter()', body: 'private void OnCollisionEnter(Collision collision)\n{\n\t$0\n}', line: true },
  { key: 'coroutine', title: 'IEnumerator 코루틴', body: 'private IEnumerator ${1:Routine}()\n{\n\tyield return new WaitForSeconds(${2:1f});\n\t$0\n}', line: true },
  { key: 'wfs', title: 'yield return WaitForSeconds', body: 'yield return new WaitForSeconds(${1:1f});', line: true },
  { key: 'dlog', title: 'Debug.Log', body: 'Debug.Log($"${1}");', line: true },
  { key: 'gc', title: 'GetComponent<T>()', body: 'GetComponent<${1:Rigidbody2D}>()' },
  { key: 'trygc', title: 'TryGetComponent', body: 'if (TryGetComponent(out ${1:Rigidbody2D} ${2:rb}))\n{\n\t$0\n}', line: true },
  { key: 'ifnull', title: 'null이면 return', body: 'if (${1:target} == null) return;', line: true },
  { key: 'reqcomp', title: '[RequireComponent]', body: '[RequireComponent(typeof(${1:Rigidbody2D}))]', line: true },
  { key: 'createasset', title: '[CreateAssetMenu]', body: '[CreateAssetMenu(fileName = "${1:NewData}", menuName = "${2:Data}/${1}")]', line: true },
  { key: 'prop', title: '자동 속성 (private set)', body: 'public ${1:int} ${2:Value} { get; private set; }', line: true },
  { key: 'singleton', title: '싱글톤 Instance', body: 'public static ${1:ClassName} Instance { get; private set; }\n\nprivate void Awake()\n{\n\tif (Instance != null && Instance != this)\n\t{\n\t\tDestroy(gameObject);\n\t\treturn;\n\t}\n\tInstance = this;\n}', line: true },
  { key: 'for', title: 'for 반복문', body: 'for (int ${1:i} = 0; $1 < ${2:count}; $1++)\n{\n\t$0\n}', line: true },
  { key: 'foreach', title: 'foreach 반복문', body: 'foreach (var ${1:item} in ${2:items})\n{\n\t$0\n}', line: true },
];

function normalizeLine(text) {
  const t = text.trim();
  if (t.length < MIN_LINE_LEN || t.length > MAX_LINE_LEN) return null;
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return null;
  if (ONLY_PUNCT_RE.test(t) || CONTINUES_RE.test(t) || !balanced(t)) return null;
  return t;
}

// ( ) and [ ] must pair up within the line; otherwise it's a piece of a multi-line statement
// (`Foo(a,` … `b, c);`). Braces are exempt: `void Update() {` is a normal whole line.
function balanced(t) {
  let paren = 0;
  let square = 0;
  let quote = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') paren++;
    else if (ch === ')') { if (--paren < 0) return false; }
    else if (ch === '[') square++;
    else if (ch === ']') { if (--square < 0) return false; }
  }
  return paren === 0 && square === 0 && !quote;
}

function bump(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

function prune(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max * 1.2) return map;
  return Object.fromEntries(keys.sort((a, b) => map[b] - map[a]).slice(0, max).map((k) => [k, map[k]]));
}

export class CodeMemory {
  /** @param {{ enabled: () => boolean, lspCovers: (model) => boolean }} opts */
  constructor({ enabled, lspCovers }) {
    this.enabled = enabled;
    this.lspCovers = lspCovers;
    this.store = this.load();
    this.saveTimer = null;
    this.scan = null; // { key, lines: Map<lang, Map<line, count>>, words: Map<lang, Map<word, count>> }

    monaco.editor.registerCommand(USED_COMMAND, (_accessor, kind, value) => {
      if (kind === 'line') bump(this.store.lines, value);
      else if (kind === 'snippet') bump(this.store.snippets, value);
      this.scheduleSave();
    });
    // Register per language, not '*': Monaco only asks a lower-scored ('*') provider group when the
    // language-specific group (Roslyn for C#) returned nothing, so '*' would never show next to Roslyn.
    const languages = monaco.languages.getLanguages().map((l) => l.id);
    monaco.languages.registerCompletionItemProvider(languages, {
      provideCompletionItems: (model, position) => (this.enabled() ? this.provide(model, position) : { suggestions: [] }),
    });
  }

  // ------------------------------------------------------------------ storage
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      // Drop fragments learned by older builds (half lines from Enter mid-line, multi-line pieces).
      const lines = Object.fromEntries(Object.entries(s.lines || {}).filter(([t]) => normalizeLine(t) === t));
      return { lines, words: s.words || {}, snippets: s.snippets || {} };
    } catch {
      return { lines: {}, words: {}, snippets: {} };
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.store.lines = prune(this.store.lines, MAX_LINES);
      this.store.words = prune(this.store.words, MAX_WORDS);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(this.store)); } catch { /* quota: keep in memory */ }
    }, SAVE_DELAY_MS);
  }

  clear() {
    this.store = { lines: {}, words: {}, snippets: {} };
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ learning
  /** Learn each line the user finishes with Enter. */
  attach(editor) {
    editor.onDidChangeModelContent((e) => {
      if (e.isFlush || e.isUndoing || e.isRedoing || !this.enabled()) return;
      const model = editor.getModel();
      if (!model) return;
      for (const c of e.changes) {
        const breaks = c.text.split('\n').length - 1;
        if (breaks === 0 || breaks > MAX_PASTE_LINES) continue;
        const line = c.range.startLineNumber;
        if (line + breaks > model.getLineCount()) continue;
        // Enter in the middle of a line splits it: the part left behind is only half a line.
        // (Pasted blocks end on the last pasted line, so check the line after the insertion.)
        if (breaks === 1 && model.getLineContent(line + 1).trim() !== '') continue;
        this.learnLine(model.getLineContent(line));
      }
    });
  }

  learnLine(text) {
    const t = normalizeLine(text);
    if (!t) return;
    bump(this.store.lines, t);
    for (const w of t.match(WORD_RE) || []) bump(this.store.words, w);
    this.scheduleSave();
  }

  // ------------------------------------------------------------------ open-file index
  // Lines and words of every open model, grouped by language; rebuilt when any model changes.
  index() {
    const models = monaco.editor.getModels();
    const key = models.map((m) => `${m.uri}@${m.getVersionId()}`).join('|');
    const now = Date.now();
    if (this.scan && (this.scan.key === key || now - this.scan.at < SCAN_TTL_MS)) return this.scan;
    const lines = new Map();
    const words = new Map();
    for (const m of models) {
      const lang = m.getLanguageId();
      if (!lines.has(lang)) { lines.set(lang, new Map()); words.set(lang, new Map()); }
      const L = lines.get(lang);
      const W = words.get(lang);
      for (const raw of m.getLinesContent()) {
        const t = normalizeLine(raw);
        if (t) L.set(t, (L.get(t) || 0) + 1);
        for (const w of raw.match(WORD_RE) || []) W.set(w, (W.get(w) || 0) + 1);
      }
    }
    this.scan = { key, lines, words, at: now };
    return this.scan;
  }

  // ------------------------------------------------------------------ completion
  provide(model, position) {
    const K = monaco.languages.CompletionItemKind;
    const ln = position.lineNumber;
    const lineText = model.getLineContent(ln);
    const before = lineText.slice(0, position.column - 1);
    const after = lineText.slice(position.column - 1);
    const prefix = before.trimStart();
    const lang = model.getLanguageId();
    const word = model.getWordUntilPosition(position);
    const atLineStart = prefix === word.word;
    const wordRange = new monaco.Range(ln, word.startColumn, ln, position.column);
    const { lines, words } = this.index();
    const suggestions = [];

    // 1+2. whole lines: offer templates at the first word, before a declaration/expression is underway.
    if (atLineStart && prefix.length >= MIN_LINE_PREFIX && CLOSERS_RE.test(after)) {
      const start = before.length - prefix.length + 1;
      const range = new monaco.Range(ln, start, ln, lineText.length + 1); // also replaces auto-closed ) " ;
      const fileLines = lines.get(lang) || new Map();
      const cand = new Map();
      for (const [t, n] of Object.entries(this.store.lines)) {
        if (t.length > prefix.length && t.startsWith(prefix)) cand.set(t, { mem: n, file: 0 });
      }
      for (const [t, n] of fileLines) {
        if (n < MIN_FILE_REPEATS || t.length <= prefix.length || !t.startsWith(prefix)) continue;
        const c = cand.get(t) || { mem: 0, file: 0 };
        c.file = n;
        cand.set(t, c);
      }
      [...cand.entries()]
        .sort((a, b) => (b[1].mem * 2 + b[1].file) - (a[1].mem * 2 + a[1].file))
        .slice(0, MAX_LINE_ITEMS)
        .forEach(([t, c], i) => {
          suggestions.push({
            label: { label: t, description: c.mem ? `자주 쓰는 줄 · ${c.mem}회` : `반복되는 줄 · ${c.file}곳` },
            kind: K.Snippet,
            insertText: t,
            filterText: t,
            range,
            sortText: `!${String(i).padStart(2, '0')}`,
            documentation: { value: '```' + lang + '\n' + t + '\n```' },
            command: { id: USED_COMMAND, title: '', arguments: ['line', t] },
          });
        });
    }

    // 3. words (Roslyn already lists C# symbols once it's ready)
    if (word.word.length >= MIN_WORD_PREFIX && !this.lspCovers(model)) {
      const first = word.word[0].toLowerCase();
      const counts = new Map(words.get(lang) || []);
      for (const [w, n] of Object.entries(this.store.words)) counts.set(w, (counts.get(w) || 0) + n);
      counts.delete(word.word);
      [...counts.entries()]
        .filter(([w]) => w[0].toLowerCase() === first)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_WORD_ITEMS)
        .forEach(([w]) => suggestions.push({ label: w, kind: K.Text, insertText: w, range: wordRange, detail: '코드에서' }));
    }

    // 4. Unity snippets
    if (lang === 'csharp' && word.word.length >= MIN_WORD_PREFIX) {
      for (const s of SNIPPETS) {
        if (s.line && !atLineStart) continue;
        if (!s.key.startsWith(word.word.toLowerCase())) continue;
        const used = this.store.snippets[s.key] || 0;
        suggestions.push({
          label: { label: s.key, description: s.title },
          kind: K.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range: wordRange,
          sortText: used ? `!${String(9999 - Math.min(used, 9999)).padStart(4, '0')}` : `~${s.key}`,
          detail: used ? `스니펫 · ${used}회 사용` : '스니펫',
          documentation: { value: '```csharp\n' + s.body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d/g, '') + '\n```' },
          command: { id: USED_COMMAND, title: '', arguments: ['snippet', s.key] },
        });
      }
    }

    return { suggestions };
  }
}
