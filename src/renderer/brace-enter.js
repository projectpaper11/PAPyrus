// Enter right after `{` puts the brace on its own line and opens the block (Rider / VS default,
// "Allman" braces):   if (x) {|}   ->   if (x)
//                                      {
//                                          |
//                                      }
import { maskCode } from './script-copy.js';

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
