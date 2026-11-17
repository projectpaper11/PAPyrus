// Unity message completion (Rider: "Unity event functions"): in the body of a class that derives,
// directly or through the project's own classes, from MonoBehaviour / ScriptableObject / Editor /
// EditorWindow, typing "Upd", "OnTri", "void Aw"... offers Unity's message methods and inserts the
// whole method:
//
//     private void Update()
//     {
//         |
//     }
//
// Messages the class already declares are left out. The base chain is followed through source the
// project has (classSourceLookup, the same lookup as override completion); a base without source is
// matched against well-known Unity / package classes (UI Button, NetworkBehaviour, ...).
import { monaco } from './monaco.js';
import { braceContext } from './unity-completions.js';
import { classes, classSourceLookup } from './override-completions.js';

const MAX_DEPTH = 8;
const CACHE_MS = 30000;

// m = MonoBehaviour, s = ScriptableObject (also Editor / EditorWindow), e = Editor, w = EditorWindow
// co: may also be written as `IEnumerator Name()` (a coroutine)
const MESSAGES = [
  // lifecycle
  { name: 'Awake', in: 'msew', doc: '스크립트 인스턴스가 로드될 때 한 번 호출돼요 (Start보다 먼저).' },
  { name: 'OnEnable', in: 'msew', doc: '오브젝트/컴포넌트가 활성화될 때마다 호출돼요.' },
  { name: 'Start', in: 'm', co: true, doc: '첫 Update 직전에 한 번 호출돼요. IEnumerator로 쓰면 코루틴이 돼요.' },
  { name: 'Update', in: 'mw', doc: '매 프레임 호출돼요.' },
  { name: 'FixedUpdate', in: 'm', doc: '고정 시간 간격(물리 스텝)마다 호출돼요. Rigidbody 처리는 여기서 해요.' },
  { name: 'LateUpdate', in: 'm', doc: '모든 Update가 끝난 뒤 매 프레임 호출돼요. 카메라 추적에 좋아요.' },
  { name: 'OnDisable', in: 'msew', doc: '오브젝트/컴포넌트가 비활성화될 때 호출돼요.' },
  { name: 'OnDestroy', in: 'msew', doc: '오브젝트가 파괴될 때 호출돼요.' },
  { name: 'OnValidate', in: 'ms', doc: '에디터에서 인스펙터 값이 바뀌거나 스크립트가 로드될 때 호출돼요.' },
  { name: 'Reset', in: 'ms', doc: '컴포넌트를 처음 붙이거나 인스펙터에서 Reset을 누를 때 호출돼요.' },
  { name: 'OnApplicationPause', params: 'bool pauseStatus', in: 'm', doc: '앱이 일시정지되거나 다시 실행될 때 호출돼요.' },
  { name: 'OnApplicationFocus', params: 'bool hasFocus', in: 'm', doc: '앱이 포커스를 얻거나 잃을 때 호출돼요.' },
  { name: 'OnApplicationQuit', in: 'm', doc: '앱이 종료되기 직전에 호출돼요.' },
  // physics 3D
  { name: 'OnCollisionEnter', params: 'Collision collision', in: 'm', co: true, doc: '다른 콜라이더/리지드바디와 충돌을 시작할 때 호출돼요.' },
  { name: 'OnCollisionStay', params: 'Collision collision', in: 'm', co: true, doc: '충돌이 이어지는 동안 매 물리 스텝 호출돼요.' },
  { name: 'OnCollisionExit', params: 'Collision collision', in: 'm', co: true, doc: '충돌이 끝날 때 호출돼요.' },
  { name: 'OnTriggerEnter', params: 'Collider other', in: 'm', co: true, doc: '트리거 콜라이더에 들어올 때 호출돼요.' },
  { name: 'OnTriggerStay', params: 'Collider other', in: 'm', co: true, doc: '트리거 안에 머무는 동안 매 물리 스텝 호출돼요.' },
  { name: 'OnTriggerExit', params: 'Collider other', in: 'm', co: true, doc: '트리거에서 나갈 때 호출돼요.' },
  { name: 'OnControllerColliderHit', params: 'ControllerColliderHit hit', in: 'm', doc: 'CharacterController가 Move 중에 콜라이더에 부딪힐 때 호출돼요.' },
  { name: 'OnJointBreak', params: 'float breakForce', in: 'm', doc: '이 오브젝트의 조인트가 끊어질 때 호출돼요.' },
  // physics 2D
  { name: 'OnCollisionEnter2D', params: 'Collision2D collision', in: 'm', co: true, doc: '2D 충돌을 시작할 때 호출돼요.' },
  { name: 'OnCollisionStay2D', params: 'Collision2D collision', in: 'm', co: true, doc: '2D 충돌이 이어지는 동안 호출돼요.' },
  { name: 'OnCollisionExit2D', params: 'Collision2D collision', in: 'm', co: true, doc: '2D 충돌이 끝날 때 호출돼요.' },
  { name: 'OnTriggerEnter2D', params: 'Collider2D other', in: 'm', co: true, doc: '2D 트리거에 들어올 때 호출돼요.' },
  { name: 'OnTriggerStay2D', params: 'Collider2D other', in: 'm', co: true, doc: '2D 트리거 안에 머무는 동안 호출돼요.' },
  { name: 'OnTriggerExit2D', params: 'Collider2D other', in: 'm', co: true, doc: '2D 트리거에서 나갈 때 호출돼요.' },
  { name: 'OnJointBreak2D', params: 'Joint2D brokenJoint', in: 'm', doc: '2D 조인트가 끊어질 때 호출돼요.' },
  // mouse
  { name: 'OnMouseDown', in: 'm', co: true, doc: '콜라이더 위에서 마우스 버튼을 누를 때 호출돼요.' },
  { name: 'OnMouseUp', in: 'm', co: true, doc: '마우스 버튼을 뗄 때 호출돼요.' },
  { name: 'OnMouseUpAsButton', in: 'm', co: true, doc: '누른 콜라이더 위에서 버튼을 뗄 때(클릭) 호출돼요.' },
  { name: 'OnMouseEnter', in: 'm', co: true, doc: '마우스가 콜라이더 위로 들어올 때 호출돼요.' },
  { name: 'OnMouseOver', in: 'm', co: true, doc: '마우스가 콜라이더 위에 있는 동안 매 프레임 호출돼요.' },
  { name: 'OnMouseExit', in: 'm', co: true, doc: '마우스가 콜라이더에서 나갈 때 호출돼요.' },
  { name: 'OnMouseDrag', in: 'm', co: true, doc: '콜라이더를 누른 채 드래그하는 동안 호출돼요.' },
  // rendering
  { name: 'OnBecameVisible', in: 'mw', doc: '렌더러가 어떤 카메라에든 보이기 시작할 때 호출돼요.' },
  { name: 'OnBecameInvisible', in: 'mw', doc: '렌더러가 어떤 카메라에도 안 보이게 될 때 호출돼요.' },
  { name: 'OnWillRenderObject', in: 'm', doc: '오브젝트가 보이는 각 카메라가 렌더링하기 전에 호출돼요.' },
  { name: 'OnRenderObject', in: 'm', doc: '카메라가 씬을 렌더링한 뒤 호출돼요.' },
  { name: 'OnPreCull', in: 'm', doc: '카메라가 컬링하기 전에 호출돼요 (카메라에 붙은 스크립트, 빌트인 파이프라인).' },
  { name: 'OnPreRender', in: 'm', doc: '카메라가 렌더링을 시작하기 전에 호출돼요 (빌트인 파이프라인).' },
  { name: 'OnPostRender', in: 'm', doc: '카메라가 렌더링을 마친 뒤 호출돼요 (빌트인 파이프라인).' },
  { name: 'OnRenderImage', params: 'RenderTexture source, RenderTexture destination', in: 'm', doc: '렌더링된 이미지를 후처리할 때 호출돼요 (빌트인 파이프라인).' },
  { name: 'OnDrawGizmos', in: 'm', doc: '씬 뷰에 기즈모를 그릴 때 매번 호출돼요.' },
  { name: 'OnDrawGizmosSelected', in: 'm', doc: '오브젝트가 선택됐을 때만 기즈모를 그려요.' },
  { name: 'OnGUI', in: 'mw', doc: 'IMGUI를 그리고 이벤트를 처리할 때 호출돼요 (한 프레임에 여러 번).' },
  // animation / particles / audio
  { name: 'OnAnimatorMove', in: 'm', doc: '루트 모션을 직접 처리할 때 호출돼요.' },
  { name: 'OnAnimatorIK', params: 'int layerIndex', in: 'm', doc: 'IK를 설정할 때 호출돼요.' },
  { name: 'OnParticleCollision', params: 'GameObject other', in: 'm', doc: '파티클이 콜라이더에 부딪힐 때 호출돼요.' },
  { name: 'OnParticleTrigger', in: 'm', doc: '파티클 시스템의 트리거 모듈 조건이 맞을 때 호출돼요.' },
  { name: 'OnParticleSystemStopped', in: 'm', doc: '파티클 시스템이 완전히 멈췄을 때 호출돼요.' },
  { name: 'OnAudioFilterRead', params: 'float[] data, int channels', in: 'm', doc: '오디오 버퍼를 직접 가공할 때 호출돼요 (오디오 스레드).' },
  // hierarchy / UI
  { name: 'OnTransformParentChanged', in: 'm', doc: '부모 트랜스폼이 바뀔 때 호출돼요.' },
  { name: 'OnTransformChildrenChanged', in: 'm', doc: '자식 목록이 바뀔 때 호출돼요.' },
  { name: 'OnRectTransformDimensionsChange', in: 'm', doc: 'RectTransform 크기가 바뀔 때 호출돼요.' },
  { name: 'OnCanvasGroupChanged', in: 'm', doc: '부모 CanvasGroup 상태가 바뀔 때 호출돼요.' },
  // Editor
  { name: 'OnSceneGUI', in: 'e', doc: '씬 뷰에서 이 에디터의 핸들/GUI를 그릴 때 호출돼요.' },
  // EditorWindow
  { name: 'CreateGUI', in: 'w', doc: '창의 UI Toolkit 화면을 만들 때 호출돼요.' },
  { name: 'OnFocus', in: 'w', doc: '창이 포커스를 얻을 때 호출돼요.' },
  { name: 'OnLostFocus', in: 'w', doc: '창이 포커스를 잃을 때 호출돼요.' },
  { name: 'OnSelectionChange', in: 'w', doc: '선택한 오브젝트가 바뀔 때 호출돼요.' },
  { name: 'OnHierarchyChange', in: 'w', doc: '하이어라키가 바뀔 때 호출돼요.' },
  { name: 'OnProjectChange', in: 'w', doc: '프로젝트 에셋이 바뀔 때 호출돼요.' },
  { name: 'OnInspectorUpdate', in: 'w', doc: '초당 10번 호출돼요 (인스펙터 갱신 주기).' },
];

// bases without source in the project: Unity / UI / common package classes and what they are
const ROOTS = new Map([
  ['MonoBehaviour', 'm'], ['ScriptableObject', 's'], ['Editor', 'e'], ['EditorWindow', 'w'],
  ['StateMachineBehaviour', ''], ['PlayableBehaviour', ''], // not components; their callbacks are overrides
  ...['UIBehaviour', 'Selectable', 'Button', 'Toggle', 'Slider', 'Scrollbar', 'Dropdown', 'InputField', 'ScrollRect',
    'Graphic', 'MaskableGraphic', 'Image', 'RawImage', 'Text', 'Mask', 'RectMask2D', 'ToggleGroup',
    'LayoutGroup', 'HorizontalOrVerticalLayoutGroup', 'HorizontalLayoutGroup', 'VerticalLayoutGroup', 'GridLayoutGroup',
    'LayoutElement', 'ContentSizeFitter', 'AspectRatioFitter', 'CanvasScaler', 'BaseMeshEffect', 'Shadow', 'Outline',
    'EventTrigger', 'EventSystem', 'BaseInputModule', 'PointerInputModule', 'StandaloneInputModule', 'InputSystemUIInputModule',
    'BaseRaycaster', 'GraphicRaycaster', 'PhysicsRaycaster', 'Physics2DRaycaster',
    'TMP_Text', 'TextMeshProUGUI', 'TextMeshPro', 'TMP_InputField', 'TMP_Dropdown', 'TMP_SubMesh', 'TMP_SubMeshUI',
    'NetworkBehaviour', 'NetworkManager', 'MonoBehaviourPun', 'MonoBehaviourPunCallbacks', 'PlayerInput',
  ].map((n) => [n, 'm']),
  ...['ScriptableSingleton', 'PlayableAsset', 'TileBase', 'Tile', 'RuleTile', 'ScriptableRendererFeature', 'ScriptableRendererData',
    'RenderPipelineAsset', 'VolumeComponent', 'LocalizationTable'].map((n) => [n, 's']),
  ...['ScriptedImporterEditor', 'AssetImporterEditor'].map((n) => [n, 'e']),
]);

// names no project declares itself: no source lookup (a Roslyn round trip) for them
const CORE = new Set(['MonoBehaviour', 'ScriptableObject', 'EditorWindow', 'StateMachineBehaviour', 'PlayableBehaviour']);

const bare = (t) => (t || '').replace(/<.*$/s, '').split('.').pop();

// `[modifiers] [return type] ` before the name being typed
const HEAD = /^\s*((?:(?:public|private|protected|internal|new|async|unsafe)\s+)*)(?:(void|IEnumerator|System\.Collections\.IEnumerator)\s+)?$/;

export function registerUnityMessageCompletion(app) {
  const sourceOf = classSourceLookup(app);
  const cache = new Map(); // class name -> { at, kind }

  /** 'm' / 's' / 'e' / 'w' for a Unity class, '' otherwise. */
  async function kindOf(name, depth = 0, seen = new Set()) {
    name = bare(name);
    if (!name || depth > MAX_DEPTH || seen.has(name)) return '';
    seen.add(name);
    const hit = cache.get(name);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.kind;
    if (CORE.has(name)) return ROOTS.get(name);
    let kind = '';
    const text = await sourceOf(name);
    const cls = text ? classes(text).find((c) => c.name === name) : null;
    if (cls) kind = cls.base ? await kindOf(cls.base, depth + 1, seen) : '';
    else if (ROOTS.has(name)) kind = ROOTS.get(name);
    cache.set(name, { at: Date.now(), kind });
    return kind;
  }

  monaco.languages.registerCompletionItemProvider('csharp', {
    async provideCompletionItems(model, position) {
      const none = { suggestions: [] };
      const line = model.getLineContent(position.lineNumber);
      const word = model.getWordUntilPosition(position);
      const head = HEAD.exec(line.slice(0, word.startColumn - 1));
      if (!head || line.slice(position.column - 1).trim() !== '') return none;
      const upto = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, word.startColumn));
      if (braceContext(upto) !== 'type') return none;

      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const all = classes(text);
      const own = all.filter((c) => c.start < offset && offset < c.end).sort((a, b) => b.start - a.start)[0];
      if (!own || !own.base) return none;
      // the class's own source names (rather than the lookup) decide here: it may not be saved yet
      const base = bare(own.base);
      const kind = ROOTS.has(base) && !all.some((c) => c.name === base) ? ROOTS.get(base) : await kindOf(base, 0, new Set([own.name]));
      if (!kind) return none;
      const kinds = kind === 'e' || kind === 'w' ? kind + 's' : kind;

      // methods the class already has (nested classes' bodies cut out)
      let body = text.slice(own.start + 1, own.end - 1);
      for (const c of all.filter((x) => x.start > own.start && x.end < own.end).sort((a, b) => b.start - a.start)) {
        const s = c.start - own.start - 1;
        if (s >= 0 && s < body.length) body = body.slice(0, s) + body.slice(c.end - own.start - 1);
      }
      const taken = new Set();
      for (const m of body.matchAll(/\b(?:void|IEnumerator|Task|UniTask(?:Void)?|Awaitable)\s+(\w+)\s*\(/g)) taken.add(m[1]);

      const mods = head[1].trim();
      const ret = head[2];
      const coroutine = ret && ret !== 'void';
      const L = monaco.languages;
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
      const suggestions = MESSAGES
        .filter((x) => [...x.in].some((k) => kinds.includes(k)) && !taken.has(x.name) && (!coroutine || x.co))
        .map((x) => {
          const sig = `${x.name}(${x.params || ''})`;
          const prefix = ret ? '' : (mods ? '' : 'private ') + 'void ';
          return {
            label: { label: x.name, detail: `(${x.params || ''})`, description: 'Unity 메시지' },
            kind: L.CompletionItemKind.Method,
            filterText: x.name,
            detail: `${mods ? mods + ' ' : ret ? '' : 'private '}${ret || 'void'} ${sig}`,
            documentation: x.doc,
            insertText: `${prefix}${sig}\n{\n\t$0\n}`,
            insertTextRules: L.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            sortText: '0',
            __unityMsg: true,
            __snippet: true,
          };
        });
      return { suggestions };
    },
  });
}
