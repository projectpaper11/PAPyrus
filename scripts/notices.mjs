// Writes THIRD_PARTY_NOTICES.txt: the license text of every third-party package that ships in the
// installer. MIT / OFL / CC BY require the notice to travel with redistributed copies.
//  - BUNDLED: packed into dist/ by esbuild (renderer code, fonts, icons)
//  - runtime `dependencies` and everything they pull in (packed into app.asar by electron-builder)
// Run with `node scripts/notices.mjs` (build.mjs also calls it). Output is deterministic.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const BUNDLED = ['monaco-editor', '@vscode/codicons', '@fontsource/inter', '@fontsource/jetbrains-mono'];
const LICENSE_RE = /^(licen[cs]e|copying)(-code)?(\.(md|txt))?$/i;
const NOTICE_RE = /^third-?party-?notices(\.(md|txt))?$/i;
const RULE = '='.repeat(78);

function readText(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trimEnd();
}

function mitText(holder) {
  return `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

// Collect the runtime dependency tree from package-lock (handles nested node_modules).
function runtimePackages(lock) {
  const pkgs = lock.packages;
  const found = new Map();
  const visit = (name, fromKey) => {
    let base = fromKey;
    let key = null;
    while (true) {
      const k = (base ? `${base}/` : '') + `node_modules/${name}`;
      if (pkgs[k]) { key = k; break; }
      if (!base) break;
      const i = base.lastIndexOf('/node_modules/');
      base = i < 0 ? '' : base.slice(0, i);
    }
    if (!key || found.has(key)) return;
    found.set(key, name);
    for (const dep of Object.keys(pkgs[key].dependencies || {})) visit(dep, key);
    for (const dep of Object.keys(pkgs[key].optionalDependencies || {})) visit(dep, key);
  };
  for (const dep of Object.keys(pkgs[''].dependencies || {})) visit(dep, '');
  return found;
}

function entry(dir, name) {
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const files = fs.readdirSync(dir).sort();
  const licenses = files.filter((f) => LICENSE_RE.test(f));
  const notices = files.filter((f) => NOTICE_RE.test(f));
  const repo = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url;
  const lines = [RULE, `${name} ${pj.version}`, `License: ${pj.license || 'see below'}`];
  if (pj.homepage || repo) lines.push(`Source: ${(pj.homepage || repo).replace(/^git\+/, '')}`);
  lines.push(RULE, '');
  if (!licenses.length) {
    const author = typeof pj.author === 'string' ? pj.author.replace(/\s*[<(].*$/, '') : pj.author?.name;
    if (pj.license === 'MIT' && author) lines.push(`(the package ships no license file; standard MIT text)\n\n${mitText(author)}`, '');
    else lines.push(`(no license file in the package; license field: ${pj.license})`, '');
  }
  for (const f of licenses) {
    if (licenses.length > 1) lines.push(`--- ${f} ---`);
    lines.push(readText(path.join(dir, f)), '');
  }
  for (const f of notices) lines.push(`--- ${f} (notices of code bundled inside ${name}) ---`, readText(path.join(dir, f)), '');
  return { name, text: lines.join('\n') };
}

export function writeNotices() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const entries = BUNDLED.map((n) => entry(path.join(root, 'node_modules', n), n));
  for (const [key, name] of runtimePackages(lock)) entries.push(entry(path.join(root, key), name));
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const header = [
    'PAPyrus - Third-Party Notices',
    '',
    'PAPyrus includes the third-party software listed below. Each is distributed under its own',
    'license, reproduced in full in this file.',
    '',
    'Also part of the installation, with their own license files next to PAPyrus.exe:',
    '  - Electron (MIT): LICENSE.electron.txt',
    '  - Chromium and its components: LICENSES.chromium.html',
    '',
    'Not included in PAPyrus, obtained separately:',
    '  - Roslyn Language Server (MIT, https://github.com/dotnet/roslyn): installed by the user as a .NET tool.',
    '  - Microsoft.Unity.Analyzers (MIT, https://github.com/microsoft/Microsoft.Unity.Analyzers):',
    '    downloaded from nuget.org on first use.',
    '',
    'Included packages:',
    ...entries.map((e) => `  - ${e.name}`),
    '',
  ].join('\n');

  const out = header + '\n' + entries.map((e) => e.text).join('\n') + '\n';
  const file = path.join(root, 'THIRD_PARTY_NOTICES.txt');
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== out) fs.writeFileSync(file, out);
  return { file, count: entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, 'scripts', 'notices.mjs')) {
  const { file, count } = writeNotices();
  console.log(`${path.basename(file)}: ${count} packages`);
}
