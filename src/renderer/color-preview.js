// Unity colors in C#, like Rider: a swatch before `new Color(r, g, b[, a])`, `new Color32(r, g, b, a)`
// and `Color.red`; clicking it opens Monaco's color picker, and the color picked is written back in
// the same form (Color32 stays bytes, Color floats; a named color becomes `new Color(...)`).
import { monaco } from './monaco.js';
import { maskCode } from './script-copy.js';

const NUM = String.raw`\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[fFdDmM])?)\s*`;
const CTOR = new RegExp(String.raw`\bnew\s+(?:UnityEngine\s*\.\s*)?(Color32|Color)\s*\(${NUM},${NUM},${NUM}(?:,${NUM})?\)`, 'g');
// Unity's static colors (UnityEngine.Color)
const NAMED = {
  red: [1, 0, 0, 1], green: [0, 1, 0, 1], blue: [0, 0, 1, 1], white: [1, 1, 1, 1], black: [0, 0, 0, 1],
  yellow: [1, 0.92156863, 0.015686275, 1], cyan: [0, 1, 1, 1], magenta: [1, 0, 1, 1],
  gray: [0.5, 0.5, 0.5, 1], grey: [0.5, 0.5, 0.5, 1], clear: [0, 0, 0, 0],
};
const NAMED_RE = new RegExp(String.raw`\b(?:UnityEngine\s*\.\s*)?Color\s*\.\s*(${Object.keys(NAMED).join('|')})\b(?!\s*\()`, 'g');

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const num = (s) => parseFloat(String(s).replace(/[fFdDmM]$/, ''));

/** Colors in the text: [{ range: {start, end} (offsets), kind: 'color'|'color32'|'named', rgba: [0..1 x4], args }]. */
export function findColors(text) {
  const masked = maskCode(text);
  const out = [];
  CTOR.lastIndex = 0;
  for (let m; (m = CTOR.exec(masked));) {
    const src = text.slice(m.index, m.index + m[0].length);
    const parts = new RegExp(CTOR.source).exec(src); // the numbers from the real text, not the mask
    if (!parts) continue;
    const is32 = parts[1] === 'Color32';
    const vals = parts.slice(2, 6).map((v) => (v == null ? null : num(v)));
    if (vals.slice(0, 3).some((v) => Number.isNaN(v))) continue;
    const scale = is32 ? 255 : 1;
    const a = vals[3] == null || Number.isNaN(vals[3]) ? scale : vals[3];
    out.push({
      start: m.index, end: m.index + m[0].length, kind: is32 ? 'color32' : 'color', alpha: vals[3] != null,
      rgba: [vals[0] / scale, vals[1] / scale, vals[2] / scale, a / scale].map(clamp01),
    });
  }
  NAMED_RE.lastIndex = 0;
  for (let m; (m = NAMED_RE.exec(masked));) {
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'named', alpha: false, rgba: NAMED[m[1]] });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** `0.5f`, `1f`, `0.25f`: up to 3 decimals, no trailing zeros. */
function float(v) {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return (s === '-0' ? '0' : s) + 'f';
}

/** The code for a color, in the form the original used. */
export function colorCode(kind, keepAlpha, { red, green, blue, alpha }) {
  if (kind === 'color32') {
    const b = (v) => Math.round(clamp01(v) * 255);
    return `new Color32(${b(red)}, ${b(green)}, ${b(blue)}, ${b(alpha)})`;
  }
  const withAlpha = keepAlpha || alpha < 0.9995;
  return `new Color(${float(red)}, ${float(green)}, ${float(blue)}${withAlpha ? `, ${float(alpha)}` : ''})`;
}

export function registerColorPreview() {
  return monaco.languages.registerColorProvider('csharp', {
    provideDocumentColors(model) {
      if (model.getValueLength() > 2_000_000) return [];
      return findColors(model.getValue()).map((c) => {
        const s = model.getPositionAt(c.start);
        const e = model.getPositionAt(c.end);
        return {
          range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column),
          color: { red: c.rgba[0], green: c.rgba[1], blue: c.rgba[2], alpha: c.rgba[3] },
        };
      });
    },
    provideColorPresentations(model, info) {
      const text = model.getValueInRange(info.range);
      const found = findColors(text)[0];
      const kind = found ? found.kind : /Color32/.test(text) ? 'color32' : 'color';
      const label = colorCode(kind === 'named' ? 'color' : kind, !!(found && found.alpha), info.color);
      return [{ label, textEdit: { range: info.range, text: label } }];
    },
  });
}
