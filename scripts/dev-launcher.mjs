import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildDevLauncher(root) {
  if (process.platform !== 'win32') return;
  const dir = path.join(root, 'node_modules', '.cache', 'papyrus');
  const launcher = path.join(dir, 'PAPyrus.exe');
  const source = path.join(root, 'scripts', 'PapyrusLauncher.cs');
  const icon = path.join(root, 'build', 'icon.ico');
  const compiled = fs.existsSync(launcher) ? fs.statSync(launcher).mtimeMs : 0;
  if ([source, icon, fileURLToPath(import.meta.url)].every(file => fs.statSync(file).mtimeMs <= compiled)) return;

  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET');
  const compiler = ['Framework64', 'Framework']
    .map(dir => path.join(framework, dir, 'v4.0.30319', 'csc.exe'))
    .find(file => fs.existsSync(file));
  if (!compiler) throw new Error('The .NET Framework C# compiler is required to build the Windows development launcher.');
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `PAPyrus-${process.pid}.exe`);
  try {
    execFileSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/reference:System.Windows.Forms.dll',
      '/win32icon:' + icon, '/out:' + temp, source], { stdio: 'inherit', windowsHide: true });
    fs.renameSync(temp, launcher);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
