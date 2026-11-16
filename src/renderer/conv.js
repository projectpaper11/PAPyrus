// LSP <-> Monaco conversions
import { monaco } from './monaco.js';

export function pathToUri(p) {
  return monaco.Uri.file(p).toString();
}

export function uriToPath(uri) {
  const u = typeof uri === 'string' ? monaco.Uri.parse(uri) : uri;
  if (u.scheme !== 'file') return null;
  let p = u.fsPath;
  return p;
}

export const toPos = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });
export const toLspRange = (r) => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
export const toRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

export function markdown(content) {
  if (!content) return null;
  if (typeof content === 'string') return { value: content };
  if (Array.isArray(content)) {
    const parts = content.map(markdown).filter(Boolean);
    return parts.length ? { value: parts.map((p) => p.value).join('\n\n') } : null;
  }
  if (content.kind === 'markdown') return { value: content.value, supportHtml: false, isTrusted: false };
  if (content.kind === 'plaintext') return { value: escapeMd(content.value) };
  if (content.language) return { value: '```' + content.language + '\n' + content.value + '\n```' };
  if (content.value != null) return { value: content.value };
  return null;
}

function escapeMd(s) {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

const CK = monaco.languages.CompletionItemKind;
const completionKindMap = {
  1: CK.Text, 2: CK.Method, 3: CK.Function, 4: CK.Constructor, 5: CK.Field, 6: CK.Variable, 7: CK.Class, 8: CK.Interface,
  9: CK.Module, 10: CK.Property, 11: CK.Unit, 12: CK.Value, 13: CK.Enum, 14: CK.Keyword, 15: CK.Snippet, 16: CK.Color,
  17: CK.File, 18: CK.Reference, 19: CK.Folder, 20: CK.EnumMember, 21: CK.Constant, 22: CK.Struct, 23: CK.Event,
  24: CK.Operator, 25: CK.TypeParameter,
};
export const completionKind = (k) => completionKindMap[k] ?? CK.Text;

const SK = monaco.languages.SymbolKind;
export const symbolKind = (k) => (k >= 1 && k <= 26 ? k - 1 : SK.Variable);

export function severity(s) {
  switch (s) {
    case 1: return monaco.MarkerSeverity.Error;
    case 2: return monaco.MarkerSeverity.Warning;
    case 3: return monaco.MarkerSeverity.Hint; // "suggestion" level: subtle dots like Rider, not a blue squiggle
    default: return monaco.MarkerSeverity.Hint;
  }
}

// Hint-level diagnostics without a visual tag (e.g. "use explicit type") are noise; Rider hides them too.
export function visibleDiagnostic(d) {
  return !(d.severity === 4 && !(d.tags && d.tags.length));
}

export function toMarker(d) {
  const r = toRange(d.range);
  const tags = [];
  if (d.tags) {
    if (d.tags.includes(1)) tags.push(monaco.MarkerTag.Unnecessary);
    if (d.tags.includes(2)) tags.push(monaco.MarkerTag.Deprecated);
  }
  return {
    severity: severity(d.severity || 1),
    message: d.message,
    source: d.source,
    code: typeof d.code === 'object' && d.code ? d.code.value : d.code != null ? String(d.code) : undefined,
    startLineNumber: r.startLineNumber,
    startColumn: r.startColumn,
    endLineNumber: r.endLineNumber,
    endColumn: r.endColumn,
    tags,
  };
}

// codicon name for a symbol kind (1-based LSP)
export function symbolIcon(kind) {
  const names = {
    1: 'file', 2: 'symbol-namespace', 3: 'symbol-namespace', 4: 'symbol-package', 5: 'symbol-class', 6: 'symbol-method',
    7: 'symbol-property', 8: 'symbol-field', 9: 'symbol-method', 10: 'symbol-enum', 11: 'symbol-interface', 12: 'symbol-method',
    13: 'symbol-variable', 14: 'symbol-constant', 15: 'symbol-string', 16: 'symbol-number', 17: 'symbol-boolean', 18: 'symbol-array',
    19: 'symbol-object', 20: 'symbol-key', 21: 'symbol-null', 22: 'symbol-enum-member', 23: 'symbol-structure', 24: 'symbol-event',
    25: 'symbol-operator', 26: 'symbol-type-parameter',
  };
  return names[kind] || 'symbol-misc';
}

export function symbolColor(kind) {
  if ([5, 11, 23, 10, 26].includes(kind)) return '#C191FF';
  if ([6, 9, 12].includes(kind)) return '#39CC9B';
  if ([7, 8, 14, 22].includes(kind)) return '#66C3CC';
  if (kind === 24) return '#ED94C0';
  return '#9da0a8';
}
