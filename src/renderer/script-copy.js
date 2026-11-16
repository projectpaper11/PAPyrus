// Makes a copied C# script compile next to its original. A plain copy re-declares every type of the
// file in the same assembly and namespace (CS0101), so the copy gets the new class name and drops the
// file's other top-level types (the original still provides them). Pure text helpers, no editor deps.

const TYPE_RE = /\b(class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+(@?[A-Za-z_]\w*)/y;
const DELEGATE_RE = /\bdelegate\s+[\w<>[\],.?\s]+?\s(@?[A-Za-z_]\w*)\s*(?=[<(])/y;
const NOT_NAMES = new Set(['where', 'new', 'class', 'struct']);

/** Same length as text, with comments and string/char literal contents blanked out. */
export function maskCode(text) {
  const out = text.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  let i = 0;
  const n = text.length;
  // returns the index after a string starting at i (handles @"", $"", $@"", """raw""")
  const skipString = (s) => {
    let j = s;
    let verbatim = false;
    let interp = 0;
    while (text[j] === '$') { interp++; j++; }
    if (text[j] === '@') { verbatim = true; j++; if (text[j] === '$') { interp++; j++; } }
    if (text.startsWith('"""', j)) {
      let q = 0;
      while (text[j] === '"') { q++; j++; }
      const close = text.indexOf('"'.repeat(q), j);
      return close < 0 ? n : close + q;
    }
    j++; // opening quote
    while (j < n) {
      const c = text[j];
      if (!verbatim && c === '\\') { j += 2; continue; }
      if (c === '"') {
        if (verbatim && text[j + 1] === '"') { j += 2; continue; }
        return j + 1;
      }
      if (!verbatim && c === '\n') return j;
      if (interp && c === '{') {
        if (text[j + 1] === '{') { j += 2; continue; }
        // an interpolation hole: skip balanced braces (nested strings inside are rare enough)
        let d = 1;
        j++;
        while (j < n && d) {
          if (text[j] === '"') { j = skipString(j); continue; }
          if (text[j] === '{') d++;
          else if (text[j] === '}') d--;
          j++;
        }
        continue;
      }
      j++;
    }
    return n;
  };
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || ((c === '$' || c === '@') && /^[$@]*"/.test(text.slice(i, i + 4)))) {
      const end = skipString(i);
      blank(i, end);
      i = end;
    } else if (c === '\'') {
      let j = i + 1;
      while (j < n && text[j] !== '\'' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
    } else if (c === '#' && /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i))) {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Types declared directly in the file or in its namespace(s) (not nested ones):
 * [{ kind, name, start, end, header }] — start includes attributes/modifiers/doc comments above,
 * end is after the closing brace (or `;`) and the line break.
 */
export function topLevelTypes(text) {
  const m = maskCode(text);
  const types = [];
  const stack = []; // 'ns' | 'other'
  let stmtStart = 0; // where the current declaration starts (after the last ; { })
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === '{') {
      stack.push(/\bnamespace\s+[\w.]+\s*$/.test(m.slice(stmtStart, i)) ? 'ns' : 'other');
      stmtStart = i + 1;
    } else if (c === '}') {
      stack.pop();
      stmtStart = i + 1;
    } else if (c === ';') {
      stmtStart = i + 1;
    } else if (stack.every((k) => k === 'ns') && /[a-z]/.test(c) && (i === 0 || !/\w/.test(m[i - 1]))) {
      TYPE_RE.lastIndex = i;
      DELEGATE_RE.lastIndex = i;
      let t = TYPE_RE.exec(m);
      let kind;
      let name;
      if (t && !NOT_NAMES.has(t[2])) { kind = t[1].replace(/\s+/g, ' '); name = t[2]; }
      else if ((t = DELEGATE_RE.exec(m))) { kind = 'delegate'; name = t[1]; }
      else continue;
      // the body: first `{` (or `;` for delegates / `record R(int X);`) at this level
      let j = i + t[0].length;
      let depth = 0;
      while (j < m.length) {
        const d = m[j];
        if (d === '(' || d === '[') depth++;
        else if (d === ')' || d === ']') depth--;
        else if (!depth && (d === '{' || d === ';')) break;
        j++;
      }
      let end = j;
      if (m[j] === '{') {
        let b = 0;
        for (; end < m.length; end++) {
          if (m[end] === '{') b++;
          else if (m[end] === '}' && --b === 0) break;
        }
        end++;
        if (/^\s*;/.test(m.slice(end, end + 8))) end = m.indexOf(';', end) + 1;
      } else {
        end = j + 1;
      }
      const start = m.slice(stmtStart, i).search(/\S/) < 0 ? i : stmtStart + m.slice(stmtStart, i).search(/\S/);
      types.push({ kind, name: name.replace(/^@/, ''), start: lineStartWithComments(text, start), end: lineEnd(text, end), header: m.slice(start, j) });
      i = end - 1;
      stmtStart = end;
    }
  }
  return types;
}

function lineStartWithComments(text, start) {
  let s = text.lastIndexOf('\n', start - 1) + 1;
  if (text.slice(s, start).trim()) return start;
  // doc comments / comments directly above go with the type
  while (s > 0) {
    const ps = text.lastIndexOf('\n', s - 2) + 1;
    if (/^\s*(\/\/|\/\*|\*)/.test(text.slice(ps, s))) s = ps; else break;
  }
  return s;
}

function lineEnd(text, end) {
  const e = text.indexOf('\n', end);
  if (e < 0) return text.length;
  return text.slice(end, e).trim() ? end : e + 1;
}

const UNITY_BASES = /:\s*[^{]*\b(MonoBehaviour|ScriptableObject|Editor|EditorWindow|PropertyDrawer|NetworkBehaviour|StateMachineBehaviour)\b/;

/** The type the file is "about": named like the file, else the only one, else the Unity component. */
export function mainType(types, fileClass) {
  if (!types.length) return null;
  return types.find((t) => t.name === fileClass)
    || (types.length === 1 ? types[0] : null)
    || types.find((t) => t.kind === 'class' && UNITY_BASES.test(t.header))
    || types.find((t) => /class|struct|record/.test(t.kind))
    || types[0];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole identifiers only (OldName2 / MyOldName stay), strings and comments included so
 * CreateAssetMenu(fileName = "Old") and doc comments follow the new name too.
 */
export function renameIdentifier(text, oldName, newName) {
  return text.replace(new RegExp(`(?<![A-Za-z0-9_])@?${esc(oldName)}(?![A-Za-z0-9_])`, 'g'), newName);
}

/**
 * The copy's text: the main type renamed to newClass (when rename), the other top-level types
 * removed (when dropOthers). Returns { text, main, renamedFrom, removed: [names] }.
 */
export function fixScriptCopy(text, { fileClass, newClass, rename = true, dropOthers = true }) {
  const types = topLevelTypes(text);
  const main = mainType(types, fileClass);
  let out = text;
  const removed = [];
  if (main && dropOthers) {
    const others = types.filter((t) => t !== main).sort((a, b) => b.start - a.start);
    for (const t of others) {
      let s = t.start;
      let e = t.end;
      // no doubled blank line left behind
      const prevStart = out.lastIndexOf('\n', s - 2) + 1;
      if (!out.slice(prevStart, s).trim() && /^\s*\r?\n/.test(out.slice(e))) e = out.indexOf('\n', e) + 1;
      out = out.slice(0, s) + out.slice(e);
      removed.unshift(t.name);
    }
    // a namespace whose only content was removed would be empty: harmless, keep it
  }
  let renamedFrom = null;
  if (main && rename && newClass && main.name !== newClass) {
    out = renameIdentifier(out, main.name, newClass);
    renamedFrom = main.name;
  }
  return { text: out, main: main && main.name, renamedFrom, removed };
}

/** Assembly a script in `relDir` (project-relative, '/' separated) compiles into, without asmdefs. */
export function predefinedAssembly(relDir) {
  const p = `/${relDir.replace(/\\/g, '/')}/`;
  const editor = /\/Editor\//i.test(p);
  const first = /^\/Assets\/(Plugins|Standard Assets|Pro Standard Assets)\//i.test(p);
  return `Assembly-CSharp${first ? '-firstpass' : ''}${editor ? '-Editor' : ''}`;
}
