// Small DOM helpers, menus, dialogs, toasts, fuzzy matching.

export function el(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const e = document.createElement(name || 'div');
  if (classes.length) e.className = classes.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className += (e.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const icon = (name, extra) => el(`i.codicon.codicon-${name}${extra ? '.' + extra : ''}`);

export function basename(p) {
  return p.split(/[\\/]/).pop();
}
export function dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
}
export function joinPath(a, b) {
  const sep = a.includes('\\') ? '\\' : '/';
  return a.replace(/[\\/]+$/, '') + sep + b;
}
export function relPath(root, p) {
  if (!root) return p;
  const norm = (s) => s.replace(/\\/g, '/');
  const r = norm(root).replace(/\/+$/, '');
  const n = norm(p);
  if (n.toLowerCase().startsWith(r.toLowerCase() + '/')) return n.slice(r.length + 1);
  return n;
}
export function samePath(a, b) {
  if (!a || !b) return false;
  const n = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

const IMG = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.psd', '.tif', '.tiff', '.exr', '.hdr', '.svg']);
export function fileIcon(name, isDir, extra) {
  if (isDir) {
    const cls = name === 'Assets' ? 'assets' : name === 'Packages' ? 'packages' : '';
    return el(`span.ficon.folder${cls ? '.' + cls : ''}`, null, icon(extra === 'open' ? 'folder-opened' : 'folder'));
  }
  const ext = extname(name);
  const map = {
    '.cs': ['cs', 'C#'], '.shader': ['shader', 'S'], '.hlsl': ['shader', 'H'], '.cginc': ['shader', 'H'], '.compute': ['shader', 'CS'],
    '.json': ['json', '{}'], '.asmdef': ['asmdef', 'A'], '.asmref': ['asmdef', 'A'], '.xml': ['xml', '<>'], '.csproj': ['xml', '<>'],
    '.uxml': ['xml', '<>'], '.uss': ['xml', '#'], '.md': ['md', 'M'], '.txt': ['txt', 'T'], '.unity': ['unity', 'U'], '.prefab': ['asmdef', 'P'],
    '.sln': ['cs', 'SL'], '.yaml': ['txt', 'Y'], '.yml': ['txt', 'Y'], '.asset': ['other', 'A'], '.mat': ['other', 'M'],
  };
  if (IMG.has(ext)) return el('span.ficon.img', null, '▣');
  const [cls, label] = map[ext] || ['other', ext ? ext.slice(1, 3).toUpperCase() : '?'];
  return el(`span.ficon.${cls}`, null, label);
}

// ---------------------------------------------------------------- overlays
const root = () => document.getElementById('overlay-root');
let openMenu = null;

export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
}
function onDocDown(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}
function onMenuKey(e) {
  if (!openMenu) return;
  const items = [...openMenu.querySelectorAll('.menu-item:not(.disabled)')];
  let i = items.findIndex((x) => x.classList.contains('active'));
  if (e.key === 'Escape') { closeMenu(); e.preventDefault(); e.stopPropagation(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items.forEach((x) => x.classList.remove('active'));
    items[i] && items[i].classList.add('active');
    e.preventDefault(); e.stopPropagation();
  } else if (e.key === 'Enter' && i >= 0) {
    items[i].click(); e.preventDefault(); e.stopPropagation();
  }
}

/** items: [{label, icon, key, action, disabled} | '-'] */
export function contextMenu(x, y, items) {
  closeMenu();
  const m = el('div.menu');
  for (const it of items) {
    if (it === '-') { m.append(el('div.menu-sep')); continue; }
    if (!it) continue;
    const row = el('div.menu-item' + (it.disabled ? '.disabled' : ''), {
      onclick: () => { closeMenu(); it.action && it.action(); },
    }, it.icon ? icon(it.icon) : el('span', { style: { width: '16px' } }), it.label, it.key ? el('span.mk', null, it.key) : null);
    m.append(row);
  }
  root().append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
  openMenu = m;
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onMenuKey, true);
  });
}

/**
 * Text input dialog. Resolves the string, or null when cancelled. With `choices` and/or `check`
 * ({ label, checked, onChange }) it resolves { value, choice?, checked? } instead.
 */
export function prompt({ title, sub, value = '', select, placeholder, choices, check }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, placeholder: placeholder || '' });
    let choice = choices ? choices[0].value : null;
    const box = check ? el('input', { type: 'checkbox', checked: !!check.checked, onchange: () => check.onChange && check.onChange(box.checked) }) : null;
    const result = () => (choices || check
      ? { value: input.value, ...(choices ? { choice } : {}), ...(check ? { checked: box.checked } : {}) }
      : input.value);
    const finish = (v) => { back.remove(); resolve(v); };
    const choiceRow = choices
      ? el('div.choices', null, choices.map((c, i) => {
        const b = el('button.toggle' + (i === 0 ? '.on' : ''), {
          onclick: () => {
            choice = c.value;
            choiceRow.querySelectorAll('.toggle').forEach((t) => t.classList.remove('on'));
            b.classList.add('on');
            input.focus();
          },
        }, c.icon ? icon(c.icon) : null, c.label);
        return b;
      }))
      : null;
    const back = el('div.dialog-back', { onmousedown: (e) => { if (e.target === back) finish(null); } },
      el('div.dialog', null,
        el('h3', null, title),
        sub ? el('div.sub', null, sub) : null,
        choiceRow,
        input,
        check ? el('label.dialog-check', null, box, check.label) : null,
        el('div.row', null,
          el('button.btn', { onclick: () => finish(null) }, '취소'),
          el('button.btn.primary', { onclick: () => finish(result()) }, '확인'))));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(result());
      if (e.key === 'Escape') finish(null);
      e.stopPropagation();
    });
    root().append(back);
    input.focus();
    if (select) input.setSelectionRange(select[0], select[1]);
    else input.select();
  });
}

let toastWrap = null;
export function toast({ title, message, kind = 'info', actions = [], timeout = 6000 }) {
  if (!toastWrap) {
    toastWrap = el('div.toast-wrap');
    root().append(toastWrap);
  }
  const ic = kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : 'info';
  const t = el(`div.toast.${kind}`, null, icon(ic), el('div.tbody', null,
    title ? el('div.ttitle', null, title) : null,
    message ? el('div.tmsg', null, message) : null,
    actions.length ? el('div.tacts', null, actions.map((a) => el('span.link', { onclick: () => { t.remove(); a.action(); } }, a.label))) : null),
  el('button.toast-close', { title: '닫기', onclick: () => t.remove() }, icon('close')));
  toastWrap.append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
  return t;
}

// ---------------------------------------------------------------- fuzzy
// Returns {score, positions} or null. Rider-ish: camel humps and contiguous runs score higher.
export function fuzzy(query, text) {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  const positions = [];
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      const isHump = i === 0 || /[^a-z0-9]/i.test(text[i - 1]) || (text[i] >= 'A' && text[i] <= 'Z' && text[i - 1] >= 'a' && text[i - 1] <= 'z');
      score += 1 + (last === i - 1 ? 4 : 0) + (isHump ? 6 : 0) + (i === 0 ? 4 : 0);
      if (query[qi] === text[i]) score += 1;
      positions.push(i);
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score -= text.length * 0.05;
  return { score, positions };
}

export function highlight(text, positions) {
  const frag = document.createDocumentFragment();
  if (!positions || !positions.length) { frag.append(text); return frag; }
  const set = new Set(positions);
  let run = '';
  let bold = false;
  const flush = () => {
    if (!run) return;
    frag.append(bold ? el('b', null, run) : document.createTextNode(run));
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const b = set.has(i);
    if (b !== bold) { flush(); bold = b; }
    run += text[i];
  }
  flush();
  return frag;
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}
