// Sets the Windows exe icon + version info without wine (pure JS via resedit).
import fs from 'node:fs';
import path from 'node:path';
import * as ResEdit from 'resedit';

const exe = process.argv[2];
const icoPath = process.argv[3] || 'build/icon.ico';
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const data = fs.readFileSync(exe);
const pe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(pe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
if (vi) {
  const [a, b, c] = version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'PAPyrus', ProductName: 'PAPyrus', CompanyName: 'PAPyrus', OriginalFilename: path.basename(exe), InternalName: 'PAPyrus',
    LegalCopyright: '', FileVersion: version, ProductVersion: version,
  });
  vi.outputToResourceEntries(res.entries);
}
res.outputResource(pe);
fs.writeFileSync(exe, Buffer.from(pe.generate()));
console.log('patched', exe);
