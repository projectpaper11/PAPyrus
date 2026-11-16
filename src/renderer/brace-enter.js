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

/**
 * before/after: the line's text left/right of the caret. Returns null when this isn't such an Enter
 * (Monaco's own Enter runs then), else { lines: [...], caretLine (index into lines), caretColumn }.
 */
export function allmanEnter(before, after, unit) {
  if (!/\{[ \t]*$/.test(before)) return null;
  // a `{` inside a string ($"{"), char or comment is no block
  if (!/\{[ \t]*$/.test(maskCode(before + after).slice(0, before.length))) return null;
  const indent = /^[ \t]*/.exec(before)[0];
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
