// The built-in browser agent's pure parts, kept apart from Electron so they can be tested
// with plain Node (tests/web/browseragent.test.mjs): how an accessibility tree becomes the
// compact snapshot JARVIS reads, how element refs are handed out and go stale, what changed
// since the last snapshot, where screenshot marks go, key names, URL globs.
'use strict';

// Roles a person can act on: each gets a ref ([e12]) the agent can click, type into...
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox',
  'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'treeitem', 'DisclosureTriangle', 'MenuListOption', 'ToggleButton',
  'PopUpButton', 'textField', 'SearchBox', 'ComboBoxGrouping', 'ComboBoxMenuButton',
  'ComboBoxSelect', 'color', 'date', 'DateTime', 'InputTime',
]);
// Containers worth a ref too: something to scope a snapshot to, scroll to or look inside.
const CONTAINERS = new Set([
  'dialog', 'alertdialog', 'form', 'main', 'navigation', 'region', 'complementary', 'banner',
  'contentinfo', 'search', 'Iframe', 'IframePresentational', 'table', 'grid', 'treegrid',
  'tabpanel', 'menu', 'menubar', 'tree', 'feed', 'article',
]);
// Shown as lines (with no ref) when they carry structure.
const STRUCTURE = new Set([
  'heading', 'alert', 'status', 'log', 'marquee', 'timer', 'tablist', 'toolbar', 'group',
  'radiogroup', 'list', 'figure', 'img', 'image', 'row', 'cell', 'gridcell', 'columnheader',
  'rowheader', 'note', 'math', 'meter', 'progressbar', 'scrollbar', 'tooltip', 'definition',
  'term', 'blockquote', 'code', 'caption',
]);
// Never shown; their children are.
const SKIP = new Set([
  'none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak', 'LayoutTable',
  'LayoutTableRow', 'LayoutTableCell', 'LabelText', 'paragraph', 'Section', 'div', 'Pre',
  'Ruby', 'Abbr', 'Mark', 'time', 'emphasis', 'strong', 'subscript', 'superscript',
  'insertion', 'deletion', 'listitem', 'ListMarker', 'separator', 'splitter', 'rowgroup',
  'Canvas', 'Legend', 'FigureCaption', 'DescriptionList', 'DescriptionListTerm',
  'DescriptionListDetail', 'contentinfo_', 'Unknown', 'Video', 'Audio', 'Embed', 'Details',
  'Summary',
]);
const NAMED_ONLY = new Set(['group', 'radiogroup', 'list', 'figure', 'region', 'form', 'img', 'image', 'table', 'article']);
const ROLE_NAMES = {
  DisclosureTriangle: 'disclosure', MenuListOption: 'option', ToggleButton: 'button',
  PopUpButton: 'button', textField: 'textbox', SearchBox: 'searchbox', Iframe: 'iframe',
  IframePresentational: 'iframe', RootWebArea: 'document', image: 'img',
  ComboBoxGrouping: 'combobox', ComboBoxMenuButton: 'combobox', ComboBoxSelect: 'combobox',
  color: 'color picker', date: 'date', DateTime: 'date and time', InputTime: 'time',
};
// Names and values that must never reach Claude as they are.
const SECRET = /\b(pass(word|code|phrase)?|pin|cvv|cvc|csc|security code|card ?(number|no)|one[- ]?time|otp|2fa|verification code|ssn|social security|iban|routing number|account number)\b/i;
// Words on buttons that start runs, send, post, pay or delete: a click on them waits for the
// user's OK (the same words app/page-preload.js asks a second pinch for).
const RISKY = /\b(generate|regenerate|run|rerun|start|launch|create|delete|remove|erase|archive|discard|send|post|publish|submit|share|invite|buy|sell|trade|order|pay|purchase|checkout|transfer|sign ?out|log ?out|approve|reject|revoke|disconnect|upload|import|reset|clear|confirm|accept|agree|deactivate|promote|demote|ban|block)\b/i;

const LINE_BUDGET = 40000;
const OPTIONS_SHOWN = 12;
const NAME_MAX = 100;
const TEXT_MAX = 200;

function clip(text, max) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function quote(text) {
  return JSON.stringify(text);
}

function prop(node, name) {
  for (const p of node.properties || []) if (p.name === name) return p.value ? p.value.value : undefined;
  return undefined;
}

function roleOf(node) {
  return node && node.role ? String(node.role.value || '') : '';
}

function nameOf(node) {
  return node && node.name ? clip(node.name.value, NAME_MAX) : '';
}

// A form control's value, as far as Claude may see it: never a password's or a secret's.
function valueOf(node, role, name) {
  if (!node.value || node.value.value === undefined || node.value.value === null) return '';
  const raw = String(node.value.value);
  if (!raw.trim()) return '';
  if (/^[•●*•●]+$/.test(raw.trim()) || SECRET.test(name)) return '(hidden)';
  if (role === 'link' || role === 'RootWebArea') return '';
  return clip(raw, NAME_MAX);
}

// What a line says about its state, in plain words.
function statesOf(node, role, inView) {
  const out = [];
  const checked = prop(node, 'checked');
  if (checked !== undefined) out.push(checked === 'mixed' ? 'mixed' : String(checked) === 'true' ? 'checked' : 'unchecked');
  const pressed = prop(node, 'pressed');
  if (pressed !== undefined) out.push(pressed === 'mixed' ? 'partly pressed' : String(pressed) === 'true' ? 'pressed' : 'not pressed');
  const expanded = prop(node, 'expanded');
  if (expanded !== undefined) out.push(String(expanded) === 'true' ? 'expanded' : 'collapsed');
  if (String(prop(node, 'selected')) === 'true' && role !== 'RootWebArea') out.push('selected');
  const level = prop(node, 'level');
  if (role === 'heading' && level) out.push(`level ${level}`);
  if (String(prop(node, 'disabled')) === 'true') out.push('disabled');
  if (String(prop(node, 'readonly')) === 'true' && INTERACTIVE.has(role)) out.push('read-only');
  if (String(prop(node, 'required')) === 'true') out.push('required');
  const invalid = prop(node, 'invalid');
  if (invalid !== undefined && String(invalid) !== 'false') out.push('invalid');
  if (String(prop(node, 'modal')) === 'true') out.push('modal');
  if (String(prop(node, 'focused')) === 'true') out.push('focused');
  if (inView) out.push('in view');
  return out;
}

// What counts as "changed" between two snapshots: not scrolling (in view) or focus.
function signature(line) {
  return `${line.role}|${line.name}|${line.value}|${line.states.filter((s) => s !== 'in view' && s !== 'focused').join(',')}`;
}

// ── refs ──

// Refs number every element the agent may act on. The numbers are unique across all tabs
// for the app's lifetime, so a ref from another tab or an earlier page can never quietly
// point at something else: it's reported as such instead.
class RefRegistry {
  constructor() {
    this.next = 1;
    this.owner = new Map(); // ref number -> tab id
  }

  take(tabId) {
    const n = this.next++;
    this.owner.set(n, tabId);
    if (this.owner.size > 200000) { // bounded: the oldest refs are forgotten first
      const drop = this.owner.size - 150000;
      let i = 0;
      for (const key of this.owner.keys()) { if (i++ >= drop) break; this.owner.delete(key); }
    }
    return n;
  }

  forgetTab(tabId) {
    for (const [n, tab] of this.owner) if (tab === tabId) this.owner.delete(n);
  }
}

class RefTable {
  constructor(registry, tabId) {
    this.registry = registry;
    this.tabId = tabId;
    this.docGen = 0;
    this.byKey = new Map(); // node key -> ref number (this document)
    this.entries = new Map(); // ref number -> entry
    this.latest = new Set(); // ref numbers in the latest snapshot
    this.snapshots = 0;
    this.previous = null; // node key -> signature, from the latest snapshot
  }

  // A new page (the main frame navigated): every ref so far is stale.
  newDocument(docGen) {
    this.docGen = docGen;
    this.byKey.clear();
    this.entries.clear();
    this.latest.clear();
    this.previous = null;
    this.snapshots = 0;
  }

  assign(key, info) {
    let n = this.byKey.get(key);
    if (n === undefined) {
      n = this.registry.take(this.tabId);
      this.byKey.set(key, n);
    }
    this.entries.set(n, { ...info, key, ref: `e${n}`, docGen: this.docGen });
    return `e${n}`;
  }

  // Why a ref can't be used here, or its entry.
  lookup(ref) {
    const match = /^e?(\d{1,9})$/i.exec(String(ref || '').trim());
    if (!match) return { error: `“${clip(ref, 40)}” isn't a ref. Refs look like e12; take a browser_snapshot to get them.` };
    const n = Number(match[1]);
    const entry = this.entries.get(n);
    if (entry && this.latest.has(n)) return { entry };
    const owner = this.registry.owner.get(n);
    if (owner !== undefined && owner !== this.tabId) {
      return { error: `e${n} belongs to tab ${owner}, not this one. Pass tab ${owner}, or take a new browser_snapshot of this tab.` };
    }
    if (entry || (owner === this.tabId)) {
      return { error: `e${n} is from an earlier snapshot and isn't on the page any more (it changed since). Take a new browser_snapshot and use its refs.` };
    }
    return { error: `There's no e${n} on this page. Take a browser_snapshot and use its refs.` };
  }
}

// ── the snapshot ──

// frames: { [frameKey]: { nodes: AXNode[], sessionId, frameId } }, main: the main frame's key.
// childFrame(frameKey, backendNodeId): the frame key an <iframe> element shows, or ''.
// inView(frameKey, backendNodeId): whether that element is in the viewport.
// Returns { lines, refs, signatures, counts }: lines as { mark, depth, text, ref }.
function buildSnapshot({ frames, main, childFrame = () => '', inView = () => false, table, interactive = false, within = '', maxFrames = 20 }) {
  const lines = [];
  const signatures = new Map();
  const previous = table && table.previous;
  const seenFrames = new Set();
  let refCount = 0;
  let textChars = 0;
  const counts = { added: 0, changed: 0, removed: 0 };
  let scopeDepth = -1; // while inside `within`: the depth it starts at
  let scopeDone = false;

  function emit(line) {
    if (!within) { lines.push(line); return; }
    if (scopeDone || scopeDepth < 0) return;
    lines.push({ ...line, depth: line.depth - scopeDepth });
  }

  function visit(frameKey, id, depth, byId, parentName) {
    const node = byId.get(id);
    if (!node) return;
    const role = roleOf(node);
    let kids = node.childIds || [];
    // A long list of options (every country) shows its first ones and how many more.
    if (kids.length > OPTIONS_SHOWN + 2 && (role === 'combobox' || role === 'listbox' || role === 'MenuListPopup')) {
      const options = kids.filter((k) => /option/i.test(roleOf(byId.get(k))));
      if (options.length > OPTIONS_SHOWN + 2) {
        const hidden = new Set(options.slice(OPTIONS_SHOWN));
        kids = kids.filter((k) => !hidden.has(k));
        node.moreOptions = options.length - OPTIONS_SHOWN;
      }
    }
    if (node.ignored || SKIP.has(role) || (role === 'RootWebArea' && frameKey !== main)) {
      for (const kid of kids) visit(frameKey, kid, depth, byId, parentName);
      return;
    }
    const backend = node.backendDOMNodeId;
    const key = backend !== undefined ? `${frameKey}:${backend}` : '';
    if (role === 'StaticText') {
      const text = clip(node.name && node.name.value, TEXT_MAX);
      if (!text || interactive || text === parentName || textChars > LINE_BUDGET * 4) return;
      textChars += text.length;
      emit({ mark: '', depth, text: quote(text), kind: 'text' });
      return;
    }
    const name = nameOf(node);
    const interactiveRole = INTERACTIVE.has(role) || (role === 'generic' && String(prop(node, 'focusable')) === 'true');
    const container = CONTAINERS.has(role) || role === 'RootWebArea';
    const shown = interactiveRole || container || STRUCTURE.has(role);
    if (!shown || (NAMED_ONLY.has(role) && !name && !container)) {
      for (const kid of kids) visit(frameKey, kid, depth, byId, parentName);
      return;
    }
    const value = valueOf(node, role, name);
    const states = statesOf(node, role, key && role !== 'RootWebArea' && (interactiveRole || container) ? inView(frameKey, backend) : false);
    const describedBy = node.description ? clip(node.description.value, 120) : '';
    let ref = '';
    if (key && table && (interactiveRole || (container && role !== 'RootWebArea'))) {
      ref = table.assign(key, { role, name, frameKey, backendNodeId: backend });
      table.latest.add(Number(ref.slice(1)));
      refCount += 1;
    }
    const shownRole = ROLE_NAMES[role] || (role === 'generic' ? 'clickable' : role);
    const line = { mark: '', depth, ref, role: shownRole, name, value, states, kind: interactiveRole ? 'control' : container ? 'container' : 'structure' };
    let text = `${ref ? `[${ref}] ` : ''}${shownRole}${name ? ` ${quote(name)}` : ''}${value ? ` = ${quote(value)}` : ''}`;
    if (states.length) text += ` (${states.join(', ')})`;
    if (describedBy && (interactiveRole || role === 'dialog') && describedBy !== name) text += ` — ${quote(describedBy)}`;
    line.text = text;
    if (key && (interactiveRole || container || role === 'heading')) {
      const sig = signature(line);
      signatures.set(key, sig);
      if (previous) {
        if (!previous.has(key)) { line.mark = '+'; counts.added += 1; } else if (previous.get(key) !== sig) { line.mark = '~'; counts.changed += 1; }
      }
    }
    const startsScope = within && ref === within && scopeDepth < 0;
    if (startsScope) scopeDepth = depth;
    const keep = !interactive || interactiveRole || ref || role === 'heading' || role === 'dialog' || role === 'alertdialog';
    if (keep) emit(line);
    const childDepth = keep ? depth + 1 : depth;
    if (role === 'Iframe' || role === 'IframePresentational') {
      const child = backend !== undefined ? childFrame(frameKey, backend) : '';
      if (child && frames[child] && !seenFrames.has(child) && seenFrames.size < maxFrames) {
        seenFrames.add(child);
        walkFrame(child, childDepth);
      }
    }
    for (const kid of kids) visit(frameKey, kid, childDepth, byId, name || parentName);
    if (node.moreOptions && !interactive) emit({ mark: '', depth: childDepth, text: `… ${node.moreOptions} more options (select one by its label with browser_act select)`, kind: 'text' });
    if (startsScope) scopeDone = true;
  }

  function walkFrame(frameKey, depth) {
    const frame = frames[frameKey];
    if (!frame || !Array.isArray(frame.nodes) || !frame.nodes.length) return;
    const byId = new Map(frame.nodes.map((n) => [n.nodeId, n]));
    const childIds = new Set();
    for (const n of frame.nodes) for (const c of n.childIds || []) childIds.add(c);
    const roots = frame.nodes.filter((n) => !childIds.has(n.nodeId) && (!n.parentId || !byId.has(n.parentId)));
    for (const root of roots.length ? roots : [frame.nodes[0]]) visit(frameKey, root.nodeId, depth, byId, '');
  }

  if (table) table.latest.clear();
  seenFrames.add(main);
  walkFrame(main, 0);
  if (previous) {
    for (const key of previous.keys()) if (!signatures.has(key)) counts.removed += 1;
  }
  if (table) {
    table.previous = signatures;
    table.snapshots += 1;
  }
  return { lines, refCount, counts, first: !previous };
}

// The snapshot's lines as text, from line `offset`, within the budget; and where the next
// page starts (0 when this is the end).
function renderLines(lines, { offset = 0, budget = LINE_BUDGET } = {}) {
  const start = Math.max(0, Math.min(Number(offset) || 0, lines.length));
  const out = [];
  let used = 0;
  let i = start;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const text = `${l.mark || ' '} ${'  '.repeat(Math.min(l.depth, 30))}${l.text}`;
    if (used + text.length + 1 > budget && out.length) break;
    out.push(text);
    used += text.length + 1;
  }
  return { text: out.join('\n'), next: i < lines.length ? i : 0, shown: out.length, total: lines.length, start };
}

// ── where things are ──

function quadCenter(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  if (!(w >= 1 && h >= 1)) return null;
  return { x: xs.reduce((a, b) => a + b, 0) / 4, y: ys.reduce((a, b) => a + b, 0) / 4, w, h, left: Math.min(...xs), top: Math.min(...ys) };
}

// The first quad big enough to press (an inline link can wrap across lines).
function clickPoint(quads) {
  for (const quad of quads || []) {
    const c = quadCenter(quad);
    if (c) return c;
  }
  return null;
}

function intersects(box, view) {
  return box.x < view.x + view.width && box.x + box.width > view.x && box.y < view.y + view.height && box.y + box.height > view.y;
}

// ── marks on a screenshot ──

const MARK_H = 15;
const MARK_CHAR = 6.4;

// Boxes (in the viewport's CSS pixels) and a label for each, placed where it covers the fewest
// other labels: above the element's top-left corner, else inside it, else below it.
function layoutMarks(items, viewport, { max = 150 } = {}) {
  const placed = [];
  const view = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  for (const item of items) {
    if (placed.length >= max) break;
    const box = { x: item.x, y: item.y, width: item.width, height: item.height };
    if (!(box.width >= 2 && box.height >= 2) || !intersects(box, view)) continue;
    const w = Math.ceil(String(item.ref).length * MARK_CHAR + 6);
    const clampX = (x) => Math.max(0, Math.min(viewport.width - w, x));
    const clampY = (y) => Math.max(0, Math.min(viewport.height - MARK_H, y));
    const tries = [
      { x: clampX(box.x), y: clampY(box.y - MARK_H) },
      { x: clampX(box.x), y: clampY(box.y) },
      { x: clampX(box.x + box.width - w), y: clampY(box.y - MARK_H) },
      { x: clampX(box.x), y: clampY(box.y + box.height) },
      { x: clampX(box.x + box.width - w), y: clampY(box.y + box.height - MARK_H) },
    ];
    let best = tries[0];
    let bestHits = Infinity;
    for (const t of tries) {
      const label = { x: t.x, y: t.y, width: w, height: MARK_H };
      const hits = placed.filter((p) => intersects(label, p.label)).length;
      if (hits < bestHits) { best = t; bestHits = hits; }
      if (!hits) break;
    }
    placed.push({ ref: item.ref, box, label: { x: Math.round(best.x), y: Math.round(best.y), width: w, height: MARK_H } });
  }
  return placed;
}

// ── keys ──

const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
const MODIFIERS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const PUNCT = { '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192] };
// macOS editing commands for the shortcuts that need them (Chromium on the Mac runs them as
// commands, not keys).
const MAC_COMMANDS = {
  'Meta+a': 'selectAll', 'Meta+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste', 'Meta+z': 'undo',
  'Shift+Meta+z': 'redo', Backspace: 'deleteBackward', Delete: 'deleteForward',
  'Alt+Backspace': 'deleteWordBackward', 'Meta+Backspace': 'deleteToBeginningOfLine',
  ArrowLeft: 'moveLeft', ArrowRight: 'moveRight', ArrowUp: 'moveUp', ArrowDown: 'moveDown',
  'Meta+ArrowLeft': 'moveToBeginningOfLine', 'Meta+ArrowRight': 'moveToEndOfLine',
  'Meta+ArrowUp': 'moveToBeginningOfDocument', 'Meta+ArrowDown': 'moveToEndOfDocument',
  'Alt+ArrowLeft': 'moveWordLeft', 'Alt+ArrowRight': 'moveWordRight',
  'Shift+ArrowLeft': 'moveLeftAndModifySelection', 'Shift+ArrowRight': 'moveRightAndModifySelection',
  'Shift+Meta+ArrowLeft': 'moveToBeginningOfLineAndModifySelection', 'Shift+Meta+ArrowRight': 'moveToEndOfLineAndModifySelection',
};

// "Enter", "Meta+A", "Shift+Tab", "ctrl+shift+ArrowUp", "a" → what CDP's Input.dispatchKeyEvent
// needs, or null for a name it doesn't know.
function parseKey(spec) {
  const parts = String(spec || '').trim().split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  let modifiers = 0;
  const names = [];
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (!bit) return null;
    if (!(modifiers & bit)) names.push({ 1: 'Alt', 2: 'Control', 4: 'Meta', 8: 'Shift' }[bit]);
    modifiers |= bit;
  }
  const last = parts[parts.length - 1];
  let base = KEYS[last.toLowerCase()];
  if (!base && last.length === 1) {
    const ch = last;
    if (/[a-z]/i.test(ch)) {
      const lower = ch.toLowerCase();
      const shown = modifiers & 8 || (modifiers === 0 && ch !== lower) ? lower.toUpperCase() : lower;
      base = { key: shown, code: `Key${lower.toUpperCase()}`, keyCode: lower.toUpperCase().charCodeAt(0), text: shown, printable: true };
    }
    else if (/\d/.test(ch)) base = { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), text: ch, printable: true };
    else if (PUNCT[ch]) base = { key: ch, code: PUNCT[ch][0], keyCode: PUNCT[ch][1], text: ch, printable: true };
    else base = { key: ch, code: '', keyCode: 0, text: ch, printable: true };
  }
  if (!base) return null;
  const key = { ...base, modifiers };
  if (modifiers & (2 | 4 | 1)) delete key.text; // a shortcut types nothing
  const order = ['Shift', 'Control', 'Alt', 'Meta'].filter((m) => names.includes(m));
  const combo = [...order, base.key.length === 1 ? base.key.toLowerCase() : base.key].join('+');
  key.commands = MAC_COMMANDS[combo] ? [MAC_COMMANDS[combo]] : [];
  key.label = [...order, base.key === ' ' ? 'Space' : base.key].join('+');
  key.printable = Boolean(base.printable && !(modifiers & (1 | 2 | 4)));
  return key;
}

// ── addresses ──

function globToRegExp(glob) {
  let out = '';
  const text = String(glob || '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '*') {
      if (text[i + 1] === '*') { out += '.*'; i++; } else out += '[^/]*';
    } else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// A URL glob ("**/checkout*", "https://example.com/*") or, with no wildcard in it, a piece of
// the address.
function urlMatches(url, pattern) {
  const want = String(pattern || '').trim();
  if (!want) return false;
  if (!/[*?]/.test(want)) return String(url || '').includes(want);
  try { return globToRegExp(want).test(String(url || '')); } catch { return false; }
}

// Pages on this Mac: the web app a Jarvis Code session is building.
function isLoopback(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

function risky(name, { role = '', submits = false } = {}) {
  if (role === 'link' && !submits) return false; // links go places
  return RISKY.test(String(name || '')) || Boolean(submits);
}

module.exports = {
  INTERACTIVE, RISKY, SECRET, RefRegistry, RefTable, buildSnapshot, renderLines, clickPoint, quadCenter,
  intersects, layoutMarks, parseKey, globToRegExp, urlMatches, isLoopback, risky, clip, LINE_BUDGET,
};
