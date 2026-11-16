// Rider-style Unity code insight, from the project's assets and settings (src/main/unity-assets.js):
//  1. asset usages: code lenses on a script's class ("used in 2 prefabs, 1 scene") and on methods
//     called from UnityEvents / animation events; renaming a serialized field adds
//     [FormerlySerializedAs("old")] so values set in the inspector survive
//  2. string literals: completion and typo warnings for tags, layers, sorting layers, scenes, input
//     axes, animator parameters and Resources paths
//  3. performance: GetComponent / Find / SendMessage... in Update-like methods, with a quick fix that
//     caches the result in a field assigned in Awake
import { monaco } from './monaco.js';
import { maskCode, topLevelTypes } from './script-copy.js';
import { basename, dirname, extname, relPath } from './ui.js';
import { showPopupItems, popupPoint } from './location-popup.js';

const O = window.papyrus;
const ASSET_RE = /\.(prefab|unity|asset|controller|anim|overridecontroller)$/i;
const DATA_RE = /[\\/]ProjectSettings[\\/](TagManager|EditorBuildSettings|InputManager)\.asset$|\.(controller|unity)$|[\\/]Resources[\\/]/i;
const UNITY_BASE = /:\s*(?:[\w.]+\.)?(MonoBehaviour|ScriptableObject|StateMachineBehaviour|NetworkBehaviour|UIBehaviour|Selectable|Graphic|MaskableGraphic|PlayableAsset|PlayableBehaviour)\b/;
const HOT = new Set(['Update', 'LateUpdate', 'FixedUpdate', 'OnGUI']);
const KIND_LABEL = { '.unity': '씬', '.prefab': '프리팹', '.asset': '에셋', '.controller': '애니메이터', '.anim': '애니메이션', '.overridecontroller': '애니메이터' };
const PARAM_TYPE = { 1: 'Float', 3: 'Int', 4: 'Bool', 9: 'Trigger' };
const ANIM_EXPECT = { SetTrigger: 9, ResetTrigger: 9, SetBool: 4, GetBool: 4, SetInteger: 3, GetInteger: 3, SetFloat: 1, GetFloat: 1 };

// ------------------------------------------------------------------ string contexts
// `re` matches the code right before the opening quote of the string argument
const CONTEXTS = [
  { kind: 'tag', label: '태그', re: /(?:\b(?:CompareTag|FindWithTag|FindGameObjectWithTag|FindGameObjectsWithTag)\s*\(|\.tag\s*(?:==|!=|=)|\btag\s*(?:==|!=))\s*$/ },
  { kind: 'layer', label: '레이어', re: /\bLayerMask\s*\.\s*(?:NameToLayer\s*\(|GetMask\s*\([^()]*)\s*$/ },
  { kind: 'sortingLayer', label: '정렬 레이어', re: /(?:\bsortingLayerName\s*=|\bSortingLayer\s*\.\s*(?:NameToID|GetLayerValueFromName)\s*\()\s*$/ },
  { kind: 'scene', label: '씬', re: /\bSceneManager\s*\.\s*(?:LoadScene|LoadSceneAsync|GetSceneByName|UnloadSceneAsync)\s*\(\s*$/ },
  { kind: 'axis', label: '입력 축', re: /\bInput\s*\.\s*(?:GetAxis|GetAxisRaw|GetButton|GetButtonDown|GetButtonUp)\s*\(\s*$/ },
  { kind: 'anim', label: '애니메이터 파라미터', re: /(?:(\w+)\s*\.\s*)?\b(SetTrigger|ResetTrigger|SetBool|GetBool|SetInteger|GetInteger|SetFloat|GetFloat|StringToHash)\s*\(\s*$/ },
  { kind: 'resource', label: 'Resources 경로', re: /\bResources\s*\.\s*(?:Load|LoadAsync|LoadAll)\s*(?:<[^<>()]*>)?\s*\(\s*$/ },
];

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
const closest = (v, list) => {
  let best = null;
  let bd = Infinity;
  for (const x of list) {
    const dd = editDistance(v, x);
    if (dd < bd) { bd = dd; best = x; }
  }
  return best && bd <= Math.max(2, Math.floor(v.length / 3)) ? best : null;
};

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const INHERITED = new Set(['transform', 'gameObject', 'rigidbody', 'rigidbody2D', 'camera', 'light', 'animation', 'renderer',
  'collider', 'collider2D', 'audio', 'hingeJoint', 'particleSystem', 'constantForce', 'networkView', 'name', 'tag', 'enabled']);

export class UnityFeatures {
  constructor(app) {
    this.app = app;
    this.data = null; // projectData
    this.files = []; // scanAssets
    this.byGuid = new Map(); // guid -> [{ path, line, object }]
    this.byMethod = new Map(); // method -> [{ path, line, object, type }]
    this.guids = new Map(); // script path (lower) -> guid
    this.lensEmitter = new monaco.Emitter();
    this.fixes = new Map(); // model uri -> [{ range, title, edits }]
    this.timers = new Map();
    this.register();
  }

  get enabled() {
    return !!(this.app.project && this.app.isUnityProject);
  }

  // ------------------------------------------------------------------ data
  async onProjectOpened() {
    this.data = null;
    this.files = [];
    this.byGuid.clear();
    this.byMethod.clear();
    this.guids.clear();
    if (!this.enabled) return;
    await Promise.all([this.refreshData(), this.refreshAssets()]);
  }

  onFilesChanged(paths) {
    if (!this.enabled) return;
    if (paths.some((p) => ASSET_RE.test(p))) this.soon('assets', () => this.refreshAssets(), 1500);
    if (paths.some((p) => DATA_RE.test(p))) this.soon('data', () => this.refreshData(), 1200);
    if (paths.some((p) => /\.cs\.meta$/i.test(p))) this.guids.clear();
  }

  settingsChanged() {
    for (const m of monaco.editor.getModels()) this.analyze(m);
    this.lensEmitter.fire(this.lensProvider);
  }

  soon(key, fn, ms) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(fn, ms));
  }

  async refreshData() {
    const root = this.app.project;
    try { this.data = await O.unity.projectData(root); } catch { return; }
    if (root !== this.app.project) return;
    for (const m of monaco.editor.getModels()) this.analyze(m);
  }

  async refreshAssets() {
    const root = this.app.project;
    let files;
    try { files = await O.unity.scanAssets(root); } catch { return; }
    if (root !== this.app.project) return;
    this.files = files;
    this.byGuid.clear();
    this.byMethod.clear();
    for (const f of files) {
      for (const [guid, line, object] of f.scripts) {
        if (!this.byGuid.has(guid)) this.byGuid.set(guid, []);
        this.byGuid.get(guid).push({ path: f.path, line, object });
      }
      for (const [type, method, line, object] of f.events) {
        if (!this.byMethod.has(method)) this.byMethod.set(method, []);
        this.byMethod.get(method).push({ path: f.path, line, object, type });
      }
    }
    this.lensEmitter.fire(this.lensProvider);
  }

  async guidOf(path) {
    const k = path.toLowerCase();
    if (this.guids.has(k)) return this.guids.get(k);
    let guid = null;
    try {
      const r = await O.fs.readFile(path + '.meta');
      guid = (/^guid:\s*([0-9a-f]{32})/m.exec(r.text || '') || [])[1] || null;
    } catch { /* no meta */ }
    this.guids.set(k, guid);
    return guid;
  }

  /** Asset usages of the script file (its MonoBehaviour / ScriptableObject). */
  async scriptUsages(path) {
    const guid = await this.guidOf(path);
    return guid ? this.byGuid.get(guid) || [] : [];
  }

  /** UnityEvent / animation event calls of `method` on class `cls` (full name `full`). */
  methodUsages(method, cls, full) {
    return (this.byMethod.get(method) || []).filter((u) => !u.type || u.type === full || u.type === cls || u.type.endsWith('.' + cls));
  }

  // ------------------------------------------------------------------ registration
  register() {
    const self = this;
    monaco.editor.registerCommand('papyrus.unity.assetUsages', (_acc, title, list) => this.showUsages(title, list));

    // 1. code lenses
    this.lensProvider = {
      onDidChange: this.lensEmitter.event,
      async provideCodeLenses(model) {
        const lenses = await self.lenses(model).catch(() => []);
        return { lenses, dispose() {} };
      },
    };
    monaco.languages.registerCodeLensProvider('csharp', this.lensProvider);

    // 2. string completions
    monaco.languages.registerCompletionItemProvider('csharp', {
      triggerCharacters: ['"', '/'],
      provideCompletionItems: (model, position) => this.completeString(model, position),
    });

    // quick fixes (typo -> closest name, cache in a field)
    monaco.languages.registerCodeActionProvider('csharp', {
      provideCodeActions: (model, range) => {
        const list = (this.fixes.get(model.uri.toString()) || []).filter((f) => f.range.intersectRanges(range));
        return {
          actions: list.map((f) => ({
            title: f.title,
            kind: 'quickfix',
            isPreferred: !!f.preferred,
            edit: { edits: f.edits.map((e) => ({ resource: model.uri, textEdit: e, versionId: model.getVersionId() })) },
          })),
          dispose() {},
        };
      },
    });

    // analysis of open C# files
    const watch = (m) => {
      if (m.getLanguageId() !== 'csharp' || m.uri.scheme !== 'file') return;
      this.analyze(m);
      const sub = m.onDidChangeContent(() => this.soon('an:' + m.uri, () => this.analyze(m), 500));
      m.onWillDispose(() => { sub.dispose(); this.fixes.delete(m.uri.toString()); });
    };
    monaco.editor.getModels().forEach(watch);
    monaco.editor.onDidCreateModel(watch);
  }

  // ------------------------------------------------------------------ lenses
  async lenses(model) {
    if (!this.enabled || !this.files.length || this.app.settings['unity.assetLenses'] === false) return [];
    const path = model.uri.fsPath;
    if (!/[\\/]Assets[\\/]/i.test(path) || !this.app.editors.tabsOfModel(model).length) return [];
    const text = model.getValue();
    const m = maskCode(text);
    const types = topLevelTypes(text).filter((t) => /class|struct/.test(t.kind));
    if (!types.length) return [];
    const fileClass = basename(path).replace(/\.cs$/i, '');
    const ns = (/^[ \t]*namespace\s+([\w.]+)/m.exec(m) || [])[1] || '';
    const lenses = [];
    for (const t of types) {
      const re = new RegExp(`\\b(?:class|struct)\\s+${t.name}\\b`, 'g');
      re.lastIndex = t.start;
      const hit = re.exec(m);
      if (!hit) continue;
      const line = model.getPositionAt(hit.index).lineNumber;
      const range = new monaco.Range(line, 1, line, 1);
      const full = ns ? `${ns}.${t.name}` : t.name;
      // the script's own usages: Unity links a file to the class named like it
      if (t.name === fileClass) {
        const uses = await this.scriptUsages(path);
        const header = m.slice(hit.index, m.indexOf('{', hit.index));
        if (uses.length || UNITY_BASE.test(header)) {
          lenses.push({ range, command: { id: 'papyrus.unity.assetUsages', title: this.usageTitle(uses), arguments: [`${t.name} 에셋 사용처`, uses] } });
        }
      }
      // methods called from UnityEvents / animation events
      const body = { start: m.indexOf('{', hit.index), end: t.end };
      for (const [method] of this.byMethod) {
        const uses = this.methodUsages(method, t.name, full);
        if (!uses.length) continue;
        const decl = new RegExp(`(?:^|[\\s;{}\\]])[\\w<>\\[\\],.?]+\\s+(${method})\\s*\\(`, 'gm');
        decl.lastIndex = body.start;
        let d;
        while ((d = decl.exec(m)) && d.index < body.end) {
          if (this.depth(m, body.start, d.index) !== 1) continue;
          const l = model.getPositionAt(d.index + d[0].lastIndexOf(method)).lineNumber;
          const anim = uses.every((u) => !u.type);
          lenses.push({ range: new monaco.Range(l, 1, l, 1), command: { id: 'papyrus.unity.assetUsages', title: `${anim ? '애니메이션 이벤트' : 'UnityEvent'} ${uses.length}곳에서 호출`, arguments: [`${method}() 호출하는 이벤트`, uses] } });
          break;
        }
      }
    }
    return lenses;
  }

  /** Brace depth of `at` counted from `from` (the class's `{` is depth 1). */
  depth(m, from, at) {
    let d = 0;
    for (let i = from; i < at; i++) {
      if (m[i] === '{') d++;
      else if (m[i] === '}') d--;
    }
    return d;
  }

  usageTitle(uses) {
    if (!uses.length) return 'Unity 에셋에서 사용 안 함';
    const by = new Map();
    for (const u of uses) {
      const k = KIND_LABEL[extname(u.path)] || '에셋';
      if (!by.has(k)) by.set(k, new Set());
      by.get(k).add(u.path.toLowerCase());
    }
    return `Unity 에셋 ${uses.length}곳에서 사용 (${[...by].map(([k, s]) => `${k} ${s.size}`).join(' · ')})`;
  }

  showUsages(title, list) {
    if (!list || !list.length) return;
    const at = popupPoint(this.app.editors.editor);
    const items = list.map((u) => ({
      file: u.path,
      line: u.line,
      column: 1,
      label: basename(u.path),
      text: u.object || '',
      dir: relPath(this.app.project, dirname(u.path)),
      usage: u,
    }));
    showPopupItems({
      title: `${title} · ${list.length}`,
      items,
      at,
      project: this.app.project,
      onPick: (file) => {
        // scenes, prefabs, ScriptableObjects open decoded in the inspector; the explorer shows the file
        if (/\.(unity|prefab|asset)$/i.test(file) && this.app.inspector) this.app.inspector.pin(file);
        this.app.explorer.reveal(file);
      },
    });
  }

  // ------------------------------------------------------------------ serialized field rename
  /**
   * Called by the rename provider with Roslyn's edits: when the renamed symbol is a serialized
   * field of a Unity-serialized class, adds [FormerlySerializedAs("old")] (and the using).
   */
  async onRename(model, position, newName, result) {
    if (!this.enabled || this.app.settings['unity.formerlySerializedAs'] === false || !result || !result.edits) return;
    const word = model.getWordAtPosition(position);
    if (!word) return;
    const oldName = word.word;
    for (const e of result.edits) {
      if (!e.textEdit || e.textEdit.text !== newName) continue;
      const m = monaco.editor.getModel(e.resource);
      if (!m || m.getValueInRange(e.textEdit.range) !== oldName) continue;
      const decl = await this.serializedField(m, e.textEdit.range, oldName);
      if (!decl) continue;
      const nl = m.getEOL();
      const line = m.getLineContent(decl.line);
      const indent = line.match(/^\s*/)[0];
      result.edits.push({ resource: m.uri, textEdit: { range: new monaco.Range(decl.line, 1, decl.line, 1), text: `${indent}[FormerlySerializedAs("${oldName}")]${nl}` }, versionId: undefined });
      const text = m.getValue();
      if (!/^\s*using\s+UnityEngine\.Serialization\s*;/m.test(text)) {
        const usings = [...text.matchAll(/^[ \t]*using\s+[\w.]+\s*;[ \t]*\r?$/gm)];
        const last = usings.length ? usings[usings.length - 1] : null;
        const at = last ? m.getPositionAt(last.index + last[0].length) : new monaco.Position(1, 1);
        result.edits.push({ resource: m.uri, textEdit: { range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column), text: last ? `${nl}using UnityEngine.Serialization;` : `using UnityEngine.Serialization;${nl}` }, versionId: undefined });
      }
      return; // one declaration
    }
  }

  /** { line } when the identifier at `range` declares a field Unity serializes, else null. */
  async serializedField(model, range, name) {
    const text = model.getValue();
    const m = maskCode(text);
    const off = model.getOffsetAt(range.getStartPosition());
    // the declaration statement: from the previous ; { } to the next ;
    let s = off;
    while (s > 0 && !';{}'.includes(m[s - 1])) s--;
    const e = m.indexOf(';', off);
    if (e < 0) return null;
    const stmt = m.slice(s, e + 1);
    const nameAt = off - s;
    const before = stmt.slice(0, nameAt);
    const after = stmt.slice(nameAt + name.length);
    if (!/^\s*(?:=[^;]*)?;\s*$/.test(after) || /\(|=>|\bevent\b/.test(before)) return null; // not a field declaration (method, property, local...)
    if (/\b(static|const|readonly)\b/.test(before) || /,/.test(before.replace(/<[^<>]*>/g, ''))) return null;
    if (/\[\s*(?:System\.)?NonSerialized\s*\]/.test(before)) return null;
    const isPublic = /\bpublic\b/.test(before);
    if (!isPublic && !/\[\s*(?:\w+\s*,\s*)*(?:UnityEngine\.)?Serialize(?:Field|Reference)\b/.test(before)) return null;
    if (/FormerlySerializedAs\s*\(\s*"/.test(before) && before.includes(`"${name}"`)) return null;
    // directly in a class body (not a local in a method)
    let depth = 0;
    let open = -1;
    for (let i = s - 1; i >= 0; i--) {
      if (m[i] === '}') depth++;
      else if (m[i] === '{') { if (depth === 0) { open = i; break; } depth--; }
    }
    if (open < 0) return null;
    let hs = open;
    while (hs > 0 && !';{}'.includes(m[hs - 1])) hs--;
    const header = m.slice(hs, open);
    const cls = /\b(class|struct)\s+(\w+)/.exec(header);
    if (!cls) return null;
    // Unity-serialized: a script the assets use, a MonoBehaviour / ScriptableObject, or [Serializable]
    const serializable = /\[\s*(?:System\.)?Serializable\s*\]/.test(header) || UNITY_BASE.test(header)
      || (cls[2] === basename(model.uri.fsPath).replace(/\.cs$/i, '') && (await this.scriptUsages(model.uri.fsPath)).length > 0);
    if (!serializable) return null;
    // the line where the declaration (its attributes included) starts
    const firstCode = s + (stmt.length - stmt.trimStart().length);
    return { line: model.getPositionAt(firstCode).lineNumber };
  }

  // ------------------------------------------------------------------ string completions
  candidates(kind, method) {
    const d = this.data;
    if (!d) return [];
    switch (kind) {
      case 'tag': return d.tags.map((x) => ({ value: x }));
      case 'layer': return d.layers.map((x) => ({ value: x }));
      case 'sortingLayer': return d.sortingLayers.map((x) => ({ value: x }));
      case 'axis': return d.axes.map((x) => ({ value: x }));
      case 'resource': return d.resources.map((x) => ({ value: x }));
      case 'scene': {
        const build = new Set(d.buildScenes.filter((s) => s.enabled).map((s) => s.path.toLowerCase()));
        return d.scenes.map((p) => ({ value: basename(p).replace(/\.unity$/i, ''), detail: build.has(p.toLowerCase()) ? 'Build Settings' : 'Build Settings에 없음', doc: p }));
      }
      case 'anim': {
        const want = ANIM_EXPECT[method];
        const seen = new Map();
        for (const p of d.animatorParams) {
          if (want && p.type !== want) continue;
          if (!seen.has(p.name)) seen.set(p.name, { value: p.name, detail: PARAM_TYPE[p.type] || '', doc: p.controller });
        }
        return [...seen.values()];
      }
      default: return [];
    }
  }

  completeString(model, position) {
    if (!this.enabled || !this.data) return { suggestions: [] };
    const line = model.getLineContent(position.lineNumber);
    const prefix = line.slice(0, position.column - 1);
    // inside a plain "..." literal: the text before its opening quote decides the list
    const q = /"([^"\\]*)$/.exec(prefix);
    if (!q) return { suggestions: [] };
    const before = prefix.slice(0, q.index);
    if (/[$@]$/.test(before) || (before.match(/"/g) || []).length % 2) return { suggestions: [] };
    // the text before on earlier lines matters for multi-line calls: keep it simple, this line only
    const ctx = CONTEXTS.find((c) => c.re.test(before));
    if (!ctx) return { suggestions: [] };
    const mm = ctx.kind === 'anim' ? ctx.re.exec(before) : null;
    if (mm && /^(SetFloat|GetFloat)$/.test(mm[2]) && mm[1] && /mat|shader|renderer/i.test(mm[1])) return { suggestions: [] };
    const close = line.indexOf('"', position.column - 1);
    const range = new monaco.Range(position.lineNumber, q.index + 2, position.lineNumber, close >= 0 ? close + 1 : position.column);
    const list = this.candidates(ctx.kind, mm && mm[2]);
    return {
      suggestions: list.map((c, i) => ({
        label: { label: c.value, description: c.detail || ctx.label },
        kind: monaco.languages.CompletionItemKind.Value,
        insertText: c.value,
        range,
        sortText: String(i).padStart(4, '0'),
        filterText: c.value,
        documentation: c.doc,
      })),
    };
  }

  // ------------------------------------------------------------------ analysis (warnings + perf)
  analyze(model) {
    if (model.isDisposed() || model.getLanguageId() !== 'csharp') return;
    const fixes = [];
    const markers = [];
    if (this.enabled && /[\\/]Assets[\\/]/i.test(model.uri.fsPath)) {
      const text = model.getValue();
      const m = maskCode(text);
      if (this.data && this.app.settings['unity.stringChecks'] !== false) this.checkStrings(model, text, m, markers, fixes);
      if (this.app.settings['unity.performanceHints'] !== false) this.checkPerformance(model, text, m, markers, fixes);
    }
    monaco.editor.setModelMarkers(model, 'unity', markers);
    this.fixes.set(model.uri.toString(), fixes);
  }

  checkStrings(model, text, m, markers, fixes) {
    const d = this.data;
    for (const lit of stringLiterals(text)) {
      const x = { index: lit.start, 0: text.slice(lit.start, lit.end), 1: lit.value };
      const lineStart = text.lastIndexOf('\n', x.index) + 1;
      const before = m.slice(Math.max(lineStart, x.index - 200), x.index);
      const ctx = CONTEXTS.find((c) => c.re.test(before));
      if (!ctx) continue;
      // "Enemy" + suffix: built at runtime, can't check
      if (/^\s*\+/.test(text.slice(x.index + x[0].length, x.index + x[0].length + 8))) continue;
      const v = x[1];
      if (!v) continue;
      let msg = null;
      let pool = [];
      if (ctx.kind === 'scene') {
        const name = v.replace(/\.unity$/i, '');
        const all = d.scenes.filter((p) => samePathEnd(p, name));
        const build = d.buildScenes.filter((s) => s.enabled && samePathEnd(s.path, name));
        pool = d.scenes.map((p) => basename(p).replace(/\.unity$/i, ''));
        if (!all.length) msg = `'${v}' 씬이 프로젝트에 없어요.`;
        else if (!build.length) msg = `'${v}' 씬이 Build Settings에 없어서 실행하면 불러올 수 없어요. (File → Build Settings에 추가)`;
      } else if (ctx.kind === 'anim') {
        const mm = ctx.re.exec(before);
        const method = mm && mm[2];
        if (!d.animatorParams.length || method === 'StringToHash') continue;
        if (/^(SetFloat|GetFloat)$/.test(method) && ((mm[1] && /mat|shader|renderer/i.test(mm[1])) || v.startsWith('_'))) continue;
        const same = d.animatorParams.filter((p) => p.name === v);
        pool = [...new Set(d.animatorParams.filter((p) => !ANIM_EXPECT[method] || p.type === ANIM_EXPECT[method]).map((p) => p.name))];
        if (!same.length) msg = `애니메이터 파라미터 '${v}'가 어떤 Animator Controller에도 없어요.`;
        else if (ANIM_EXPECT[method] && !same.some((p) => p.type === ANIM_EXPECT[method])) msg = `'${v}'는 ${PARAM_TYPE[same[0].type] || '다른'} 타입 파라미터예요. ${method}에는 ${PARAM_TYPE[ANIM_EXPECT[method]]} 파라미터가 필요해요.`;
      } else {
        const list = { tag: d.tags, layer: d.layers, sortingLayer: d.sortingLayers, axis: d.axes, resource: d.resources }[ctx.kind] || [];
        if (!list.length && ctx.kind !== 'tag') continue;
        pool = list;
        if (!list.includes(v)) {
          const ci = list.find((s) => s.toLowerCase() === v.toLowerCase());
          msg = ci ? `${ctx.label} 이름은 대소문자를 구분해요: '${ci}'` : `${ctx.label} '${v}'가 없어요.${ctx.kind === 'tag' || ctx.kind === 'layer' ? ' (Project Settings → Tags and Layers)' : ''}`;
        }
      }
      if (!msg) continue;
      const s = model.getPositionAt(x.index + 1);
      const e = model.getPositionAt(x.index + 1 + v.length);
      const range = new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column);
      const near = closest(v, pool);
      const said = near && msg.includes(`'${near}'`);
      markers.push({ severity: monaco.MarkerSeverity.Warning, message: msg + (near && near !== v && !said ? ` 혹시 '${near}'?` : ''), source: 'Unity', code: 'unity-string', ...range });
      if (near && near !== v) fixes.push({ range, title: `'${near}'(으)로 바꾸기`, preferred: true, edits: [{ range, text: near }] });
    }
  }

  checkPerformance(model, text, m, markers, fixes) {
    // Update-like methods directly in a class body
    const decl = /\bvoid\s+(Update|LateUpdate|FixedUpdate|OnGUI)\s*\(\s*\)\s*\{/g;
    let d;
    while ((d = decl.exec(m))) {
      if (!HOT.has(d[1])) continue;
      const open = d.index + d[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < m.length; i++) {
        if (m[i] === '{') depth++;
        else if (m[i] === '}' && --depth === 0) { close = i; break; }
      }
      if (close < 0) continue;
      this.hotCalls(model, text, m, d[1], open + 1, close, markers, fixes);
    }
  }

  hotCalls(model, text, m, method, from, to, markers, fixes) {
    const body = m.slice(from, to);
    const rules = [
      { re: /(?:(?<![\w.])|\b(?:this|gameObject|transform)\s*\.\s*)(GetComponents?(?:InChildren|InParent)?)\s*(?:<\s*([\w.]+)\s*>)?\s*\(\s*\)/g, what: (g) => `${g[1]}`, fix: 'component' },
      { re: /\b(?:(?:UnityEngine\s*\.\s*)?Object\s*\.\s*|GameObject\s*\.\s*|(?<![\w.]))(FindObjectOfType|FindObjectsOfType|FindFirstObjectByType|FindAnyObjectByType|FindObjectsByType)\s*(?:<\s*([\w.]+)\s*>)?\s*\(\s*\)/g, what: (g) => g[1], fix: 'find' },
      { re: /\bGameObject\s*\.\s*(Find|FindWithTag|FindGameObjectWithTag|FindGameObjectsWithTag)\s*\([^()\n]*\)/g, what: (g) => `GameObject.${g[1]}`, fix: 'gofind' },
      { re: /(?:(?<![\w.])|\b(?:this|gameObject)\s*\.\s*)(SendMessage|SendMessageUpwards|BroadcastMessage)\s*\(/g, what: (g) => g[1] },
      { re: /(?:(?<![\w.])|\bgameObject\s*\.\s*)(AddComponent)\s*(?:<[\w.]+>)?\s*\(/g, what: () => 'AddComponent', msg: 'AddComponent를 매 프레임 호출해요. 컴포넌트가 계속 늘어나요.' },
      { re: /\bResources\s*\.\s*(Load|LoadAll)\b/g, what: (g) => `Resources.${g[1]}` },
    ];
    for (const r of rules) {
      let g;
      r.re.lastIndex = 0;
      while ((g = r.re.exec(body))) {
        const startOff = from + g.index + (g[0].length - g[0].trimStart().length);
        const callStart = from + g.index + g[0].indexOf(g[1]);
        const s = model.getPositionAt(callStart);
        const e = model.getPositionAt(from + g.index + g[0].length);
        const range = new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column);
        const what = r.what(g);
        markers.push({
          severity: monaco.MarkerSeverity.Info,
          message: r.msg || `성능: ${method}()에서 ${what}를 매 프레임 호출해요. Awake/Start에서 한 번 구해 필드에 저장해 두세요.`,
          source: 'Unity 성능',
          code: 'unity-perf',
          ...range,
        });
        if (r.fix) {
          const expr = text.slice(startOff, from + g.index + g[0].length);
          const fix = this.cacheFix(model, text, m, expr, g, r.fix, startOff);
          if (fix) fixes.push({ range, ...fix });
        }
      }
    }
  }

  /** "Cache in a field": private T _t; assigned in Awake; the hot calls use the field. */
  cacheFix(model, text, m, expr, g, kind, off) {
    let type;
    let base;
    if (kind === 'component' || kind === 'find') {
      if (!g[2] || /^GetComponents|FindObjectsOfType|FindObjectsByType|FindGameObjectsWithTag/.test(g[1])) return null; // arrays: leave to the user
      type = g[2];
      base = type.split('.').pop();
    } else if (kind === 'gofind') {
      if (g[1] === 'FindGameObjectsWithTag') return null;
      type = 'GameObject';
      base = ((/"([^"]*)"/.exec(expr) || [])[1] || 'target').replace(/[^A-Za-z0-9_]/g, '') || 'target';
      base = base.charAt(0).toUpperCase() + base.slice(1);
    } else return null;
    // the enclosing class
    const cls = this.classAround(m, off);
    if (!cls) return null;
    const underscore = /\bprivate\s+[\w<>[\],.]+\s+_\w+\s*[;=]/.test(m.slice(cls.open, cls.close));
    // `rigidbody2D`, `transform`, `camera`...: members Component already has (obsolete or not)
    const pre = underscore || INHERITED.has(lowerFirst(base)) ? '_' : '';
    let name = pre + lowerFirst(base);
    const ident = (n) => new RegExp(`\\b${n}\\b`).test(m.slice(cls.open, cls.close));
    for (let k = 2; ident(name); k++) name = pre + lowerFirst(base) + k;

    const nl = model.getEOL();
    const unit = /\n\t/.test(text) ? '\t' : '    ';
    const clsIndent = (text.slice(text.lastIndexOf('\n', cls.open) + 1, cls.open).match(/^\s*/) || [''])[0];
    const mi = clsIndent + unit;
    const edits = [];
    const lineEnd = (off) => { const n = text.indexOf('\n', off); return n < 0 ? text.length : n + 1; };
    const pos = (off) => model.getPositionAt(off);
    const rangeAt = (a, b) => { const s = pos(a); const e = pos(b); return new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column); };
    // field right after the class's opening brace
    const fieldAt = lineEnd(cls.open);
    const awake = new RegExp(`\\bvoid\\s+Awake\\s*\\(\\s*\\)\\s*\\{`, 'g');
    awake.lastIndex = cls.open;
    const aw = awake.exec(m);
    if (aw && aw.index < cls.close) {
      const ab = aw.index + aw[0].length;
      if (text.slice(ab, lineEnd(ab - 1)).trim()) return null; // `void Awake() { ... }` on one line: leave it
      const bodyIndent = mi + unit;
      edits.push({ range: rangeAt(fieldAt, fieldAt), text: `${mi}private ${type} ${name};${nl}${nl}` });
      edits.push({ range: rangeAt(lineEnd(ab - 1), lineEnd(ab - 1)), text: `${bodyIndent}${name} = ${expr};${nl}` });
    } else {
      edits.push({ range: rangeAt(fieldAt, fieldAt), text: `${mi}private ${type} ${name};${nl}${nl}${mi}private void Awake()${nl}${mi}{${nl}${mi}${unit}${name} = ${expr};${nl}${mi}}${nl}${nl}` });
    }
    // every identical call in Update-like methods of this class uses the field
    const norm = (s) => s.replace(/\s+/g, '');
    const hot = /\bvoid\s+(Update|LateUpdate|FixedUpdate|OnGUI)\s*\(\s*\)\s*\{/g;
    hot.lastIndex = cls.open;
    let h;
    while ((h = hot.exec(m)) && h.index < cls.close) {
      const open = h.index + h[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < m.length; i++) {
        if (m[i] === '{') depth++;
        else if (m[i] === '}' && --depth === 0) { close = i; break; }
      }
      if (close < 0) continue;
      const seg = text.slice(open, close);
      const mseg = m.slice(open, close);
      for (let i = 0; i < seg.length; i++) {
        if (mseg[i] !== seg[i]) continue; // inside a comment / string
        if (seg[i] !== expr[0]) continue;
        // compare ignoring whitespace from here
        let j = i;
        let k = 0;
        const target = norm(expr);
        while (j < seg.length && k < target.length) {
          if (/\s/.test(seg[j])) { j++; continue; }
          if (seg[j] !== target[k]) break;
          j++; k++;
        }
        if (k === target.length && !/[\w.]/.test(seg[i - 1] || '')) {
          edits.push({ range: rangeAt(open + i, open + j), text: name });
          i = j - 1;
        }
      }
    }
    return { title: `필드 '${name}'에 캐싱 (Awake에서 한 번만 구하기)`, preferred: true, edits };
  }

  /** The class whose body contains `off`: { open, close } offsets of its braces. */
  classAround(m, off) {
    const re = /\b(?:class|struct)\s+\w+[^{;]*\{/g;
    let best = null;
    let c;
    while ((c = re.exec(m))) {
      const open = c.index + c[0].length - 1;
      if (open > off) break;
      let depth = 0;
      let close = -1;
      for (let i = open; i < m.length; i++) {
        if (m[i] === '{') depth++;
        else if (m[i] === '}' && --depth === 0) { close = i; break; }
      }
      if (close > off) best = { open, close };
    }
    return best;
  }
}

/** Plain "..." literals outside comments: [{ start, end, value }] (verbatim / interpolated ones skipped). */
export function stringLiterals(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '\'') {
      let j = i + 1;
      while (j < n && text[j] !== '\'' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) { const e = text.indexOf('"""', i + 3); i = e < 0 ? n : e + 3; continue; } // raw string
      const p1 = text[i - 1] || '';
      const p2 = text[i - 2] || '';
      const verbatim = p1 === '@' || (p1 === '$' && p2 === '@');
      const interp = p1 === '$' || (p1 === '@' && p2 === '$');
      let j = i + 1;
      if (verbatim) {
        while (j < n && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1;
        i = j + 1;
        continue;
      }
      let escaped = false;
      while (j < n && text[j] !== '"' && text[j] !== '\n') {
        if (text[j] === '\\') escaped = true;
        j += text[j] === '\\' ? 2 : 1;
      }
      // only literals whose value is exactly what's written (no escapes, no {holes})
      if (!interp && !escaped && text[j] === '"') out.push({ start: i, end: j + 1, value: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function samePathEnd(scenePath, name) {
  const p = scenePath.replace(/\\/g, '/').replace(/\.unity$/i, '');
  const n = name.replace(/\\/g, '/');
  return p === n || p.endsWith('/' + n);
}
