'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { LspServer } = require('./lsp');
const { UnityBridge } = require('./unity');
const files = require('./files');
const settings = require('./settings');
const { ensureUnityAnalyzers } = require('./analyzers');
const updater = require('./updater');
const setup = require('./setup');

app.setName('PAPyrus');
// Fixed location so the Unity package can find install-path.txt and the analyzers.
app.setPath('userData', path.join(app.getPath('appData'), 'PAPyrus'));

// ---------------------------------------------------------------- args
// Accepted:
//   PAPyrus.exe [--project <dir>] [--goto <file>[:line[:col]]]
//   PAPyrus.exe <dir-or-file>
function parseArgs(argv) {
  const out = { project: null, goto: null };
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project') out.project = args[++i];
    else if (a === '--goto') out.goto = parseGoto(args[++i]);
    else if (!a.startsWith('-') && a !== '.') {
      try {
        const st = fs.statSync(a);
        if (st.isDirectory()) out.project = path.resolve(a);
        else out.goto = { file: path.resolve(a), line: 1, column: 1 };
      } catch { /* ignore */ }
    }
  }
  if (out.goto && !out.project) out.project = findProjectRoot(out.goto.file);
  if (out.project) out.project = path.resolve(out.project);
  return out;
}

function parseGoto(s) {
  if (!s) return null;
  // Windows paths contain "C:" so parse numbers from the right.
  const m = s.match(/^(.*?)(?::(-?\d+))?(?::(-?\d+))?$/);
  const file = m[1];
  const line = Math.max(1, parseInt(m[2] || '1', 10) || 1);
  const column = Math.max(1, parseInt(m[3] || '1', 10) || 1);
  return { file: path.resolve(file), line, column };
}

function findProjectRoot(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, 'Assets')) && fs.existsSync(path.join(dir, 'ProjectSettings'))) return dir;
    try {
      if (fs.readdirSync(dir).some((f) => f.endsWith('.sln'))) return dir;
    } catch { /* ignore */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.dirname(file);
}

// ---------------------------------------------------------------- windows
/** @type {Map<number, {win: BrowserWindow, project: string|null, lsp: LspServer|null, unity: UnityBridge|null, pendingGoto: any}>} */
const sessions = new Map();

function sessionFor(sender) {
  const win = BrowserWindow.fromWebContents(sender);
  return win ? sessions.get(win.id) : null;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

// Title-bar button colors and window background per theme (the renderer sends 'dark' | 'light' | 'rainbow').
const OVERLAY = {
  dark: { color: '#2B2D30', symbolColor: '#DFE1E5' },
  light: { color: '#F7F8FA', symbolColor: '#1E1F22' },
  rainbow: { color: '#211E2C', symbolColor: '#E4E0F2' },
};
const WINDOW_BG = { dark: '#1E1F22', light: '#FFFFFF', rainbow: '#17151F' };

function createWindow(project, goto) {
  const state = settings.get('window') || {};
  const win = new BrowserWindow({
    width: state.width || 1500,
    height: state.height || 920,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: WINDOW_BG[settings.get('lastTheme')] || WINDOW_BG.dark,
    title: 'PAPyrus',
    icon: path.join(__dirname, '../../build/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { ...(OVERLAY[settings.get('lastTheme')] || OVERLAY.dark), height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  if (state.maximized) win.maximize();
  const s = { win, project: project || null, lsp: null, unity: null, pendingGoto: goto || null };
  sessions.set(win.id, s);

  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    if (!win.isMaximized() && !win.isMinimized()) {
      const b = win.getBounds();
      settings.set('window', { ...b, maximized: false });
    } else settings.set('window', { ...(settings.get('window') || {}), maximized: win.isMaximized() });
  });
  win.on('closed', () => {
    stopSession(s);
    sessions.delete(win.id);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, '../../dist/index.html'));
  if (process.env.PAPYRUS_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  // Test hook: PAPYRUS_SCREENSHOT=out.png [PAPYRUS_SCREENSHOT_DELAY=ms] [PAPYRUS_EVAL=js]
  if (process.env.PAPYRUS_SCREENSHOT) {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.PAPYRUS_EVAL) {
          try { console.log('[eval]', JSON.stringify(await win.webContents.executeJavaScript(process.env.PAPYRUS_EVAL))); } catch (err) { console.log('[eval error]', err.message); }
          await new Promise((r) => setTimeout(r, parseInt(process.env.PAPYRUS_EVAL_WAIT || '1500', 10)));
        }
        for (const key of (process.env.PAPYRUS_KEYS || '').split(',').filter(Boolean)) {
          if (key === 'WAIT') { await new Promise((r) => setTimeout(r, 1200)); continue; }
          const [mods, k] = key.includes('+') ? [key.split('+').slice(0, -1).map((m) => m.toLowerCase()), key.split('+').pop()] : [[], key];
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods });
          if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k, modifiers: mods });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods });
          await new Promise((r) => setTimeout(r, parseInt(process.env.PAPYRUS_KEY_DELAY || '120', 10)));
        }
        if (process.env.PAPYRUS_EVAL2) {
          await new Promise((r) => setTimeout(r, 800));
          try { console.log('[eval2]', JSON.stringify(await win.webContents.executeJavaScript(process.env.PAPYRUS_EVAL2))); } catch (err) { console.log('[eval2 error]', err.message); }
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.PAPYRUS_SCREENSHOT, img.toPNG());
        app.exit(0);
      }, parseInt(process.env.PAPYRUS_SCREENSHOT_DELAY || '3000', 10));
    });
  }
  return s;
}

function stopSession(s) {
  try { s.lsp && s.lsp.stop(); } catch { /* ignore */ }
  try { s.unity && s.unity.stop(); } catch { /* ignore */ }
  s.lsp = null;
  s.unity = null;
}

function focusWindow(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  // Windows focus-stealing workaround
  win.setAlwaysOnTop(true);
  win.focus();
  win.setAlwaysOnTop(false);
}

function routeOpen(args) {
  // find a window that already has this project
  for (const s of sessions.values()) {
    if (args.project && samePath(s.project, args.project)) {
      focusWindow(s.win);
      if (args.goto) s.win.webContents.send('app:goto', args.goto);
      return;
    }
  }
  // reuse an empty window
  for (const s of sessions.values()) {
    if (!s.project) {
      s.project = args.project;
      s.pendingGoto = args.goto;
      s.win.webContents.send('app:openProject', { project: args.project, goto: args.goto });
      focusWindow(s.win);
      return;
    }
  }
  createWindow(args.project, args.goto);
}

// ---------------------------------------------------------------- app lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const args = parseArgs(argv);
    if (!args.project) {
      const any = [...sessions.values()][0];
      if (any) focusWindow(any.win);
      else createWindow(null, null);
      return;
    }
    routeOpen(args);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    updater.init(settings);
    // Let the Unity package find us (portable installs included).
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(path.join(app.getPath('userData'), 'install-path.txt'), process.execPath);
    } catch { /* ignore */ }

    const args = parseArgs(process.argv);
    let project = args.project;
    if (!project && settings.get('reopenLastProject') !== false) {
      const recent = settings.get('recentProjects') || [];
      if (recent[0] && fs.existsSync(recent[0])) project = recent[0];
    }
    createWindow(project, args.goto);
  });

  app.on('window-all-closed', () => app.quit());
}

// ---------------------------------------------------------------- IPC: app/project
ipcMain.handle('app:init', (e) => {
  const s = sessionFor(e.sender);
  const goto = s.pendingGoto;
  s.pendingGoto = null;
  return {
    project: s.project,
    goto,
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    settings: settings.all(),
    recentProjects: settings.get('recentProjects') || [],
  };
});

ipcMain.handle('app:openFolderDialog', async (e) => {
  const s = sessionFor(e.sender);
  const r = await dialog.showOpenDialog(s.win, { properties: ['openDirectory'], title: 'Unity 프로젝트 폴더 열기' });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('app:setProject', (e, project) => {
  const s = sessionFor(e.sender);
  stopSession(s);
  s.project = project;
  if (project) {
    const recent = (settings.get('recentProjects') || []).filter((p) => !samePath(p, project));
    recent.unshift(project);
    settings.set('recentProjects', recent.slice(0, 12));
  }
  return true;
});

ipcMain.handle('app:setTitle', (e, title) => {
  const s = sessionFor(e.sender);
  s.win.setTitle(title);
});

ipcMain.handle('app:setSettings', (e, patch) => {
  for (const [k, v] of Object.entries(patch)) settings.set(k, v);
  return settings.all();
});

ipcMain.handle('app:settingsPath', () => settings.file);

ipcMain.handle('app:setTheme', (e, { effective, source }) => {
  nativeTheme.themeSource = ['dark', 'light', 'system'].includes(source) ? source : 'dark';
  const s = sessionFor(e.sender);
  const o = OVERLAY[effective] || OVERLAY.dark;
  if (s && process.platform !== 'darwin') {
    try { s.win.setTitleBarOverlay({ ...o, height: 40 }); } catch { /* not supported */ }
  }
  if (s) s.win.setBackgroundColor(WINDOW_BG[effective] || WINDOW_BG.dark);
  settings.set('lastTheme', effective);
});
ipcMain.handle('app:reloadSettings', () => { settings.reload(); return settings.all(); });

ipcMain.handle('app:toggleDevTools', (e) => e.sender.toggleDevTools());
ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('app:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('app:newWindow', () => { createWindow(null, null); });
ipcMain.handle('app:confirm', async (e, opts) => {
  const s = sessionFor(e.sender);
  const r = await dialog.showMessageBox(s.win, {
    type: opts.type || 'question',
    buttons: opts.buttons || ['확인', '취소'],
    defaultId: 0,
    cancelId: (opts.buttons || ['확인', '취소']).length - 1,
    message: opts.message,
    detail: opts.detail,
  });
  return r.response;
});

// ---------------------------------------------------------------- IPC: files / setup
files.register(ipcMain, sessionFor);
setup.register(sessionFor);

// ---------------------------------------------------------------- IPC: LSP
ipcMain.handle('lsp:start', async (e) => {
  const s = sessionFor(e.sender);
  if (!s.project) return { ok: false, error: 'no project' };
  if (s.lsp) s.lsp.stop();
  const send = (ch, payload) => { if (!s.win.isDestroyed()) s.win.webContents.send(ch, payload); };
  s.lsp = new LspServer({
    root: s.project,
    settings: settings.all(),
    logDir: path.join(app.getPath('userData'), 'logs'),
    onNotification: (method, params) => send('lsp:notification', { method, params }),
    onStatus: (status) => send('lsp:status', status),
    onLog: (line) => send('lsp:log', line),
  });
  return s.lsp.start();
});

ipcMain.handle('lsp:stop', (e) => {
  const s = sessionFor(e.sender);
  if (s.lsp) s.lsp.stop();
  s.lsp = null;
});

ipcMain.handle('lsp:request', async (e, { method, params, token }) => {
  const s = sessionFor(e.sender);
  if (!s || !s.lsp) return { error: { message: 'language server not running' } };
  try {
    return { result: await s.lsp.request(method, params, token) };
  } catch (err) {
    return { error: { message: String((err && err.message) || err), code: err && err.code } };
  }
});

ipcMain.on('lsp:cancel', (e, token) => {
  const s = sessionFor(e.sender);
  if (s && s.lsp) s.lsp.cancel(token);
});

ipcMain.on('lsp:notify', (e, { method, params }) => {
  const s = sessionFor(e.sender);
  if (s && s.lsp) s.lsp.notify(method, params);
});

ipcMain.handle('lsp:install', async (e) => {
  const s = sessionFor(e.sender);
  const send = (line) => { if (!s.win.isDestroyed()) s.win.webContents.send('lsp:log', line); };
  return LspServer.installRoslyn(send);
});

ipcMain.handle('lsp:restore', async (e) => {
  const s = sessionFor(e.sender);
  const send = (line) => { if (!s.win.isDestroyed()) s.win.webContents.send('lsp:log', line); };
  return LspServer.restore(s.project, send);
});

// ---------------------------------------------------------------- IPC: Unity
ipcMain.handle('unity:start', (e) => {
  const s = sessionFor(e.sender);
  if (!s.project) return false;
  if (s.unity) s.unity.stop();
  const send = (ch, payload) => { if (!s.win.isDestroyed()) s.win.webContents.send(ch, payload); };
  s.unity = new UnityBridge({
    root: s.project,
    onMessage: (msg) => {
      if (msg.type === 'open' && msg.file) {
        focusWindow(s.win);
        send('app:goto', { file: path.resolve(s.project, msg.file), line: Math.max(1, msg.line || 1), column: Math.max(1, msg.column || 1) });
        return;
      }
      send('unity:message', msg);
    },
    onStatus: (st) => send('unity:status', st),
  });
  s.unity.start();
  return true;
});

ipcMain.on('unity:send', (e, cmd) => {
  const s = sessionFor(e.sender);
  if (s && s.unity) s.unity.send(cmd);
});

ipcMain.handle('unity:ensureAnalyzers', async (e) => {
  const s = sessionFor(e.sender);
  const log = (line) => { if (!s.win.isDestroyed()) s.win.webContents.send('lsp:log', line); };
  return ensureUnityAnalyzers(app.getPath('userData'), (url) => net.fetch(url), log);
});

ipcMain.handle('unity:installPackage', async (e) => {
  // Copies the bundled Unity package into <project>/Packages/com.papyrus.ide
  const s = sessionFor(e.sender);
  const src = app.isPackaged
    ? path.join(process.resourcesPath, 'unity-package', 'com.papyrus.ide')
    : path.join(__dirname, '../../unity-package/com.papyrus.ide');
  const dst = path.join(s.project, 'Packages', 'com.papyrus.ide');
  await fsp.rm(dst, { recursive: true, force: true });
  await fsp.cp(src, dst, { recursive: true });
  return dst;
});
