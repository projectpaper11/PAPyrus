'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { LspServer } = require('./lsp');
const { UnityBridge } = require('./unity');
const files = require('./files');
const unityAssets = require('./unity-assets');
const settings = require('./settings');
const { ensureUnityAnalyzers } = require('./analyzers');
const updater = require('./updater');
const setup = require('./setup');
const { parseLaunchArgs } = require('./launch');

app.setName('PAPyrus');
// Fixed location so the Unity package can find install-path.txt and the analyzers.
app.setPath('userData', path.join(app.getPath('appData'), 'PAPyrus'));

// ---------------------------------------------------------------- args
// Accepted:
//   PAPyrus.exe [--project <dir>] [--goto <file>[:line[:col]]]
//   PAPyrus.exe <dir-or-file>
function parseArgs(argv, cwd = process.cwd()) {
  return parseLaunchArgs(argv.slice(app.isPackaged ? 1 : 2), cwd);
}

function externalEditorPath() {
  if (app.isPackaged) return process.execPath;
  if (process.platform !== 'win32') return null;
  const launcher = path.join(__dirname, '../../node_modules/.cache/papyrus/PAPyrus.exe');
  return fs.existsSync(launcher) ? launcher : null;
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
  // when this window last lost the focus (see focusIde)
  win.on('blur', () => { s.blurAt = Date.now(); });
  win.on('focus', () => { s.blurAt = 0; });
  // the Unity inspector window laid over the right dock follows the IDE window
  for (const ev of ['move', 'resize', 'minimize', 'restore', 'maximize', 'unmaximize', 'show', 'hide', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => placeUnityMirror(s));
  }
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

/**
 * Was this window in front just before Unity's message? `fg` is the window Unity saw in front before
 * it opened its own (newer packages); without it, the focus must have been lost a moment ago.
 */
function wasJustFocused(s, fg) {
  if (s.win.isDestroyed() || s.win.isMinimized()) return false;
  if (typeof fg === 'number' && fg) return fg === nativeHandle(s.win);
  if (s.win.isFocused()) return true;
  return !!s.blurAt && Date.now() - s.blurAt < 1500;
}

function nativeHandle(win) {
  const h = win.getNativeWindowHandle();
  return h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
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
const initialLaunch = parseArgs(process.argv);
// Chromium can reorder switches and positional values in the second-instance event.
if (!app.requestSingleInstanceLock({ launch: initialLaunch })) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd, data) => {
    const args = data?.launch ?? parseArgs(argv, cwd);
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
      const editor = externalEditorPath();
      if (editor) {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(path.join(app.getPath('userData'), 'install-path.txt'), editor);
      }
    } catch { /* ignore */ }

    let project = initialLaunch.project;
    if (!project && settings.get('reopenLastProject') !== false) {
      const recent = settings.get('recentProjects') || [];
      if (recent[0] && fs.existsSync(recent[0])) project = recent[0];
    }
    createWindow(project, initialLaunch.goto);
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
    externalEditorPath: externalEditorPath(),
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

// Background image (Rider's "Set Background Image"): the picked picture is copied into
// userData/backgrounds, so moving or deleting the original doesn't take it away.
const BG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];
ipcMain.handle('app:pickBackgroundImage', async (e, given) => {
  const s = sessionFor(e.sender);
  let src = given;
  if (!src) {
    const r = await dialog.showOpenDialog(s.win, { title: '배경 이미지 고르기', properties: ['openFile'], filters: [{ name: '이미지', extensions: BG_EXT }] });
    if (r.canceled || !r.filePaths[0]) return null;
    src = r.filePaths[0];
  }
  if (!BG_EXT.includes(path.extname(src).slice(1).toLowerCase())) throw new Error('이미지 파일(png, jpg, gif, webp, bmp)만 쓸 수 있어요');
  const dir = path.join(app.getPath('userData'), 'backgrounds');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, Date.now() + '-' + path.basename(src).replace(/[^\w.\-]+/g, '_'));
  fs.copyFileSync(src, dest);
  // earlier copies aren't needed any more (the current one is the setting's)
  const keep = new Set([path.resolve(dest).toLowerCase(), path.resolve(String(settings.get('appearance.backgroundImage') || '')).toLowerCase()]);
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (!keep.has(path.resolve(p).toLowerCase())) { try { fs.unlinkSync(p); } catch { /* in use */ } }
  }
  return dest;
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

// Cleaning up the recent projects list (right-click on a project): the renderer sends the new list.
ipcMain.handle('app:setRecentProjects', (_e, list) => {
  if (!Array.isArray(list)) return settings.get('recentProjects') || [];
  const clean = [];
  for (const p of list) if (typeof p === 'string' && p && !clean.some((q) => samePath(q, p))) clean.push(p);
  settings.set('recentProjects', clean.slice(0, 12));
  return settings.get('recentProjects');
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
ipcMain.handle('app:newWindow', (_e, project) => { createWindow(typeof project === 'string' && project ? project : null, null); });
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
unityAssets.register(ipcMain);
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
      if (msg.type === 'focusIde') {
        // Unity just showed the inspector mirror window and stole the focus. Take it back only when it
        // was taken from this window: Unity reopens the mirror after a script reload or a selection
        // made in Unity, and pulling the IDE up then dragged it over whatever the user had switched to.
        if (wasJustFocused(s, msg.fg)) focusWindow(s.win);
        return;
      }
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

// The renderer reports the inspector area (CSS px in the page, or null); Unity gets it in screen
// pixels together with this window's handle, and lays its real inspector window over it (Windows).
ipcMain.on('unity:mirrorPlace', (e, rect) => {
  const s = sessionFor(e.sender);
  if (!s) return;
  s.mirrorRect = rect;
  placeUnityMirror(s);
});

function placeUnityMirror(s) {
  if (process.platform !== 'win32' || !s.unity || !s.mirrorRect || s.win.isDestroyed()) return;
  const win = s.win;
  const r = s.mirrorRect;
  const zoom = win.webContents.getZoomFactor();
  const cb = win.getContentBounds();
  const px = screen.dipToScreenRect(win, {
    x: Math.round(cb.x + r.x * zoom),
    y: Math.round(cb.y + r.y * zoom),
    width: Math.round(r.width * zoom),
    height: Math.round(r.height * zoom),
  });
  const hwnd = nativeHandle(win);
  s.unity.send({
    type: 'inspector.mirrorPlace',
    id: 0,
    x: px.x,
    y: px.y,
    width: px.width,
    height: px.height,
    hwnd,
    visible: !!r.visible && win.isVisible() && !win.isMinimized(),
  });
}

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
