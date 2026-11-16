'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Unity's default external editor passes a positional file path. Its configurable
// arguments can also pass the project, file, and cursor position separately.
function parseLaunchArgs(args, cwd) {
  let project = null;
  let file = null;
  let line;
  let column;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const value = args[i + 1];
      if (value == null || value.startsWith('--')) continue;
      if (arg === '--project') project = value || null;
      else if (arg === '--file') file = value || null;
      else if (arg === '--line') line = value;
      else if (arg === '--column') column = value;
      else if (arg === '--goto') {
        // The Windows drive colon is part of the file name.
        const match = /^(.*?)(?::(-?\d+))?(?::(-?\d+))?$/.exec(value);
        if (match) [, file, line, column] = match;
      } else continue;
      i++;
    } else if (arg && !arg.startsWith('-') && arg !== '.') {
      const target = path.resolve(cwd, arg);
      try {
        const stat = fs.statSync(target, { throwIfNoEntry: false });
        if (stat?.isDirectory()) project = target;
        else if (stat?.isFile()) file = target;
      } catch { /* ignore inaccessible targets */ }
    }
  }
  if (project) project = path.resolve(cwd, project);
  const goto = file ? {
    file: path.resolve(project || cwd, file),
    line: Math.max(1, parseInt(line, 10) || 1),
    column: Math.max(1, parseInt(column, 10) || 1),
  } : null;
  if (!project && goto) project = findProjectRoot(goto.file);
  if (!project && isUnityProject(cwd)) project = cwd;
  return { project, goto };
}

function isUnityProject(dir) {
  return fs.existsSync(path.join(dir, 'Assets')) && fs.existsSync(path.join(dir, 'ProjectSettings'));
}

function findProjectRoot(file) {
  let dir = path.dirname(file);
  let solutionDir;
  for (;;) {
    if (isUnityProject(dir)) return dir;
    if (!solutionDir) {
      try {
        if (fs.readdirSync(dir).some(name => /\.slnx?$/i.test(name))) solutionDir = dir;
      } catch { /* skip missing or unreadable folders */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return solutionDir || path.dirname(file);
    dir = parent;
  }
}

module.exports = { parseLaunchArgs };
