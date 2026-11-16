// Command registry + keybinding dispatcher (VS Code keymap by default, user-overridable).
//
// Key strings look like "Ctrl+Shift+K", chords "Ctrl+K Ctrl+S". Keys are derived from
// KeyboardEvent.code so shortcuts keep working while the Korean IME is active.
import { monaco } from './monaco.js';

const CODE_MAP = {
  Slash: '/', Backslash: '\\', Period: '.', Comma: ',', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Backquote: '`', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape',
  Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp',
  PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  NumpadAdd: '=', NumpadSubtract: '-', ContextMenu: 'ContextMenu',
};
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'HangulMode', 'HanjaMode', 'Process']);

export function codeToKey(code) {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_MAP[code] || null;
}

export function eventToKey(e) {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const k = codeToKey(e.code);
  if (!k) return null;
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + k;
}

// Normalize user-typed strings ("shift+ctrl+k" -> "Ctrl+Shift+K")
export function normalizeKey(str) {
  return String(str || '').trim().split(/\s+/).filter(Boolean).map((part) => {
    const bits = part.split('+').map((b) => b.trim()).filter(Boolean);
    let ctrl = false; let shift = false; let alt = false; let key = '';
    for (const b of bits) {
      const l = b.toLowerCase();
      if (l === 'ctrl' || l === 'cmd' || l === 'control' || l === 'meta') ctrl = true;
      else if (l === 'shift') shift = true;
      else if (l === 'alt' || l === 'option') alt = true;
      else key = b.length === 1 ? b.toUpperCase() : b[0].toUpperCase() + b.slice(1);
    }
    return (ctrl ? 'Ctrl+' : '') + (shift ? 'Shift+' : '') + (alt ? 'Alt+' : '') + key;
  }).join(' ');
}

export function displayKey(str) {
  return String(str || '').replace(/\bUp\b/g, '↑').replace(/\bDown\b/g, '↓').replace(/\bLeft\b/g, '←').replace(/\bRight\b/g, '→');
}

// "Ctrl+K Ctrl+S" -> Monaco keybinding number (used to unbind Monaco defaults we override)
const MONACO_KEY = {
  '/': 'Slash', '\\': 'Backslash', '.': 'Period', ',': 'Comma', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
  ';': 'Semicolon', "'": 'Quote', '`': 'Backquote', Up: 'UpArrow', Down: 'DownArrow', Left: 'LeftArrow', Right: 'RightArrow',
};
export function keyToMonaco(str) {
  const parts = normalizeKey(str).split(' ');
  const one = (p) => {
    const bits = p.split('+');
    const key = bits.pop();
    let n = 0;
    if (bits.includes('Ctrl')) n |= monaco.KeyMod.CtrlCmd;
    if (bits.includes('Shift')) n |= monaco.KeyMod.Shift;
    if (bits.includes('Alt')) n |= monaco.KeyMod.Alt;
    let name = MONACO_KEY[key] || key;
    if (/^[A-Z]$/.test(name)) name = 'Key' + name;
    else if (/^\d$/.test(name)) name = 'Digit' + name;
    const code = monaco.KeyCode[name];
    return code == null ? null : n | code;
  };
  const a = one(parts[0]);
  if (a == null) return null;
  if (parts.length === 1) return a;
  const b = one(parts[1]);
  return b == null ? null : monaco.KeyMod.chord(a, b);
}

export class Keybindings {
  constructor(app) {
    this.app = app;
    this.commands = new Map();
    this.user = {};
    this.pending = null; // first half of a chord
    this.recording = false;
    this.monacoUnbinds = null;
    this.lastShift = 0;
    this.shiftAlone = false;
    window.addEventListener('keydown', (e) => this.onKeyDown(e), true);
    window.addEventListener('keyup', (e) => this.onKeyUp(e), true);
  }

  /**
   * scope: 'global' (anywhere) | 'editor' (Monaco text focus)
   * monaco: Monaco command id this replaces (its default keys get unbound if the user remaps it)
   */
  register(cmd) {
    const c = { scope: 'global', keys: [], category: '일반', ...cmd };
    c.keys = (Array.isArray(c.keys) ? c.keys : [c.keys]).filter(Boolean).map(normalizeKey);
    this.commands.set(c.id, c);
    return c;
  }

  setUserBindings(map) {
    this.user = {};
    for (const [id, v] of Object.entries(map || {})) {
      this.user[id] = (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '').map(normalizeKey);
    }
    this.syncMonaco();
  }

  keysFor(id) {
    if (id in this.user) return this.user[id];
    const c = this.commands.get(id);
    return c ? c.keys : [];
  }

  isCustom(id) {
    return id in this.user;
  }

  primaryKey(id) {
    return this.keysFor(id)[0] || '';
  }

  // Commands bound to a key (for conflict display)
  commandsForKey(key, exceptId) {
    const out = [];
    for (const c of this.commands.values()) {
      if (c.id !== exceptId && this.keysFor(c.id).includes(key)) out.push(c);
    }
    return out;
  }

  run(id) {
    const c = this.commands.get(id);
    if (!c) return;
    try {
      const r = c.run();
      if (r && r.catch) r.catch((err) => console.error(err));
    } catch (err) {
      console.error(err);
    }
  }

  // When a Monaco command is remapped, its built-in default key must stop triggering it.
  syncMonaco() {
    if (this.monacoUnbinds) this.monacoUnbinds.dispose();
    const rules = [];
    for (const c of this.commands.values()) {
      if (!c.monaco || !this.isCustom(c.id)) continue;
      for (const k of c.keys) {
        if (this.keysFor(c.id).includes(k)) continue;
        const kb = keyToMonaco(k);
        if (kb != null) rules.push({ keybinding: kb, command: '-' + c.monaco });
      }
    }
    this.monacoUnbinds = rules.length ? monaco.editor.addKeybindingRules(rules) : null;
  }

  editorFocused() {
    const ed = this.app.editors && this.app.editors.editor;
    return !!(ed && ed.hasTextFocus());
  }

  match(key, editorFocus, typingInInput) {
    let fallback = null;
    for (const c of this.commands.values()) {
      if (!this.keysFor(c.id).includes(key)) continue;
      if (c.scope === 'editor') {
        if (editorFocus) return c;
      } else if (!typingInInput || /^(Ctrl|Alt)\+|^F\d|^Shift\+F\d/.test(key)) {
        fallback = fallback || c;
      }
    }
    return fallback;
  }

  hasChordPrefix(key) {
    for (const c of this.commands.values()) {
      if (this.keysFor(c.id).some((k) => k.startsWith(key + ' '))) return true;
    }
    return false;
  }

  onKeyDown(e) {
    if (this.recording) return;
    if (e.key === 'Shift') {
      this.shiftAlone = !e.repeat;
      return;
    }
    this.shiftAlone = false;
    if (e.isComposing && !e.ctrlKey && !e.altKey) return;
    const key = eventToKey(e);
    if (!key) return;
    const t = e.target;
    const editorFocus = this.editorFocused();
    const typingInInput = !editorFocus && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    if (this.pending) {
      const full = this.pending + ' ' + key;
      this.pending = null;
      this.app.setKeyHint && this.app.setKeyHint('');
      const c = this.match(full, editorFocus, false);
      e.preventDefault();
      e.stopPropagation();
      if (c) this.run(c.id);
      else this.app.setKeyHint && this.app.setKeyHint(`${full} 조합에 연결된 명령이 없어요`, 1800);
      return;
    }

    const c = this.match(key, editorFocus, typingInInput);
    if (c) {
      e.preventDefault();
      e.stopPropagation();
      this.run(c.id);
      return;
    }
    if ((!typingInInput || /^(Ctrl|Alt)\+/.test(key)) && this.hasChordPrefix(key)) {
      e.preventDefault();
      e.stopPropagation();
      this.pending = key;
      this.app.setKeyHint && this.app.setKeyHint(`(${key}) 두 번째 키를 누르세요…`);
      clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          this.app.setKeyHint && this.app.setKeyHint('');
        }
      }, 3000);
    }
  }

  onKeyUp(e) {
    if (this.recording || e.key !== 'Shift' || !this.shiftAlone) return;
    if (!this.app.settings['keyboard.doubleShift']) return;
    const now = Date.now();
    if (now - this.lastShift < 380) {
      this.lastShift = 0;
      this.run('workbench.searchEverywhere');
    } else this.lastShift = now;
  }
}
