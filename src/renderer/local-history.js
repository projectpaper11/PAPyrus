// Local History (Rider): the versions src/main/local-history.js keeps of every file PAPyrus writes.
//  - file history: pick a version, see it next to the current text (diff), restore it
//  - project history: every change and label ("before rename X"...), newest first; going back to a
//    point restores all files changed since (moves undone, created files removed)
import { monaco } from './monaco.js';
import { modal } from './refactorings.js';
import { el, icon, basename, joinPath, relPath, samePath, fileIcon, toast } from './ui.js';

const H = window.papyrus.history;
const ofs = window.papyrus.fs;

/** Marks "the project as it is now" before a multi-file operation. Never throws. */
export function historyLabel(text) {
  try {
    return H.label(text).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

const KIND = {
  before: ['변경 전', 'history'],
  save: ['저장', 'save'],
  created: ['만듦', 'new-file'],
  deleted: ['삭제', 'trash'],
  moved: ['이동', 'arrow-right'],
  revert: ['되돌림', 'discard'],
  label: ['', 'tag'],
};

/** Folder part of a project-relative path ('' at the root). */
function relDir(r) {
  const i = Math.max(r.lastIndexOf('/'), r.lastIndexOf('\\'));
  return i > 0 ? r.slice(0, i) : '';
}

const pad = (n) => String(n).padStart(2, '0');
function when(t) {
  const d = new Date(t);
  const diff = Date.now() - t;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (diff < 60000) return '방금';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전 · ${hm}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `오늘 ${hm}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `어제 ${hm}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
}

let seq = 0;
/** A throwaway model; the file name keeps the extension so it gets the right highlighting. */
const tempModel = (text, path) => monaco.editor.createModel(text, undefined, monaco.Uri.from({ scheme: 'papyrus-history', path: `/${++seq}/${basename(path)}` }));

export class LocalHistory {
  constructor(app) {
    this.app = app;
  }

  get E() { return this.app.editors; }

  /** A label before a multi-file operation: the project can be put back to how it was here. */
  label(text) {
    return historyLabel(text);
  }

  ready() {
    if (!this.app.project) {
      toast({ kind: 'warn', title: '로컬 히스토리', message: '프로젝트를 먼저 여세요.', timeout: 2500 });
      return false;
    }
    if (this.app.settings['history.enabled'] === false) {
      toast({ kind: 'warn', title: '로컬 히스토리', message: '설정 → 파일에서 로컬 히스토리가 꺼져 있어요.', timeout: 3500 });
    }
    return true;
  }

  diffOptions() {
    const s = this.app.settings;
    return {
      theme: this.app.monacoTheme(),
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      fontFamily: s['editor.fontFamily'],
      fontSize: s['editor.fontSize'],
      lineHeight: Math.round(s['editor.fontSize'] * s['editor.lineHeight']),
      fontLigatures: !!s['editor.fontLigatures'],
      minimap: { enabled: false },
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
    };
  }

  /** What the file holds now: the open tab's text (unsaved edits too), else the disk's. */
  async currentText(path) {
    const tab = this.E.findTab(path);
    if (tab && tab.model) return { text: tab.model.getValue(), tab };
    const res = (await ofs.exists(path)) ? await ofs.readFile(path) : null;
    return { text: res && !res.binary && !res.tooLarge ? res.text : '', missing: !res, encoding: res && res.encoding };
  }

  // ------------------------------------------------------------------ one file
  async showFile(path) {
    if (!path || !this.ready()) return;
    const data = await H.file(path);
    // the same content twice in a row (saved, then "before" the next save) is one version
    const versions = [];
    for (const e of data.entries) {
      const prev = versions[versions.length - 1];
      if (prev && prev.h === e.h && e.k !== 'deleted' && e.k !== 'moved') continue;
      versions.push(e);
    }
    if (!versions.some((v) => v.h)) {
      toast({ title: '로컬 히스토리', message: `${basename(path)}: 아직 남은 기록이 없어요. 저장하면 이전 내용이 기록돼요.`, timeout: 3500 });
      return;
    }
    const labels = (data.labels || []).slice().reverse();

    const dlg = modal({ title: `로컬 히스토리 — ${basename(path)}`, width: 1180 });
    dlg.body.classList.add('lh-body');
    const list = el('div.lh-list', { tabindex: '0' });
    const diffHost = el('div.lh-diff');
    const info = el('div.lh-info');
    dlg.body.append(el('div.lh-wrap', null, list, el('div.lh-right', null, info, diffHost)));
    const revertBtn = el('button.btn.primary', { disabled: true }, icon('discard'), '이 버전으로 되돌리기');
    dlg.foot.append(el('span.lh-foot-note', null, relPath(this.app.project, path)), el('button.btn', { onclick: () => dlg.close(null) }, '닫기'), revertBtn);

    const diff = monaco.editor.createDiffEditor(diffHost, this.diffOptions());
    const models = [];
    const cur = await this.currentText(path);
    const right = tempModel(cur.text, path);
    models.push(right);
    let left = null;
    let selected = null;
    const rows = [];

    const select = async (v, row) => {
      selected = v;
      rows.forEach((r) => r.classList.toggle('on', r === row));
      row.scrollIntoView({ block: 'nearest' });
      revertBtn.disabled = !v.h;
      const text = v.h ? (await H.content(v.h)).text : '';
      if (selected !== v) return;
      const old = left;
      left = tempModel(text, path);
      models.push(left);
      diff.setModel({ original: left, modified: right });
      if (old) { models.splice(models.indexOf(old), 1); old.dispose(); }
      const same = v.h && text === cur.text;
      info.replaceChildren(
        el('span', null, el('b', null, '선택한 버전'), ` (${when(v.t)})`),
        el('span.lh-sep', null, '↔'),
        el('span', null, el('b', null, '지금'), cur.tab && cur.tab.dirty ? ' (저장 안 한 내용 포함)' : cur.missing ? ' (파일 없음)' : ''),
        same ? el('span.lh-same', null, '지금과 같아요') : null,
      );
      setTimeout(() => {
        const ch = diff.getLineChanges();
        if (ch && ch.length) diff.getModifiedEditor().revealLineInCenterIfOutsideViewport(ch[0].modifiedStartLineNumber || 1);
      }, 120);
    };

    let li = 0;
    for (const v of versions) {
      // labels between this version and the next newer one
      while (li < labels.length && labels[li].t > v.t) {
        if (labels[li].t <= (versions[0].t + 1)) list.append(el('div.lh-label', null, icon('tag'), labels[li].l, el('span.lh-time', null, when(labels[li].t))));
        li++;
      }
      const [kind, ic] = KIND[v.k] || [v.k, 'circle'];
      const extra = v.k === 'moved' ? (v.to ? ` → ${v.to}` : v.from ? ` ← ${v.from}` : '') : '';
      const row = el('div.lh-row' + (v.h ? '' : '.dim'), { onclick: () => select(v, row) },
        icon(ic),
        el('div.lh-main', null, el('div.lh-when', null, when(v.t)), el('div.lh-kind', null, kind + extra)));
      rows.push(row);
      list.append(row);
    }
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = rows.findIndex((r) => r.classList.contains('on'));
      const n = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      rows[n].click();
    });

    // newest version that differs from now
    const first = versions.findIndex((v) => v.h) ;
    await select(versions[first], rows[first]);
    list.focus();

    revertBtn.onclick = async () => {
      if (!selected || !selected.h) return;
      const { text, encoding } = await H.content(selected.h);
      await this.restoreFile(path, text, encoding);
      dlg.close(true);
      toast({ title: '로컬 히스토리', message: `${basename(path)}을(를) ${when(selected.t)} 버전으로 되돌렸어요. (Ctrl+Z로 취소)`, timeout: 4000 });
    };

    await dlg.result;
    diff.dispose();
    for (const m of models) m.dispose();
  }

  /** Puts text into the file: through the open tab (undoable with Ctrl+Z, then saved), else on disk. */
  async restoreFile(path, text, encoding) {
    const tab = this.E.findTab(path);
    if (tab && tab.model) {
      const m = tab.model;
      m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null);
      await this.E.save(tab, { skipUsings: true });
      return;
    }
    await ofs.writeFile(path, text, encoding === 'cp949' ? 'utf8bom' : encoding || 'utf8');
    this.app.lsp.syncDiskWrite(monaco.Uri.file(path).toString(), text);
    this.app.lsp.refreshAfterExternalEdit();
  }

  // ------------------------------------------------------------------ whole project
  async showProject() {
    if (!this.ready()) return;
    const items = await H.recent(600);
    if (!items.length) {
      toast({ title: '로컬 히스토리', message: '아직 남은 기록이 없어요.', timeout: 3000 });
      return;
    }
    const dlg = modal({ title: '로컬 히스토리 — 프로젝트 최근 변경', width: 760 });
    dlg.body.classList.add('lh-body');
    const list = el('div.lh-plist', { tabindex: '0' });
    dlg.body.append(list);
    const hint = el('span.lh-foot-note', null, '줄을 고르면 그 변경 "전" 상태로 프로젝트를 되돌릴 수 있어요. 파일 줄을 더블클릭하면 파일 히스토리가 열려요.');
    const revertBtn = el('button.btn.primary', { disabled: true }, icon('discard'), '이 변경 전으로 되돌리기');
    dlg.foot.append(hint, el('button.btn', { onclick: () => dlg.close(null) }, '닫기'), revertBtn);

    let selected = null;
    const rows = [];
    let day = '';
    for (const it of items) {
      const d = new Date(it.t).toDateString();
      if (d !== day) {
        day = d;
        list.append(el('div.lh-day', null, when(it.t).replace(/ \d\d:\d\d:\d\d$/, '').replace(/^(방금|\d+분 전 · .*)$/, '오늘')));
      }
      const [kind, ic] = KIND[it.k] || [it.k, 'circle'];
      let row;
      if (it.k === 'label') {
        row = el('div.lh-prow.lh-plabel', null, icon(ic), el('span.lh-ptext', null, it.l), el('span.lh-time', null, when(it.t)));
      } else {
        const abs = joinPath(this.app.project, it.path);
        const extra = it.k === 'moved' ? (it.to ? ` → ${it.to}` : '') : '';
        row = el('div.lh-prow', { title: it.path, ondblclick: () => { dlg.close(null); this.showFile(it.to ? joinPath(this.app.project, it.to) : abs); } },
          fileIcon(basename(it.path), false),
          el('span.lh-ptext', null, basename(it.path), el('span.lh-pdir', null, relDir(it.path))),
          el('span.lh-pkind', null, icon(ic), kind + extra),
          el('span.lh-time', null, when(it.t)));
      }
      row.onclick = () => {
        selected = it;
        rows.forEach((r) => r.classList.toggle('on', r === row));
        revertBtn.disabled = false;
      };
      rows.push(row);
      list.append(row);
    }
    list.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && selected) { e.preventDefault(); revertBtn.click(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = rows.findIndex((r) => r.classList.contains('on'));
      const n = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      rows[n].click();
      rows[n].scrollIntoView({ block: 'nearest' });
    });
    list.focus();

    revertBtn.onclick = async () => {
      if (!selected) return;
      const T = selected.t - 1;
      const plan = await H.changesSince(T);
      if (!plan.files.length && !plan.renames.length) {
        toast({ title: '로컬 히스토리', message: '되돌릴 변경이 없어요. 그 뒤로 바뀐 파일이 이미 그때와 같아요.', timeout: 3500 });
        return;
      }
      const what = selected.k === 'label' ? `"${selected.l}"` : `${basename(selected.path)} ${KIND[selected.k] ? KIND[selected.k][0] : ''}`;
      if (!(await this.confirmRevert(plan, what, selected.t))) return;
      dlg.close(true);
      await this.revertProject(T);
    };
    await dlg.result;
  }

  async confirmRevert(plan, what, t) {
    const root = this.app.project;
    const dirty = new Set(this.E.dirtyTabs.map((x) => x.path.toLowerCase()));
    const dlg = modal({ title: '프로젝트 되돌리기', width: 560 });
    const list = el('div.cd-list');
    for (const r of plan.renames) {
      list.append(el('div.cd-use', { title: `${r.to} → ${r.from}` }, icon('arrow-left'), el('span.cd-file', null, basename(r.from)), el('span.cd-code', null, `${r.to} → ${r.from}`)));
    }
    for (const f of plan.files) {
      const abs = joinPath(root, f.path);
      const isDirty = dirty.has(abs.toLowerCase());
      list.append(el('div.cd-use', { title: f.path },
        f.h ? fileIcon(basename(f.path), false) : icon('trash'),
        el('span.cd-file', null, basename(f.path)),
        el('span.cd-code', null, (f.h ? '' : '지움 · ') + relDir(f.path) + (isDirty ? ' · 저장 안 한 편집 있음' : ''))));
    }
    const dirtyHit = plan.files.some((f) => dirty.has(joinPath(root, f.path).toLowerCase()));
    dlg.body.append(
      el('div.cd-warn', null, icon('history'), el('div', null,
        el('div.cd-msg', null, `${what} 전으로 되돌릴까요?`),
        el('div.cd-sub', null, `${when(t)} 이후에 바뀐 파일 ${plan.files.length}개${plan.renames.length ? `, 이동 ${plan.renames.length}건` : ''}을 그때 상태로 돌려요. 그 뒤에 만든 파일은 휴지통으로 가요.`))),
      list,
      el('div.cd-note', null, icon('info'), el('span', null, '지금 상태도 기록에 남기 때문에 이 되돌리기도 다시 되돌릴 수 있어요.',
        dirtyHit ? ' 저장 안 한 편집은 덮어써져요 (탭에서 Ctrl+Z로 되찾을 수 있어요).' : '')));
    const ok = el('button.btn.primary', { onclick: () => dlg.close(true) }, '되돌리기');
    dlg.foot.append(el('button.btn', { onclick: () => dlg.close(false) }, '취소'), ok);
    ok.focus();
    return !!(await dlg.result);
  }

  async revertProject(T, { quiet = false } = {}) {
    const root = this.app.project;
    let done;
    try {
      done = await H.revertTo(T);
    } catch (err) {
      toast({ kind: 'error', title: '되돌리기 실패', message: String(err.message || err), timeout: 0 });
      return;
    }
    if (!done) return;
    const E = this.E;
    // moved back: tabs at the newer path follow the file
    for (const r of done.renamed) {
      const from = joinPath(root, r.from);
      const to = joinPath(root, r.to);
      for (const t of E.tabs.filter((x) => !x.special && x.path && samePath(x.path, to))) {
        const g = t.group;
        await E.closeTab(t, { force: true, noHistory: true });
        await E.open(from, E.groups.includes(g) ? { group: g } : {});
      }
    }
    for (const rel of done.removed) {
      const p = joinPath(root, rel);
      for (const t of E.tabs.filter((x) => !x.special && x.path && samePath(x.path, p))) await E.closeTab(t, { force: true, noHistory: true });
    }
    let closedWritten = false;
    for (const rel of done.restored) {
      const p = joinPath(root, rel);
      const res = await ofs.readFile(p);
      if (res.binary || res.tooLarge) continue;
      const tab = E.findTab(p);
      if (tab && tab.model) E.reloadFromDisk(tab, res);
      else {
        this.app.lsp.syncDiskWrite(monaco.Uri.file(p).toString(), res.text);
        closedWritten = true;
      }
    }
    if (closedWritten) this.app.lsp.refreshAfterExternalEdit();
    if (this.app.explorer) this.app.explorer.refresh();
    if (this.app.unityRefreshSoon) this.app.unityRefreshSoon();
    const n = done.restored.length + done.removed.length + done.renamed.length;
    if (!quiet) toast({ title: '로컬 히스토리', message: `파일 ${n}개를 되돌렸어요.${done.removed.length ? ` (${done.removed.length}개는 휴지통으로)` : ''}`, timeout: 4000 });
  }
}
