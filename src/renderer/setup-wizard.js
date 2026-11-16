// C# tools plus optional live Unity integration.
import { el, icon, toast } from './ui.js';

const S = window.papyrus.setup;

const STEPS = [
  { id: 'dotnet', title: '.NET 10 SDK', desc: 'C# 언어 서버를 실행하는 데 필요해요. winget으로 설치해요 (관리자 권한 확인 창이 뜰 수 있어요).' },
  { id: 'lsp', title: 'C# 언어 서버', desc: '자동완성, 오류 표시, 이름 바꾸기 등을 담당해요. (roslyn-language-server)' },
  { id: 'unity', optional: true, title: 'Unity 실시간 연동 (선택)', desc: 'Unity의 콘솔, Play 제어, 라이브 인스펙터와 프로젝트 파일 생성 기능을 추가해요.' },
];
const UNITY_ARGS = '--project $(ProjectPath) --file $(File) --line $(Line) --column $(Column)';

export class SetupWizard {
  constructor(app) {
    this.app = app;
    this.running = false;
  }

  async status() {
    return S.status();
  }

  // Show automatically after opening a project if something is missing.
  async maybeShow() {
    if (this.app.settings['setup.dontShow']) return;
    const st = await this.status();
    if (this.missing(st).length) this.open(st);
  }

  missing(st) {
    return STEPS.filter((s) => !s.optional && !st[s.id].ok);
  }

  async open(st) {
    if (this.back) return;
    st = st || await this.status();
    this.st = st;
    this.list = el('div.setup-list');
    this.runBtn = el('button.btn.primary', { onclick: () => this.runAll() }, icon('zap'), 'C# 도구 자동 설정');
    const dont = el('input', { type: 'checkbox', checked: !!this.app.settings['setup.dontShow'], onchange: (e) => this.app.setSetting('setup.dontShow', e.target.checked) });
    this.back = el('div.dialog-back', { onmousedown: (e) => { if (e.target === this.back && !this.running) this.close(); } },
      el('div.dialog.setup', null,
        el('div.setup-head', null, el('img', { src: this.app.logoUrl, alt: '' }), el('div', null, el('h3', null, 'PAPyrus 설정 도우미'))),
        this.list,
        el('div.row', null,
          el('label.setup-dont', null, dont, '다시 자동으로 띄우지 않기'),
          el('span', { style: { flex: 1 } }),
          el('button.btn', { onclick: () => !this.running && this.close() }, '닫기'),
          this.runBtn)));
    document.getElementById('overlay-root').append(this.back);
    this.render();
  }

  close() {
    if (this.back) this.back.remove();
    this.back = null;
  }

  stepState(id) {
    const st = this.st;
    if (this.busy === id) return 'busy';
    if (id === 'unity' && !st.unity.isUnity) return 'skip';
    return st[id].ok ? 'ok' : this.failed && this.failed.has(id) ? 'fail' : 'todo';
  }

  render() {
    if (!this.back) return;
    this.list.replaceChildren(...STEPS.filter((s) => !s.optional || this.st.unity.isUnity).map((s) => {
      const state = this.stepState(s.id);
      const ic = { ok: 'pass-filled', busy: 'loading', todo: 'circle-large-outline', fail: 'error', skip: 'circle-slash' }[state];
      const i = icon(ic);
      if (state === 'busy') i.classList.add('spin');
      let note = '';
      if (s.id === 'dotnet' && this.st.dotnet.version) note = `설치된 버전: ${this.st.dotnet.version}`;
      if (state === 'skip') note = 'Unity 프로젝트가 아니라서 건너뛰어요.';
      return el('div.setup-step.' + state, null, el('span.setup-icon', null, i),
        el('div.setup-text', null, el('div.setup-title', null, s.title), el('div.setup-desc', null, s.desc), note ? el('div.setup-note', null, note) : null),
        state === 'todo' || state === 'fail' ? el('button.btn', { onclick: () => this.runOne(s.id) }, '설치') : null);
    }));
    if (this.st.unity.isUnity && this.app.externalEditorPath) {
      const copyField = (label, value) => el('input.settings-search', {
        'aria-label': label, value, readonly: true, onclick: (event) => event.currentTarget.select(),
      });
      this.list.append(el('div.setup-step', null, el('div.setup-text', null,
        el('div.setup-title', null, 'Unity에서 스크립트 열기'),
        el('div.setup-desc', null, 'Unity 환경설정 → External Tools → External Script Editor에서 PAPyrus를 선택하세요. Browse로 직접 등록할 때는 아래 실행 파일과 인자를 사용하세요.'),
        copyField('PAPyrus 실행 파일', this.app.externalEditorPath),
        copyField('External Script Editor Args', UNITY_ARGS))));
    }
    const left = this.missing(this.st).length;
    this.runBtn.disabled = this.running || !left;
    this.runBtn.lastChild.textContent = left ? 'C# 도구 자동 설정' : '설정 완료';
  }

  async runOne(id) {
    if (this.running) return false;
    this.running = true;
    const ok = await this.exec(id);
    this.running = false;
    this.render();
    return ok;
  }

  async exec(id) {
    this.busy = id;
    this.failed = this.failed || new Set();
    this.render();
    let ok = false;
    try {
      if (id === 'dotnet') ok = await S.installDotnet();
      else if (id === 'lsp') ok = await S.installLsp();
      else if (id === 'unity') ok = !!(await window.papyrus.unity.installPackage());
    } catch (err) {
      toast({ kind: 'error', title: '설치 실패', message: String(err.message || err) });
    }
    this.busy = null;
    this.st = await this.status();
    if (!ok) this.failed.add(id);
    else this.failed.delete(id);
    if (ok && id === 'lsp') this.app.restartLsp();
    return ok;
  }

  async runAll() {
    if (this.running) return;
    this.running = true;
    this.render();
    for (const s of this.missing(this.st)) {
      if (s.id === 'lsp' && !this.st.dotnet.ok) break; // needs the SDK first
      if (!(await this.exec(s.id))) {
        this.app.panels.show('output');
        break;
      }
    }
    this.running = false;
    this.render();
    if (!this.missing(this.st).length) {
      toast({ title: 'C# 도구 설정 완료', message: '이제 C# 자동완성과 코드 탐색을 사용할 수 있어요.', timeout: 6000 });
      setTimeout(() => this.close(), 1200);
    }
  }
}
