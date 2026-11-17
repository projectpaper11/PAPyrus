// Settings tab (VS Code-style): grouped options on the left, keybinding editor included.
import { el, icon, toast, debounce } from './ui.js';
import { eventToKey, displayKey, normalizeKey } from './keybindings.js';
import { KEYMAPS, keymapLabel } from './keymaps.js';
import { FILL_OPTIONS, ANCHOR_OPTIONS, fileUrl, setBackgroundOpacity } from './background-art.js';

export const SCHEMA = [
  {
    id: 'appearance', title: '모양', icon: 'symbol-color', items: [
      { key: 'workbench.theme', label: '색 테마', type: 'select', options: [['dark', '어두운 테마'], ['light', '밝은 테마'], ['rainbow', '무지개 테마'], ['system', '시스템 설정 따르기']] },
      { key: 'editor.fontFamily', label: '에디터 글꼴', type: 'text', desc: "쉼표로 여러 개 지정할 수 있어요. 기본: 'JetBrains Mono', Consolas, monospace" },
      { key: 'editor.fontSize', label: '글자 크기', type: 'number', min: 8, max: 40 },
      { key: 'editor.lineHeight', label: '줄 간격 (글자 크기의 배수)', type: 'number', min: 1, max: 2.5, step: 0.05 },
      { key: 'editor.fontLigatures', label: '합자 사용', type: 'bool', desc: '=>, !=, == 같은 기호를 하나로 이어서 보여 줘요.' },
      { key: 'editor.minimap', label: '미니맵', type: 'bool' },
      { key: 'editor.inlayHints', label: '파라미터 이름 힌트', type: 'bool', desc: 'Jump(force: 7.5f) 처럼 인자 앞에 파라미터 이름을 표시해요.' },
      { key: 'editor.codeLens', label: '참조 개수 표시', type: 'bool', desc: '클래스·메서드 위에 "참조 N개", "상속 N개" 같은 표시를 보여줘요.' },
      { key: 'editor.stickyScroll', label: '현재 클래스/메서드 머리글 고정', type: 'bool' },
      { key: 'editor.renderWhitespace', label: '공백 문자 표시', type: 'select', options: [['none', '안 함'], ['boundary', '단어 사이 공백 제외'], ['all', '모두']] },
    ],
  },
  {
    id: 'background', title: '배경 이미지', icon: 'file-media', items: [
      { key: 'appearance.backgroundImage', label: '배경 이미지', type: 'image', desc: 'Rider처럼 코드 뒤에 좋아하는 그림을 깔아요. 이미지 파일을 여기로 끌어다 놓아도 돼요. 고른 그림은 PAPyrus 설정 폴더에 복사돼서 원본을 옮겨도 그대로예요.' },
      { key: 'appearance.backgroundEnabled', label: '배경 이미지 표시', type: 'bool', desc: '명령 팔레트의 "배경 이미지 켜기/끄기"로도 바꿀 수 있어요.' },
      { key: 'appearance.backgroundOpacity', label: '진하기 (불투명도)', type: 'range', min: 0, max: 100, step: 1, unit: '%', live: setBackgroundOpacity, desc: '코드가 잘 보이려면 10~25%를 추천해요.' },
      { key: 'appearance.backgroundFill', label: '채우기 방식', type: 'select', options: FILL_OPTIONS },
      { key: 'appearance.backgroundAnchor', label: '위치', type: 'select', options: ANCHOR_OPTIONS, desc: '그림의 어느 쪽을 기준으로 맞출지예요 (꽉 채우기에서 잘리는 쪽이 바뀌어요).' },
      { key: 'appearance.backgroundTarget', label: '표시할 곳', type: 'select', options: [['editor', '에디터만'], ['all', '에디터와 툴 창 전체']] },
    ],
  },
  {
    id: 'editor', title: '에디터', icon: 'edit', items: [
      { key: 'editor.tabSize', label: '탭 크기', type: 'number', min: 1, max: 8 },
      { key: 'editor.insertSpaces', label: 'Tab 키로 공백 넣기', type: 'bool' },
      { key: 'editor.wordWrap', label: '자동 줄 바꿈', type: 'bool' },
      { key: 'editor.formatOnSave', label: '저장할 때 서식 적용 (C#)', type: 'bool' },
      { key: 'editor.formatOnType', label: '입력하면서 서식 적용', type: 'bool', desc: '; 나 } 를 입력하면 해당 줄을 정리해요.' },
      { key: 'editor.formatOnPaste', label: '붙여넣을 때 서식 적용 (C#)', type: 'bool', desc: '붙여넣은 코드의 들여쓰기와 중괄호 위치를 정리해요.' },
      { key: 'editor.allmanBraces', label: '{ 뒤 Enter로 블록 펼치기', type: 'bool', desc: 'if () { 에서 Enter를 누르면 { 를 다음 줄로 내리고 블록을 열어요 (Rider 기본).' },
      { key: 'csharp.namespaceCheck', label: '네임스페이스가 폴더와 다르면 경고 (C#)', type: 'bool', desc: '네임스페이스가 없거나 폴더 위치와 다르면 노란 줄을 그어요. Ctrl+.로 바로 맞출 수 있어요 (Plugins·외부 에셋은 제외).' },
      { key: 'editor.removeUnusedUsings', label: '안 쓰는 using 자동 정리 (C#)', type: 'select', options: [['auto', '바로 (방금 입력한 using은 저장할 때)'], ['onSave', '저장할 때'], ['off', '끄기']], desc: '쓰지 않는 using과 찾을 수 없는 네임스페이스의 using을 지워요. 직접 하려면 "using 정리" (Ctrl+Alt+O).' },
        { key: 'editor.learnedCompletions', label: '학습형 자동완성', type: 'bool', desc: '줄의 첫 단어를 입력할 때 자주 쓰는 줄을 제안하고, Unity 스니펫(sf, awake, dlog…)도 보여 줘요.' },
    ],
  },
  {
    id: 'files', title: '파일', icon: 'files', items: [
      { key: 'files.autoSave', label: '자동 저장', type: 'select', options: [['off', '끄기'], ['afterDelay', '입력을 멈추면'], ['onFocusChange', '탭이나 창을 바꿀 때']] },
      { key: 'files.autoSaveDelay', label: '자동 저장 지연 (ms)', type: 'number', min: 200, max: 10000, step: 100 },
      { key: 'explorer.hideProjectFiles', label: '탐색기에서 .sln / .csproj 숨기기', type: 'bool' },
      { key: 'files.exclude', label: '탐색기·검색에서 제외할 폴더', type: 'list', desc: '한 줄에 하나씩' },
      { key: 'search.excludeFolders', label: '검색에서 뺄 외부 폴더 (플러그인·에셋)', type: 'list', desc: '이름 검색과 파일에서 찾기에서 빠져요 (탐색기에는 보여요). 폴더 이름 또는 Assets/경로, 한 줄에 하나씩' },
      { key: 'history.enabled', label: '로컬 히스토리', type: 'bool', desc: '저장·이름 바꾸기·삭제할 때마다 이전 내용을 남겨요. 탭·파일 우클릭 → "로컬 히스토리"에서 비교하고 되돌릴 수 있어요.' },
      { key: 'history.days', label: '로컬 히스토리 보관 기간 (일)', type: 'number', min: 1, max: 365 },
      { key: 'reopenLastProject', label: '시작할 때 마지막 프로젝트 열기', type: 'bool' },
    ],
  },
  {
    id: 'unity', title: 'Unity', icon: 'game', items: [
      { key: 'unity.refreshOnSave', label: '저장하면 Unity 에셋 새로고침', type: 'bool', desc: 'Unity 창으로 돌아가기 전에 컴파일이 시작돼요.' },
      { key: 'unity.clearLogOnPlay', label: 'Play할 때 Unity Log 지우기', type: 'bool' },
      { key: 'unity.assetLenses', label: '에셋 사용처 표시', type: 'bool', desc: '스크립트 클래스 위에 "프리팹 2 · 씬 1에서 사용", UnityEvent·애니메이션 이벤트로 불리는 메서드 위에 호출 위치를 보여 줘요.' },
      { key: 'unity.formerlySerializedAs', label: '직렬화 필드 이름 바꿀 때 값 보존', type: 'bool', desc: '인스펙터에 저장된 필드의 이름을 바꾸면 [FormerlySerializedAs("이전 이름")]을 붙여서 값이 사라지지 않게 해요.' },
      { key: 'unity.stringChecks', label: '태그·레이어·씬 이름 자동완성과 오타 경고', type: 'bool', desc: 'CompareTag, LayerMask, LoadScene, Animator.SetTrigger, Input.GetAxis, Resources.Load의 문자열을 프로젝트 설정에서 찾아 자동완성하고, 없는 이름이면 경고해요.' },
      { key: 'unity.performanceHints', label: '성능 힌트', type: 'bool', desc: 'Update·LateUpdate·FixedUpdate·OnGUI에서 GetComponent, Find, SendMessage 같은 비싼 호출을 표시하고, 필드에 캐싱하는 빠른 수정(Ctrl+.)을 제안해요.' },
    ],
  },
  {
    id: 'lsp', title: 'C# 언어 서버', icon: 'symbol-namespace', items: [
      { key: 'lsp.path', label: '언어 서버 경로', type: 'text', desc: '"auto"면 roslyn-language-server(dotnet tool)를 써요. OmniSharp 경로를 넣어도 돼요.', restart: true },
      { key: 'lsp.autoRestore', label: '필요하면 dotnet restore 자동 실행', type: 'bool' },
    ],
  },
  {
    id: 'keyboard', title: '키보드', icon: 'keyboard', items: [
      { key: 'keyboard.keymap', label: '키맵', type: 'select', options: Object.entries(KEYMAPS).map(([v, m]) => [v, m.label]), desc: '기본 단축키 묶음이에요. 단축키 화면에서 직접 바꾼 키는 키맵을 바꿔도 그대로예요.' },
      { key: 'keyboard.doubleShift', label: 'Shift 두 번으로 Search Everywhere 열기', type: 'bool' },
    ],
  },
  {
    id: 'update', title: '업데이트', icon: 'cloud-download', items: [
      { key: 'update.checkOnStartup', label: '시작할 때 새 버전 확인', type: 'bool', desc: '새 버전이 있으면 알림이 뜨고, 수락하면 내려받아 설치해요.' },
      { key: 'update.repo', label: '업데이트 저장소 (GitHub 아이디/저장소)', type: 'text', desc: '예: myid/papyrus. 비워 두면 설치 파일을 만든 저장소를 써요. 바꾼 뒤에는 PAPyrus를 다시 시작해 주세요.' },
      { key: 'setup.dontShow', label: '설정 도우미 자동으로 띄우지 않기', type: 'bool' },
    ],
  },
  { id: 'keys', title: '단축키', icon: 'record-keys', custom: true },
];

export class SettingsView {
  constructor(app) {
    this.app = app;
    this.section = 'appearance';
    this.query = '';
    this.keyQuery = '';
    this.el = el('div.settings');
    this.nav = el('div.settings-nav');
    this.body = el('div.settings-body');
    this.search = el('input.settings-search', {
      placeholder: '설정 검색',
      oninput: debounce(() => { this.query = this.search.value.trim().toLowerCase(); this.render(); }, 120),
    });
    this.el.append(el('div.settings-side', null, this.search, this.nav,
      el('div.settings-foot', null,
        el('span.link', { onclick: () => this.app.openSettingsJson() }, 'settings.json 열기'))), this.body);
  }

  show(section) {
    if (section) this.section = section;
    this.render();
  }

  render() {
    this.nav.replaceChildren(...SCHEMA.map((g) => el('div.settings-nav-item' + (g.id === this.section && !this.query ? '.active' : ''), {
      onclick: () => { this.section = g.id; this.query = ''; this.search.value = ''; this.render(); },
    }, icon(g.icon), g.title)));
    if (this.query) {
      const groups = SCHEMA.filter((g) => !g.custom).map((g) => ({ ...g, items: g.items.filter((i) => (i.label + ' ' + i.key + ' ' + (i.desc || '')).toLowerCase().includes(this.query)) })).filter((g) => g.items.length);
      this.body.replaceChildren(...groups.map((g) => this.renderGroup(g)), groups.length ? '' : el('div.empty-msg', null, '일치하는 설정이 없어요.'));
      return;
    }
    const g = SCHEMA.find((x) => x.id === this.section) || SCHEMA[0];
    this.body.replaceChildren(g.custom ? this.renderKeys() : this.renderGroup(g));
    this.body.scrollTop = 0;
  }

  /** Picture setting: preview, "찾기…", "지우기"; an image file dropped on it is used too. */
  imageControl(item, val, set) {
    const O = window.papyrus.app;
    const use = async (file) => {
      try {
        const p = await O.pickBackgroundImage(file || null);
        if (!p) return;
        await set(p);
        if (this.app.settings['appearance.backgroundEnabled'] === false) await this.app.setSetting('appearance.backgroundEnabled', true);
        this.render();
      } catch (err) {
        toast({ kind: 'warn', title: '배경 이미지', message: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), timeout: 4000 });
      }
    };
    const thumb = el('div.bg-thumb' + (val ? '' : '.empty'), { title: val || '' }, val ? null : icon('file-media'));
    if (val) thumb.style.backgroundImage = `url("${fileUrl(val)}")`;
    const wrap = el('div.bg-pick', {
      ondragover: (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); wrap.classList.add('drop'); } },
      ondragleave: () => wrap.classList.remove('drop'),
      ondrop: (e) => {
        wrap.classList.remove('drop');
        const f = e.dataTransfer.files[0];
        if (!f) return;
        e.preventDefault();
        e.stopPropagation();
        use(O.pathForFile(f));
      },
    },
    thumb,
    el('div.bg-pick-btns', null,
      el('button.btn', { onclick: () => use() }, icon('folder-opened'), val ? '바꾸기…' : '찾기…'),
      val ? el('button.btn', { onclick: async () => { await set(''); this.render(); } }, icon('trash'), '지우기') : null));
    return wrap;
  }

  renderGroup(g) {
    return el('div.settings-group', null, el('h2', null, g.title), ...g.items.map((i) => this.renderItem(i)));
  }

  renderItem(item) {
    const s = this.app.settings;
    const val = s[item.key];
    const set = (v) => this.app.setSetting(item.key, v).then(() => {
      if (item.restart) toast({ title: '언어 서버를 다시 시작할까요?', actions: [{ label: '재시작', action: () => this.app.restartLsp() }] });
    });
    let control;
    if (item.type === 'bool') {
      control = el('label.switch', null, el('input', { type: 'checkbox', checked: !!val, onchange: (e) => set(e.target.checked) }), el('span.slider'));
    } else if (item.type === 'select') {
      control = el('select.settings-input', { onchange: (e) => set(e.target.value) },
        ...item.options.map(([v, l]) => el('option', { value: v, selected: v === val }, l)));
    } else if (item.type === 'number') {
      control = el('input.settings-input.num', {
        type: 'number', value: val, min: item.min, max: item.max, step: item.step || 1,
        onchange: (e) => {
          let n = parseFloat(e.target.value);
          if (Number.isNaN(n)) return;
          if (item.min != null) n = Math.max(item.min, n);
          if (item.max != null) n = Math.min(item.max, n);
          set(n);
        },
      });
    } else if (item.type === 'range') {
      const out = el('span.range-val', null, `${val}${item.unit || ''}`);
      const input = el('input.settings-range', {
        type: 'range', min: item.min, max: item.max, step: item.step || 1, value: val,
        oninput: (e) => { out.textContent = `${e.target.value}${item.unit || ''}`; if (item.live) item.live(e.target.value); },
        onchange: (e) => set(Number(e.target.value)),
      });
      control = el('div.range-wrap', null, input, out);
    } else if (item.type === 'image') {
      control = this.imageControl(item, val, set);
    } else if (item.type === 'list') {
      control = el('textarea.settings-input.list', {
        rows: 4,
        onchange: (e) => set(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)),
      });
      control.value = (val || []).join('\n');
    } else {
      control = el('input.settings-input', { type: 'text', value: val == null ? '' : val, onchange: (e) => set(e.target.value) });
    }
    return el('div.settings-item', null,
      el('div.settings-label', null, el('div.si-title', null, item.label), el('div.si-key', null, item.key), item.desc ? el('div.si-desc', null, item.desc) : null),
      el('div.settings-control', null, control));
  }

  // ------------------------------------------------------------------ keybindings
  renderKeys() {
    const K = this.app.keys;
    const wrap = el('div.settings-group.keys');
    const search = el('input.settings-input.keysearch', {
      placeholder: '명령 이름 또는 키 검색 (예: 저장, Ctrl+S)',
      value: this.keyQuery,
      oninput: debounce(() => { this.keyQuery = search.value; renderRows(); }, 100),
    });
    const recordSearch = el('button.toggle', {
      title: '키를 눌러서 검색',
      onclick: async () => {
        const k = await this.recordKey('검색할 키 조합을 누르세요');
        if (k) { this.keyQuery = k; search.value = k; renderRows(); }
      },
    }, icon('record-keys'), '키로 검색');
    const onlyCustom = el('button.toggle' + (this.onlyCustom ? '.on' : ''), {
      onclick: () => { this.onlyCustom = !this.onlyCustom; onlyCustom.classList.toggle('on', this.onlyCustom); renderRows(); },
    }, '변경한 것만');
    const table = el('div.keytable');
    const renderRows = () => {
      const q = this.keyQuery.trim().toLowerCase();
      const qKey = /\+|^f\d+$/i.test(q) ? normalizeKey(q) : null;
      const rows = [...K.commands.values()].filter((c) => {
        if (this.onlyCustom && !K.isCustom(c.id)) return false;
        if (!q) return true;
        const keys = K.keysFor(c.id);
        if (qKey && keys.some((k) => k === qKey || k.startsWith(qKey + ' '))) return true;
        return (c.label + ' ' + c.id + ' ' + c.category + ' ' + keys.join(' ')).toLowerCase().includes(q);
      });
      table.replaceChildren(
        el('div.keyrow.head', null, el('span', null, '명령'), el('span', null, '단축키'), el('span', null, '범위'), el('span', null, '')),
        ...rows.map((c) => this.keyRow(c, renderRows)));
      if (!rows.length) table.append(el('div.empty-msg', null, '일치하는 명령이 없어요.'));
    };
    renderRows();
    const keymapSel = el('select.settings-input.keymap-select', {
      title: '키맵',
      onchange: (e) => this.app.setSetting('keyboard.keymap', e.target.value).then(() => this.render && this.render()),
    }, ...Object.entries(KEYMAPS).map(([v, m]) => el('option', { value: v, selected: v === K.keymap }, m.label)));
    wrap.append(
      el('h2', null, '단축키'),
      el('p.si-desc', null, `지금 키맵은 ${keymapLabel(K.keymap)}이에요. 단축키를 더블클릭하거나 ✎를 눌러 바꿀 수 있어요. Ctrl+K Ctrl+S 처럼 두 번 누르는 조합도 돼요.`),
      el('div.keytools', null, el('label.keymap-label', null, '키맵', keymapSel), search, recordSearch, onlyCustom,
        el('button.btn', { onclick: () => this.resetAllKeys(renderRows) }, icon('discard'), '모두 기본값으로')),
      table);
    return wrap;
  }

  keyRow(c, rerender) {
    const K = this.app.keys;
    const keys = K.keysFor(c.id);
    const custom = K.isCustom(c.id);
    const chips = keys.length
      ? keys.map((k, i) => {
        const conflicts = K.commandsForKey(k, c.id).filter((o) => o.scope === c.scope || o.scope === 'global' || c.scope === 'global');
        return el('span.keychip' + (conflicts.length ? '.conflict' : ''), { title: conflicts.length ? `같은 키를 쓰는 명령: ${conflicts.map((o) => o.label).join(', ')}` : '' },
          displayKey(k),
          el('span.kx', { title: '이 키 제거', onclick: (e) => { e.stopPropagation(); this.setKeys(c.id, keys.filter((_, j) => j !== i), rerender); } }, '×'));
      })
      : [el('span.nokey', null, '—')];
    return el('div.keyrow' + (custom ? '.custom' : ''), {
      ondblclick: () => this.editKey(c, 0, rerender),
    },
    el('span.kname', null, el('span', null, c.label), el('span.kcat', null, `${c.category} · ${c.id}`)),
    el('span.kkeys', null, ...chips),
    el('span.kscope', null, c.scope === 'editor' ? '에디터' : '전역'),
    el('span.kact', null,
      el('button.tb-btn.icon.small', { title: keys.length ? '단축키 바꾸기' : '단축키 추가', onclick: () => this.editKey(c, 0, rerender) }, icon('edit')),
      keys.length ? el('button.tb-btn.icon.small', { title: '단축키 하나 더 추가', onclick: () => this.editKey(c, keys.length, rerender) }, icon('add')) : null,
      custom ? el('button.tb-btn.icon.small', { title: '기본값으로', onclick: () => this.resetKey(c.id, rerender) }, icon('discard')) : null));
  }

  async editKey(c, index, rerender) {
    const K = this.app.keys;
    const k = await this.recordKey(`'${c.label}' 단축키`, c.id);
    if (!k) return;
    const keys = [...K.keysFor(c.id)];
    keys[index] = k;
    this.setKeys(c.id, [...new Set(keys.filter(Boolean))], rerender);
  }

  setKeys(id, keys, rerender) {
    const map = { ...(this.app.settings.keybindings || {}) };
    const def = this.app.keys.defaultKeys(id);
    if (keys.length === def.length && keys.every((k, i) => k === def[i])) delete map[id];
    else map[id] = keys;
    this.app.setSetting('keybindings', map).then(rerender);
  }

  resetKey(id, rerender) {
    const map = { ...(this.app.settings.keybindings || {}) };
    delete map[id];
    this.app.setSetting('keybindings', map).then(rerender);
  }

  async resetAllKeys(rerender) {
    const r = await window.papyrus.app.confirm({ message: `직접 바꾼 단축키를 모두 지우고 키맵(${keymapLabel(this.app.keys.keymap)}) 기본값으로 되돌릴까요?`, buttons: ['되돌리기', '취소'] });
    if (r === 0) this.app.setSetting('keybindings', {}).then(rerender);
  }

  // Captures a key or a two-step chord. Enter confirms, Esc cancels.
  recordKey(title, forId) {
    const K = this.app.keys;
    return new Promise((resolve) => {
      let parts = [];
      const keyEl = el('div.rec-key', null, '키를 누르세요');
      const info = el('div.rec-info');
      const done = (v) => {
        K.recording = false;
        window.removeEventListener('keydown', onKey, true);
        back.remove();
        resolve(v);
      };
      const update = () => {
        const k = parts.join(' ');
        keyEl.textContent = k ? displayKey(k) : '키를 누르세요';
        const conflicts = k && forId !== undefined ? K.commandsForKey(k).filter((o) => o.id !== forId) : [];
        info.replaceChildren(...[
          parts.length === 1 ? el('div', null, '두 번 누르는 조합이면 이어서 다음 키를 누르세요.') : null,
          conflicts.length ? el('div.rec-conflict', null, icon('warning'), ` 이미 사용 중: ${conflicts.map((o) => o.label).join(', ')}`) : null,
          el('div.rec-help', null, el('kbd', null, 'Enter'), ' 확인  ', el('kbd', null, 'Esc'), ' 취소  ', el('kbd', null, 'Backspace'), ' 다시'),
        ].filter(Boolean));
      };
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
          if (e.key === 'Escape') return done(null);
          if (e.key === 'Enter' && parts.length) return done(parts.join(' '));
          if (e.key === 'Backspace') { parts = []; update(); return; }
        }
        const k = eventToKey(e);
        if (!k) return;
        if (parts.length >= 2) parts = [];
        parts.push(k);
        update();
      };
      const back = el('div.dialog-back', { onmousedown: (e) => { if (e.target === back) done(null); } },
        el('div.dialog.recorder', null, el('h3', null, title), keyEl, info,
          el('div.row', null,
            el('button.btn', { onclick: () => done(null) }, '취소'),
            el('button.btn.primary', { onclick: () => done(parts.length ? parts.join(' ') : null) }, '확인'))));
      document.getElementById('overlay-root').append(back);
      K.recording = true;
      window.addEventListener('keydown', onKey, true);
      update();
    });
  }
}
