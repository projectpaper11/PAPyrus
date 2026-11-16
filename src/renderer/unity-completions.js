// Completion ranking and Unity inspector attributes.
//
// 1. Ranking (Monaco orders by fuzzy-match score, then by provider order):
//    - C# keywords the typed text is a prefix of (override, false, return...) always come first.
//    - Unity's inspector attributes (SerializeField, Header, Range...) get a score bonus, so "sf" or
//      "seri" puts SerializeField on top. The rest of Unity's API ranks like any other symbol.
// 2. Attributes: typing a Unity attribute name ("sf", "Seri", "head", "req"...) at the start of a
//    member line offers the whole attribute, brackets and arguments included: [SerializeField],
//    [Header("")], [Range(0f, 1f)], [RequireComponent(typeof(...))]...
import { monaco } from './monaco.js';
import { CompletionModel } from 'monaco-editor/editor/contrib/suggest/browser/completionModel.js';

// fuzzy scores run about 5-8 per matched character: "sf" scores SerializeField ~12 and a field
// named sfxVolume ~15, so the bonus has to cover a few points
const ATTRIBUTE_BONUS = 8;
const KEYWORD = monaco.languages.CompletionItemKind.Keyword;

// ------------------------------------------------------------------ ranking
const base = CompletionModel._compareCompletionItems;
const keywordFirst = (it) => {
  const c = it.completion;
  return !!(c && c.kind === KEYWORD && it.word && it.textLabel.toLowerCase().startsWith(it.word.trim().toLowerCase()));
};
// our [SerializeField] snippet a hair above Roslyn's bare SerializeField type
const rank = (it) => it.score[0] + (it.completion && it.completion.__unityAttr ? ATTRIBUTE_BONUS + (it.completion.__snippet ? 1 : 0) : 0);
// Monaco reads this static when each list is created (and the snippets-up/down variants call it),
// so replacing it before the first suggestion affects every list.
CompletionModel._compareCompletionItems = (a, b) => {
  const ka = keywordFirst(a);
  if (ka !== keywordFirst(b)) return ka ? -1 : 1;
  const d = rank(b) - rank(a);
  return d !== 0 ? d : base(a, b);
};

// ------------------------------------------------------------------ attributes
// where: 'member' = fields/methods in a type body, 'type' = on a class (also valid at namespace level)
const ATTRIBUTES = [
  // after [SerializeField] the list opens again for `private`, the type...
  { name: 'SerializeField', text: '[SerializeField] ', where: 'member', retrigger: true, doc: '비공개 필드를 인스펙터에 노출하고 직렬화해요.' },
  { name: 'Header', text: '[Header("$1")]$0', where: 'member', doc: '인스펙터에서 필드 위에 제목을 표시해요.' },
  { name: 'Tooltip', text: '[Tooltip("$1")]$0', where: 'member', doc: '인스펙터에서 마우스를 올리면 설명을 보여줘요.' },
  { name: 'Range', text: '[Range(${1:0f}, ${2:1f})]$0', where: 'member', doc: '숫자 필드를 슬라이더로 표시해요.' },
  { name: 'Min', text: '[Min(${1:0})]$0', where: 'member', doc: '숫자 필드의 최솟값을 정해요.' },
  { name: 'Space', text: '[Space]', where: 'member', doc: '인스펙터에서 필드 위에 빈 칸을 넣어요.' },
  { name: 'HideInInspector', text: '[HideInInspector]', where: 'member', doc: '공개 필드를 인스펙터에서 숨겨요 (직렬화는 유지).' },
  { name: 'TextArea', text: '[TextArea]', where: 'member', doc: '문자열 필드를 여러 줄 입력칸으로 표시해요.' },
  { name: 'Multiline', text: '[Multiline]', where: 'member', doc: '문자열 필드를 여러 줄로 표시해요.' },
  { name: 'Delayed', text: '[Delayed]', where: 'member', doc: '입력을 마칠 때(Enter/포커스 해제)만 값을 반영해요.' },
  { name: 'SerializeReference', text: '[SerializeReference] ', where: 'member', retrigger: true, doc: '참조 타입 필드를 다형성 있게 직렬화해요.' },
  { name: 'ContextMenu', text: '[ContextMenu("$1")]$0', where: 'member', doc: '컴포넌트 메뉴(⋮)에서 이 메서드를 실행하게 해요.' },
  { name: 'RuntimeInitializeOnLoadMethod', text: '[RuntimeInitializeOnLoadMethod]', where: 'member', doc: '게임 시작 시 이 static 메서드를 호출해요.' },
  { name: 'RequireComponent', text: '[RequireComponent(typeof(${1:Rigidbody}))]$0', where: 'type', doc: '이 컴포넌트를 붙이면 필요한 컴포넌트도 함께 붙여요.' },
  { name: 'DisallowMultipleComponent', text: '[DisallowMultipleComponent]', where: 'type', doc: '한 오브젝트에 하나만 붙일 수 있게 해요.' },
  { name: 'CreateAssetMenu', text: '[CreateAssetMenu(fileName = "${1:New Data}", menuName = "${2:Data}")]$0', where: 'type', doc: 'Assets > Create 메뉴에 이 ScriptableObject를 추가해요.' },
  { name: 'AddComponentMenu', text: '[AddComponentMenu("$1")]$0', where: 'type', doc: 'Add Component 메뉴에서의 위치를 정해요.' },
  { name: 'ExecuteAlways', text: '[ExecuteAlways]', where: 'type', doc: '에디트 모드에서도 스크립트를 실행해요.' },
  { name: 'ExecuteInEditMode', text: '[ExecuteInEditMode]', where: 'type', doc: '에디트 모드에서도 스크립트를 실행해요 (구식, ExecuteAlways 권장).' },
  { name: 'DefaultExecutionOrder', text: '[DefaultExecutionOrder(${1:0})]$0', where: 'type', doc: '스크립트 실행 순서를 정해요.' },
  { name: 'SelectionBase', text: '[SelectionBase]', where: 'type', doc: '씬에서 자식을 클릭해도 이 오브젝트가 선택돼요.' },
  { name: 'Serializable', text: '[System.Serializable]', where: 'type', doc: '이 클래스/구조체를 인스펙터에 표시하고 직렬화해요.' },
];

/** Unity attribute names; Roslyn's items with these labels (e.g. inside "[...]") rank first too. */
export const UNITY_ATTRIBUTE_NAMES = new Set([
  ...ATTRIBUTES.map((a) => a.name),
  'ContextMenuItem', 'FormerlySerializedAs', 'ColorUsage', 'GradientUsage', 'InspectorName', 'NonReorderable',
  'MenuItem', 'CustomEditor', 'CustomPropertyDrawer', 'CanEditMultipleObjects', 'InitializeOnLoad', 'InitializeOnLoadMethod',
]);

/**
 * What the innermost open brace before the cursor belongs to: 'type' (class/struct/interface/record
 * body), 'namespace' (or file level), or 'code' (method, property, enum...). Skips comments,
 * strings and char literals so braces inside them don't count.
 */
function braceContext(text) {
  const stack = [];
  let stmt = 0; // start of the current statement/header
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); if (e < 0) break; i = e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) break; i = e + 1; continue; }
    if (c === '"' || c === "'") {
      const verbatim = c === '"' && (text[i - 1] === '@' || (text[i - 1] === '$' && text[i - 2] === '@'));
      for (i++; i < n; i++) {
        if (!verbatim && text[i] === '\\') { i++; continue; }
        if (text[i] === c) { if (verbatim && text[i + 1] === '"') { i++; continue; } break; }
        if (!verbatim && text[i] === '\n') break;
      }
      continue;
    }
    if (c === '{') {
      const head = text.slice(stmt, i);
      stack.push(/\bnamespace\b/.test(head) ? 'namespace' : /\b(class|struct|interface|record)\b/.test(head) ? 'type' : 'code');
      stmt = i + 1;
    } else if (c === '}') {
      stack.pop();
      stmt = i + 1;
    } else if (c === ';') {
      stmt = i + 1;
    }
  }
  return stack.length ? stack[stack.length - 1] : 'namespace';
}

monaco.languages.registerCompletionItemProvider('csharp', {
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
    // only at the start of a line; inside "[...]" Roslyn already lists the attribute names
    if (before.trim() !== '') return { suggestions: [] };
    const ctx = braceContext(model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, word.startColumn)));
    if (ctx === 'code') return { suggestions: [] };
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
    const L = monaco.languages;
    const suggestions = ATTRIBUTES
      .filter((a) => ctx === 'type' || a.where === 'type')
      .map((a) => ({
        label: { label: `[${a.name}]`, description: 'Unity 속성' },
        // matched against the bare name, so "sf", "seri", "SerializeF" all find it
        filterText: a.name,
        kind: L.CompletionItemKind.Class,
        detail: a.text.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d/g, '').trim(),
        documentation: a.doc,
        insertText: a.text,
        insertTextRules: L.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
        sortText: '0',
        command: a.retrigger ? { id: 'editor.action.triggerSuggest', title: '' } : undefined,
        __unityAttr: true,
        __snippet: true,
      }));
    return { suggestions };
  },
});
