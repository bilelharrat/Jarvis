// The app shell's pure logic, apart from Electron so node --test can check it
// (app/features/shell.js wires it up): the words its menus use, what the window reports,
// the menus themselves as templates, and the small file it keeps beside the app's data.
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
  quit: 'Quit J.A.R.V.I.S.',
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

// ── the shell's own file (shell.json beside the app's data) ──
// What the app needs before the backend answers: whether to show the menu bar icon.
// Read defensively: a damaged or hand-edited file never stops the app.
function readStore(text) {
  let raw = {};
  try { raw = JSON.parse(text) || {}; } catch { raw = {}; }
  if (typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  return { version: 1, menuBar: raw.menuBar !== false };
}

module.exports = { DEFAULT_LABELS, mergeLabels, normalizeState, statusLine, trayTemplate, readStore };
