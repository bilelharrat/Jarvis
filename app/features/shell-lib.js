// The app shell's pure logic, apart from Electron so node --test can check it
// (app/features/shell.js wires it up): the words its menus use, what the window reports,
// the menus themselves as templates, the global shortcuts the user may choose, the window's
// place on each set of displays, how often a crashed page is reloaded, and the small file
// it keeps beside the app's data.
'use strict';

// ── words ──
// English until the window sends its own (translated, when the language is 中文).
const DEFAULT_LABELS = {
  idle: 'Ready',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  offline: 'Reconnecting…',
  ask: 'Ask…',
  mute: 'Mute',
  unmute: 'Unmute',
  handsFree: 'Hands-free',
  pause: 'Pause heads-ups for an hour',
  paused: 'Heads-ups paused',
  pausedUntil: '',
  resume: 'Resume heads-ups',
  open: 'Open J.A.R.V.I.S.',
  code: 'Jarvis Code',
  browser: 'Browser',
  quit: 'Quit J.A.R.V.I.S.',
  needsOk: 'Needs your OK',
  allow: 'Allow',
  notNow: 'Not now',
  purchaseHint: 'Say “confirm purchase”, or confirm it in J.A.R.V.I.S.',
};

// The window's labels over the defaults: only known keys, only short plain strings.
function mergeLabels(given) {
  const out = { ...DEFAULT_LABELS };
  if (!given || typeof given !== 'object') return out;
  for (const key of Object.keys(DEFAULT_LABELS)) {
    const value = given[key];
    if (typeof value === 'string' && value.length <= 120) out[key] = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  }
  return out;
}

// ── what the window reports ──
const STATES = ['idle', 'listening', 'transcribing', 'thinking', 'speaking'];

function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const until = Number(s.pausedUntil);
  return {
    state: STATES.includes(s.state) ? s.state : 'idle',
    online: s.online === true,
    muted: s.muted === true,
    handsFree: s.handsFree === true,
    pausedUntil: Number.isFinite(until) && until > 0 ? until : 0, // ms since 1970
    menuBar: s.menuBar !== false,
  };
}

function statusLine(s, L) {
  if (!s.online) return L.offline;
  return L[s.state === 'transcribing' ? 'thinking' : s.state] || L.idle;
}

// ── the menu bar icon's menu ──
// act(name) runs a command: ask, mute, unmute, hands-free, pause, resume, open, code, quit.
function trayTemplate(s, L, act, { now = Date.now(), ask = '' } = {}) {
  const paused = s.pausedUntil > now;
  return [
    { label: statusLine(s, L), enabled: false },
    { type: 'separator' },
    { label: L.ask, accelerator: ask || undefined, registerAccelerator: false, click: () => act('ask') },
    { type: 'separator' },
    { label: s.muted ? L.unmute : L.mute, enabled: s.online, click: () => act(s.muted ? 'unmute' : 'mute') },
    { label: L.handsFree, type: 'checkbox', checked: s.handsFree, enabled: s.online, click: () => act('hands-free') },
    ...(paused
      ? [{ label: L.pausedUntil || L.paused, enabled: false }, { label: L.resume, enabled: s.online, click: () => act('resume') }]
      : [{ label: L.pause, enabled: s.online, click: () => act('pause') }]),
    { type: 'separator' },
    { label: L.open, click: () => act('open') },
    { label: L.code, click: () => act('code') },
    { type: 'separator' },
    { label: L.quit, click: () => act('quit') },
  ];
}

// ── the Dock icon's menu ──
function dockTemplate(s, L, act) {
  return [
    { label: L.ask, click: () => act('ask') },
    { label: s.muted ? L.unmute : L.mute, enabled: s.online, click: () => act(s.muted ? 'unmute' : 'mute') },
    { type: 'separator' },
    { label: L.code, click: () => act('code') },
    { label: L.browser, click: () => act('browser') },
  ];
}

// ── notifications ──

const clip = (value, max) => (typeof value === 'string' ? value : '').slice(0, max);

function excerpt(value, max) {
  const flat = clip(value, 4000).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// An approval card as the window reports it, in the shape and sizes this side trusts.
function normalizeApproval(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[\w-]{1,64}$/.test(raw.id)) return null;
  const choices = (Array.isArray(raw.choices) ? raw.choices : []).slice(0, 8)
    .filter((c) => c && typeof c.id === 'string' && c.id.length <= 40)
    .map((c) => ({ id: c.id, label: clip(c.label, 60) }));
  return {
    id: raw.id,
    question: clip(raw.question, 500),
    detail: clip(raw.detail, 2000),
    choices,
    askKind: clip(raw.askKind, 20),
    task: Number.isFinite(raw.task) ? raw.task : null,
  };
}

// What its macOS notification says, and its buttons. Only a plain yes-or-no card gets
// buttons (its own words for them: Allow / Not now, Send / Don't send): a purchase needs
// the spoken words "confirm purchase" or JARVIS itself, and a plan or a question has
// more answers than two buttons hold.
function approvalNotice(a, L) {
  const allow = a.choices.find((c) => c.id === 'allow');
  const deny = a.choices.find((c) => c.id === 'deny');
  const purchase = a.askKind === 'purchase';
  const buttons = Boolean(allow && deny && !purchase);
  const lines = [excerpt(a.question, 160), excerpt(a.detail, 180)].filter(Boolean);
  if (purchase) lines.push(L.purchaseHint);
  return {
    title: L.needsOk,
    body: lines.join('\n'),
    actions: buttons ? [allow.label || L.allow, deny.label || L.notNow] : [],
    answers: buttons ? ['allow', 'deny'] : [],
  };
}

// A heads-up as the window reports it.
function normalizeHeadsUp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const h = { key: clip(raw.key, 200), kind: clip(raw.kind, 40), title: clip(raw.title, 200), text: clip(raw.text, 1000) };
  return h.title || h.text ? h : null;
}

// ── global shortcuts ──
// Electron accelerators, in one spelling: modifiers in this order, then the key.

const MODIFIERS = ['Command', 'Control', 'Alt', 'Shift'];
const FKEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);
const KEYS = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...FKEYS, 'Space', 'Return', 'Tab', 'Backspace', 'Delete',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`',
]);
const DEFAULT_SHORTCUTS = { ask: 'Alt+Space', whatsThis: 'Alt+Shift+Space' };
// macOS's own, which it keeps for itself (or would lose): input sources, the emoji picker,
// Finder search, the app switcher, screenshots, lock and log out, Spaces. (Kept in step with
// jarvis.features.shell.RESERVED, which checks what's saved.)
const RESERVED = new Set([
  'Control+Space', 'Command+Control+Space', 'Command+Alt+Space', 'Command+Tab', 'Command+Shift+Tab',
  'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5', 'Command+Control+Q', 'Command+Shift+Q',
  'Control+Up', 'Control+Down', 'Control+Left', 'Control+Right',
]);

// {ok, accelerator} with it spelled the one way, or {ok: false, error}: 'invalid' (not a
// key combination), 'modifier' (no ⌃ or ⌥, or ⌘ alone: that would take the key from
// every app), 'reserved' (macOS's).
function checkAccelerator(value) {
  if (typeof value !== 'string' || !value || value.length > 60) return { ok: false, error: 'invalid' };
  const parts = value.split('+');
  const key = parts.pop();
  if (!KEYS.has(key) || new Set(parts).size !== parts.length || parts.some((m) => !MODIFIERS.includes(m))) {
    return { ok: false, error: 'invalid' };
  }
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  const accelerator = [...mods, key].join('+');
  const fkey = FKEYS.includes(key);
  const strong = mods.includes('Control') || mods.includes('Alt') || (mods.includes('Command') && mods.length > 1);
  if (!fkey && !strong) return { ok: false, error: 'modifier' };
  if (RESERVED.has(accelerator)) return { ok: false, error: 'reserved' };
  return { ok: true, accelerator };
}

const KEY_SIGNS = { Return: '↩', Tab: '⇥', Backspace: '⌫', Delete: '⌦', Up: '↑', Down: '↓', Left: '←', Right: '→', Home: '↖', End: '↘', PageUp: '⇞', PageDown: '⇟' };

// As the Mac writes it: ⌃⌥⇧⌘, then the key ("⌥ Space", "⌃⌥J", "⇧⌘ F5").
function shortcutLabel(accelerator) {
  if (typeof accelerator !== 'string' || !accelerator) return '';
  const parts = accelerator.split('+');
  const key = parts.pop();
  const signs = [['Control', '⌃'], ['Alt', '⌥'], ['Shift', '⇧'], ['Command', '⌘']].filter(([m]) => parts.includes(m)).map(([, sign]) => sign).join('');
  const shown = KEY_SIGNS[key] || key;
  return shown.length > 1 ? `${signs} ${shown}`.trim() : `${signs}${shown}`;
}

// What the user chose, each one checked; the defaults for anything missing or wrong, and
// never one key combination for both.
function normalizeShortcuts(raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [slot, fallback] of Object.entries(DEFAULT_SHORTCUTS)) {
    const checked = checkAccelerator(given[slot]);
    out[slot] = checked.ok ? checked.accelerator : fallback;
  }
  if (out.whatsThis === out.ask) out.whatsThis = out.ask === DEFAULT_SHORTCUTS.whatsThis ? DEFAULT_SHORTCUTS.ask : DEFAULT_SHORTCUTS.whatsThis;
  return out;
}

// ── the window's place, remembered for each set of displays ──
// At the desk with the big screen it opens where it was on the big screen; on the laptop
// alone, where it was on the laptop.

const MIN_SIZE = { width: 760, height: 620 }; // main.js's minimum
const PLACES_KEPT = 12;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const isRect = (r) => Boolean(r) && ['x', 'y', 'width', 'height'].every((k) => finite(r[k])) && r.width > 0 && r.height > 0;

// Which displays these are: each one's size, place in the arrangement and scale, in any order.
function displaySetKey(displays) {
  return (Array.isArray(displays) ? displays : [])
    .filter((d) => d && isRect(d.bounds))
    .map((d) => `${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}@${d.scaleFactor || 1}`)
    .sort()
    .join('|');
}

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Where a remembered window goes: onto the screen its title bar overlaps most, no bigger
// than that screen's visible area (the menu bar and the Dock left out) and wholly on it.
// Null when its title bar isn't on any screen enough to grab (it then opens as it would
// have anyway).
function placeWindow(saved, displays, min = MIN_SIZE) {
  if (!isRect(saved)) return null;
  const areas = (Array.isArray(displays) ? displays : []).map((d) => d && d.workArea).filter(isRect);
  const bar = { x: saved.x, y: saved.y, width: saved.width, height: 40 };
  let best = null;
  let most = 0;
  for (const area of areas) {
    const o = overlap(bar, area);
    if (o > most) { most = o; best = area; }
  }
  if (!best || most < 40 * 40) return null;
  const width = Math.round(Math.min(best.width, Math.max(saved.width, min.width)));
  const height = Math.round(Math.min(best.height, Math.max(saved.height, min.height)));
  return {
    x: Math.round(Math.min(Math.max(saved.x, best.x), best.x + best.width - width)),
    y: Math.round(Math.min(Math.max(saved.y, best.y), best.y + best.height - height)),
    width,
    height,
  };
}

// A window of this size in the middle of a screen's visible area (no bigger than it).
function centerOn(area, size) {
  const width = Math.round(Math.min(area.width, size.width));
  const height = Math.round(Math.min(area.height, size.height));
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
}

// The store with this place kept for these displays (the most recent few sets only).
function rememberPlace(store, key, bounds, at) {
  if (!key || !isRect(bounds)) return store;
  const places = { ...store.places, [key]: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height), at } };
  const keep = Object.entries(places).sort((a, b) => b[1].at - a[1].at).slice(0, PLACES_KEPT);
  return { ...store, places: Object.fromEntries(keep) };
}

// ── a crashed page: reloaded, but not over and over ──
// The times of the reloads still counted, and whether another one may go now.
function allowReload(times, now, { max = 3, windowMs = 5 * 60_000 } = {}) {
  const recent = (times || []).filter((t) => now - t < windowMs);
  return recent.length < max ? { ok: true, times: [...recent, now] } : { ok: false, times: recent };
}

// ── the shell's own file (shell.json beside the app's data) ──
// What the app needs before the backend answers: whether to show the menu bar icon, and
// where the window was. Read defensively: a damaged or hand-edited file never stops the app.
function readStore(text) {
  let raw = {};
  try { raw = JSON.parse(text) || {}; } catch { raw = {}; }
  if (typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const places = {};
  const given = raw.places && typeof raw.places === 'object' && !Array.isArray(raw.places) ? raw.places : {};
  for (const [key, place] of Object.entries(given).slice(0, 50)) {
    if (typeof key === 'string' && key.length <= 2000 && isRect(place)) {
      places[key] = { x: place.x, y: place.y, width: place.width, height: place.height, at: finite(place.at) ? place.at : 0 };
    }
  }
  return { version: 1, menuBar: raw.menuBar !== false, shortcuts: normalizeShortcuts(raw.shortcuts), places };
}

module.exports = {
  DEFAULT_LABELS, mergeLabels, normalizeState, statusLine, trayTemplate, dockTemplate,
  excerpt, normalizeApproval, approvalNotice, normalizeHeadsUp,
  DEFAULT_SHORTCUTS, checkAccelerator, shortcutLabel, normalizeShortcuts,
  MIN_SIZE, displaySetKey, placeWindow, centerOn, rememberPlace, allowReload, readStore,
};
