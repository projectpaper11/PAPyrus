// Settings tab (VS Code-style): grouped options on the left, keybinding editor included.
import { el, icon, toast, debounce } from './ui.js';
import { eventToKey, displayKey, normalizeKey } from './keybindings.js';

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
      { key: 'editor.codeLens', label: '참조 개수 표시', type: 'bool', desc: '클래스·메서드 위에 "N references"를 표시해요.' },
      { key: 'editor.stickyScroll', label: '현재 클래스/메서드 머리글 고정', type: 'bool' },
      { key: 'editor.renderWhitespace', label: '공백 문자 표시', type: 'select', options: [['none', '안 함'], ['boundary', '단어 사이 공백 제외'], ['all', '모두']] },
    ],
  },
  {
    id: 'editor', title: '에디터', icon: 'edit', items: [
      { key: 'editor.tabSize', label: '탭 크기', type: 'number', min: 1, max: 8 },
      { key: 'editor.insertSpaces', label: 'Tab 키로 공백 넣기', type: 'bool' },
      { key: 'editor.wordWrap', label: '자동 줄 바꿈', type: 'bool' },
      { key: 'editor.formatOnSave', label: '저장할 때 서식 적용 (C#)', type: 'bool' },
      { key: 'editor.formatOnType', label: '입력하면서 서식 적용', type: 'bool', desc: '; 나 } 를 입력하면 해당 줄을 정리해요.' },
      { key: 'editor.learnedCompletions', label: '학습형 자동완성', type: 'bool', desc: '직접 쓴 줄과 열린 파일에서 반복되는 줄을 기억해서 제안하고, Unity 스니펫(sf, awake, dlog…)도 보여 줘요.' },
    ],
  },
  {
    id: 'files', title: '파일', icon: 'files', items: [
      { key: 'files.autoSave', label: '자동 저장', type: 'select', options: [['off', '끄기'], ['afterDelay', '입력을 멈추면'], ['onFocusChange', '탭이나 창을 바꿀 때']] },
      { key: 'files.autoSaveDelay', label: '자동 저장 지연 (ms)', type: 'number', min: 200, max: 10000, step: 100 },
      { key: 'explorer.hideProjectFiles', label: 'Explorer에서 .sln / .csproj 숨기기', type: 'bool' },
      { key: 'files.exclude', label: 'Explorer·검색에서 제외할 폴더', type: 'list', desc: '한 줄에 하나씩' },
      { key: 'reopenLastProject', label: '시작할 때 마지막 프로젝트 열기', type: 'bool' },
    ],
  },
  {
    id: 'unity', title: 'Unity', icon: 'game', items: [
      { key: 'unity.refreshOnSave', label: '저장하면 Unity 에셋 새로고침', type: 'bool', desc: 'Unity 창으로 돌아가기 전에 컴파일이 시작돼요.' },
      { key: 'unity.clearLogOnPlay', label: 'Play할 때 Unity Log 지우기', type: 'bool' },
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
    wrap.append(
      el('h2', null, '단축키'),
      el('p.si-desc', null, '기본값은 Visual Studio Code 키맵이에요. 단축키를 더블클릭하거나 ✎를 눌러 바꿀 수 있어요. Ctrl+K Ctrl+S 처럼 두 번 누르는 조합도 돼요.'),
      el('div.keytools', null, search, recordSearch, onlyCustom,
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
    const def = this.app.keys.commands.get(id).keys;
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
    const r = await window.papyrus.app.confirm({ message: '모든 단축키를 기본값(VS Code)으로 되돌릴까요?', buttons: ['되돌리기', '취소'] });
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
