'use strict';
// Auto update via electron-updater + GitHub Releases.
// Flow: check on startup / every 4h -> renderer shows "new version" toast -> user accepts ->
// download (progress in status bar) -> "restart to install" -> quitAndInstall.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let autoUpdater = null;
let state = { status: 'idle' };
let timer = null;

function send() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:state', state);
  }
}

function set(next) {
  state = { ...next, current: app.getVersion() };
  send();
}

const PLACEHOLDER = 'YOUR_GITHUB_ID';

function supported() {
  if (!app.isPackaged) return false;
  // Only NSIS installs ship app-update.yml; the portable zip can't self-update.
  return fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}

// "owner/repo" from settings wins; otherwise whatever the build baked into app-update.yml.
function feed(settings) {
  const fromSettings = String(settings.get('update.repo') || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(fromSettings)) {
    const [owner, repo] = fromSettings.split('/');
    return { owner, repo, custom: true };
  }
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = (yml.match(/^owner:\s*(.+)$/m) || [])[1];
    const repo = (yml.match(/^repo:\s*(.+)$/m) || [])[1];
    if (owner && repo && owner.trim() !== PLACEHOLDER) return { owner: owner.trim(), repo: repo.trim(), custom: false };
  } catch { /* ignore */ }
  return null;
}

async function check(manual) {
  if (!autoUpdater) {
    set({ status: 'disabled', manual, reason: disabledReason });
    return state;
  }
  if (['checking', 'downloading', 'downloaded'].includes(state.status)) return state;
  set({ status: 'checking', manual });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    set({ status: 'error', manual, error: String((err && err.message) || err) });
  }
  return state;
}

let disabledReason = '';

function init(settings) {
  const f = supported() ? feed(settings) : null;
  if (!supported()) {
    disabledReason = app.isPackaged ? '설치 파일(PAPyrus-Setup)로 설치한 경우에만 자동 업데이트돼요.' : '개발 모드에서는 업데이트를 확인하지 않아요.';
    state = { status: 'disabled', current: app.getVersion() };
  } else if (!f) {
    disabledReason = '업데이트를 받을 GitHub 저장소가 설정되지 않았어요. 설정 → 업데이트에서 "아이디/저장소"를 넣어 주세요.';
    state = { status: 'disabled', current: app.getVersion() };
  } else {
    ({ autoUpdater } = require('electron-updater'));
    if (f.custom) autoUpdater.setFeedURL({ provider: 'github', owner: f.owner, repo: f.repo, releaseType: 'release' });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    let manual = false;
    autoUpdater.on('checking-for-update', () => { manual = state.manual; });
    autoUpdater.on('update-available', (info) => {
      const skip = settings.get('update.skipVersion');
      if (!manual && skip && skip === info.version) {
        set({ status: 'none', manual });
        return;
      }
      set({ status: 'available', manual, version: info.version, notes: notesText(info.releaseNotes), date: info.releaseDate });
    });
    autoUpdater.on('update-not-available', () => set({ status: 'none', manual }));
    autoUpdater.on('download-progress', (p) => set({ ...state, status: 'downloading', percent: Math.round(p.percent || 0), bytesPerSecond: p.bytesPerSecond }));
    autoUpdater.on('update-downloaded', (info) => set({ status: 'downloaded', version: info.version, notes: notesText(info.releaseNotes) }));
    autoUpdater.on('error', (err) => set({ status: 'error', manual, error: String((err && err.message) || err) }));

    if (settings.get('update.checkOnStartup') !== false) {
      setTimeout(() => check(false), 6000);
      timer = setInterval(() => check(false), 4 * 60 * 60 * 1000);
    }
  }

  ipcMain.handle('update:getState', () => ({ ...state, current: app.getVersion() }));
  ipcMain.handle('update:check', () => check(true));
  ipcMain.handle('update:download', async () => {
    if (!autoUpdater || state.status !== 'available') return state;
    set({ ...state, status: 'downloading', percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      set({ status: 'error', error: String((err && err.message) || err) });
    }
    return state;
  });
  ipcMain.handle('update:skip', (_e, version) => {
    settings.set('update.skipVersion', version);
    set({ status: 'none' });
  });
  ipcMain.handle('update:install', () => {
    if (!autoUpdater || state.status !== 'downloaded') return false;
    // isSilent=true: no installer UI, isForceRunAfter=true: reopen PAPyrus afterwards
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });
}

function notesText(notes) {
  if (!notes) return '';
  const raw = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes);
  return raw.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 600);
}

function dispose() {
  clearInterval(timer);
}

module.exports = { init, dispose };
