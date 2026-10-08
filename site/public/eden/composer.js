// Jarvis Code's composer, ported from JARVIS V1 (src/jarvis/web/app.js 3434-4609): the
// reactor orb unfolds the control row (right-click pins it), auto-grow to 220px, Enter sends
// and Shift+Enter breaks a line, attachments (paste, drag and drop, ⌘U), / commands,
// @ mentions, ? shortcuts, ↑ recall, ⇧Tab mode cycle, ⌘⇧M / ⌘⇧I / ⌘⇧E, Esc in order, the
// menu engine with keyboard navigation, the context ring and the effort slider.
// Adapted: model menu = Model Router (auto) + the available models (an override); the
// effort gauge sets the override's effort and hides under the router; modes are Chat /
// Search / Research, or Manual / Accept edits / Plan / Auto in Code conversations. Dictate
// and Talk (the mic and the waveform beside send) live in voice.js.

import { $, el, toast, fmtCost, fmtTokens, sizeText, placePopup, shortModel, effortLabel, EFFORT_SHORT, store, isTouch, noKeys } from './util.js';
import { browseMode, setBrowseMode } from './browser-agent.js';
import { state, path, nodeText, sessionCost, persona, ui } from './state.js';
import { initVoice, voiceEscape } from './voice.js';
import { currentOverride, setOverride, availableModels, modelInfo, setPreviewText, levels, setLevel, scatter, rowsToCandidates, openChipPop, closeChipPop, chipPopOpenFor, PROVIDER_NAMES, schedulePreview } from './router.js';
import { initCompare, renderEstimate } from './compare.js';
import { macChips, macMenuItems } from './files.js';
import { api } from './api.js';
import { clock, confirmText, isVideo, needsConfirm, videoProblem } from './video-model.js';

let H = {}; // handlers from app.js

/* ---------- icons (Jarvis Code's ICON_PATHS) ---------- */
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  ask: ['M5.4 8.4V4.2a1 1 0 0 1 2 0v3.4', 'M7.4 7.4V3.1a1 1 0 0 1 2 0v4.3', 'M9.4 7.5V4.1a1 1 0 0 1 2 0v4.8c0 2.8-1.8 4.6-4.3 4.6-1.6 0-2.6-.7-3.4-2L2.3 9a1 1 0 0 1 1.7-1l1.4 1.6'],
  edits: ['M3 13l.9-3.2 6.8-6.8a1.5 1.5 0 0 1 2.2 2.1L6.1 11.9z', 'M9.7 4.1l2.1 2.1'],
  plan: ['M6 4h7.5', 'M6 8h7.5', 'M6 12h7.5', 'M2.6 4h.5', 'M2.6 8h.5', 'M2.6 12h.5'],
  smart: ['M7.2 2l1.3 3.3 3.3 1.3-3.3 1.3-1.3 3.3-1.3-3.3-3.3-1.3 3.3-1.3z', 'M12.4 9.8l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z'],
  auto: ['M9.2 1.6L3.4 9.1h4.2l-1.1 5.3 5.8-7.6H8.1z'],
  chat: ['M2.6 4.2A1.6 1.6 0 0 1 4.2 2.6h7.6a1.6 1.6 0 0 1 1.6 1.6v5.4a1.6 1.6 0 0 1-1.6 1.6H6.4L3.4 13.6V11.2h-.8a.0 .0 0 0 1 0 0z'],
  search: ['M7 2.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2z', 'M10.4 10.4l3.4 3.4'],
  research: ['M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8z', 'M1.8 8h12.4', 'M8 1.8c1.7 1.6 2.6 3.7 2.6 6.2S9.7 12.6 8 14.2C6.3 12.6 5.4 10.5 5.4 8S6.3 3.4 8 1.8z'],
  clip: ['M13.2 7.3l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5L8.8 2.7a2.1 2.1 0 0 1 3 3L6.6 11a1 1 0 0 1-1.5-1.5l4.9-4.9'],
  note: ['M4 1.8h5.2L12.4 5v8.6a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6z', 'M9 1.8V5.2h3.4', 'M5.6 8.2h4.8M5.6 10.6h3'],
  persona: ['M8 2.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z', 'M3 13.6c.6-2.6 2.6-4 5-4s4.4 1.4 5 4'],
  clock: ['M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8z', 'M8 4.6V8l2.4 1.6'],
  slash: ['M10.6 2.4L5.4 13.6'],
  gear: ['M8.15 1.33h-0.293a1.33 1.33 0 0 0 -1.33 1.33v0.12a1.33 1.33 0 0 1 -0.667 1.15l-0.287 0.167a1.33 1.33 0 0 1 -1.33 0l-0.1 -0.0533a1.33 1.33 0 0 0 -1.82 0.487l-0.147 0.253a1.33 1.33 0 0 0 0.487 1.82l0.1 0.0667a1.33 1.33 0 0 1 0.667 1.15v0.34a1.33 1.33 0 0 1 -0.667 1.16l-0.1 0.06a1.33 1.33 0 0 0 -0.487 1.82l0.147 0.253a1.33 1.33 0 0 0 1.82 0.487l0.1 -0.0533a1.33 1.33 0 0 1 1.33 0l0.287 0.167a1.33 1.33 0 0 1 0.667 1.15V13.3a1.33 1.33 0 0 0 1.33 1.33h0.293a1.33 1.33 0 0 0 1.33 -1.33v-0.12a1.33 1.33 0 0 1 0.667 -1.15l0.287 -0.167a1.33 1.33 0 0 1 1.33 0l0.1 0.0533a1.33 1.33 0 0 0 1.82 -0.487l0.147 -0.26a1.33 1.33 0 0 0 -0.487 -1.82l-0.1 -0.0533a1.33 1.33 0 0 1 -0.667 -1.16v-0.333a1.33 1.33 0 0 1 0.667 -1.16l0.1 -0.06a1.33 1.33 0 0 0 0.487 -1.82l-0.147 -0.253a1.33 1.33 0 0 0 -1.82 -0.487l-0.1 0.0533a1.33 1.33 0 0 1 -1.33 0l-0.287 -0.167a1.33 1.33 0 0 1 -0.667 -1.15V2.67a1.33 1.33 0 0 0 -1.33 -1.33z', 'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'], // Lucide "settings" (ISC), scaled to 16
  key: ['M10.3 2.2a3.5 3.5 0 1 1-2.9 5.4L2.6 12.4V14h2.2v-1.3h1.4v-1.4h1.3l1.4-1.4', 'M10.9 4.5h.01'],
  router: ['M8 1.6l1.5 3.9 3.9 1.5-3.9 1.5L8 12.4 6.5 8.5 2.6 7l3.9-1.5z'],
  chev: ['M6 3.5l4.5 4.5L6 12.5'],
  doc: ['M4 1.8h5.2L12.4 5v8.6a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6z', 'M9 1.8V5.2h3.4', 'M5.6 8.2h4.8M5.6 10.6h4.8'],
  check: ['M3.4 8.6l3 3 6.2-7.2'],
  plus: ['M8 3v10M3 8h10'],
  compare: ['M2.4 3.4h4.4v9.2H2.4z', 'M9.2 3.4h4.4v9.2H9.2z'],
  up: ['M8 13V3.8', 'M4.4 7.4L8 3.8l3.6 3.6'],
  mac: ['M3 3.4h10a.6.6 0 0 1 .6.6v6.8H2.4V4a.6.6 0 0 1 .6-.6z', 'M1.2 12.6h13.6'],
  screen: ['M2.4 2.8h11.2a.6.6 0 0 1 .6.6v7.2a.6.6 0 0 1-.6.6H2.4a.6.6 0 0 1-.6-.6V3.4a.6.6 0 0 1 .6-.6z', 'M6 13.6h4M8 11.2v2.4', 'M5 5.6h6M5 8h3.6'],
};
export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `ic ic-${name}` })) svg.setAttribute(k, String(v));
  for (const d of ICON_PATHS[name] || []) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}

/* ---------- modes ---------- */
export const CHAT_MODES = [
  { id: 'chat', icon: 'chat', label: 'Chat', note: 'Routed to the best model for each message' },
  { id: 'search', icon: 'search', label: 'Search', note: 'Searches the web and cites its sources' },
  { id: 'research', icon: 'research', label: 'Research', note: 'Searches widely, then writes a structured report (high effort)' },
  { id: 'compare', icon: 'compare', label: 'Compare', note: 'Up to 3 models answer side by side, then a short summary' },
];
/** Compare needs two models you can use (askeden.com: the hosted Claude models). */
const compareOff = () => (state.meta && availableModels().length < 2 ? 'Compare needs at least two models: add another API key in Settings' : '');
/** Search and Research need a search provider; Chat and Compare don't. */
const needsSearch = (id) => id === 'search' || id === 'research';
export const CODE_MODES = [
  { id: 'default', css: 'ask', icon: 'ask', label: 'Manual', note: 'Asks before each edit and command' },
  { id: 'acceptEdits', css: 'edits', icon: 'edits', label: 'Accept edits', note: 'Edits files without asking; commands still ask' },
  { id: 'plan', css: 'plan', icon: 'plan', label: 'Plan', note: 'Explores and plans; changes nothing until you approve' },
  { id: 'bypassPermissions', css: 'auto', icon: 'auto', label: 'Auto', note: 'Runs anything without asking', danger: true },
];
const modesFor = (c) => (c && c.kind === 'code' ? CODE_MODES : CHAT_MODES);
const curMode = () => { const c = state.current; return c ? c.mode : (state.pendingMode || 'chat'); };

/* ---------- slash commands, keys ---------- */
const SLASH_CHAT = [
  ['new', 'New chat'], ['temp', 'New temporary chat (not saved)'], ['chat', 'Chat mode'], ['search', 'Search mode: web, with sources'],
  ['research', 'Research mode: a sourced report'], ['model', 'Switch model: /model sonnet (or auto)'], ['effort', 'How hard it thinks: /effort high'],
  ['level', 'Router level: /level 1–5'], ['persona', 'Persona: /persona name (or none)'], ['note', 'Attach a note from your Mac: /note query'],
  ['memory', 'What your Mac remembers'], ['calendar', 'Your calendar this week'], ['brief', 'Your day: the brief and meeting prep'], ['brain', 'Search your second brain'],
  ['meetings', 'Meeting notes and their action items'], ['web', 'Do this on a website: /web what to do'], ['browse', 'Eden uses the cloud browser: /browse what to do'], ['undo', 'What Eden did, with Undo'],
  ['canvas', 'Open the canvas'], ['rename', 'Rename: /rename New name'], ['export', 'Save the chat as Markdown'], ['pin', 'Pin or unpin this chat'],
  ['copy', 'Copy the last reply'], ['clear', 'Start over in a new chat'], ['compact', 'Summarize into a new chat'],
  ['route', 'Route console'], ['settings', 'Settings and API keys'], ['theme', 'Light, dark or system'], ['stop', 'Stop the reply'], ['help', 'Commands and shortcuts'],
];
const SLASH_CODE = [
  ['code', 'New Code session'], ['manual', 'Ask before each edit and command'], ['edits', 'Accept edits automatically'], ['plan', 'Plan first, you approve'],
  ['auto', 'Auto: run anything without asking'], ['changes', 'Show what changed'], ['todos', 'The to-do list'], ['activity', 'Tool activity (⌘J)'],
];
const KEYS = [
  ['⏎', 'Send'], ['⇧⏎', 'New line'], ['⌘⏎', 'Steer: queue for the running Code step'], ['↑ ↓', 'Your earlier messages'],
  ['⇧⇥', 'Switch mode'], ['⌘⇧M', 'Mode menu'], ['⌘⇧I', 'Model'], ['⌘⇧E', 'Effort'], ['⌘U', 'Attach files'],
  ['⌘K', 'Search and commands'], ['⌘N', 'New chat'], ['⌘B', 'Sidebar'], ['⌘⌥0', 'Inspector'], ['⌘J', 'Code activity'], ['⌘,', 'Settings'],
  ['Esc', 'Stop, or close a menu or pane'], ['/', 'Commands'], ['@', 'Mention a note or persona'],
];

let pickIndex = 0;
let attachments = [];
const reading = new Set();
const MAX_FILES = 6, MAX_BINARY = 6 * 1024 * 1024, MAX_TEXT = 400 * 1024, MAX_TOTAL = 20 * 1024 * 1024;
let mentionItems = []; // async @ results
let mentionQuery = null;

const input = () => $('deck-input');

function suggestions() {
  const inp = input();
  const v = inp.value.slice(0, inp.selectionStart);
  if (inp.value === '?') return { kind: 'keys', items: KEYS.map(([key, help]) => ({ label: key, help, value: '' })) };
  if (/^\/[\w.:-]*$/.test(v)) {
    const q = v.slice(1).toLowerCase();
    const list = [...SLASH_CHAT, ...(state.current && state.current.kind === 'code' ? SLASH_CODE : SLASH_CODE.slice(0, 1))];
    return { kind: 'slash', items: list.filter(([n]) => n.startsWith(q)).map(([name, help]) => ({ label: `/${name}`, help, value: name })).slice(0, 40) };
  }
  const m = v.match(/(?:^|\s)@([\w./-]*)$/);
  if (m) {
    if (mentionQuery !== m[1]) { mentionQuery = m[1]; fetchMentions(m[1]); }
    const q = m[1].toLowerCase();
    const personas = state.personas.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 5).map((p) => ({ label: `@${p.name}`, help: 'Persona', value: p.name, persona: p }));
    return { kind: 'at', query: m[1], items: [...personas, ...mentionItems].slice(0, 14) };
  }
  mentionQuery = null;
  return { kind: '', items: [] };
}

let mentionT = 0;
function fetchMentions(q) {
  clearTimeout(mentionT);
  mentionItems = [];
  if (!q || q.length < 2 || !state.jarvis.available) return;
  mentionT = setTimeout(async () => {
    try {
      const notes = await H.searchNotes(q);
      if (mentionQuery !== q) return;
      mentionItems = notes.slice(0, 8).map((n) => ({ label: n.title, help: `Note · ${n.meta}`, value: n.title, note: n }));
      renderSuggestions();
    } catch { /* Jarvis away: no notes */ }
  }, 250);
}

function renderSuggestions() {
  const s = suggestions();
  const box = $('cc-slash');
  box.hidden = !s.items.length;
  pickIndex = Math.min(pickIndex, Math.max(0, s.items.length - 1));
  const kids = [];
  if (s.kind === 'keys') kids.push(el('div', 'pop-head', 'Shortcuts'));
  s.items.forEach((item, i) => {
    const b = el('button', { type: 'button', class: i === pickIndex ? 'active' : '', role: 'option', 'aria-selected': String(i === pickIndex), id: `sugg-${i}` });
    if (s.kind === 'at') b.append(el('code', '', item.label), item.help ? el('span', '', item.help) : '');
    else b.append(el('strong', '', item.label), el('span', '', item.help));
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pick(s, item); });
    kids.push(b);
  });
  box.replaceChildren(...kids);
  input().setAttribute('aria-activedescendant', s.items.length ? `sugg-${pickIndex}` : '');
}

function pick(s, item) {
  const inp = input();
  if (s.kind === 'keys') { inp.value = ''; $('cc-slash').hidden = true; inp.focus(); return; }
  if (s.kind === 'slash') {
    const needsArg = ['model', 'effort', 'rename', 'level', 'persona', 'note'].includes(item.value);
    inp.value = `/${item.value}${needsArg ? ' ' : ''}`;
    $('cc-slash').hidden = true;
    if (!needsArg) $('deck-composer').requestSubmit();
    else { inp.focus(); grow(); }
    return;
  }
  // @: a persona sets the persona; a note is attached as context; the mention leaves the text
  const before = inp.value.slice(0, inp.selectionStart).replace(/@[\w./-]*$/, '');
  inp.value = before + inp.value.slice(inp.selectionStart);
  inp.selectionStart = inp.selectionEnd = before.length;
  $('cc-slash').hidden = true;
  if (item.persona) H.setPersona(item.persona.id);
  else if (item.note) H.attachNote(item.note);
  inp.focus();
  grow();
}

/* ---------- ↑ recall ---------- */
const recall = { index: -1, draft: '' };
function recallMessage(step) {
  const inp = input();
  const said = path(state.current).filter((n) => n.role === 'user').map((n) => n.content || '');
  if (!said.length) return false;
  if (recall.index < 0) { if (step > 0) return false; recall.draft = inp.value; }
  const next = recall.index < 0 ? said.length - 1 : recall.index + step;
  if (next < 0) return true;
  if (next >= said.length) { recall.index = -1; inp.value = recall.draft; } else { recall.index = next; inp.value = said[next]; }
  inp.selectionStart = inp.selectionEnd = inp.value.length;
  grow();
  return true;
}

/* ---------- the orb and the drawer ---------- */
let composerExpanded = false;
let composerPinned = false;
try {
  composerPinned = localStorage.getItem('jc-composer-pinned') === '1';
  composerExpanded = composerPinned || localStorage.getItem('jc-composer-open') === '1';
} catch { /* private mode */ }
function setComposerExpanded(v, { focus = true } = {}) {
  composerExpanded = v;
  $('deck-composer').classList.toggle('expanded', v);
  $('jc-orb').setAttribute('aria-expanded', v ? 'true' : 'false');
  try { localStorage.setItem('jc-composer-open', v ? '1' : '0'); } catch { /* */ }
  if (v && focus) input().focus();
}

function grow() {
  const inp = input();
  inp.style.height = 'auto';
  inp.style.height = `${Math.min(220, inp.scrollHeight)}px`;
}

/* ---------- attachments ---------- */
const TEXT_FILE = /\.(md|markdown|txt|log|json|jsonl|csv|tsv|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|m?js|cjs|tsx?|jsx|vue|svelte|py|pyi|rb|go|rs|java|kt|kts|swift|m|mm|c|h|cc|cpp|hpp|cs|php|pl|lua|r|dart|scala|sh|bash|zsh|fish|sql|graphql|proto|env\.example|gitignore|dockerfile|makefile|gradle|plist|strings|diff|patch)$/i;
const TEXT_TYPES = ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/toml', 'application/x-sh', 'application/sql'];
function fileKind(file) {
  if (isVideo(file)) return 'video';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || TEXT_TYPES.includes(file.type) || TEXT_FILE.test(file.name) || /^(Makefile|Dockerfile|Gemfile|Procfile|LICENSE|README)$/i.test(file.name)) return 'text';
  return '';
}
/**
 * Every picture is redrawn through a canvas before it's attached, whatever its size: only the
 * pixels survive, so its EXIF block (GPS location, camera, time) and any other metadata are
 * gone. (Pictures under 6 MB used to go as they were, location and all.) It also turns HEIC
 * (Safari) or SVG into PNG/JPEG, which the models take, and scales anything over 2048 px down.
 * Rotation is applied first (from the EXIF orientation), so photos stay upright. An animated
 * GIF keeps its first frame.
 */
const cleaned = new WeakSet();
const MAX_SIDE = 2048;
async function cleanPicture(file) {
  let src = null, url = null;
  try {
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { // SVG, or HEIC outside Safari's bitmap path: decode through an <img>
      url = URL.createObjectURL(file);
      src = new Image();
      src.src = url;
      await src.decode();
    }
    const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
    if (!w0 || !h0) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const encode = (type, quality, flatten) => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d');
      if (flatten) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); } // JPEG has no transparency
      g.drawImage(src, 0, 0, w, h);
      return new Promise((r) => cv.toBlob(r, type, quality));
    };
    // pictures that may be transparent stay PNG unless that's too big; photos go as JPEG
    let blob = /^image\/(png|gif|webp|svg\+xml)$/i.test(file.type) ? await encode('image/png') : null;
    if (!blob || blob.size > MAX_BINARY) blob = await encode('image/jpeg', 0.88, true);
    if (!blob) return null;
    const type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const out = new File([blob], `${file.name.replace(/\.[^.]*$/, '') || 'picture'}${type === 'image/png' ? '.png' : '.jpg'}`, { type });
    cleaned.add(out);
    return out;
  } catch { return null; }
  finally {
    if (src && typeof src.close === 'function') src.close();
    if (url) URL.revokeObjectURL(url);
  }
}
/** A video's length and first frame (a small JPEG), read in the page: { seconds, thumb }. */
function probeVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (out) => { URL.revokeObjectURL(url); resolve(out); };
    v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    v.onerror = () => done(null);
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); };
    v.onseeked = () => {
      let thumb = '';
      try {
        const w = 160, h = Math.round(160 * (v.videoHeight || 90) / (v.videoWidth || 160)) || 90;
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(v, 0, 0, w, h);
        thumb = cv.toDataURL('image/jpeg', 0.7);
      } catch { /* no frame */ }
      done({ seconds: Number.isFinite(v.duration) ? v.duration : 0, thumb });
    };
    v.src = url;
  });
}
/** A video: checked, read (length, first frame), then uploaded now so it's ready when the message goes. */
async function addVideo(file) {
  const big = videoProblem({ type: file.type, name: file.name, size: file.size, seconds: 0 });
  if (big) { toast(`${file.name}: ${big}`); return; }
  const slot = { kind: 'video', size: 0, name: file.name, uploading: true };
  reading.add(slot); renderAttachments();
  try {
    const p = await probeVideo(file);
    if (!p) { toast(`${file.name} couldn’t be read as a video.`); return; }
    const long = videoProblem({ type: file.type, name: file.name, size: file.size, seconds: p.seconds });
    if (long) { toast(`${file.name} is ${clock(p.seconds)} long. ${long}`); return; }
    Object.assign(slot, { thumb: p.thumb, seconds: p.seconds, fileSize: file.size });
    renderAttachments();
    const up = await api.video(file, p.seconds);
    attachments.push({ kind: 'video', name: file.name, mime: up.mime, size: file.size, seconds: up.seconds || p.seconds, thumb: p.thumb, file: up.file, uri: up.uri, estimate: up.estimate });
  } catch (e) {
    toast(e && e.status === 404 ? 'Video works on askeden.com.' : `${file.name}: ${(e && e.message) || 'the upload didn’t work'}`);
  } finally { reading.delete(slot); renderAttachments(); }
}
export function addFile(file) {
  if (!file) return;
  const kind = fileKind(file);
  if (!kind) { toast(`${file.name} can’t be attached: pictures, videos and text or code files only.`); return; }
  const held = [...attachments, ...reading];
  if (held.length >= MAX_FILES) { toast('Up to six attachments per message.'); return; }
  if (kind === 'video') { addVideo(file); return; }
  if (kind === 'image' && !cleaned.has(file)) { cleanPicture(file).then((f) => (f ? addFile(f) : toast(`${file.name} couldn’t be read.`))); return; }
  if (kind === 'text' && file.size > MAX_TEXT) { toast(`${file.name} is over 400 KB.`); return; }
  if (kind === 'image' && file.size > MAX_BINARY) { toast(`${file.name} is over 6 MB.`); return; }
  if (held.reduce((n, a) => n + (a.kind === 'video' ? 0 : a.size || 0), 0) + file.size > MAX_TOTAL) { toast(`${file.name} would make this message too big to send.`); return; }
  if (kind === 'image' && state.current && state.current.kind !== 'code') {
    const o = currentOverride();
    const m = o && modelInfo(o.model);
    if (m && m.vision === false) toast(`${m.name} can’t see pictures; the router will pick a model that can.`);
  }
  const slot = { kind, size: file.size };
  reading.add(slot);
  const reader = new FileReader();
  reader.onerror = () => { reading.delete(slot); toast(`${file.name} couldn’t be read.`); };
  reader.onload = () => {
    reading.delete(slot);
    const result = String(reader.result);
    if (kind === 'text') {
      if (result.includes('\u0000')) { toast(`${file.name} isn’t a text file.`); return; }
      attachments.push({ kind, mime: file.type || 'text/plain', text: result, name: file.name, size: file.size });
    } else attachments.push({ kind, mime: file.type, data: result.split(',', 2)[1], url: result, name: file.name, size: file.size });
    renderAttachments();
  };
  if (kind === 'text') reader.readAsText(file); else reader.readAsDataURL(file);
}
/**
 * eden:attach: what the Eden iPhone app's share sheet or Siri's "Ask Eden" brings (native.js
 * passes it on): { prompt, send, fresh, files: [{ name, mime, data (base64) }] }. The files are
 * attached as if picked (pictures redrawn), the words go in the box, and with `send` the
 * message goes once every file has been read.
 */
addEventListener('eden:attach', async (e) => {
  const d = e.detail && typeof e.detail === 'object' ? e.detail : {};
  if (d.fresh) { attachments = []; state.draftContext = []; renderAttachments(); } // only what was shared goes
  for (const f of (Array.isArray(d.files) ? d.files : []).slice(0, MAX_FILES)) {
    let file = null;
    try {
      const bin = atob(String(f.data || ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      file = new File([bytes], String(f.name || 'Shared item').slice(0, 120), { type: String(f.mime || '') });
    } catch { toast('A shared item couldn’t be read.'); continue; }
    if (fileKind(file) === 'image') file = await cleanPicture(file);
    if (file) addFile(file); else toast('A shared picture couldn’t be read.');
  }
  for (let waited = 0; reading.size && waited < 10000; waited += 50) await new Promise((r) => setTimeout(r, 50));
  const text = String(d.prompt || '');
  if (text) setComposerText(text); else focusComposer();
  if (d.send && text.trim()) {
    $('deck-composer').requestSubmit();
    if (isTouch()) input().blur(); // asked from elsewhere: the reply, not the keyboard
  }
});
/** A video's chip: its first frame, length and size (uploading: a note instead of ×). */
function videoChip(a, x, uploading = false) {
  return el('span', { class: 'jc-file-chip video', title: `${a.name}${uploading ? ' (uploading…)' : ''}` },
    a.thumb ? el('img', { class: 'vthumb', src: a.thumb, alt: '' }) : icon('doc', 15),
    el('span', 'nm', a.name), el('small', '', [a.seconds ? clock(a.seconds) : '', a.size ? sizeText(a.size) : '', uploading ? 'uploading…' : ''].filter(Boolean).join(' · ')), x || '');
}
function removeChip(label, onRemove) {
  return el('button', { type: 'button', class: 'jc-chip-x', 'aria-label': `Remove ${label}`, onclick: onRemove }, '×');
}
export function renderAttachments() {
  const box = $('jc-attach');
  const chips = attachments.map((a, i) => {
    const drop = () => { attachments.splice(i, 1); renderAttachments(); input().focus(); };
    if (a.kind === 'image') return el('span', 'jc-thumb-img', el('img', { src: a.url, alt: a.name || 'Attached image' }), removeChip(a.name || 'image', drop));
    if (a.kind === 'video') return videoChip(a, removeChip(a.name || 'video', drop));
    return el('span', { class: 'jc-file-chip', title: a.name }, icon('doc', 15), el('span', 'nm', a.name), el('small', '', sizeText(a.size || 0)), removeChip(a.name, drop));
  });
  for (const s of reading) if (s.kind === 'video') chips.push(videoChip({ ...s, size: s.fileSize }, null, true));
  state.draftContext.forEach((x, i) => chips.push(el('span', { class: 'jc-file-chip ctx', title: x.title }, icon('note', 15), el('span', 'nm', x.title), el('small', '', 'context'), removeChip(x.title, () => { state.draftContext.splice(i, 1); renderAttachments(); }))));
  const pid = state.current ? state.current.personaId : state.draftPersona;
  const p = persona(pid);
  if (p) chips.push(el('span', { class: 'jc-file-chip persona', title: `Persona: ${p.name}` }, icon('persona', 15), el('span', 'nm', p.name), el('small', '', 'persona'), removeChip(p.name, () => H.setPersona(null))));
  chips.push(...macChips()); // Use my Mac, project knowledge (files.js): whose model the files go to
  box.hidden = !chips.length;
  box.replaceChildren(...chips);
}
export function addContext(block) {
  if (state.draftContext.some((x) => x.title === block.title)) { toast('Already attached'); return; }
  state.draftContext.push(block);
  renderAttachments();
  toast(`“${block.title}” goes with your next message`);
}

/* ---------- menus (Jarvis Code's engine) ---------- */
function menuItem(item) {
  if (item === '-') return el('hr');
  if (item.heading) return el('p', { class: 'jc-menu-head', role: 'presentation' }, item.heading);
  if (item.foot) return el('p', { class: 'jc-menu-foot', role: 'presentation' }, item.foot);
  const isSwitch = item.switch !== undefined;
  const b = el('button', { type: 'button', class: ['jc-mi', isSwitch ? 'jc-menu-switch' : '', item.danger ? 'danger' : '', item.sub ? 'has-sub' : ''].filter(Boolean).join(' ') });
  b.setAttribute('role', isSwitch ? 'menuitemcheckbox' : item.checked !== undefined ? 'menuitemradio' : 'menuitem');
  if (isSwitch) b.setAttribute('aria-checked', String(!!item.switch));
  else if (item.checked !== undefined) b.setAttribute('aria-checked', String(!!item.checked));
  if (item.disabled) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
  if (item.muted) b.classList.add('muted'); // looks unavailable, still opens something (a locked model: its keys)
  if (item.title) b.title = item.title;
  if (item.icon) b.append(icon(item.icon, 16));
  const text = el('span', 'mi-text', el('span', 'mi-label', item.label));
  if (item.note) text.append(el('small', '', item.note));
  b.append(text);
  if (isSwitch) b.append(el('span', `sw ${item.switch ? 'on' : ''}`));
  else if (item.checked) b.append(icon('check', 14));
  else if (item.key) b.append(el('span', 'k', item.key));
  if (item.sub) {
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.append(icon('chev', 12));
    let hover = 0;
    b.addEventListener('mouseenter', () => { clearTimeout(hover); hover = setTimeout(() => openMenu(b, item.sub(), { sub: true, noFocus: true }), 140); });
    b.addEventListener('mouseleave', () => clearTimeout(hover));
  } else b.addEventListener('mouseenter', () => { if (b.parentElement && b.parentElement.id === 'jc-menu') closeSubmenu(); });
  b.addEventListener('click', () => {
    if (item.sub) { openMenu(b, item.sub(), { sub: true }); return; }
    if (isSwitch && item.keepOpen) {
      const on = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(on));
      b.querySelector('.sw').classList.toggle('on', on);
      item.run(on);
      return;
    }
    closeMenu(true);
    item.run();
  });
  return b;
}

export function openMenu(anchor, items, opts = {}) {
  const menu = opts.sub ? $('jc-submenu') : $('jc-menu');
  if (opts.sub) {
    const parent = document.querySelector('[data-sub-open="1"]');
    if (parent) { parent.removeAttribute('data-sub-open'); parent.setAttribute('aria-expanded', 'false'); }
  } else { closeSubmenu(); closeEffort(); closeCtx(); closeMenu(); }
  items = items.filter(Boolean); // (an item left out is null)
  menu.replaceChildren(...items.map(menuItem));
  menu.classList.toggle('rich', items.some((i) => i && typeof i === 'object' && (i.note || i.icon)));
  menu.hidden = false;
  placePopup(menu, anchor, opts.sub ? 'right' : 'auto');
  anchor.setAttribute('aria-expanded', 'true');
  if (opts.sub) { anchor.setAttribute('data-sub-open', '1'); menu.dataset.parent = '1'; }
  else { menu._anchor = anchor; menu.dataset.anchor = anchor.id || ''; }
  if (!opts.noFocus) {
    const first = menu.querySelector('button:not([disabled])[aria-checked="true"]') || menu.querySelector('button:not([disabled])');
    if (first) first.focus();
  }
}
function closeSubmenu(refocus) {
  const sub = $('jc-submenu');
  if (sub.hidden) return;
  sub.hidden = true;
  const parent = document.querySelector('[data-sub-open="1"]');
  if (parent) { parent.removeAttribute('data-sub-open'); parent.setAttribute('aria-expanded', 'false'); if (refocus) parent.focus(); }
}
export function closeMenu(refocus) {
  closeSubmenu();
  const menu = $('jc-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  const anchor = menu._anchor;
  menu._anchor = null;
  if (anchor) { anchor.setAttribute('aria-expanded', 'false'); if (refocus && document.contains(anchor)) anchor.focus(); }
}
const menuOpenFor = (anchor) => !$('jc-menu').hidden && $('jc-menu')._anchor === anchor;

/* ---------- mode ---------- */
export function setMode(id) {
  const c = state.current;
  const modes = modesFor(c);
  const m = modes.find((x) => x.id === id);
  if (!m) return;
  const meta = state.meta;
  if (needsSearch(id) && !(c && c.kind === 'code') && meta && meta.search && meta.search.available === false) { toast(`Search isn’t available: ${meta.search.reason || 'no search provider'}`); return; }
  if (id === 'compare' && compareOff()) { toast(compareOff()); return; }
  const go = () => {
    const was = curMode();
    if (c) { c.mode = id; H.save(c); } else state.pendingMode = id;
    if ((was === 'compare') !== (id === 'compare')) schedulePreview(); // Compare prices its lanes
    renderComposer();
    toast(`${c && c.kind === 'code' ? 'Permission mode' : 'Mode'}: ${m.label}`);
  };
  if (id === 'bypassPermissions' && c.mode !== id) {
    H.confirm('Auto runs any command and changes any file without asking you. Use it only for a project you could lose.', 'Switch to Auto', go);
  } else go();
}
function nextMode() {
  const modes = modesFor(state.current).filter((m) => m.id !== 'bypassPermissions');
  const i = modes.findIndex((m) => m.id === curMode());
  return modes[(i + 1) % modes.length].id;
}
function modeMenu() {
  const c = state.current;
  const cur = curMode();
  const searchOff = state.meta && state.meta.search && state.meta.search.available === false;
  openMenu($('jc-mode-btn'), [
    ...modesFor(c).map((m) => ({
      icon: m.icon, label: m.label, danger: m.danger, checked: cur === m.id,
      note: needsSearch(m.id) && !(c && c.kind === 'code') && searchOff ? (state.meta.search.reason || 'Search isn’t available') : m.id === 'compare' && compareOff() ? compareOff() : m.note,
      disabled: (needsSearch(m.id) && !(c && c.kind === 'code') && searchOff) || (m.id === 'compare' && !!compareOff()),
      run: () => setMode(m.id),
    })),
    isTouch() ? null : { foot: '⌘⇧M or ⇧⇥ to switch' },
  ]);
}

/* ---------- model: the router, or a model of yours (an override) ---------- */
export function modelMenu() {
  const o = currentOverride();
  const code = state.current && state.current.kind === 'code';
  const models = (state.meta && state.meta.models) || [];
  const byProv = {};
  for (const m of models) (byProv[m.provider] = byProv[m.provider] || []).push(m);
  const items = [{ icon: 'router', label: 'Model Router (auto)', note: code ? 'Claude Code’s default model' : 'Picks the model for each message', checked: !o, run: () => setOverride(null) }];
  for (const [p, list] of Object.entries(byProv)) {
    items.push({ heading: PROVIDER_NAMES[p] || p });
    for (const m of list) items.push({
      label: m.name, checked: !!o && o.model === m.id,
      // askeden.com: whose key the model runs on (meta's keySource, accounts/user-keys.js)
      note: !m.available ? (m.needsKey ? m.reason || 'Add your Anthropic API key in Settings to use Claude' : 'Unavailable') : m.keySource === 'user' ? 'your key' : m.keySource === 'service' ? 'included' : m.note ? m.note : code && p !== 'anthropic' ? 'Code mode runs Claude' : m.tier === 'frontier' ? 'Frontier' : m.tier === 'fast' ? 'Fast' : '',
      // askeden.com: Claude is bring-your-own-key: its locked models open the keys settings instead
      disabled: (!m.available && !m.needsKey) || (code && p !== 'anthropic'),
      muted: !!m.needsKey, title: m.needsKey ? m.reason : undefined,
      run: () => (m.needsKey ? H.openSettings(0) : setOverride(m.id)),
    });
  }
  if (!models.length) items.push({ label: state.metaError ? 'The model list didn’t load' : 'Loading models…', disabled: true });
  items.push('-', { icon: 'key', label: 'Models & API keys…', run: () => H.openSettings(0) });
  openMenu($('jc-model'), items);
}

/* ---------- effort: a slider over the override model's efforts ---------- */
const EFFORT_NOTES = { none: 'No thinking: the fastest, cheapest answers.', minimal: 'A moment of thought.', low: 'Fast: quick answers, light thinking.', medium: 'A balance of speed and thought.', high: 'Thinks things through.', xhigh: 'Deeper reasoning for harder problems.', max: 'Thinks as hard as it can. Slower, and costs more.' };
function effortList() { const o = currentOverride(); const m = o && modelInfo(o.model); return (m && m.efforts && m.efforts.length ? m.efforts : ['low', 'medium', 'high', 'xhigh', 'max']); }
function showEffortValue(stop) {
  const list = effortList();
  const e = list[stop];
  $('ep-value').textContent = EFFORT_SHORT[e] || e;
  $('ep-note').textContent = EFFORT_NOTES[e] || '';
  $('ep-range').setAttribute('aria-valuetext', EFFORT_SHORT[e] || e);
  const p = list.length > 1 ? stop / (list.length - 1) : 0;
  $('ep-range').style.setProperty('--fill', `${p * 100}%`);
  $('ep-range').parentElement.style.setProperty('--p', String(p));
}
function openEffort() {
  const pop = $('jc-effort-pop');
  if (!pop.hidden) { closeEffort(true); return; }
  const o = currentOverride();
  if (!o) { toast(noKeys('The router picks the effort. Choose a model first (⌘⇧I).')); return; }
  closeMenu(); closeCtx();
  const list = effortList();
  const range = $('ep-range');
  range.max = String(Math.max(0, list.length - 1));
  const stop = Math.max(0, list.indexOf(o.effort));
  range.value = String(stop);
  const n = list.length;
  $('ep-dots').replaceChildren(...list.map((_, i) => { const d = el('i'); d.style.left = `${n > 1 ? (i / (n - 1)) * 100 : 0}%`; return d; }));
  $('ep-ticks').replaceChildren(...list.map((e, i) => { const s = el('span', '', EFFORT_SHORT[e] || e); s.style.left = `${n > 1 ? (i / (n - 1)) * 100 : 0}%`; if (i === 0) s.style.transform = 'translateX(-20%)'; if (i === n - 1 && n > 1) s.style.transform = 'translateX(-80%)'; return s; }));
  showEffortValue(stop);
  pop.hidden = false;
  placePopup(pop, $('jc-effort'), 'auto');
  $('jc-effort').setAttribute('aria-expanded', 'true');
  range.focus();
}
function closeEffort(refocus) {
  const pop = $('jc-effort-pop');
  if (pop.hidden) return;
  pop.hidden = true;
  $('jc-effort').setAttribute('aria-expanded', 'false');
  if (refocus) $('jc-effort').focus();
}
function applyEffort(stop) {
  const o = currentOverride();
  if (!o) return;
  setOverride(o.model, effortList()[Number(stop)]);
}

/* ---------- context window ---------- */
function contextWindowOf(modelId) {
  const m = modelInfo(modelId);
  if (m && (m.contextWindow || m.context)) return m.contextWindow || m.context;
  if (m && m.provider === 'gemini') return 1_000_000;
  if (m && m.provider === 'openai') return 400_000;
  if (m && m.provider === 'kimi') return 256_000;
  return 200_000;
}
function contextUse() {
  const c = state.current;
  const cats = [];
  const p = persona(c ? c.personaId : state.draftPersona);
  if (p && p.system) cats.push({ name: `Persona · ${p.name}`, tokens: Math.ceil(p.system.length / 4) });
  let ctx = state.draftContext.reduce((n, x) => n + x.text.length, 0);
  let msgs = 0, files = 0, images = 0;
  for (const n of path(c)) {
    if (n.role === 'user') {
      msgs += (n.content || '').length;
      for (const x of n.context || []) ctx += (x.text || '').length;
      for (const a of n.attachments || []) { if (a.kind === 'text') files += (a.text || '').length; else images += 1; }
    } else msgs += nodeText(n).length;
  }
  msgs += input().value.length;
  for (const a of attachments) { if (a.kind === 'text') files += a.text.length; else images += 1; }
  if (ctx) cats.push({ name: 'Notes and memory', tokens: Math.ceil(ctx / 4) });
  if (msgs) cats.push({ name: 'Messages', tokens: Math.ceil(msgs / 4) });
  if (files) cats.push({ name: 'Attached files', tokens: Math.ceil(files / 4) });
  if (images) cats.push({ name: `Pictures (${images})`, tokens: images * 1600 });
  const modelId = (currentOverride() || {}).model || (state.preview && state.preview.pick && state.preview.pick.model) || (c && c.lastRoute && c.lastRoute.model) || '';
  const max = contextWindowOf(modelId);
  const tokens = cats.reduce((n, x) => n + x.tokens, 0);
  return { cats, tokens, max, percent: Math.min(100, Math.round((100 * tokens) / max)), modelId };
}
const CX_COLORS = ['var(--cx-1)', 'var(--cx-2)', 'var(--cx-3)', 'var(--cx-4)', 'var(--cx-5)', 'var(--cx-6)'];
let cxArmed = 0;
function cxDisarm() { clearTimeout(cxArmed); cxArmed = 0; $('cx-clear').classList.remove('armed'); $('cx-clear').textContent = 'Clear'; }
function renderCtxPop() {
  const pop = $('jc-ctx-pop');
  if (pop.hidden) return;
  const u = contextUse();
  $('cx-total').textContent = `${fmtTokens(u.tokens)} / ${fmtTokens(u.max)} (${u.percent}%)`;
  $('cx-bar').replaceChildren(...u.cats.map((cat, i) => { const seg = el('i'); seg.style.width = `${(100 * cat.tokens) / u.max}%`; seg.style.background = CX_COLORS[i % CX_COLORS.length]; return seg; }));
  $('cx-legend').replaceChildren(...u.cats.map((cat, i) => { const dot = el('i'); dot.style.background = CX_COLORS[i % CX_COLORS.length]; return el('li', '', dot, el('span', '', cat.name), el('b', '', fmtTokens(cat.tokens))); }));
  const m = modelInfo(u.modelId);
  $('cx-note').textContent = `${m ? `Sized for ${m.name}` : 'Sized for a 200k window'}. An estimate (about 4 characters a token); the whole history goes with each message.`;
  $('cx-compact').hidden = !path(state.current).length;
}
function openCtx() {
  const pop = $('jc-ctx-pop');
  if (!pop.hidden) { closeCtx(true); return; }
  closeMenu(); closeEffort();
  pop.hidden = false;
  cxDisarm();
  renderCtxPop();
  placePopup(pop, $('jc-ctx'), 'auto');
  $('jc-ctx').setAttribute('aria-expanded', 'true');
  $('cx-compact').focus();
}
function closeCtx(refocus) {
  const pop = $('jc-ctx-pop');
  if (pop.hidden) return;
  pop.hidden = true;
  cxDisarm();
  $('jc-ctx').setAttribute('aria-expanded', 'false');
  if (refocus) $('jc-ctx').focus();
}

/* ---------- + menu ---------- */
function plusMenu() {
  const c = state.current;
  const pid = c ? c.personaId : state.draftPersona;
  openMenu($('jc-plus'), [
    { icon: 'clip', label: 'Add files or photos', key: '⌘U', run: () => $('jc-file').click() },
    { icon: 'note', label: 'Note from your Mac', note: state.jarvis.available ? 'Search your second brain, attach as context' : (state.jarvis.reason || 'Your Mac isn’t connected'), run: () => H.openBrain() },
    ...macMenuItems(), // Use my Mac, Ask about my screen (files.js)
    { icon: 'persona', label: 'Persona', note: persona(pid) ? persona(pid).name : 'Custom instructions', sub: () => [
      { label: 'None', checked: !pid, run: () => H.setPersona(null) },
      ...state.personas.map((p) => ({ label: p.name, note: p.system ? p.system.slice(0, 60) : '', checked: pid === p.id, run: () => H.setPersona(p.id) })),
      '-',
      { icon: 'plus', label: 'New persona…', run: () => H.editPersona(null) },
    ] },
    { icon: 'clock', label: 'Temporary chat', note: 'Not saved', switch: !!(c && c.temp), keepOpen: false, run: () => H.newTemp() },
    '-',
    { icon: 'slash', label: 'Commands', key: '/', run: showSlash },
    { icon: 'gear', label: 'Settings', key: '⌘,', run: () => H.openSettings(0) },
  ]);
}
function showSlash() {
  const inp = input();
  if (!inp.value.startsWith('/')) inp.value = `/${inp.value.trimStart()}`;
  inp.focus();
  inp.selectionStart = inp.selectionEnd = 1;
  pickIndex = 0;
  renderSuggestions();
}

/* ---------- the router chip (live pick) and the cost popover ---------- */
function routerPopContent() {
  const p = state.preview;
  const kids = [el('div', 'cp-t', 'Router · this message')];
  if (p && p.pick) {
    kids.push(scatter(rowsToCandidates(p.rows, p.pick)));
    kids.push(el('div', 'cp-row', el('span', '', `${shortModel(p.pick.name)} · ${effortLabel(p.pick.effort)}`), el('b', '', `~${fmtCost(p.pick.costUSD)}`)));
    if (p.pick.rationale) kids.push(el('div', 'cp-why', p.pick.rationale));
    kids.push(el('div', 'cp-why', p.rated ? 'Rated by Gemini.' : p.classification && p.classification.skipped ? `Rules: ${p.classification.skipped}.` : 'The rules’ pick; Gemini rates it when you send.'));
  } else if (p && p.error) kids.push(el('div', 'cp-why', `Preview unavailable: ${p.error}`));
  else kids.push(el('div', 'cp-why', 'Type a message: the pick for it shows here.'));
  const seg = el('div', { class: 'seg', style: { '--n': 5, marginTop: '10px' }, role: 'radiogroup', 'aria-label': 'Optimization level' }, el('div', 'seg-thumb'));
  seg.querySelector('.seg-thumb').style.setProperty('--i', state.settings.level - 1);
  for (const L of levels()) seg.append(el('button', { type: 'button', role: 'radio', 'aria-checked': String(L.level === state.settings.level), class: L.level === state.settings.level ? 'on' : '', title: L.label, onclick: () => { setLevel(L.level); openChipPop($('jc-router'), routerPopContent()); } }, String(L.level)));
  kids.push(seg, el('div', 'lvl-cap', el('span', '', '1 Max efficiency'), el('span', '', '5 Max performance')));
  kids.push(el('button', { type: 'button', class: 'cp-link', onclick: () => { closeChipPop(); H.openInspector('Route'); } }, 'Open Route console →'));
  return kids;
}
function openCostPop() {
  const pop = $('costPop');
  if (pop.classList.contains('show')) { closeCostPop(true); return; }
  const s = sessionCost(state.current);
  const max = Math.max(...s.turns, 1e-9);
  const bars = s.turns.slice(-16).map((v) => { const i = el('i'); i.style.height = `${Math.max(4, (v / max) * 100)}%`; i.title = fmtCost(v); return i; });
  pop.replaceChildren(el('div', 'cp-t', 'Cost per turn'),
    bars.length ? el('div', { class: 'sparkline', role: 'img', 'aria-label': `Cost of the last ${bars.length} turns` }, ...bars) : el('div', 'cp-f', 'No turns yet.'),
    el('div', 'cp-f', `${s.turns.length} turn${s.turns.length === 1 ? '' : 's'} · session total `, el('b', '', fmtCost(s.total)),
      s.notional ? el('div', '', '* Claude through the subscription: counted, not billed.') : ''));
  pop.classList.add('show');
  $('cc-meta').setAttribute('aria-expanded', 'true');
  placePopup(pop, $('cc-meta'), 'auto');
}
export function closeCostPop(refocus) {
  const pop = $('costPop');
  if (!pop.classList.contains('show')) return false;
  pop.classList.remove('show');
  $('cc-meta').setAttribute('aria-expanded', 'false');
  if (refocus) $('cc-meta').focus();
  return true;
}

/* ---------- render ---------- */
const GAUGE_OF = (i, n) => (n > 1 ? 18 + (82 * i) / (n - 1) : 56);
export function renderComposer() {
  const c = state.current;
  const code = c && c.kind === 'code';
  const streaming = c && state.streams.has(c.id);
  const modes = modesFor(c);
  const m = modes.find((x) => x.id === curMode()) || modes[0];
  const btn = $('jc-mode-btn');
  if (btn.dataset.mode !== (m.css || m.id)) $('jc-mode-ic').replaceChildren(icon(m.icon, 14));
  $('jc-mode-label').textContent = m.label;
  btn.dataset.mode = m.css || m.id;
  btn.title = `${m.label}: ${m.note} (⌘⇧M or ⇧⇥ to switch)`;
  const o = currentOverride();
  const om = o && modelInfo(o.model);
  $('jc-model-label').textContent = o ? (om ? shortModel(om.name) : o.model) : code ? 'Claude Code' : 'Model Router';
  $('jc-model').classList.toggle('routed', !o);
  $('jc-model').title = `Model: ${o ? (om ? om.name : o.model) : 'Model Router (auto)'} (⌘⇧I)`;
  // effort: only for an override (the router picks it otherwise)
  const eff = $('jc-effort');
  eff.hidden = !o || !om || !om.efforts || om.efforts.length < 2;
  if (!eff.hidden) {
    const list = om.efforts;
    const i = Math.max(0, list.indexOf(o.effort));
    $('jc-effort-label').textContent = EFFORT_SHORT[o.effort] || o.effort;
    eff.title = `Effort: ${EFFORT_SHORT[o.effort] || o.effort} (⌘⇧E)`;
    $('jc-gauge-fill').style.strokeDashoffset = String(100 - GAUGE_OF(i, list.length));
  }
  // the router's ✦ chip
  const chip = $('jc-router');
  chip.hidden = !!o || code;
  const p = state.preview;
  chip.classList.toggle('loading', !!(p && p.loading));
  if (p && p.pick) { $('jc-router-label').textContent = shortModel(p.pick.name); $('jc-router-sub').textContent = `${EFFORT_SHORT[p.pick.effort] || p.pick.effort} · ~${fmtCost(p.pick.costUSD)}`; }
  else if (p && p.loading) { $('jc-router-label').textContent = 'Routing…'; $('jc-router-sub').textContent = ''; }
  else if (p && p.error) { $('jc-router-label').textContent = 'Router'; $('jc-router-sub').textContent = 'offline'; }
  else { $('jc-router-label').textContent = 'Router'; $('jc-router-sub').textContent = `Level ${state.settings.level}`; }
  chip.title = p && p.pick ? `The router’s pick for this text: ${p.pick.name} · ${effortLabel(p.pick.effort)}${p.rated ? ' (rated by Gemini)' : ' (rules)'}` : 'The router’s pick for what you type';
  if (chipPopOpenFor(chip)) openChipPop(chip, routerPopContent());
  // cost and context
  const s = sessionCost(c);
  const lastTurn = s.turns.at(-1);
  $('cc-meta').textContent = s.turns.length ? `${fmtCost(lastTurn)} turn · ${fmtCost(s.total)} session${s.notional ? '*' : ''}` : '';
  const u = contextUse();
  $('jc-ctx-ring').style.strokeDashoffset = String(50.3 * (1 - u.percent / 100));
  $('jc-ctx-text').textContent = `${u.percent}%`;
  $('jc-ctx').classList.toggle('warn', u.percent >= 70 && u.percent < 90);
  $('jc-ctx').classList.toggle('full', u.percent >= 90);
  $('jc-ctx').title = `Context window: ${fmtTokens(u.tokens)} of ${fmtTokens(u.max)}`;
  renderCtxPop();
  // send ↔ stop; steer only for a running Code turn
  const send = $('jc-send');
  send.classList.toggle('stop', !!streaming);
  send.setAttribute('aria-label', streaming ? 'Stop' : 'Send');
  send.title = streaming ? 'Stop (Esc). Type to steer instead: it waits for the reply' : 'Send (⏎)';
  $('jc-steer').hidden = !streaming;
  $('deck-composer').classList.toggle('busy', !!streaming);
  input().placeholder = code ? `Ask Eden to plan, build or fix something in ${c.project ? c.project.name : 'this project'}…`
    : curMode() === 'search' ? 'Search the web — answers with sources…' : curMode() === 'research' ? 'What should I research? A sourced report…'
    : curMode() === 'compare' ? 'Ask several models at once — answers side by side…' : 'Message Eden — routed automatically…';
  renderEstimate(); // the routed model, its cost and time, above the input (compare.js)
  // the queue (steer)
  const q = (c && c.queue) || [];
  $('jc-queue').hidden = !q.length;
  $('jc-queue').replaceChildren(...q.map((item) => el('li', item.state === 'queued' && !code ? 'jc-queued jc-queued-wait' : 'jc-queued',
    el('span', 'jc-queued-kicker', item.state === 'sent' ? 'Steered' : item.state === 'sending' ? 'Steering…' : code ? 'Steer' : 'Queued — sends when Eden finishes'),
    el('span', { class: 'jc-queued-text', title: item.text }, item.state === 'sent' ? `${item.text} — sent to the running step` : item.text),
    item.state === 'queued' ? el('button', { type: 'button', class: 'jc-queued-steer', title: code ? 'Send into the running step now' : 'Stop this reply (keeping what it wrote) and send this now', onclick: () => H.steerNow(item.id) }, code ? 'Steer now' : 'Send now (stop reply)') : null,
    item.state === 'sent' ? null : el('button', { type: 'button', class: 'jc-queued-x', 'aria-label': 'Remove from the queue', onclick: () => H.dropQueued(item.id) }, '×'))));
  // the status line
  const bits = [];
  if (c && c.temp) bits.push('Temporary · not saved');
  if (code && c.allowTools && c.allowTools.length) bits.push(`Always allowed: ${c.allowTools.join(', ')}`);
  if (streaming) bits.push(noKeys(code ? 'Working… Esc stops' : 'Replying… Esc stops'));
  $('cc-status').textContent = bits.join(' · ');
  renderAttachments();
}

/* ---------- Esc, in order ---------- */
export function composerEscape(e) {
  if (!$('jc-submenu').hidden) { closeSubmenu(true); return true; }
  if (!$('jc-effort-pop').hidden) { closeEffort(true); return true; }
  if (!$('jc-menu').hidden) { closeMenu(true); return true; }
  if (!$('jc-ctx-pop').hidden) { closeCtx(true); return true; }
  if (!$('cc-slash').hidden) { $('cc-slash').hidden = true; return true; }
  if (closeCostPop(true)) return true;
  if (composerExpanded && !composerPinned && $('deck-composer').contains(e.target)) { setComposerExpanded(false); return true; }
  if (voiceEscape()) return true; // dictating, or reading aloud
  return false;
}

export function focusComposer() { input().focus(); }
export function setComposerText(text, { append = false } = {}) {
  const inp = input();
  inp.value = append && inp.value ? `${inp.value}\n${text}` : text;
  inp.focus();
  inp.selectionStart = inp.selectionEnd = inp.value.length;
  grow();
  setPreviewText(inp.value);
  renderComposer();
}
export function clearAttachments() { attachments = []; renderAttachments(); }

/* ---------- wiring ---------- */
let steerThis = false;
export function initComposer(handlers) {
  H = handlers;
  initVoice();
  initCompare({ openMenu, closeMenu }); // after voice: lanes of a comparison redraw in place
  const inp = input();
  if (composerExpanded) setComposerExpanded(true, { focus: false });
  $('deck-composer').classList.toggle('pinned', composerPinned);
  $('jc-orb').addEventListener('click', () => setComposerExpanded(!composerExpanded));
  $('jc-orb').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    composerPinned = !composerPinned;
    try { localStorage.setItem('jc-composer-pinned', composerPinned ? '1' : '0'); } catch { /* */ }
    $('deck-composer').classList.toggle('pinned', composerPinned);
    if (composerPinned) setComposerExpanded(true);
    toast(composerPinned ? 'Controls pinned open' : 'Controls unpinned');
  });
  $('jc-steer').addEventListener('click', () => { steerThis = true; $('deck-composer').requestSubmit(); });
  $('jc-send').addEventListener('click', (e) => {
    const c = state.current;
    if (c && state.streams.has(c.id)) {
      e.preventDefault();
      if (inp.value.trim()) { steerThis = true; $('deck-composer').requestSubmit(); return; }
      H.stop();
    }
  });
  $('deck-composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const steer = steerThis;
    steerThis = false;
    const text = inp.value.trim();
    const c = state.current;
    const streaming = c && state.streams.has(c.id);
    if (!text && !attachments.length) return;
    if (text.startsWith('/') && !attachments.length) {
      const [word, ...rest] = text.slice(1).split(/\s+/);
      if (H.slash(word.toLowerCase(), rest.join(' ').trim())) { done(); return; }
    }
    if (streaming) {
      // steer without interrupting: the text waits above the composer (or goes into the Code step)
      if (attachments.length) { toast('Attachments go with a new message: stop the reply first, or wait'); return; }
      H.queue(text); done(); return;
    }
    if ([...reading].some((s) => s.kind === 'video')) { toast('Wait for the video to finish uploading'); return; }
    const videos = attachments.filter((a) => a.kind === 'video');
    if (needsConfirm(videos) && !confirm(confirmText(videos))) return; // a long video: its estimate first
    const ok = H.send(text, attachments.slice(), state.draftContext.slice());
    if (!ok) return; // not sent: the draft stays
    attachments = [];
    state.draftContext = [];
    done();
  });
  function done() {
    recall.index = -1;
    inp.value = '';
    inp.style.height = '';
    $('cc-slash').hidden = true;
    setPreviewText('');
    if (!composerPinned) setComposerExpanded(false, { focus: true });
    renderComposer();
  }
  inp.addEventListener('keydown', (e) => {
    const s = suggestions();
    if (s.items.length && !$('cc-slash').hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pickIndex = (pickIndex + (e.key === 'ArrowDown' ? 1 : -1) + s.items.length) % s.items.length; renderSuggestions(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(s, s.items[pickIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('cc-slash').hidden = true; return; }
    }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); setMode(nextMode()); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) {
      const up = e.key === 'ArrowUp';
      const onEdge = up ? !inp.value.slice(0, inp.selectionStart).includes('\n') : !inp.value.slice(inp.selectionEnd).includes('\n');
      if ((recall.index >= 0 || (up && !inp.value)) && onEdge && recallMessage(up ? -1 : 1)) { e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const c = state.current;
      if (c && state.streams.has(c.id)) { steerThis = true; }
      $('deck-composer').requestSubmit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('deck-composer').requestSubmit(); }
  });
  inp.addEventListener('input', () => {
    recall.index = -1;
    pickIndex = 0;
    renderSuggestions();
    grow();
    setPreviewText(inp.value);
    renderCtxRing();
  });
  inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) $('cc-slash').hidden = true; }, 120));
  inp.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); files.forEach(addFile); }
  });
  const comp = $('deck-composer');
  comp.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); comp.classList.add('drag'); } });
  comp.addEventListener('dragleave', () => comp.classList.remove('drag'));
  comp.addEventListener('drop', (e) => { e.preventDefault(); comp.classList.remove('drag'); [...e.dataTransfer.files].forEach(addFile); });
  // a drop anywhere on the conversation attaches too
  $('split').addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); comp.classList.add('drag'); } });
  $('split').addEventListener('dragleave', (e) => { if (!$('split').contains(e.relatedTarget)) comp.classList.remove('drag'); });
  $('split').addEventListener('drop', (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); comp.classList.remove('drag'); [...e.dataTransfer.files].forEach(addFile); } });
  $('jc-file').addEventListener('change', (e) => { [...e.target.files].forEach(addFile); e.target.value = ''; });

  const browseBtn = $('jc-browse');
  if (browseBtn) {
    const showBrowse = () => { browseBtn.setAttribute('aria-pressed', String(browseMode())); browseBtn.classList.toggle('on', browseMode()); };
    browseBtn.addEventListener('click', () => { setBrowseMode(!browseMode()); toast(browseMode() ? 'Eden will use the browser for your messages' : 'Browser off: Eden uses it only when a message needs it'); });
    addEventListener('eden:browse-mode', showBrowse);
    showBrowse();
  }
  $('jc-mode-btn').addEventListener('click', () => { if (menuOpenFor($('jc-mode-btn'))) closeMenu(); else modeMenu(); });
  $('jc-model').addEventListener('click', () => { if (menuOpenFor($('jc-model'))) closeMenu(); else modelMenu(); });
  $('jc-plus').addEventListener('click', () => { if (menuOpenFor($('jc-plus'))) closeMenu(); else plusMenu(); });
  $('jc-effort').addEventListener('click', openEffort);
  $('ep-range').addEventListener('input', () => showEffortValue(Number($('ep-range').value)));
  $('ep-range').addEventListener('change', () => applyEffort($('ep-range').value));
  $('ep-range').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyEffort($('ep-range').value); closeEffort(true); } });
  $('jc-ctx').addEventListener('click', openCtx);
  $('cx-compact').addEventListener('click', () => { closeCtx(); H.compact(); });
  $('cx-clear').addEventListener('click', () => {
    if (!cxArmed) { $('cx-clear').classList.add('armed'); $('cx-clear').textContent = 'Click again to clear'; cxArmed = setTimeout(cxDisarm, 3500); return; }
    cxDisarm(); closeCtx(); H.clear();
  });
  $('jc-router').addEventListener('click', () => { const chip = $('jc-router'); if (chipPopOpenFor(chip)) closeChipPop(); else openChipPop(chip, routerPopContent()); });
  $('cc-meta').addEventListener('click', openCostPop);

  for (const id of ['jc-menu', 'jc-submenu']) {
    $(id).addEventListener('keydown', (e) => {
      const menu = $(id);
      const items = [...menu.querySelectorAll('button:not([disabled])')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1].focus(); }
      else if (e.key === 'ArrowRight' && document.activeElement.classList.contains('has-sub')) { e.preventDefault(); document.activeElement.click(); }
      else if (e.key === 'ArrowLeft' && id === 'jc-submenu') { e.preventDefault(); closeSubmenu(true); }
      else if (e.key === 'Tab') closeMenu();
    });
  }
  document.addEventListener('mousedown', (e) => {
    const inside = (id) => $(id).contains(e.target);
    if (!$('jc-menu').hidden && !inside('jc-menu') && !inside('jc-submenu') && !($('jc-menu')._anchor && $('jc-menu')._anchor.contains(e.target))) closeMenu();
    if (!$('jc-effort-pop').hidden && !inside('jc-effort-pop') && !e.target.closest('#jc-effort')) closeEffort();
    if (!$('jc-ctx-pop').hidden && !e.target.closest('#jc-ctx-pop, #jc-ctx')) closeCtx();
    if ($('costPop').classList.contains('show') && !e.target.closest('#costPop, #cc-meta')) closeCostPop();
  });
  addEventListener('resize', () => { closeMenu(); closeEffort(); closeCtx(); closeCostPop(); });

  // global composer keys
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'u' && !e.shiftKey) { e.preventDefault(); $('jc-file').click(); }
    else if (e.shiftKey && k === 'm') { e.preventDefault(); if (!composerExpanded) setComposerExpanded(true, { focus: false }); modeMenu(); }
    else if (e.shiftKey && k === 'i') { e.preventDefault(); if (!composerExpanded) setComposerExpanded(true, { focus: false }); modelMenu(); }
    else if (e.shiftKey && k === 'e') { e.preventDefault(); if (!composerExpanded) setComposerExpanded(true, { focus: false }); requestAnimationFrame(openEffort); }
  });
  renderComposer();
}

function renderCtxRing() {
  const u = contextUse();
  $('jc-ctx-ring').style.strokeDashoffset = String(50.3 * (1 - u.percent / 100));
  $('jc-ctx-text').textContent = `${u.percent}%`;
}
export { contextUse, store as _store, ui as _ui };
