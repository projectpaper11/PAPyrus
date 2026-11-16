'use strict';
// Downloads Microsoft.Unity.Analyzers (MIT) once so the generated .csproj files can reference it.
// It teaches Roslyn about Unity messages (Awake/Update are not "unused", etc.) and adds Unity inspections.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const VERSION = '1.27.0';
const ENTRY = 'analyzers/dotnet/cs/Microsoft.Unity.Analyzers.dll';

function analyzerPath(userData) {
  return path.join(userData, 'analyzers', 'Microsoft.Unity.Analyzers.dll');
}

async function ensureUnityAnalyzers(userData, fetchImpl, log) {
  const dst = analyzerPath(userData);
  if (fs.existsSync(dst)) return { path: dst, downloaded: false };
  const urls = [
    `https://www.nuget.org/api/v2/package/Microsoft.Unity.Analyzers/${VERSION}`,
    'https://www.nuget.org/api/v2/package/Microsoft.Unity.Analyzers',
  ];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const dll = extractZipEntry(buf, ENTRY);
      if (!dll) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, dll);
      log && log(`[analyzers] Microsoft.Unity.Analyzers 설치됨: ${dst}`);
      return { path: dst, downloaded: true };
    } catch (err) {
      log && log(`[analyzers] 다운로드 실패 (${url}): ${err.message}`);
    }
  }
  return { path: null, downloaded: false };
}

// Minimal ZIP reader for a single entry (stored or deflated).
function extractZipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const want = name.toLowerCase();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const fname = decodeURIComponent(buf.slice(off + 46, off + 46 + nameLen).toString('utf8'));
    if (fname.toLowerCase() === want) {
      const lNameLen = buf.readUInt16LE(local + 26);
      const lExtra = buf.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtra;
      const data = buf.slice(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

module.exports = { ensureUnityAnalyzers, extractZipEntry, analyzerPath };
