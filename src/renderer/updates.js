// Update notifications: "new version" toast -> download progress -> restart to install.
import { el, icon, toast } from './ui.js';

const U = window.papyrus.update;

export class Updates {
  constructor(app) {
    this.app = app;
    this.state = { status: 'idle' };
    this.toastEl = null;
    U.onState((s) => this.onState(s));
    U.getState().then((s) => { this.state = s; this.renderStatus(); });
  }

  closeToast() {
    if (this.toastEl) this.toastEl.remove();
    this.toastEl = null;
  }

  onState(s) {
    const prev = this.state.status;
    this.state = s;
    this.renderStatus();
    if (s.status === prev && s.status !== 'downloading') return;
    switch (s.status) {
      case 'available':
        this.closeToast();
        this.toastEl = toast({
          kind: 'info', timeout: 0,
          title: `PAPyrus ${s.version} 업데이트가 있어요`,
          message: `현재 버전 ${s.current}${s.notes ? '\n\n' + s.notes : ''}`,
          actions: [
            { label: '업데이트', action: () => this.download() },
            { label: '나중에', action: () => {} },
            { label: '이 버전 건너뛰기', action: () => U.skip(s.version) },
          ],
        });
        break;
      case 'downloaded':
        this.closeToast();
        this.toastEl = toast({
          kind: 'info', timeout: 0,
          title: `PAPyrus ${s.version} 설치 준비 완료`,
          message: '지금 재시작하면 업데이트가 설치돼요. 나중에 하면 PAPyrus를 끌 때 설치돼요.',
          actions: [
            { label: '지금 재시작', action: () => this.install() },
            { label: '나중에', action: () => {} },
          ],
        });
        break;
      case 'none':
        if (s.manual) toast({ title: '최신 버전이에요', message: `PAPyrus ${s.current}`, timeout: 3000 });
        break;
      case 'disabled':
        if (s.manual) toast({ kind: 'warn', title: '자동 업데이트를 쓸 수 없어요', message: s.reason || '', timeout: 5000 });
        break;
      case 'error':
        if (s.manual) toast({ kind: 'error', title: '업데이트 확인 실패', message: s.error || '', timeout: 6000 });
        break;
      default:
        break;
    }
  }

  async download() {
    this.closeToast();
    toast({ title: '업데이트를 내려받는 중이에요', message: '진행률은 아래 상태 표시줄에서 볼 수 있어요.', timeout: 3000 });
    await U.download();
  }

  async install() {
    if (this.app.editors.dirtyTabs.length) await this.app.editors.saveAll();
    await U.install();
  }

  check() {
    return U.check();
  }

  renderStatus() {
    const sb = document.getElementById('sb-update');
    const s = this.state;
    if (s.status === 'downloading') {
      sb.replaceChildren(icon('cloud-download'), `업데이트 ${s.percent || 0}%`);
      sb.title = 'PAPyrus 업데이트 내려받는 중';
      sb.onclick = null;
    } else if (s.status === 'downloaded') {
      sb.replaceChildren(icon('debug-restart'), '재시작해서 업데이트');
      sb.title = `PAPyrus ${s.version}`;
      sb.onclick = () => this.install();
    } else if (s.status === 'available') {
      sb.replaceChildren(icon('arrow-circle-up'), `${s.version} 업데이트`);
      sb.title = '클릭해서 업데이트';
      sb.onclick = () => this.download();
    } else {
      sb.replaceChildren();
      sb.onclick = null;
    }
  }
}

export { el };
