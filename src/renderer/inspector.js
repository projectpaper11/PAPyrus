// Inspector dock on the right, Unity style.
// What it shows (the "target"):
//   - an asset (.asset ScriptableObject, .mat): its fields
//   - a scene / prefab file: its hierarchy on top, the selected object's components below
//   - the scenes open in Unity (live)
// Clicking an asset in the explorer previews it here; double-clicking pins it (like Unity's lock).
// Live (Unity connected): data and edits go through PapyrusInspector.cs (SerializedObject + Undo),
// scripts dropped on objects are really added with AddComponent.
// File mode (Unity closed, or a scene/prefab that isn't open in Unity): the YAML is parsed here and
// plain values (numbers, strings, 0/1 flags) are edited by rewriting that one line of the file.
import { el, icon, basename, relPath, samePath, extname, contextMenu, toast, prompt, debounce } from './ui.js';

const O = window.papyrus;
const PATH_MIME = 'application/x-papyrus-path';
const OBJ_MIME = 'application/x-papyrus-object';
const RELOAD_MS = 150;
const RETRY_MAX = 8;
const RETRY_WINDOW_MS = 90000;
const OWN_WRITE_MS = 1500;   // ignore watcher events for a file we just wrote
const HIER_KEY = 'ins:hierH';
const FOLLOW_KEY = 'ins:follow';
const DOCK_KEY = 'ins:dock';
const MIRROR_KEY = 'ins:mirror';
const MIRROR_MOVE_MS = 80;    // hover events sent to Unity at most this often
const WHEEL_SCALE = 1 / 33;   // browser wheel pixels -> Unity scroll delta (3 per notch)
// browser KeyboardEvent.key -> Unity KeyCode name
const UNITY_KEYS = {
  Backspace: 'Backspace', Delete: 'Delete', Enter: 'Return', Tab: 'Tab', Escape: 'Escape', ' ': 'Space',
  ArrowUp: 'UpArrow', ArrowDown: 'DownArrow', ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  '-': 'Minus', '=': 'Equals', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'LeftBracket', ']': 'RightBracket', '\\': 'Backslash', '`': 'BackQuote',
};
function unityKey(e) {
  if (UNITY_KEYS[e.key]) return UNITY_KEYS[e.key];
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase();
  if (/^[0-9]$/.test(e.key)) return 'Alpha' + e.key;
  return '';
}
const unityMods = (e) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
const unityButton = (b) => (b === 2 ? 1 : b === 1 ? 2 : 0);
const INSPECT_EXT = new Set(['.asset', '.prefab', '.unity', '.mat']);

/** Files the explorer shows in the inspector instead of opening them as text. */
export const isInspectable = (p) => INSPECT_EXT.has(extname(p));

// Unity built-in class ids seen in scene / prefab YAML
const CLASS_NAMES = {
  1: 'GameObject', 4: 'Transform', 20: 'Camera', 23: 'Mesh Renderer', 33: 'Mesh Filter', 50: 'Rigidbody 2D', 54: 'Rigidbody',
  56: 'Terrain Collider', 58: 'Circle Collider 2D', 59: 'Hinge Joint', 60: 'Polygon Collider 2D', 61: 'Box Collider 2D',
  64: 'Mesh Collider', 65: 'Box Collider', 66: 'Composite Collider 2D', 68: 'Edge Collider 2D', 70: 'Capsule Collider 2D',
  81: 'Audio Listener', 82: 'Audio Source', 95: 'Animator', 96: 'Trail Renderer', 108: 'Light', 111: 'Animation',
  114: 'MonoBehaviour', 120: 'Line Renderer', 135: 'Sphere Collider', 136: 'Capsule Collider', 137: 'Skinned Mesh Renderer',
  143: 'Character Controller', 195: 'Nav Mesh Agent', 198: 'Particle System', 199: 'Particle System Renderer',
  205: 'LOD Group', 210: 'Sorting Group', 212: 'Sprite Renderer', 215: 'Reflection Probe', 218: 'Terrain', 220: 'Light Probe Group',
  222: 'Canvas Renderer', 223: 'Canvas', 224: 'Rect Transform', 225: 'Canvas Group', 226: 'Billboard Renderer',
  320: 'Playable Director', 331: 'Sprite Mask', 483693784: 'Tilemap Renderer', 1839735485: 'Tilemap', 19719996: 'Tilemap Collider 2D',
  156049354: 'Grid', 1001: 'Prefab Instance', 21: 'Material',
};
const SKIP_FIELDS = new Set(['m_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'm_GameObject',
  'm_Enabled', 'm_EditorHideFlags', 'm_Script', 'm_EditorClassIdentifier', 'serializedVersion']);
const GUID_EXT = new Set(['.cs', '.prefab', '.asset', '.mat', '.anim', '.controller', '.png', '.jpg', '.jpeg', '.psd', '.wav', '.mp3', '.ogg',
  '.unity', '.shader', '.fbx', '.inputactions', '.ttf', '.otf']);

/** "m_moveSpeed" / "_moveSpeed" / "moveSpeed" -> "Move Speed", like ObjectNames.NicifyVariableName */
function nicify(name) {
  let n = name.replace(/^m_/, '').replace(/^_+/, '').replace(/^k(?=[A-Z])/, '');
  n = n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

const toUnityPath = (project, abs) => relPath(project, abs).replace(/\\/g, '/');
const fromUnityPath = (project, p) => (p ? project.replace(/[\\/]+$/, '') + '\\' + p.replace(/\//g, '\\') : null);

export class Inspector {
  constructor(app) {
    this.app = app;
    this.target = null;        // { kind:'live' } | { kind:'scene', path } | { kind:'asset', path }  (absolute paths)
    this.pinned = false;
    this.mode = null;          // 'live' | 'file' — where the current hierarchy / data comes from
    this.filePath = null;      // scene/prefab file shown in file mode
    this.hier = null;          // { scenes:[{name,path,dirty,active,roots:[node]}], truncated, offline }
    this.expanded = new Set(); // node keys
    this.selected = null;      // { id } — object inside the hierarchy (number = live, string = file)
    this.data = null;          // inspector content
    this.error = null;
    this.playMode = false;
    this.folded = new Set();   // component type names collapsed by the user
    this.openProps = new Set(); // "<type>:<path>" of expanded structs/arrays
    this.scripts = null;       // cached script list from Unity
    this.pending = [];         // attach / create requests waiting for Unity to compile
    this.guidMap = null;       // guid -> { name, path, ext } built from .meta files
    this.ownWrites = new Map(); // path -> time of our own YAML writes
    this.follow = (() => { try { return localStorage.getItem(FOLLOW_KEY) !== '0'; } catch { return true; } })();
    this.dockVisible = false;
    // mirror: Unity's real inspector (custom editors), see PapyrusInspectorMirror.cs. On Windows the real
    // window is laid over the body (overlay); elsewhere it is streamed as images.
    this.mirror = (() => { try { return localStorage.getItem(MIRROR_KEY) !== '0'; } catch { return true; } })();
    this.mirrorKey = null;
    this.mirrorSize = null;
    this.overlay = false;
    this.resizeMirrorSoon = debounce(() => this.resizeMirror(), 120);
    this.placeQueued = false;
    this.placed = false;
    this.reloadSoon = debounce(() => this.reload(), RELOAD_MS);
    this.waitingForBlur = false;
    this.loadToken = 0;
    this.build();
  }

  get live() {
    return this.app.unityStatus.state === 'connected';
  }

  get visible() {
    return this.dockVisible;
  }

  // ====================================================================== dock
  restore() {
    let want = false;
    try { want = localStorage.getItem(DOCK_KEY) === '1'; } catch { /* ignore */ }
    if (want) this.showDock();
  }

  resetForProject() {
    this.target = null;
    this.pinned = false;
    this.selected = null;
    this.data = null;
    this.hier = null;
    this.guidMap = null;
    this.scripts = null;
    this.expanded.clear();
    this._defaultScene = undefined;
    this._buildSceneChecked = false;
  }

  showDock(reload = true) {
    const first = !this.dockVisible;
    this.dockVisible = true;
    document.getElementById('rightbar').classList.remove('hidden');
    document.getElementById('resizer-right').classList.remove('hidden');
    document.getElementById('btn-inspector').classList.add('active');
    const body = document.getElementById('rightbar-body');
    if (body.firstChild !== this.view) body.replaceChildren(this.view);
    try { localStorage.setItem(DOCK_KEY, '1'); } catch { /* ignore */ }
    if (!this.target) this.target = { kind: 'live' };
    this.renderHeader();
    if (reload && (first || !this.hier)) this.reload();
  }

  hideDock() {
    this.closeMirror();
    this.dockVisible = false;
    document.getElementById('rightbar').classList.add('hidden');
    document.getElementById('resizer-right').classList.add('hidden');
    document.getElementById('btn-inspector').classList.remove('active');
    try { localStorage.setItem(DOCK_KEY, '0'); } catch { /* ignore */ }
  }

  toggleDock() {
    if (this.dockVisible) this.hideDock();
    else this.showDock();
  }

  /** Single click in the explorer: show the file unless something is pinned. */
  preview(absPath) {
    if (this.pinned && this.dockVisible) {
      // keep the pinned target; hint how to replace it
      const sub = document.getElementById('rightbar-sub');
      sub.classList.remove('ins-flash');
      void sub.offsetWidth;
      sub.classList.add('ins-flash');
      return;
    }
    this.openFile(absPath, false);
  }

  /** Double click in the explorer: show the file and keep it. */
  pin(absPath) {
    this.openFile(absPath, true);
  }

  openFile(absPath, pin) {
    const ext = extname(absPath);
    this.setTarget(ext === '.unity' || ext === '.prefab' ? { kind: 'scene', path: absPath } : { kind: 'asset', path: absPath }, pin);
  }

  showLiveScene(pin = this.pinned) {
    this.setTarget({ kind: 'live' }, pin);
  }

  setTarget(t, pin) {
    const same = this.target && t.kind === this.target.kind && samePath(t.path || '', this.target.path || '');
    if (!same) {
      this.target = t;
      this.selected = null;
      this.data = null;
      this.hier = null;
    }
    if (pin != null) this.pinned = pin;
    this.showDock(false);
    this.renderHeader();
    if (!same || !this.hier) this.reload();
  }

  // ====================================================================== DOM
  build() {
    this.hierEl = el('div.ins-hier', {
      tabindex: '0', // takes the keyboard after a click on a row: Delete / F2 like Unity's hierarchy
      onkeydown: (e) => {
        const id = this.selected && this.selected.id;
        if (typeof id !== 'number' || !this.live || this.mode !== 'live') return;
        const label = this.hierEl.querySelector(`.ins-row[data-key="${id}"] .label`);
        const name = label ? label.textContent : '';
        if (e.key === 'Delete') {
          e.preventDefault();
          this.deleteObject(id, name);
        } else if (e.key === 'F2') {
          e.preventDefault();
          this.renameObject(id, name);
        }
      },
      ondragover: (e) => this.acceptDrag(e, ['.cs']),
      ondrop: (e) => {
        // dropped on empty space: new root object carrying the script
        const p = this.draggedPath(e);
        if (!p) return;
        e.preventDefault();
        this.createObject({ parent: 0, scriptPath: p });
      },
    });
    this.bodyEl = el('div.ins-body', {
      ondragover: (e) => this.acceptDrag(e, ['.cs']),
      ondrop: (e) => {
        if (e.target.closest('.ins-objfield')) return;
        const p = this.draggedPath(e);
        if (!p) return;
        e.preventDefault();
        if (this.data && this.data.kind === 'GameObject' && !this.data.file) this.attachScript(this.data.id, p);
        else toast({ kind: 'warn', title: '스크립트는 Unity에 열린 씬의 오브젝트에 붙일 수 있어요', timeout: 3000 });
      },
      onfocusout: () => setTimeout(() => {
        if (this.waitingForBlur && !this.editing()) {
          this.waitingForBlur = false;
          this.reload();
        }
      }),
    });
    const split = el('div.ins-split');
    split.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this.hierEl.getBoundingClientRect().height;
      const total = this.view.getBoundingClientRect().height;
      const move = (ev) => {
        const h = Math.max(60, Math.min(total - 80, startH + ev.clientY - startY));
        this.view.style.setProperty('--ins-hier-h', h + 'px');
        try { localStorage.setItem(HIER_KEY, String(h)); } catch { /* ignore */ }
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
      };
      document.body.style.cursor = 'row-resize';
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.bannerEl = el('div.ins-banner.hidden');
    this.view = el('div.inspector-view', null, this.bannerEl, this.hierEl, split, this.bodyEl);
    this.buildMirror();
    new ResizeObserver(() => {
      if (this.mirrorKey) {
        this.resizeMirrorSoon();
        this.placeMirrorSoon();
      } else if (this.bodyEl.classList.contains('mirror') && this.useMirror(this.data)) this.renderMirror(this.data); // was too small to open
    }).observe(this.bodyEl);
    // the overlaid Unity window follows the body, and steps aside for the IDE's own menus and dialogs
    window.addEventListener('resize', () => this.placeMirrorSoon());
    new MutationObserver(() => this.placeMirrorSoon()).observe(document.getElementById('overlay-root'), { childList: true });
    try {
      const h = parseInt(localStorage.getItem(HIER_KEY) || '', 10);
      if (h > 0) this.view.style.setProperty('--ins-hier-h', h + 'px');
    } catch { /* ignore */ }
  }

  renderHeader() {
    if (!this.dockVisible) return;
    const t = this.target;
    const title = !t ? '인스펙터'
      : t.kind === 'live' ? (this.live ? 'Unity 씬' : '씬')
        : basename(t.path);
    document.getElementById('rightbar-title').textContent = title;
    const sub = document.getElementById('rightbar-sub');
    sub.textContent = this.pinned ? '고정됨' : '미리보기 · 더블클릭하면 고정';
    sub.className = 'tw-sub ' + (this.pinned ? 'pinned' : 'preview');
    sub.title = this.pinned ? '자물쇠를 풀면 탐색기에서 클릭한 항목이 바로 보여요' : '탐색기에서 더블클릭하거나 자물쇠를 누르면 고정돼요';
    const lockBtn = el('button.tb-btn.icon.small' + (this.pinned ? '.on' : ''), {
      title: this.pinned ? '고정 풀기' : '고정',
      onclick: () => { this.pinned = !this.pinned; this.renderHeader(); },
    }, icon(this.pinned ? 'lock' : 'unlock'));
    const followBtn = el('button.tb-btn.icon.small' + (this.follow ? '.on' : ''), {
      title: 'Unity 선택 따라가기',
      onclick: () => {
        this.follow = !this.follow;
        try { localStorage.setItem(FOLLOW_KEY, this.follow ? '1' : '0'); } catch { /* ignore */ }
        this.renderHeader();
      },
    }, icon('link'));
    const mirrorBtn = el('button.tb-btn.icon.small' + (this.mirror ? '.on' : ''), {
      title: this.mirror ? 'Unity 인스펙터 화면 (커스텀 에디터 적용) — 누르면 간단 보기' : '간단 보기 — 누르면 Unity 인스펙터 화면 (커스텀 에디터 적용)',
      onclick: () => this.setMirror(!this.mirror),
    }, icon('window'));
    document.getElementById('rightbar-actions').replaceChildren(
      lockBtn,
      mirrorBtn,
      el('button.tb-btn.icon.small', { title: '씬 고르기', onclick: (e) => this.sceneMenu(e.currentTarget) }, icon('symbol-namespace')),
      el('button.tb-btn.icon.small', { title: '빈 오브젝트 만들기 (Unity에 열린 씬)', onclick: () => this.createObject({ parent: 0 }) }, icon('add')),
      followBtn,
      el('button.tb-btn.icon.small', { title: '새로고침', onclick: () => { this.guidMap = null; this.scripts = null; this.reload(); } }, icon('refresh')),
      el('button.tb-btn.icon.small', { title: '닫기', onclick: () => this.hideDock() }, icon('close')));
  }

  editing() {
    const a = document.activeElement;
    return !!(a && this.bodyEl.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  // ====================================================================== events from the app
  onStatus(st, was) {
    if (st.state === 'connected' && was !== 'connected') {
      this.scripts = null;
      this.retryPending();
    }
    if (st.state !== 'connected' && was === 'connected') {
      this.app.rejectUnityRequests('Unity와 연결이 끊어졌어요.');
      this.mirrorGone(); // Unity closes its window on reload / quit; reopened after reconnecting
    }
    if (this.visible && (st.state === 'connected') !== (was === 'connected')) {
      this.renderHeader();
      this.reload();
    }
  }

  onUnityMessage(msg) {
    switch (msg.type) {
      case 'inspector.mirrorFrame':
        if (!this.mirrorKey) return;
        this.mirrorImg.src = 'data:image/png;base64,' + msg.png;
        this.mirrorImg.style.width = msg.w / (msg.ppp || 1) + 'px';
        this.mirrorImg.style.height = msg.h / (msg.ppp || 1) + 'px';
        this.setMirrorStatus(null);
        break;
      case 'inspector.mirrorOverlay':
        // the real Unity window now sits on the body: nothing to draw here
        if (!this.mirrorKey) return;
        this.overlay = true;
        this.mirrorImg.removeAttribute('src');
        this.setMirrorStatus(null);
        this.placeMirror();
        break;
      case 'inspector.mirrorClosed':
        if (!this.mirrorKey) return;
        this.mirrorGone();
        this.setMirrorStatus(msg.error || 'Unity에 띄운 인스펙터 창이 닫혔어요.', [
          { label: '다시 열기', action: () => this.renderBody() },
          { label: '간단 보기', action: () => this.setMirror(false) },
        ]);
        break;
      case 'inspector.changed':
        if (!this.visible || this.mode !== 'live') return;
        if (this.editing()) this.waitingForBlur = true;
        else this.reloadSoon();
        break;
      case 'inspector.selection':
        if (!this.follow || this.pinned || !msg.target) return;
        if (msg.kind === 'GameObject') {
          if (this.selected && this.selected.id === msg.target) return;
          if (this.mode !== 'live' || !this.target || this.target.kind === 'asset') {
            this.target = { kind: 'live' };
            this.hier = null;
          }
          this.selected = { id: msg.target };
          if (this.visible) this.reload();
        } else if (msg.assetPath && /^(Assets|Packages)\//.test(msg.assetPath)) {
          const abs = fromUnityPath(this.app.project, msg.assetPath);
          if (!isInspectable(abs)) return;
          if (this.target && this.target.path && samePath(this.target.path, abs)) return;
          if (this.visible) this.openFile(abs, false);
        }
        break;
      case 'compileFinished':
        this.scripts = null;
        // the domain reload after a compile reconnects the bridge, which retries too
        if (msg.errors === 0) setTimeout(() => this.retryPending(), 1500);
        else if (this.pending.length) {
          toast({ kind: 'error', title: '컴파일 에러가 있어서 스크립트를 아직 못 붙였어요', message: '에러를 고치고 저장하면 다시 시도해요.', timeout: 4000 });
        }
        break;
      case 'state':
        if (this.lastCompiling && !msg.isCompiling) setTimeout(() => this.retryPending(), 800);
        this.lastCompiling = !!msg.isCompiling;
        break;
      default:
        break;
    }
  }

  /** File watcher: re-read the shown file when it changes on disk (Unity saved it, git, ...). */
  onFilesChanged(paths) {
    if (!this.visible || this.mode !== 'file') return;
    const shown = this.target && this.target.kind === 'asset' ? this.target.path : this.filePath;
    if (!shown || !paths.some((p) => samePath(p, shown))) return;
    const own = this.ownWrites.get(shown.toLowerCase());
    if (own && Date.now() - own < OWN_WRITE_MS) return;
    if (this.editing()) this.waitingForBlur = true;
    else this.reloadSoon();
  }

  // ====================================================================== loading
  async reload() {
    if (!this.visible || !this.app.project) return;
    const token = ++this.loadToken;
    const t = this.target || { kind: 'live' };
    this.renderHeader();
    try {
      if (t.kind === 'asset') {
        this.hier = null;
        this.mode = this.live ? 'live' : 'file';
      } else {
        let live = null;
        if (this.live && (t.kind === 'live' || extname(t.path) === '.unity')) {
          live = await this.app.unityRequest('inspector.hierarchy');
          // a scene file that isn't open in Unity is shown from the file instead
          if (t.kind === 'scene' && !live.scenes.some((s) => s.path && samePath(fromUnityPath(this.app.project, s.path), t.path))) live = null;
        }
        if (live) {
          this.hier = live;
          this.mode = 'live';
          this.filePath = null;
          if (!this.expandedLive) {
            this.expandedLive = true;
            live.scenes.forEach((s) => this.expanded.add('scene:' + s.path));
          }
        } else {
          const path = t.kind === 'scene' ? t.path : await this.defaultScenePath();
          this.filePath = path;
          this.mode = 'file';
          this.hier = path ? await this.loadFileHierarchy(path) : { scenes: [], offline: true };
        }
      }
      this.error = null;
    } catch (err) {
      this.hier = null;
      this.error = String(err.message || err);
    }
    if (token !== this.loadToken) return;
    this.view.classList.toggle('no-hier', t.kind === 'asset');
    this.renderBanner();
    this.renderHierarchy();
    if (this.selected) this.revealNode(this.selected.id);
    await this.loadSelected(token);
  }

  async loadSelected(token = this.loadToken) {
    const t = this.target || { kind: 'live' };
    try {
      if (t.kind === 'asset') {
        if (this.mode === 'live') {
          try {
            this.data = await this.app.unityRequest('inspector.asset', { path: toUnityPath(this.app.project, t.path) });
          } catch (err) {
            if (err.code === 'disconnected') throw err;
            this.data = await this.fileAsset(t.path); // not imported yet / not a Unity asset: read the file
          }
        } else {
          this.data = await this.fileAsset(t.path);
        }
      } else if (!this.selected) {
        this.data = null;
      } else if (typeof this.selected.id === 'string') {
        this.data = this.fileObject(this.selected.id);
      } else {
        this.data = await this.app.unityRequest('inspector.object', { target: this.selected.id });
      }
      this.error = null;
    } catch (err) {
      this.data = null;
      this.error = String(err.message || err);
    }
    if (token !== this.loadToken) return;
    this.renderBody();
  }

  async selectObject(id, { fromUnity = false } = {}) {
    this.selected = { id };
    this.markSelectedRow();
    this.loadToken++;
    await this.loadSelected();
    this.revealNode(id);
    if (!fromUnity && this.follow && this.live && typeof id === 'number') {
      this.app.unityRequest('inspector.select', { target: id }).catch(() => {});
    }
  }

  // ====================================================================== banner
  renderBanner() {
    let text = null;
    let action = null;
    let play = false;
    const t = this.target || { kind: 'live' };
    if (this.mode === 'file') {
      const st = this.app.unityStatus;
      if (this.live) {
        text = t.kind === 'scene' && extname(t.path) === '.unity'
          ? 'Unity에 열려 있지 않은 씬이라 파일을 직접 고쳐요. 숫자·글자 값만 바꿀 수 있어요.'
          : '파일을 직접 고쳐요. 숫자·글자 값만 바꿀 수 있어요.';
        if (t.kind !== 'asset') action = el('span.link', { onclick: () => this.showLiveScene() }, 'Unity 씬 보기');
      } else {
        text = st.state === 'reloading' || st.state === 'connecting'
          ? 'Unity가 스크립트를 다시 불러오는 중이에요…'
          : 'Unity가 꺼져 있어 파일을 직접 고쳐요. 숫자·글자 값만 바꿀 수 있고, 스크립트 붙이기는 Unity를 켜야 돼요.';
        if (st.state === 'disconnected' && st.isUnityProject && !st.packageInstalled) {
          action = el('span.link', { onclick: () => this.app.installUnityPackage() }, 'Unity 패키지 설치');
        }
      }
    } else if (this.mode === 'live' && this.playMode) {
      text = '플레이 모드예요. 여기서 바꾼 값은 정지하면 되돌아가요.';
      play = true;
    }
    this.bannerEl.classList.toggle('hidden', !text);
    this.bannerEl.classList.toggle('play', play);
    this.bannerEl.replaceChildren(...(text ? [icon(play ? 'debug-alt' : 'info'), el('span', null, text), action] : []));
  }

  // ====================================================================== hierarchy
  renderHierarchy() {
    const frag = document.createDocumentFragment();
    if (!this.hier) {
      if ((this.target || {}).kind !== 'asset') frag.append(el('div.ins-empty', null, this.error || '불러오는 중…'));
      this.hierEl.replaceChildren(frag);
      return;
    }
    const liveH = this.mode === 'live';
    if (!this.hier.scenes.length) frag.append(el('div.ins-empty', null, liveH ? '열린 씬이 없어요.' : '프로젝트에 씬이 없어요.'));
    for (const scene of this.hier.scenes) {
      const key = 'scene:' + scene.path;
      const open = this.expanded.has(key);
      frag.append(el('div.ins-row.scene' + (scene.active ? '.active-scene' : ''), {
        style: { paddingLeft: '4px' },
        onclick: () => this.toggle(key),
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: '빈 오브젝트 만들기', icon: 'add', disabled: !liveH, action: () => this.createObject({ parent: 0 }) },
            { label: '스크립트로 오브젝트 만들기…', icon: 'symbol-class', disabled: !liveH, action: () => this.pickAndCreate(0) },
            '-',
            { label: '탐색기에서 보기', icon: 'go-to-file', disabled: !scene.path, action: () => this.app.explorer.reveal(fromUnityPath(this.app.project, scene.path)) },
            { label: '텍스트로 열기', icon: 'file-code', disabled: !scene.path, action: () => this.app.editors.open(fromUnityPath(this.app.project, scene.path)) },
          ]);
        },
      },
      el('span.twisty', null, icon(open ? 'chevron-down' : 'chevron-right')),
      el('span.ins-scene-icon', null, icon(scene.prefabFile ? 'package' : 'symbol-namespace')),
      el('span.label', null, scene.name + (scene.dirty ? '*' : '')),
      scene.loaded === false ? el('span.hint', null, '(언로드됨)') : null));
      if (open) for (const n of scene.roots) this.appendNode(frag, n, 1);
    }
    if (this.hier.truncated) frag.append(el('div.ins-empty', null, '오브젝트가 너무 많아 일부만 보여요.'));
    this.hierEl.replaceChildren(frag);
  }

  appendNode(frag, n, depth) {
    const key = String(n.id);
    const open = this.expanded.has(key);
    const has = n.children.length > 0 || n.more > 0;
    const isSel = this.selected && String(this.selected.id) === key;
    const liveNode = typeof n.id === 'number';
    const row = el('div.ins-row' + (isSel ? '.selected' : '') + (n.active === false ? '.inactive' : '') + (n.prefab ? '.prefab' : ''), {
      style: { paddingLeft: 4 + depth * 14 + 'px' },
      'data-key': key,
      draggable: liveNode ? 'true' : null,
      onmousedown: (e) => {
        if (e.button !== 0) return;
        this.hierEl.focus({ preventScroll: true });
        if (e.target.closest('.twisty')) {
          this.toggle(key);
          return;
        }
        this.selectObject(n.id);
      },
      ondblclick: (e) => {
        if (e.target.closest('.twisty')) return;
        if (has) this.toggle(key);
      },
      ondragstart: (e) => {
        e.dataTransfer.setData(OBJ_MIME, String(n.id));
        e.dataTransfer.setData('text/plain', n.name);
        e.dataTransfer.effectAllowed = 'link';
      },
      ondragover: (e) => {
        if (this.acceptDrag(e, ['.cs'])) row.classList.add('drop');
      },
      ondragleave: () => row.classList.remove('drop'),
      ondrop: (e) => {
        row.classList.remove('drop');
        const p = this.draggedPath(e);
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        if (!liveNode) {
          toast({ kind: 'warn', title: '스크립트는 Unity에 열린 씬의 오브젝트에 붙일 수 있어요', timeout: 3000 });
          return;
        }
        this.attachScript(n.id, p);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        this.selectObject(n.id);
        this.nodeMenu(n, e.clientX, e.clientY);
      },
    },
    el('span.twisty', null, has ? icon(open ? 'chevron-down' : 'chevron-right') : null),
    el('span.ins-go-icon', null, icon(n.prefab ? 'package' : 'symbol-misc')),
    el('span.label', null, n.name));
    frag.append(row);
    if (open) {
      for (const c of n.children) this.appendNode(frag, c, depth + 1);
      if (n.more) frag.append(el('div.ins-row.more', { style: { paddingLeft: 4 + (depth + 1) * 14 + 'px' } }, `… ${n.more}개 더`));
    }
  }

  nodeMenu(n, x, y) {
    const live = typeof n.id === 'number' && this.live;
    contextMenu(x, y, [
      { label: '스크립트 붙이기…', icon: 'symbol-class', disabled: !live, action: () => this.pickAndAttach(n.id) },
      this.currentScript() ? { label: `'${basename(this.currentScript())}' 붙이기`, icon: 'file-code', disabled: !live, action: () => this.attachScript(n.id, this.currentScript()) } : null,
      '-',
      { label: '빈 자식 오브젝트 만들기', icon: 'add', disabled: !live, action: () => this.createObject({ parent: n.id }) },
      { label: '스크립트로 자식 오브젝트 만들기…', icon: 'symbol-class', disabled: !live, action: () => this.pickAndCreate(n.id) },
      '-',
      { label: '이름 바꾸기…', icon: 'edit', key: 'F2', disabled: !live, action: () => this.renameObject(n.id, n.name) },
      { label: n.active === false ? '활성화' : '비활성화', icon: n.active === false ? 'eye' : 'eye-closed', disabled: !live, action: () => this.edit('inspector.setActive', { target: n.id, value: n.active === false ? 'true' : 'false' }) },
      '-',
      { label: 'Unity에서 선택', icon: 'target', disabled: !live, action: () => this.app.unityRequest('inspector.select', { target: n.id }).catch((err) => this.fail(err)) },
      '-',
      { label: '삭제', icon: 'trash', key: 'Delete', disabled: !live, action: () => this.deleteObject(n.id, n.name) },
    ]);
  }

  /** Delete a scene object in Unity (with Undo, like Unity's own Delete). */
  async deleteObject(id, name) {
    try {
      await this.app.unityRequest('inspector.delete', { target: id });
    } catch (err) {
      this.fail(err);
      return;
    }
    if (this.selected && this.selected.id === id) this.selected = null;
    this.reloadSoon();
    toast({
      title: `'${name || '오브젝트'}' 삭제됨`,
      timeout: 4000,
      actions: [{ label: '실행 취소', action: () => this.app.unityRequest('inspector.undo', {}).then(() => this.reloadSoon(), (err) => this.fail(err)) }],
    });
  }

  toggle(key) {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.renderHierarchy();
  }

  markSelectedRow() {
    const key = this.selected ? String(this.selected.id) : null;
    this.hierEl.querySelectorAll('.ins-row.selected').forEach((r) => r.classList.remove('selected'));
    if (key == null) return;
    const row = this.hierEl.querySelector(`.ins-row[data-key="${CSS.escape(key)}"]`);
    if (row) row.classList.add('selected');
  }

  /** Expand the parents of a node and scroll it into view. */
  revealNode(id) {
    if (!this.hier) return;
    const key = String(id);
    let chain = null;
    const find = (nodes, path) => {
      for (const n of nodes) {
        if (String(n.id) === key) {
          chain = path;
          return true;
        }
        if (find(n.children, [...path, String(n.id)])) return true;
      }
      return false;
    };
    for (const s of this.hier.scenes) {
      if (find(s.roots, ['scene:' + s.path])) break;
    }
    if (!chain) return;
    let changed = false;
    for (const k of chain) {
      if (!this.expanded.has(k)) {
        this.expanded.add(k);
        changed = true;
      }
    }
    if (changed) this.renderHierarchy();
    else this.markSelectedRow();
    const row = this.hierEl.querySelector(`.ins-row[data-key="${CSS.escape(key)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  sceneMenu(anchor) {
    const scenes = this.app.fileIndex.filter((p) => extname(p) === '.unity').sort((a, b) => basename(a).localeCompare(basename(b)));
    const b = anchor.getBoundingClientRect();
    const t = this.target || {};
    contextMenu(b.left, b.bottom + 2, [
      this.live ? { label: 'Unity에 열린 씬', icon: t.kind === 'live' && this.mode === 'live' ? 'check' : 'blank', action: () => this.showLiveScene() } : null,
      this.live ? '-' : null,
      ...(scenes.length ? scenes.slice(0, 40).map((p) => ({
        label: relPath(this.app.project, p).replace(/\\/g, '/').replace(/^Assets\//, ''),
        icon: this.mode === 'file' && samePath(p, this.filePath) ? 'check' : 'blank',
        action: () => this.openFile(p, this.pinned),
      })) : [{ label: '씬 파일이 없어요', disabled: true }]),
    ]);
  }

  // ====================================================================== inspector body
  renderBody() {
    if (this.data && typeof this.data.playMode === 'boolean') {
      const was = this.playMode;
      this.playMode = this.data.playMode;
      if (was !== this.playMode) this.renderBanner();
    }
    const d = this.data;
    if (this.useMirror(d)) {
      this.renderMirror(d);
      return;
    }
    this.bodyEl.classList.remove('mirror');
    this.closeMirror();
    if (!d) {
      const t = this.target || {};
      const msg = this.error && (this.selected || t.kind === 'asset') ? this.error
        : '위의 하이라키에서 오브젝트를 고르세요.\n탐색기에서 .asset(ScriptableObject)·.prefab·.unity 파일을 클릭하면 여기에 보이고, 더블클릭하면 고정돼요.';
      this.bodyEl.replaceChildren(el('div.ins-empty.big', { style: { whiteSpace: 'pre-line' } }, msg));
      return;
    }
    const fileMode = !!d.file;
    const ro = fileMode || !this.live; // live-only controls
    const head = el('div.ins-head', null,
      d.kind === 'GameObject'
        ? el('input', {
          type: 'checkbox', checked: d.active !== false, title: '활성',
          disabled: fileMode ? !d.activeProp : ro,
          onchange: (e) => {
            if (fileMode) this.writeYaml(d.activeProp, e.target.checked ? '1' : '0');
            else this.edit('inspector.setActive', { target: d.id, value: e.target.checked ? 'true' : 'false' });
          },
        })
        : el('span.ins-kind-icon', null, icon(d.kind === 'ScriptableObject' ? 'symbol-structure' : 'file')),
      el('input.ins-name', {
        type: 'text', value: d.name, spellcheck: 'false',
        disabled: fileMode ? !d.nameProp : ro || d.kind !== 'GameObject' && !d.assetPath,
        onkeydown: (e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') { e.target.value = d.name; e.target.blur(); }
          e.stopPropagation();
        },
        onchange: (e) => {
          const v = e.target.value.trim();
          if (!v || v === d.name) return;
          if (fileMode) this.writeYaml(d.nameProp, v, 'string');
          else this.edit('inspector.rename', { target: d.id, name: v });
        },
      }),
      !ro ? el('button.tb-btn.icon.small', { title: 'Unity에서 선택', onclick: () => this.app.unityRequest('inspector.select', { target: d.id, path: d.assetPath }).catch((err) => this.fail(err)) }, icon('target')) : null);
    const meta = d.kind === 'GameObject'
      ? el('div.ins-meta', null,
        el('span', null, '태그 ', el('b', null, d.tag || 'Untagged')),
        el('span', null, '레이어 ', el('b', null, d.layer || 'Default')),
        d.scene ? el('span', null, '씬 ', el('b', null, d.scene)) : null)
      : el('div.ins-meta', null, el('span', null, d.kind),
        d.assetPath ? el('span.link', { onclick: () => this.app.explorer.reveal(fromUnityPath(this.app.project, d.assetPath)) }, d.assetPath) : null,
        d.assetPath ? el('span.link', { onclick: () => this.app.editors.open(fromUnityPath(this.app.project, d.assetPath)) }, '텍스트로 열기') : null);
    const cards = d.components.map((c) => this.componentCard(c, d, ro));
    const add = d.kind === 'GameObject' && !ro
      ? el('div.ins-add', null,
        el('button.btn', { onclick: () => this.pickAndAttach(d.id) }, icon('add'), '컴포넌트 추가'),
        el('div.ins-drop-hint', null, '탐색기에서 .cs 파일을 여기로 끌어와도 붙어요'))
      : null;
    this.bodyEl.replaceChildren(head, meta, ...cards, add);
  }

  componentCard(c, owner, ro) {
    const key = c.typeName || c.type;
    const folded = this.folded.has(key);
    const scriptAbs = c.script ? fromUnityPath(this.app.project, c.script) : null;
    const fileMode = !!c.file;
    const head = el('div.ins-comp-head', {
      onclick: (e) => {
        if (e.target.closest('input,button,.link')) return;
        if (folded) this.folded.delete(key);
        else this.folded.add(key);
        this.renderBody();
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: '스크립트 열기', icon: 'go-to-file', disabled: !scriptAbs, action: () => this.openRef(scriptAbs) },
          { label: 'Unity에서 선택', icon: 'target', disabled: ro || !c.id, action: () => this.app.unityRequest('inspector.select', { target: c.id }).catch((err) => this.fail(err)) },
          '-',
          { label: '컴포넌트 제거', icon: 'trash', disabled: ro || !c.canRemove, action: () => this.edit('inspector.removeComponent', { target: c.id }) },
        ]);
      },
    },
    el('span.twisty', null, icon(folded ? 'chevron-right' : 'chevron-down')),
    c.enabled === true || c.enabled === false
      ? el('input', {
        type: 'checkbox', checked: c.enabled, title: '사용',
        disabled: fileMode ? !c.enabledProp : ro,
        onchange: (e) => {
          if (fileMode) this.writeYaml(c.enabledProp, e.target.checked ? '1' : '0');
          else this.setProp(c, { path: 'm_Enabled', type: 'bool' }, e.target.checked ? 'true' : 'false');
        },
      })
      : null,
    el('span.ins-comp-icon', null, icon(c.missing ? 'warning' : c.script ? 'file-code' : 'symbol-property')),
    el('span.ins-comp-title' + (c.missing ? '.missing' : ''), null, c.type),
    scriptAbs ? el('span.link.ins-script', { title: c.script, onclick: () => this.openRef(scriptAbs) }, basename(c.script)) : null,
    !ro && c.canRemove ? el('button.tb-btn.icon.small', { title: '컴포넌트 제거', onclick: () => this.edit('inspector.removeComponent', { target: c.id }) }, icon('close')) : null);
    if (folded) return el('div.ins-comp.folded', null, head);
    const rows = [];
    let hideBelow = Infinity; // depth below which rows are inside a collapsed struct/array
    for (const p of c.props) {
      if (p.depth > hideBelow) continue;
      hideBelow = Infinity;
      rows.push(this.propRow(c, p, ro));
      if (p.type === 'struct' || p.type === 'array') {
        if (!this.openProps.has(key + ':' + p.path)) hideBelow = p.depth;
      }
    }
    if (!c.props.length) rows.push(el('div.ins-noprops', null, c.missing ? '스크립트를 찾을 수 없어요. 파일이 지워졌거나 클래스 이름이 바뀌었을 수 있어요.' : '표시할 값이 없어요'));
    return el('div.ins-comp', null, head, el('div.ins-props', null, rows));
  }

  propRow(c, p, ro) {
    const fileProp = !!p.yaml;
    const editable = fileProp ? !!p.editable : !ro && p.editable;
    const key = (c.typeName || c.type) + ':' + p.path;
    const indent = { paddingLeft: 8 + p.depth * 12 + 'px' };
    const label = el('span.ins-label', { title: p.tooltip || p.path, style: indent }, p.label);
    if (p.type === 'struct' || p.type === 'array') {
      const open = this.openProps.has(key);
      label.prepend(icon(open ? 'chevron-down' : 'chevron-right'));
      label.classList.add('fold');
      label.onclick = () => {
        if (open) this.openProps.delete(key);
        else this.openProps.add(key);
        this.renderBody();
      };
      if (p.type === 'struct' || fileProp) return el('div.ins-prop.group', null, label, fileProp && p.count ? el('span.ins-raw.dim', null, `${p.count}개`) : null);
      return el('div.ins-prop.group', null, label, this.numberInput(p.value, true, editable, (v) => this.setProp(c, { path: p.path + '.Array.size', type: 'int' }, v), '크기'));
    }
    let field;
    switch (p.type) {
      case 'bool':
        field = el('input', { type: 'checkbox', checked: !!p.value, disabled: !editable, onchange: (e) => this.setProp(c, p, e.target.checked ? 'true' : 'false') });
        break;
      case 'int':
      case 'float':
        field = this.numberInput(p.value, p.type === 'int', editable, (v) => this.setProp(c, p, v));
        this.scrub(label, field, p.type === 'int', editable);
        break;
      case 'string':
        field = this.textInput(p.value, editable, (v) => this.setProp(c, p, v));
        break;
      case 'enum': {
        const names = (p.value && p.value.names) || [];
        field = el('select', { disabled: !editable, onchange: (e) => this.setProp(c, p, e.target.value) },
          names.map((n, i) => el('option', { value: String(i), selected: i === p.value.index }, n)));
        if (p.value && p.value.index < 0) field.prepend(el('option', { value: '-1', selected: true }, '(여러 값 / 플래그)'));
        break;
      }
      case 'color':
        field = this.colorInput(p.value, editable, (v) => this.setProp(c, p, v));
        break;
      case 'vector':
      case 'vectorInt':
      case 'euler':
        field = this.vectorInput(p, editable, (v) => this.setProp(c, p, v));
        break;
      case 'object':
        field = this.objectField(c, p, editable);
        break;
      case 'yamlNum':
        field = this.numberInput(p.value, false, editable, (v) => this.writeYaml(p, v, 'number'));
        field.classList.add('ins-yaml-num');
        this.scrub(label, field, Number.isInteger(p.value), editable);
        break;
      case 'yamlStr':
        field = this.textInput(p.value, editable, (v) => this.writeYaml(p, v, 'string'));
        break;
      case 'yamlVec':
        field = this.yamlVector(p);
        break;
      default:
        field = el('span.ins-raw' + (p.ref ? '' : '.dim'), { title: String(p.value == null ? '' : p.value) }, String(p.value == null ? '' : p.value));
        break;
    }
    return el('div.ins-prop' + (editable ? '' : '.ro'), null, label, el('div.ins-field', null, field));
  }

  numberInput(value, isInt, editable, commit, placeholder) {
    const fmt = (v) => (v == null ? '' : String(v));
    const input = el('input.ins-num', { type: 'text', value: fmt(value), disabled: !editable, placeholder: placeholder || '', spellcheck: 'false' });
    const done = () => {
      const raw = input.value.trim().replace(',', '.');
      let n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) {
        input.value = fmt(value);
        return;
      }
      if (isInt) n = Math.round(n);
      if (n === value) return;
      value = n;
      input.value = fmt(n);
      commit(String(n));
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { done(); input.select(); }
      if (e.key === 'Escape') { input.value = fmt(value); input.blur(); }
      e.stopPropagation();
    });
    input.addEventListener('change', done);
    input.commitValue = (n) => { input.value = fmt(n); done(); };
    return input;
  }

  /** Drag on a number field's label to change it, like Unity. */
  scrub(label, input, isInt, editable) {
    if (!editable) return;
    label.classList.add('scrub');
    label.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = Number(input.value) || 0;
      const x0 = e.clientX;
      const step = isInt ? 0.5 : Math.max(0.01, Math.abs(start) * 0.01);
      let moved = false;
      const move = (ev) => {
        moved = true;
        const d = (ev.clientX - x0) * step * (ev.shiftKey ? 10 : 1) * (ev.altKey ? 0.1 : 1);
        const v = isInt ? Math.round(start + d) : Math.round((start + d) * 1000) / 1000;
        input.value = String(v);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        if (moved) input.commitValue(Number(input.value));
      };
      document.body.style.cursor = 'ew-resize';
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  textInput(value, editable, commit) {
    const multi = typeof value === 'string' && value.includes('\n');
    const input = el(multi ? 'textarea.ins-text' : 'input.ins-text', { type: multi ? null : 'text', disabled: !editable, spellcheck: 'false', rows: multi ? 3 : null });
    input.value = value || '';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multi) input.blur();
      if (e.key === 'Escape') { input.value = value || ''; input.blur(); }
      e.stopPropagation();
    });
    input.addEventListener('change', () => {
      if (input.value === value) return;
      value = input.value;
      commit(input.value);
    });
    return input;
  }

  colorInput(rgba, editable, commit) {
    const [r, g, b, a] = rgba || [0, 0, 0, 1];
    const hex = '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
    const picker = el('input.ins-color', { type: 'color', value: hex, disabled: !editable });
    const alpha = this.numberInput(Math.round(a * 1000) / 1000, false, editable, () => send());
    alpha.classList.add('alpha');
    alpha.title = '알파 (0~1)';
    const send = () => {
      const h = picker.value;
      const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      const av = Math.max(0, Math.min(1, Number(alpha.value) || 0));
      commit([...c, av].map((x) => String(Math.round(x * 10000) / 10000)).join(','));
    };
    picker.addEventListener('change', send);
    return el('div.ins-color-wrap', null, picker, el('span.ins-axis', null, 'A'), alpha);
  }

  vectorInput(p, editable, commit) {
    const values = (p.value || []).slice();
    const axes = /rect/i.test(p.path) && values.length === 4 ? ['X', 'Y', 'W', 'H'] : ['X', 'Y', 'Z', 'W'];
    const isInt = p.type === 'vectorInt';
    const wrap = el('div.ins-vec');
    values.forEach((v, i) => {
      const input = this.numberInput(v, isInt, editable, (nv) => {
        values[i] = Number(nv);
        commit(values.map(String).join(','));
      });
      const axis = el('span.ins-axis', null, axes[i]);
      this.scrub(axis, input, isInt, editable);
      wrap.append(el('div.ins-vec-item', null, axis, input));
    });
    return wrap;
  }

  /** "{x: 0, y: 1.5, z: 0}" on one YAML line: one field per component, written back in place. */
  yamlVector(p) {
    const wrap = el('div.ins-vec');
    const parts = p.value.slice();
    parts.forEach((part, i) => {
      const input = this.numberInput(part.v, false, p.editable, (nv) => {
        parts[i] = { ...part, v: Number(nv) };
        this.writeYaml(p, '{' + parts.map((x) => `${x.k}: ${x.v}`).join(', ') + '}', 'raw');
      });
      const axis = el('span.ins-axis', null, part.k.toUpperCase());
      this.scrub(axis, input, false, p.editable);
      wrap.append(el('div.ins-vec-item', null, axis, input));
    });
    return wrap;
  }

  objectField(c, p, editable) {
    const v = p.value;
    const box = el('div.ins-objfield' + (v ? '' : '.none'), {
      title: v ? (v.assetPath || v.name) + ` (${v.type})` : `없음 (${p.refType || 'Object'})`,
      onclick: () => {
        if (!v) return;
        if (v.assetPath) this.openRef(fromUnityPath(this.app.project, v.assetPath));
        else this.selectObject(v.id);
      },
      ondragover: (e) => {
        if (!editable) return;
        const types = [...e.dataTransfer.types];
        if (types.includes(OBJ_MIME) || types.includes(PATH_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'link';
          box.classList.add('drop');
        }
      },
      ondragleave: () => box.classList.remove('drop'),
      ondrop: (e) => {
        box.classList.remove('drop');
        if (!editable) return;
        e.preventDefault();
        e.stopPropagation();
        const obj = e.dataTransfer.getData(OBJ_MIME);
        const path = e.dataTransfer.getData(PATH_MIME);
        if (obj) this.setProp(c, p, obj);
        else if (path) this.setProp(c, p, toUnityPath(this.app.project, path));
      },
    },
    icon(v ? (v.assetPath ? 'file' : 'symbol-misc') : 'circle-slash'),
    el('span.ins-objname', null, v ? `${v.name} (${v.type})` : `없음 (${p.refType || 'Object'})`));
    const clear = editable && v ? el('button.tb-btn.icon.small', { title: '비우기', onclick: () => this.setProp(c, p, '') }, icon('close')) : null;
    return el('div.ins-obj-wrap', null, box, clear);
  }

  /** A referenced file: scripts open in the editor, assets in the inspector (unless pinned). */
  openRef(abs) {
    if (!abs) return;
    if (extname(abs) === '.cs' || !isInspectable(abs)) {
      if (extname(abs) === '.cs') this.app.editors.open(abs);
      else this.app.explorer.reveal(abs);
      return;
    }
    if (this.pinned) this.app.explorer.reveal(abs);
    else this.openFile(abs, false);
  }

  // ====================================================================== mirror (Unity's own inspector)
  setMirror(on) {
    this.mirror = on;
    try { localStorage.setItem(MIRROR_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    this.renderHeader();
    this.renderBody();
  }

  /** Live objects / assets are shown as Unity draws them, so custom editors and drawers apply. */
  useMirror(d) {
    return this.mirror && this.live && !!d && !d.file && !!(d.id || d.assetPath);
  }

  buildMirror() {
    this.mirrorImg = el('img.ins-mirror-img', { alt: '', draggable: 'false' });
    this.mirrorKeys = el('textarea.ins-mirror-keys', { spellcheck: 'false', tabindex: '-1', 'aria-hidden': 'true' });
    this.mirrorStatus = el('div.ins-mirror-status.hidden');
    this.mirrorEl = el('div.ins-mirror', null, this.mirrorImg, this.mirrorKeys, this.mirrorStatus);

    const send = (o) => O.unity.send({ type: 'inspector.mirrorInput', id: 0, ...o });
    const pos = (e) => {
      const r = this.mirrorImg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const img = this.mirrorImg;
    img.addEventListener('contextmenu', (e) => e.preventDefault());
    img.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.mirrorKeys.focus({ preventScroll: true });
      const button = unityButton(e.button);
      const clicks = e.detail || 1;
      let last = pos(e);
      send({ value: 'down', ...last, button, clicks, mods: unityMods(e) });
      // drags are coalesced to one event per frame
      let pending = null;
      let raf = 0;
      const flush = () => {
        raf = 0;
        if (pending) send(pending);
        pending = null;
      };
      const move = (ev) => {
        const p = pos(ev);
        pending = { value: 'drag', ...p, dx: (pending ? pending.dx : 0) + p.x - last.x, dy: (pending ? pending.dy : 0) + p.y - last.y, button, mods: unityMods(ev) };
        last = p;
        if (!raf) raf = requestAnimationFrame(flush);
      };
      const up = (ev) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (raf) cancelAnimationFrame(raf);
        flush();
        send({ value: 'up', ...pos(ev), button, clicks, mods: unityMods(ev) });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    let lastMove = 0;
    let hover = null;
    img.addEventListener('mousemove', (e) => {
      if (e.buttons) return;
      const p = pos(e);
      const now = performance.now();
      if (now - lastMove < MIRROR_MOVE_MS) return;
      send({ value: 'move', ...p, dx: hover ? p.x - hover.x : 0, dy: hover ? p.y - hover.y : 0, mods: unityMods(e) });
      hover = p;
      lastMove = now;
    });
    img.addEventListener('wheel', (e) => {
      e.preventDefault();
      send({ value: 'wheel', ...pos(e), dx: e.deltaX * WHEEL_SCALE, dy: e.deltaY * WHEEL_SCALE, mods: unityMods(e) });
    }, { passive: false });

    // keyboard: a hidden textarea keeps the focus; Korean (IME) text arrives on compositionend
    const keys = this.mirrorKeys;
    keys.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing || e.key === 'Process') return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.altKey) {
        const k = e.key.toLowerCase();
        const name = { c: 'Copy', v: 'Paste', x: 'Cut', a: 'SelectAll', d: 'Duplicate', y: 'Redo', z: e.shiftKey ? 'Redo' : 'Undo' }[k];
        if (name) {
          e.preventDefault();
          send({ value: 'command', name });
          return;
        }
      }
      const key = unityKey(e);
      const printable = e.key.length === 1 && !ctrl;
      if (!key && !printable) return;
      e.preventDefault();
      // like Unity itself: one event for the key, one for the character it types
      send({ value: 'keydown', x: 0, y: 0, key, chr: '', mods: unityMods(e) });
      if (printable) send({ value: 'keydown', x: 0, y: 0, key: '', chr: e.key, mods: unityMods(e) });
      else if (e.key === 'Enter') send({ value: 'keydown', x: 0, y: 0, key: '', chr: '\n', mods: unityMods(e) });
    });
    keys.addEventListener('keyup', (e) => {
      e.stopPropagation();
      const key = unityKey(e);
      if (key) send({ value: 'keyup', x: 0, y: 0, key, chr: '', mods: unityMods(e) });
    });
    keys.addEventListener('compositionend', (e) => {
      for (const ch of e.data || '') send({ value: 'keydown', x: 0, y: 0, key: '', chr: ch, mods: 0 });
      keys.value = '';
    });
    keys.addEventListener('input', (e) => {
      if (!e.isComposing) keys.value = '';
    });
  }

  setMirrorStatus(text, actions = []) {
    this.mirrorStatus.classList.toggle('hidden', !text);
    if (!text) return;
    this.mirrorStatus.replaceChildren(el('div', null, text),
      actions.length ? el('div.ins-mirror-acts', null, actions.map((a) => el('span.link', { onclick: a.action }, a.label))) : null);
  }

  renderMirror(d) {
    this.bodyEl.classList.add('mirror');
    if (this.bodyEl.firstChild !== this.mirrorEl || this.bodyEl.childNodes.length !== 1) this.bodyEl.replaceChildren(this.mirrorEl);
    const key = d.kind === 'GameObject' ? 'o' + d.id : 'a' + (d.assetPath || d.id);
    if (key === this.mirrorKey) {
      this.resizeMirrorSoon();
      this.placeMirrorSoon();
      return;
    }
    const r = this.bodyEl.getBoundingClientRect();
    const width = Math.round(r.width);
    const height = Math.round(r.height);
    if (width < 60 || height < 60) return; // laid out later; the ResizeObserver doesn't fire without a key
    this.mirrorKey = key;
    this.mirrorSize = { width, height };
    if (!this.overlay && !this.mirrorImg.getAttribute('src')) this.setMirrorStatus('Unity 인스펙터를 여는 중…');
    this.app.unityRequest('inspector.mirrorOpen', { target: d.id || 0, path: d.assetPath || '', width, height }, 15000)
      .then(() => {
        if (this.mirrorKey === key) this.placeMirror(); // the window exists now: lay it over the body
      })
      .catch((err) => {
        if (this.mirrorKey !== key) return;
        this.mirrorGone();
        this.mirrorImg.removeAttribute('src');
        this.setMirrorStatus(String(err.message || err), [
          { label: '다시 시도', action: () => this.renderBody() },
          { label: '간단 보기', action: () => this.setMirror(false) },
        ]);
      });
  }

  resizeMirror() {
    if (!this.mirrorKey || !this.live) return;
    const r = this.bodyEl.getBoundingClientRect();
    const width = Math.round(r.width);
    const height = Math.round(r.height);
    if (width < 60 || height < 60) return;
    if (this.mirrorSize && this.mirrorSize.width === width && this.mirrorSize.height === height) return;
    this.mirrorSize = { width, height };
    O.unity.send({ type: 'inspector.mirrorResize', id: 0, width, height });
  }

  closeMirror() {
    if (!this.mirrorKey) return;
    this.mirrorGone();
    this.mirrorSize = null;
    this.mirrorImg.removeAttribute('src');
    if (this.live) O.unity.send({ type: 'inspector.mirrorClose', id: 0 });
  }

  /** The Unity window is gone (or going): forget it, and stop telling where to put it. */
  mirrorGone() {
    this.mirrorKey = null;
    this.overlay = false;
    this.placeMirror();
  }

  placeMirrorSoon() {
    if (this.placeQueued) return;
    this.placeQueued = true;
    requestAnimationFrame(() => {
      this.placeQueued = false;
      this.placeMirror();
    });
  }

  /**
   * Tell where the body is (page CSS px; main converts to screen pixels) so Unity can lay its real
   * inspector window over it. Hidden while one of the IDE's menus or dialogs is open, since the
   * Unity window would sit on top of it.
   */
  placeMirror() {
    const on = !!this.mirrorKey && this.live;
    document.body.classList.toggle('unity-overlay', on && this.overlay);
    if (!on) {
      if (this.placed) O.unity.mirrorPlace(null);
      this.placed = false;
      return;
    }
    const r = this.bodyEl.getBoundingClientRect();
    const blocked = [...document.getElementById('overlay-root').children].some((c) => !c.classList.contains('toast-wrap'));
    const visible = this.dockVisible && !blocked && r.width >= 60 && r.height >= 60;
    O.unity.mirrorPlace({ x: r.left, y: r.top, width: r.width, height: r.height, visible });
    this.placed = true;
  }

  // ====================================================================== edits (live)
  fail(err) {
    toast({ kind: 'error', title: '인스펙터', message: String((err && err.message) || err), timeout: 5000 });
  }

  async edit(type, params) {
    try {
      const r = await this.app.unityRequest(type, params);
      this.reloadSoon();
      return r;
    } catch (err) {
      this.fail(err);
      this.reloadSoon();
      return null;
    }
  }

  async setProp(c, p, value) {
    if (!this.live) return;
    try {
      await this.app.unityRequest('inspector.setProperty', { target: c.id, path: p.path, value: String(value) });
      // Unity pushes inspector.changed; reload then (after the field loses focus)
    } catch (err) {
      this.fail(err);
      this.reloadSoon();
    }
  }

  async renameObject(id, name) {
    const v = await prompt({ title: '이름 바꾸기', value: name });
    if (v && v.trim() && v.trim() !== name) this.edit('inspector.rename', { target: id, name: v.trim() });
  }

  // ====================================================================== edits (file)
  /**
   * Replace the value on one YAML line. The line must still read exactly as when it was parsed,
   * otherwise the file changed underneath and nothing is written.
   */
  async writeYaml(p, value, kind = p.kind) {
    if (!p || !p.yaml) return;
    try {
      const r = await O.fs.readFile(p.file);
      if (!r || r.text == null) throw new Error('파일을 읽지 못했어요.');
      const nl = r.text.includes('\r\n') ? '\r\n' : '\n';
      const lines = r.text.split(/\r?\n/);
      if (lines[p.line] !== p.orig) throw new Error('그 사이 파일이 바뀌었어요. 다시 불러왔으니 한 번 더 고쳐 주세요.');
      let text;
      if (kind === 'number') {
        const n = Number(String(value).trim());
        if (!Number.isFinite(n)) throw new Error('숫자가 아니에요: ' + value);
        text = String(n);
      } else if (kind === 'string') {
        text = yamlString(String(value));
      } else {
        text = String(value);
      }
      lines[p.line] = p.prefix + text;
      p.orig = lines[p.line];
      this.ownWrites.set(p.file.toLowerCase(), Date.now());
      // an editor tab showing this file picks the change up through the file watcher
      await O.fs.writeFile(p.file, lines.join(nl), r.encoding);
      if (this.live) O.unity.send({ type: 'refresh' });
    } catch (err) {
      this.fail(err);
    }
    this.reloadSoon();
  }

  // ====================================================================== scripts (live)
  /** The .cs file in the active editor tab, if any. */
  currentScript() {
    const t = this.app.editors.active;
    return t && t.path && extname(t.path) === '.cs' ? t.path : null;
  }

  async ensureSaved(absPath) {
    const tab = this.app.editors.tabs.find((t) => samePath(t.path, absPath));
    if (tab && tab.dirty) await this.app.editors.save(tab);
  }

  unityScriptPath(absPath) {
    const p = toUnityPath(this.app.project, absPath);
    if (!/^(Assets|Packages)\//.test(p)) {
      toast({ kind: 'warn', title: 'Unity 프로젝트 안의 스크립트만 쓸 수 있어요', message: p, timeout: 4000 });
      return null;
    }
    return p;
  }

  /** Add a script to a GameObject; waits for Unity to compile/import it first if needed. */
  async attachScript(goId, absPath) {
    if (!this.live) {
      toast({ kind: 'warn', title: 'Unity와 연결돼 있어야 스크립트를 붙일 수 있어요', timeout: 3000 });
      return;
    }
    const script = this.unityScriptPath(absPath);
    if (!script) return;
    await this.ensureSaved(absPath);
    this.runOrQueue({ type: 'inspector.addComponent', params: { target: goId, script }, label: basename(absPath), select: goId });
  }

  async createObject({ parent = 0, scriptPath = null, name = null }) {
    if (!this.live) {
      toast({ kind: 'warn', title: 'Unity와 연결돼 있어야 오브젝트를 만들 수 있어요', timeout: 3000 });
      return;
    }
    let script = '';
    if (scriptPath) {
      script = this.unityScriptPath(scriptPath);
      if (!script) return;
      await this.ensureSaved(scriptPath);
    }
    this.runOrQueue({ type: 'inspector.createObject', params: { parent, script, name: name || '' }, label: scriptPath ? basename(scriptPath) : '새 오브젝트' });
  }

  /** Create a ScriptableObject asset from a script file. */
  async createAsset(absPath) {
    if (!this.live) {
      toast({ kind: 'warn', title: 'Unity와 연결돼 있어야 에셋을 만들 수 있어요', timeout: 3000 });
      return;
    }
    const script = this.unityScriptPath(absPath);
    if (!script) return;
    await this.ensureSaved(absPath);
    this.runOrQueue({ type: 'inspector.createAsset', params: { script, path: '' }, label: basename(absPath) });
  }

  async runOrQueue(job) {
    job.since = job.since || Date.now();
    job.tries = (job.tries || 0) + 1;
    try {
      const r = await this.app.unityRequest(job.type, job.params);
      this.pending = this.pending.filter((j) => j !== job);
      this.done(job, r);
    } catch (err) {
      if (err.code === 'notReady' || err.code === 'disconnected' || err.code === 'timeout') {
        if (!this.pending.includes(job)) {
          this.pending.push(job);
          toast({ title: `Unity가 '${job.label}'을(를) 컴파일하는 중이에요`, message: '끝나면 자동으로 이어서 할게요.', timeout: 3000 });
          O.unity.send({ type: 'refresh' });
          // in case nothing needed compiling (the import alone was missing), try again shortly
          setTimeout(() => this.retryPending(), 5000);
        }
        if (job.tries >= RETRY_MAX || Date.now() - job.since > RETRY_WINDOW_MS) {
          this.pending = this.pending.filter((j) => j !== job);
          this.fail(err);
        }
        return;
      }
      this.pending = this.pending.filter((j) => j !== job);
      this.fail(err);
    }
  }

  retryPending() {
    if (!this.live) return;
    for (const job of this.pending.slice()) this.runOrQueue(job);
  }

  done(job, r) {
    if (job.type === 'inspector.addComponent') {
      toast({ title: `'${job.label}'을(를) 붙였어요`, timeout: 2000 });
      if (!this.pinned || (this.target && this.target.kind === 'live')) {
        this.target = { kind: 'live' };
        this.selected = { id: job.select };
        this.showDock(false);
        this.reload();
        return;
      }
    } else if (job.type === 'inspector.createObject') {
      toast({ title: `'${job.label}' 오브젝트를 만들었어요`, timeout: 2000 });
      if (r && r.id && (!this.pinned || (this.target && this.target.kind === 'live'))) {
        this.target = { kind: 'live' };
        this.selected = { id: r.id };
        this.showDock(false);
        this.reload();
        return;
      }
    } else if (job.type === 'inspector.createAsset') {
      toast({ title: 'ScriptableObject 에셋을 만들었어요', message: r && r.path, timeout: 3000 });
      if (r && r.path) {
        this.openFile(fromUnityPath(this.app.project, r.path), true);
        return;
      }
    }
    this.reloadSoon();
  }

  async loadScripts() {
    if (!this.scripts) this.scripts = await this.app.unityRequest('inspector.scripts', {}, 15000);
    return this.scripts;
  }

  async pickScript(kind) {
    let list;
    try {
      list = (await this.loadScripts()).filter((s) => s.kind === kind);
    } catch (err) {
      this.fail(err);
      return null;
    }
    const cur = this.currentScript();
    return new Promise((resolve) => {
      const input = el('input', { type: 'text', placeholder: '스크립트 이름 검색', spellcheck: 'false' });
      const listEl = el('div.ins-pick-list');
      let items = [];
      let active = 0;
      const finish = (v) => { back.remove(); resolve(v); };
      const render = () => {
        const q = input.value.trim().toLowerCase();
        items = list.filter((s) => !q || s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q))
          .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name));
        if (cur && !q) {
          const p = toUnityPath(this.app.project, cur);
          const i = items.findIndex((s) => s.path === p);
          if (i > 0) items.unshift(items.splice(i, 1)[0]);
        }
        active = Math.min(active, Math.max(0, items.length - 1));
        listEl.replaceChildren(...(items.length ? items.slice(0, 200).map((s, i) => el('div.ins-pick-item' + (i === active ? '.active' : ''), {
          onmousedown: (e) => { e.preventDefault(); finish(s); },
        }, icon(kind === 'so' ? 'symbol-structure' : 'symbol-class'), el('span.name', null, s.name), el('span.path', null, s.path.replace(/^Assets\//, '')))) : [el('div.ins-empty', null, list.length ? '맞는 스크립트가 없어요' : (kind === 'so' ? 'ScriptableObject 스크립트가 없어요' : 'MonoBehaviour 스크립트가 없어요. 방금 만든 스크립트는 Unity가 컴파일한 뒤에 보여요.'))]));
        const a = listEl.querySelector('.active');
        if (a) a.scrollIntoView({ block: 'nearest' });
      };
      input.addEventListener('input', () => { active = 0; render(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
        if (e.key === 'Enter') finish(items[active] || null);
        if (e.key === 'Escape') finish(null);
        e.stopPropagation();
      });
      const back = el('div.dialog-back', { onmousedown: (e) => { if (e.target === back) finish(null); } },
        el('div.dialog.ins-pick', null, el('h3', null, kind === 'so' ? 'ScriptableObject 고르기' : '컴포넌트 추가'), input, listEl));
      document.getElementById('overlay-root').append(back);
      render();
      input.focus();
    });
  }

  async pickAndAttach(goId) {
    const s = await this.pickScript('mono');
    if (s) this.runOrQueue({ type: 'inspector.addComponent', params: { target: goId, script: s.path }, label: s.name, select: goId });
  }

  async pickAndCreate(parent) {
    const s = await this.pickScript('mono');
    if (s) this.runOrQueue({ type: 'inspector.createObject', params: { parent, script: s.path, name: '' }, label: s.name });
  }

  // ====================================================================== drag & drop helpers
  draggedPath(e) {
    const p = e.dataTransfer.getData(PATH_MIME);
    return p && extname(p) === '.cs' ? p : null;
  }

  acceptDrag(e, exts) {
    const types = [...e.dataTransfer.types];
    if (!types.includes(PATH_MIME)) return false;
    // the path itself isn't readable during dragover; the explorer tags the extension as a type
    if (!exts.some((x) => types.includes('application/x-papyrus-ext' + x))) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    return true;
  }

  // ====================================================================== file mode (YAML)
  async defaultScenePath() {
    if (this._defaultScene !== undefined) return this._defaultScene;
    let found = null;
    try {
      // the first enabled scene in Build Settings is the most likely "main" scene
      const r = await O.fs.readFile(this.app.project.replace(/[\\/]+$/, '') + '\\ProjectSettings\\EditorBuildSettings.asset');
      const m = r && r.text && /enabled: 1\s+path: (\S+)/.exec(r.text);
      if (m) found = fromUnityPath(this.app.project, m[1]);
    } catch { /* ignore */ }
    if (!found) {
      const scenes = this.app.fileIndex.filter((p) => extname(p) === '.unity');
      found = scenes.find((p) => /[\\/]Assets[\\/]/i.test(p)) || scenes[0] || null;
    }
    this._defaultScene = found;
    return found;
  }

  async ensureGuidMap() {
    if (this.guidMap) return this.guidMap;
    const map = new Map();
    const files = this.app.fileIndex.filter((p) => GUID_EXT.has(extname(p)));
    let i = 0;
    const worker = async () => {
      while (i < files.length) {
        const p = files[i++];
        try {
          const r = await O.fs.readFile(p + '.meta');
          const m = r && r.text && /^guid: ([0-9a-f]{32})/m.exec(r.text);
          if (m) map.set(m[1], { name: basename(p).replace(/\.[^.]+$/, ''), path: p, ext: extname(p) });
        } catch { /* no meta */ }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    this.guidMap = map;
    return map;
  }

  async readYaml(abs) {
    const [r] = await Promise.all([O.fs.readFile(abs), this.ensureGuidMap()]);
    if (!r || r.text == null) throw new Error('파일을 읽지 못했어요: ' + basename(abs));
    if (!/^%YAML/.test(r.text)) throw new Error('이 파일은 텍스트(YAML)로 저장돼 있지 않아요. Unity의 Asset Serialization을 Force Text로 두면 볼 수 있어요.');
    return parseYamlDocs(r.text, abs);
  }

  async loadFileHierarchy(abs) {
    const docs = await this.readYaml(abs);
    const scene = parseScene(docs, this.guidMap);
    this.fileScene = scene;
    const unityPath = toUnityPath(this.app.project, abs);
    const key = 'scene:' + unityPath;
    if (!this.expanded.has(key)) {
      this.expanded.add(key);
      // a prefab has one root; open it too
      if (extname(abs) === '.prefab' && scene.roots.length === 1) this.expanded.add(String(scene.roots[0].id));
    }
    return {
      offline: true,
      truncated: false,
      scenes: [{ name: basename(abs).replace(/\.(unity|prefab)$/i, ''), path: unityPath, loaded: true, dirty: false, active: true, prefabFile: extname(abs) === '.prefab', roots: scene.roots }],
    };
  }

  fileObject(key) {
    const s = this.fileScene;
    const node = s && s.nodes.get(key);
    if (!node) throw new Error('오브젝트를 찾지 못했어요.');
    return {
      file: true, id: key, name: node.name, kind: 'GameObject', active: node.active, tag: node.tag, layer: node.layer, scene: '',
      nameProp: node.nameProp, activeProp: node.activeProp,
      components: node.prefab
        ? [{ id: 0, file: true, type: 'Prefab Instance', script: node.prefabPath ? toUnityPath(this.app.project, node.prefabPath) : null, props: node.mods, enabled: null }]
        : node.comps.map((d) => componentFromDoc(d, this.guidMap, this.app.project)),
    };
  }

  async fileAsset(abs) {
    const docs = await this.readYaml(abs);
    const all = [...docs.values()];
    const main = all.find((d) => !d.stripped && d.classId === 114) || all[0];
    if (!main) throw new Error('에셋 내용을 읽지 못했어요.');
    const comp = componentFromDoc(main, this.guidMap, this.app.project);
    return {
      file: true, id: 0, name: field(main, 'm_Name') || basename(abs), assetPath: toUnityPath(this.app.project, abs),
      kind: main.classId === 114 ? 'ScriptableObject' : CLASS_NAMES[main.classId] || main.type || 'Asset', components: [comp],
    };
  }
}

// ------------------------------------------------------------------ YAML helpers

/** Split a Unity YAML file into documents keyed by fileID; every line keeps its line number. */
function parseYamlDocs(text, file) {
  const docs = new Map();
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^--- !u!(\d+) &(-?\d+)( stripped)?/.exec(line);
    if (m) {
      cur = { classId: +m[1], fileId: m[2], stripped: !!m[3], type: '', lines: [], nos: [], file };
      docs.set(cur.fileId, cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.type && /^[A-Za-z]\w*:\s*$/.test(line)) {
      cur.type = line.replace(/:\s*$/, '');
      continue;
    }
    cur.lines.push(line);
    cur.nos.push(i);
  }
  return docs;
}

function fieldIndex(doc, key) {
  const pre = '  ' + key + ':';
  return doc.lines.findIndex((l) => l.startsWith(pre) && (l.length === pre.length || l[pre.length] === ' '));
}

function field(doc, key) {
  const i = fieldIndex(doc, key);
  return i < 0 ? null : doc.lines[i].slice(key.length + 3).trim();
}

/** An editable handle on a top-level scalar field ("  key: value"). */
function fieldProp(doc, key) {
  const i = fieldIndex(doc, key);
  if (i < 0) return null;
  const line = doc.lines[i];
  const prefix = '  ' + key + ': ';
  return { yaml: true, file: doc.file, line: doc.nos[i], orig: line, prefix, editable: true };
}

function refId(v) {
  const m = v && /fileID: (-?\d+)/.exec(v);
  return m ? m[1] : '0';
}

function refGuid(v) {
  const m = v && /guid: ([0-9a-f]{32})/.exec(v);
  return m ? m[1] : null;
}

/** Items of a top-level YAML list ("  key:" followed by "  - ..." lines). */
function list(doc, key) {
  const out = [];
  const pre = '  ' + key + ':';
  let on = false;
  for (const l of doc.lines) {
    if (!on) {
      if (l.startsWith(pre)) {
        if (/\[\]\s*$/.test(l)) return out;
        on = true;
      }
      continue;
    }
    if (l.startsWith('  - ')) out.push(l.slice(4));
    else if (!l.startsWith('    ')) break;
  }
  return out;
}

/** A string as a YAML scalar, quoted the way Unity writes it when needed. */
function yamlString(s) {
  if (s === '') return '';
  const plain = /^[A-Za-z0-9_가-힣ㄱ-ㅎㅏ-ㅣ][A-Za-z0-9_ .()\-/가-힣ㄱ-ㅎㅏ-ㅣ]*$/.test(s) && !/\s$/.test(s)
    && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/^-?[\d.]+([eE][-+]?\d+)?$/.test(s);
  // eslint-disable-next-line no-control-regex
  if (plain && /^[\x20-\x7e]*$/.test(s)) return s;
  // Unity writes non-ASCII as \uXXXX inside double quotes
  return '"' + Array.from(s).map((ch) => {
    const c = ch.codePointAt(0);
    if (ch === '"') return '\\"';
    if (ch === '\\') return '\\\\';
    if (ch === '\n') return '\\n';
    if (ch === '\t') return '\\t';
    if (c < 0x20 || c > 0x7e) {
      if (c > 0xffff) {
        const hi = Math.floor((c - 0x10000) / 0x400) + 0xd800;
        const lo = ((c - 0x10000) % 0x400) + 0xdc00;
        return '\\u' + hi.toString(16).toUpperCase().padStart(4, '0') + '\\u' + lo.toString(16).toUpperCase().padStart(4, '0');
      }
      return '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
    }
    return ch;
  }).join('') + '"';
}

/** Decode a single-line YAML scalar. Returns { kind:'number'|'string', value } or null (not editable). */
function yamlScalar(v) {
  if (v === '') return { kind: 'string', value: '' };
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return { kind: 'number', value: Number(v) };
  if (v[0] === "'") {
    if (v.length < 2 || v[v.length - 1] !== "'") return null; // continues on the next line
    return { kind: 'string', value: v.slice(1, -1).replace(/''/g, "'") };
  }
  if (v[0] === '"') {
    if (!/[^\\]"$|^""$/.test(v)) return null;
    try {
      return { kind: 'string', value: JSON.parse(v.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')) };
    } catch {
      return null;
    }
  }
  if (/^[{[&*!|>%@`]/.test(v)) return null;
  return { kind: 'string', value: v };
}

function parseScene(docs, guidMap) {
  const nodes = new Map();       // key -> node
  const byTransform = new Map(); // transform fileId -> node key
  const parentOf = new Map();    // node key -> parent transform fileId
  const childOrder = new Map();  // transform fileId -> [child transform fileIds]

  for (const d of docs.values()) {
    if (d.classId !== 1 || d.stripped) continue;
    const nameProp = fieldProp(d, 'm_Name');
    const activeProp = fieldProp(d, 'm_IsActive');
    nodes.set('f' + d.fileId, {
      id: 'f' + d.fileId,
      name: field(d, 'm_Name') || 'GameObject',
      active: field(d, 'm_IsActive') !== '0',
      tag: field(d, 'm_TagString') || 'Untagged',
      layer: field(d, 'm_Layer') || '0',
      nameProp, activeProp,
      children: [],
      comps: list(d, 'm_Component').map((c) => docs.get(refId(c))).filter(Boolean),
    });
  }
  for (const d of docs.values()) {
    if (d.classId !== 4 && d.classId !== 224) continue;
    if (d.stripped) {
      byTransform.set(d.fileId, 'p' + refId(field(d, 'm_PrefabInstance')));
      continue;
    }
    const go = 'f' + refId(field(d, 'm_GameObject'));
    if (!nodes.has(go)) continue;
    byTransform.set(d.fileId, go);
    parentOf.set(go, refId(field(d, 'm_Father')));
    childOrder.set(d.fileId, list(d, 'm_Children').map(refId));
  }
  for (const d of docs.values()) {
    if (d.classId !== 1001 || d.stripped) continue;
    let name = null;
    let lastPath = null;
    const props = [];
    for (let i = 0; i < d.lines.length; i++) {
      const l = d.lines[i];
      const pm = /^\s+(?:- )?propertyPath: (.*)$/.exec(l);
      if (pm) { lastPath = pm[1].trim(); continue; }
      const vm = /^(\s+value: )(.*)$/.exec(l);
      if (vm && lastPath) {
        const raw = vm[2].trim();
        const sc = yamlScalar(raw);
        if (lastPath === 'm_Name' && !name) name = sc ? sc.value : raw;
        if (props.length < 200) {
          const prop = { path: lastPath, label: lastPath, depth: 1, yaml: true, file: d.file, line: d.nos[i], orig: l, prefix: vm[1] };
          if (sc) Object.assign(prop, { type: sc.kind === 'number' ? 'yamlNum' : 'yamlStr', kind: sc.kind, value: sc.value, editable: true });
          else Object.assign(prop, { type: 'raw', value: raw, editable: false });
          props.push(prop);
        }
        lastPath = null;
      }
    }
    const src = guidMap.get(refGuid(field(d, 'm_SourcePrefab')) || '');
    const key = 'p' + d.fileId;
    nodes.set(key, {
      id: key, name: name || (src ? src.name : 'Prefab'), active: true, prefab: true, prefabPath: src ? src.path : null,
      tag: '', layer: '', children: [], comps: [],
      mods: props.length ? [{ path: '__mods', label: '프리팹에서 바꾼 값', depth: 0, type: 'struct', yaml: true, count: props.length }, ...props] : [],
    });
    // m_TransformParent sits inside m_Modification, one level deeper than other fields
    const tp = d.lines.find((l) => /^\s+m_TransformParent:/.test(l));
    parentOf.set(key, refId(tp));
  }

  // children in the order of the parent's m_Children list
  const attached = new Set();
  for (const [tId, kids] of childOrder) {
    const parent = nodes.get(byTransform.get(tId));
    if (!parent) continue;
    for (const k of kids) {
      const child = nodes.get(byTransform.get(k));
      if (child && !attached.has(child.id)) {
        parent.children.push(child);
        attached.add(child.id);
      }
    }
  }
  // prefab instances parented under a transform that doesn't list them
  for (const [key, father] of parentOf) {
    if (attached.has(key) || father === '0') continue;
    const parent = nodes.get(byTransform.get(father));
    if (parent) {
      parent.children.push(nodes.get(key));
      attached.add(key);
    }
  }
  // roots: SceneRoots (Unity 2022+) keeps the order; otherwise file order
  const roots = [];
  const sr = [...docs.values()].find((d) => d.type === 'SceneRoots');
  if (sr) {
    for (const r of list(sr, 'm_Roots')) {
      const n = nodes.get(byTransform.get(refId(r)));
      if (n && !attached.has(n.id)) {
        roots.push(n);
        attached.add(n.id);
      }
    }
  }
  for (const n of nodes.values()) {
    if (!attached.has(n.id) && (parentOf.get(n.id) || '0') === '0') roots.push(n);
  }
  return { nodes, roots };
}

function componentFromDoc(d, guidMap, project) {
  let type = CLASS_NAMES[d.classId] || d.type || `Class ${d.classId}`;
  let script = null;
  let missing = false;
  if (d.classId === 114) {
    const guid = refGuid(field(d, 'm_Script'));
    const s = guid && guidMap.get(guid);
    if (s && s.ext === '.cs') {
      type = nicify(s.name);
      script = toUnityPath(project, s.path);
    } else if (guid) {
      type = 'MonoBehaviour (패키지 스크립트)';
    } else {
      type = '(스크립트 없음)';
      missing = true;
    }
  }
  const enabled = field(d, 'm_Enabled');
  return {
    id: 0, file: true, type, typeName: type, script, missing, canRemove: false,
    enabled: enabled == null ? null : enabled === '1',
    enabledProp: enabled == null ? null : fieldProp(d, 'm_Enabled'),
    props: yamlProps(d, guidMap),
  };
}

/**
 * The document's fields as inspector rows. Scalars are editable in place, "{x: 0, y: 1}" becomes a
 * vector, references and other inline maps stay read-only, nested keys and list items are indented.
 */
function yamlProps(d, guidMap) {
  const out = [];
  const counters = [];      // list item index per depth
  let skipDepth = -1;       // children of a skipped field
  for (let i = 0; i < d.lines.length; i++) {
    if (out.length > 600) break;
    const l = d.lines[i];
    const m = /^( +)(- )?([^:'"{}[\]]+):(?: (.*))?$/.exec(l);
    const item = !m && /^( +)- (.*)$/.exec(l);
    if (!m && !item) continue;
    const indent = (m || item)[1].length;
    let depth = Math.max(0, Math.floor((indent - 2) / 2));
    const isItem = item || (m && m[2]);
    if (isItem) depth += 1;
    if (skipDepth >= 0 && depth > skipDepth) continue;
    skipDepth = -1;
    counters.length = depth + 1;
    const base = { yaml: true, file: d.file, line: d.nos[i], orig: l, depth };
    if (item) {
      const idx = counters[depth] = (counters[depth] == null ? 0 : counters[depth] + 1);
      out.push(valueRow({ ...base, path: `#${i}`, label: `요소 ${idx}`, prefix: l.slice(0, indent + 2) }, item[2], guidMap));
      continue;
    }
    const key = m[3].trim();
    if (depth === 0 && (SKIP_FIELDS.has(key) || key === 'm_Name')) { // the name is in the header
      skipDepth = 0;
      continue;
    }
    if (m[2]) counters[depth] = counters[depth] == null ? 0 : counters[depth] + 1;
    const raw = m[4] == null ? '' : m[4];
    const prefix = l.slice(0, l.indexOf(':') + 1) + ' ';
    // "key:" followed by deeper lines or list items -> a group
    const next = d.lines[i + 1] || '';
    const nextIndent = next.length - next.trimStart().length;
    const container = raw.trim() === '' && (nextIndent > indent || (nextIndent === indent && /^\s*- /.test(next)));
    if (container) {
      let count = 0;
      for (let j = i + 1; j < d.lines.length; j++) {
        const n = d.lines[j];
        const ni = n.length - n.trimStart().length;
        if (ni < indent || (ni === indent && !/^\s*- /.test(n))) break;
        if (ni === indent || (ni === indent + 2 && /^\s*- /.test(n))) count++;
      }
      out.push({ ...base, path: `${key}#${i}`, label: nicify(key), type: 'array', count, editable: false });
      continue;
    }
    out.push(valueRow({ ...base, path: `${key}#${i}`, label: nicify(key), prefix }, raw, guidMap));
  }
  return out;
}

function valueRow(row, raw, guidMap) {
  const v = raw.trim();
  // {x: 1, y: 2, z: 3} (vectors, colors, quaternions) -> one number field per component
  const vec = /^\{((?:\s*[a-z]+: -?[\d.eE+-]+,?)+)\s*\}$/.exec(v);
  if (vec) {
    const parts = vec[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [k, n] = s.split(':').map((x) => x.trim());
      return { k, v: Number(n) };
    });
    if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^[xyzwrgba]$/.test(p.k) && Number.isFinite(p.v))) {
      return { ...row, type: 'yamlVec', value: parts, editable: true };
    }
  }
  if (/^\{fileID:/.test(v)) return { ...row, type: 'raw', ref: true, value: refText(v, guidMap), editable: false };
  const sc = yamlScalar(v);
  if (!sc) return { ...row, type: 'raw', value: v.length > 120 ? v.slice(0, 120) + '…' : v, editable: false };
  return { ...row, type: sc.kind === 'number' ? 'yamlNum' : 'yamlStr', kind: sc.kind, value: sc.value, editable: true };
}

function refText(v, guidMap) {
  if (/^\{fileID: 0\}/.test(v)) return '없음';
  const g = refGuid(v);
  if (g) {
    const a = guidMap.get(g);
    return a ? `${a.name}${a.ext}` : '에셋 참조';
  }
  return '씬 오브젝트 참조';
}
