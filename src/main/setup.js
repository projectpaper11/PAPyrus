'use strict';
// First-run setup helper: .NET SDK, C# language server, Unity package.
const { ipcMain, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LspServer, findRoslyn } = require('./lsp');

const isWin = process.platform === 'win32';

// A freshly installed SDK isn't on this process's PATH yet; add the default locations.
function ensureDotnetOnPath() {
  const dirs = isWin
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'dotnet'), path.join(os.homedir(), '.dotnet')]
    : ['/usr/local/share/dotnet', '/usr/share/dotnet', '/usr/lib/dotnet', path.join(os.homedir(), '.dotnet')];
  const tools = path.join(os.homedir(), '.dotnet', 'tools');
  const parts = (process.env.PATH || '').split(path.delimiter);
  for (const d of [...dirs, tools]) {
    if (fs.existsSync(d) && !parts.some((p) => p.toLowerCase() === d.toLowerCase())) parts.push(d);
  }
  process.env.PATH = parts.join(path.delimiter);
}

function dotnetSdks() {
  return new Promise((resolve) => {
    execFile('dotnet', ['--list-sdks'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean));
    });
  });
}

async function status(project) {
  ensureDotnetOnPath();
  const sdks = await dotnetSdks();
  const best = sdks.map((v) => parseInt(v, 10)).sort((a, b) => b - a)[0] || 0;
  const isUnity = !!project && fs.existsSync(path.join(project, 'ProjectSettings'));
  let pkg = false;
  if (isUnity) {
    pkg = fs.existsSync(path.join(project, 'Packages', 'com.papyrus.ide'));
    if (!pkg) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(project, 'Packages', 'manifest.json'), 'utf8'));
        pkg = !!(m.dependencies && m.dependencies['com.papyrus.ide']);
      } catch { /* ignore */ }
    }
  }
  return {
    dotnet: { ok: best >= 10, version: sdks[sdks.length - 1] || null, any: sdks.length > 0 },
    lsp: { ok: !!findRoslyn() },
    unity: { isUnity, ok: pkg },
    platform: process.platform,
  };
}

function run(cmd, args, onLine) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      onLine(String(err));
      resolve(-1);
      return;
    }
    const pipe = (s) => s.on('data', (d) => d.toString().split(/\r?\n/).filter((l) => l.trim()).forEach(onLine));
    pipe(p.stdout);
    pipe(p.stderr);
    p.on('error', (err) => { onLine(String(err.message)); resolve(-1); });
    p.on('close', (code) => resolve(code));
  });
}

async function installDotnet(onLine) {
  if (!isWin) {
    onLine('Windows가 아니면 https://dotnet.microsoft.com/download 에서 직접 설치해 주세요.');
    shell.openExternal('https://dotnet.microsoft.com/download/dotnet/10.0');
    return false;
  }
  onLine('> winget install Microsoft.DotNet.SDK.10');
  onLine('Windows가 관리자 권한을 물어보면 "예"를 눌러 주세요.');
  const code = await run('winget', ['install', '--id', 'Microsoft.DotNet.SDK.10', '-e', '--silent',
    '--accept-source-agreements', '--accept-package-agreements'], onLine);
  ensureDotnetOnPath();
  const sdks = await dotnetSdks();
  const ok = sdks.some((v) => parseInt(v, 10) >= 10);
  if (!ok) {
    onLine(code === -1 ? 'winget을 찾을 수 없어요. 다운로드 페이지를 열게요.' : `설치를 끝내지 못했어요 (exit ${code}). 다운로드 페이지를 열게요.`);
    shell.openExternal('https://dotnet.microsoft.com/download/dotnet/10.0');
  } else onLine('.NET SDK 설치 완료');
  return ok;
}

function register(sessionFor) {
  ensureDotnetOnPath();
  ipcMain.handle('setup:status', (e) => {
    const s = sessionFor(e.sender);
    return status(s && s.project);
  });
  ipcMain.handle('setup:installDotnet', (e) => {
    const s = sessionFor(e.sender);
    const log = (line) => { if (!s.win.isDestroyed()) s.win.webContents.send('lsp:log', line); };
    return installDotnet(log);
  });
  ipcMain.handle('setup:installLsp', (e) => {
    const s = sessionFor(e.sender);
    const log = (line) => { if (!s.win.isDestroyed()) s.win.webContents.send('lsp:log', line); };
    ensureDotnetOnPath();
    return LspServer.installRoslyn(log);
  });
}

module.exports = { register, ensureDotnetOnPath, status };
