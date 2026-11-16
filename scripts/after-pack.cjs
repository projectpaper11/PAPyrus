// electron-builder afterPack hook: embed icon + version info into the Windows exe (no wine needed).
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  execFileSync(process.execPath, [path.join(__dirname, 'patch-exe.mjs'), exe, path.join(__dirname, '..', 'build', 'icon.ico')], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });
};
