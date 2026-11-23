// Enter right after `{` puts the brace on its own line and opens the block (Rider / VS default,
// "Allman" braces):   if (x) {|}   ->   if (x)
//                                      {
//                                          |
//                                      }
import { maskCode } from './script-copy.js';

// `if (x)`, `else`, `for (...)`... with no brace: its body is the one next statement
const HEADER = /^([ \t]*)(?:\}[ \t]*)?(?:(?:else[ \t]+)?if[ \t]*\(.*\)|else|for[ \t]*\(.*\)|foreach[ \t]*\(.*\)|while[ \t]*\(.*\)|using[ \t]*\(.*\)|lock[ \t]*\(.*\)|fixed[ \t]*\(.*\))[ \t]*$/;

/**
 * Enter after the single statement of a brace-less `if` / `else` / loop: the new line goes back to
 * the header's indentation (Rider), not the statement's.
 *     if (ctx.Instance.Stacks >= 4)
 *         ctx.Instance.Stacks = 1;|      ->   Enter puts the caret under `if`
 * lineAt(i): masked text (comments / strings blanked) of line i (0-based); row: the caret's line.
 * Returns the indentation for the new line, or null when this isn't such an Enter.
 */
export function singleStatementIndent(lineAt, row, before, after) {
  if (after.trim()) return null;
  const cur = lineAt(row);
  const code = cur.slice(0, before.length).replace(/[ \t]+$/, '');
  if (!code.endsWith(';') || /^\s*(for|foreach|while)\b/.test(code)) return null;
  const curIndent = /^[ \t]*/.exec(cur)[0];
  let target = null;
  // nested brace-less headers (`if (a)` / `if (b)` / `x;`): back to the outermost one
  for (let i = row - 1, indent = curIndent; i >= 0; i--) {
    const h = HEADER.exec(lineAt(i));
    if (!h || h[1].length >= indent.length) break;
    target = h[1];
    indent = h[1];
  }
  return target;
}

const OPEN = '([{';
const CLOSE = ')]}';

/**
 * Enter inside long argument / parameter lists (Rider, VS):
 *     void Spawn(GameObject prefab,|          ->   void Spawn(GameObject prefab,
 *                                                       |
 * and, once the list is closed, back to where the statement started:
 *         Vector3 position)|                 ->   (the line of `Spawn(`'s indentation)
 * maskedBefore: the caret line left of the caret, comments / strings blanked (same length).
 * lineAt(i): masked text of line i (0-based); row: the caret's line.
 * Returns the indentation for the new line, or null (Monaco's own Enter runs then).
 */
export function parenEnterIndent(lineAt, row, maskedBefore, unit) {
  const s = scanBrackets(maskedBefore);
  if (!s) return null;
  if (s.top === '(' || s.top === '[') {
    // `Foo(|` / `Foo(|)`: Monaco's own bracket Enter already indents (and puts `)` below)
    if (/[([][ \t]*$/.test(maskedBefore)) return null;
    return s.indent + unit;
  }
  return s.top ? null : closedListIndent(lineAt, row, maskedBefore);
}

/**
 * The line closes a list opened above (`        int b)`): the indentation of the line that opened
 * it, when that is shallower than this line's; otherwise null.
 */
export function closedListIndent(lineAt, row, maskedBefore) {
  const s = scanBrackets(maskedBefore);
  if (!s || !s.unmatched) return null;
  const opener = openerIndent(lineAt, row, s.unmatched);
  return opener !== null && opener.length < s.indent.length ? opener : null;
}

/** Brackets still open at the end of the text (top), and `)` / `]` closing ones from above. */
function scanBrackets(text) {
  const stack = [];
  let unmatched = 0;
  for (const c of text) {
    if (OPEN.includes(c)) stack.push(c);
    else if (CLOSE.includes(c)) {
      if (stack.length) stack.pop();
      else if (c === '}') return null; // the end of a block: not an argument list
      else unmatched++;
    }
  }
  return { top: stack[stack.length - 1] || null, unmatched, indent: /^[ \t]*/.exec(text)[0] };
}

/** Indentation of the line that opened the `need` brackets left unclosed above `row`, or null. */
function openerIndent(lineAt, row, need) {
  let depth = 0;
  for (let i = row - 1; i >= 0 && i >= row - 200; i--) {
    const text = lineAt(i);
    for (let k = text.length - 1; k >= 0; k--) {
      const c = text[k];
      if (CLOSE.includes(c)) depth++;
      else if (OPEN.includes(c)) {
        if (depth) depth--;
        else if (c === '{') return null; // walked out of the enclosing block
        else if (--need === 0) {
          // `list.Add(new Item(a,` / `b),|`: still inside the outer list, so this isn't the end
          const outer = scanBrackets(text.slice(0, k));
          if (!outer || outer.top) return null;
          return /^[ \t]*/.exec(text)[0];
        }
      }
    }
  }
  return null;
}

/**
 * before/after: the line's text left/right of the caret. Returns null when this isn't such an Enter
 * (Monaco's own Enter runs then), else { lines: [...], caretLine (index into lines), caretColumn }.
 * baseIndent: where the braces go when the header started on a line above (`int b) {` closing a
 * multi-line parameter list); defaults to the line's own indentation.
 */
export function allmanEnter(before, after, unit, baseIndent) {
  if (!/\{[ \t]*$/.test(before)) return null;
  // a `{` inside a string ($"{"), char or comment is no block
  if (!/\{[ \t]*$/.test(maskCode(before + after).slice(0, before.length))) return null;
  const indent = baseIndent ?? /^[ \t]*/.exec(before)[0];
  let head = before.replace(/[ \t]*\{[ \t]*$/, '');
  if (!head.trim()) return null; // `{` already on its own line: the normal Enter indents
  const rest = after.trim();
  let tail = null; // what follows the closing brace: `);` of a lambda argument, `;` of an initializer
  if (rest.startsWith('}')) tail = rest.slice(1);
  else if (rest) return null; // `{|foo`: not a block being opened
  const lines = [];
  // `} else {` -> `}` and `else` on their own lines
  const close = /^[ \t]*\}[ \t]*(\S.*)$/.exec(head);
  if (close) {
    lines.push(indent + '}');
    head = indent + close[1];
  }
  lines.push(head.replace(/[ \t]+$/, ''), indent + '{', indent + unit);
  const caretLine = lines.length - 1;
  if (tail !== null) lines.push(indent + '}' + tail);
  return { lines, caretLine, caretColumn: indent.length + unit.length + 1 };
}
