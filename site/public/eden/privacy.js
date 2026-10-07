// Privacy mode (ROADMAP G9): a chat that stays on this Mac. Its turns carry `privacy: true`
// and the server answers them only with a local model (Ollama, LM Studio) or refuses ("Turn on
// Ollama or LM Studio to use privacy mode"); never a cloud model, the Gemini rating or search.
// Per conversation (the lock in the title bar), with a default for new chats in Settings ›
// Routing. A rules-only check on what's being typed suggests it for sensitive messages, and
// every reply wears a badge saying where it was computed ("On your Mac", "Anthropic cloud").
// On askeden.com a private turn goes to the owner's Mac through its link (the Worker forwards it
// and says when the Mac is offline; meta.local is the Mac's local models); the badge works there too.

import { $, el, ico, toast, debounce } from './util.js';
import { state, saveSettings, saveConversation, path } from './state.js';
import { getJSON } from './api.js';
import { detectSensitive, sensitiveSummary, whereOf } from './privacy-rules.js';

export const NO_LOCAL_MODEL = 'Turn on Ollama or LM Studio to use privacy mode.';
const HOSTED_REASON = 'Privacy mode needs your Mac, through its link to askeden.com.';

let H = {};
let draft; // privacy picked before the chat exists (undefined: the Settings default)
let hits = []; // what the sensitive check found in the composer
let dismissed = ''; // the finding the owner said no to (not shown again for this text)
let checking = null;

const hosted = () => !!(state.meta && state.meta.hosted);
const isChat = (c) => !c || c.kind !== 'code';

/** The local models as the server sees them (meta.local), or why there are none. */
export function localStatus() {
  const phone = state.meta && state.meta.local;
  if (phone && phone.onDevice) return phone; // the Eden iPhone app answers private chats itself (native.js)
  const s = state.meta && state.meta.local;
  if (hosted()) return s && s.viaMac ? s : { available: false, reason: HOSTED_REASON, models: [], servers: [] }; // the Mac's, through its link
  return s || { available: false, reason: state.meta ? NO_LOCAL_MODEL : 'Checking…', models: [], servers: [] };
}

/** Is this chat private? (the draft chat's choice, or the default, until its first send fixes it) */
export function privacyOn(c = state.current) {
  if (!isChat(c)) return false;
  if (c && typeof c.privacy === 'boolean') return c.privacy;
  return draft ?? !!state.settings.privacyDefault;
}

function chosenModel() {
  const s = localStatus();
  const want = state.settings.localModel;
  return (s.models || []).find((m) => m.id === want) || (s.models || [])[0] || null;
}

/**
 * What a chat turn adds to POST /api/chat/send: { privacy: true, localModel } when private.
 * The first send fixes the chat's choice. Spread it first in the body (it also drops a
 * local model kept as the "sticky" pick once privacy is off: the router doesn't know it).
 */
export function privacyBody(c) {
  if (!c || c.kind === 'code') return {};
  if (typeof c.privacy !== 'boolean') { c.privacy = draft ?? !!state.settings.privacyDefault; draft = undefined; }
  hits = [];
  paintBar();
  if (!c.privacy) {
    const known = ((state.meta && state.meta.models) || []).some((m) => c.lastRoute && m.id === c.lastRoute.model);
    if (c.lastRoute && state.meta && !known) c.lastRoute = null;
    return {};
  }
  const m = chosenModel();
  setTimeout(checkLocal, 0); // the bar then shows whether the local server is still up
  return { privacy: true, ...(m ? { localModel: m.id } : {}) };
}

/** Ask the server again which local models are up (GET /api/chat/local). */
export async function checkLocal() {
  if (!state.meta) return localStatus();
  checking ??= getJSON('/api/chat/local')
    .then((s) => { if (state.meta) state.meta.local = s; return s; }, () => localStatus())
    .finally(() => { checking = null; });
  const s = await checking;
  paint();
  return s;
}

function apply(c, on) {
  if (c) { c.privacy = on; if (!on) c.lastRoute = null; saveConversation(c); } else draft = on;
  paint();
  if (H.schedulePreview) H.schedulePreview(); // the routing preview stops (or starts) with it
  if (!on) { toast('Privacy off: this chat is routed to cloud models again'); return; }
  toast('Private: this chat stays on your Mac');
  checkLocal().then((s) => { if (privacyOn() && !s.available) toast(s.reason || NO_LOCAL_MODEL); });
}

export function setPrivacy(on) {
  const c = state.current;
  if (!isChat(c) || privacyOn(c) === on) { paint(); return; }
  // Turning it off sends the whole conversation, private messages included, with the next turn.
  if (!on && c && path(c).length && H.confirm) {
    H.confirm('Turn privacy off for this chat? Your next message sends the whole conversation, its private messages included, to a cloud model.', 'Turn off', () => apply(c, false));
    return;
  }
  apply(c, on);
}

/* ---------- the badge on every reply ---------- */

/** "On your Mac" / "Anthropic cloud": where this reply was computed (null without a route). */
export function whereBadge(route) {
  const w = whereOf(route);
  if (!w) return null;
  const title = w.place === 'mac'
    ? `Computed on your Mac${w.detail ? ` (${w.detail})` : ''}. Nothing left this Mac.`
    : w.place === 'phone' ? `Computed on this iPhone${w.detail ? ` (${w.detail})` : ''}. Nothing left this iPhone.`
      : `Computed in the ${w.label}${route.via === 'claude-cli' || route.via === 'claude-code' ? ' (through Claude Code on your Mac)' : ''}.`;
  return el('span', { class: `where-badge ${w.place}`, title }, ico(w.place === 'cloud' ? 'globe' : 'lock', 11), w.label);
}

/* ---------- the title bar's lock and the line above the composer ---------- */

/** Redraw the lock and the bar (app.js calls this from renderTitle: chat switches, new chats). */
export function paint() {
  const btn = $('btnPrivacy');
  if (!btn) return;
  const c = state.current;
  btn.hidden = !isChat(c);
  const on = privacyOn(c);
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('on', on);
  btn.title = on ? 'Private: this chat stays on your Mac. Click to turn privacy off.' : 'Privacy mode: keep this chat on your Mac';
  btn.setAttribute('aria-label', on ? 'Privacy mode on: this chat stays on your Mac' : 'Turn on privacy mode for this chat');
  paintBar();
}

function modelPicker(s) {
  const models = s.models || [];
  const cur = chosenModel();
  if (models.length < 2) return el('b', '', cur ? cur.id : '');
  const sel = el('select', { 'aria-label': 'Local model for private chats' });
  for (const m of models) {
    const o = el('option', { value: m.id }, `${m.id} · ${m.serverName}`);
    if (cur && m.id === cur.id) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => { state.settings.localModel = sel.value; saveSettings(); });
  return sel;
}

function paintBar() {
  const bar = $('privacyBar');
  if (!bar) return;
  const c = state.current;
  if (!isChat(c)) { bar.hidden = true; return; }
  if (privacyOn(c)) {
    const s = localStatus();
    bar.className = 'privacy-bar on';
    if (s.available && s.onDevice) {
      bar.replaceChildren(ico('lock', 13), el('span', 'pb-t', 'Private · answered on this iPhone by Apple’s on-device model'));
    } else if (s.available) {
      const one = (s.models || []).length < 2 && chosenModel();
      bar.replaceChildren(...[ico('lock', 13), el('span', 'pb-t', `Private · answered on ${hosted() ? 'your' : 'this'} Mac by `), modelPicker(s), one ? el('span', 'pb-sub', ` in ${one.serverName}`) : null].filter(Boolean));
    } else {
      bar.className = 'privacy-bar on warn';
      // (replaceChildren would turn a null into the text "null")
      bar.replaceChildren(ico('lock', 13), el('span', 'pb-t', `Private · ${s.reason || NO_LOCAL_MODEL}`),
        el('button', { type: 'button', class: 'cap', onclick: () => checkLocal() }, 'Check again'));
    }
    bar.hidden = false;
    return;
  }
  const sig = hits.map((h) => h.kind).join(',');
  if (hits.length && state.settings.sensitiveCheck !== false && sig !== dismissed) {
    bar.className = 'privacy-bar hint';
    bar.replaceChildren(ico('lock', 13),
      el('span', 'pb-t', `This looks like it has ${sensitiveSummary(hits)}. Keep this chat on your Mac?`),
      el('button', { type: 'button', class: 'cap primary', onclick: () => setPrivacy(true) }, 'Use privacy mode'),
      el('button', { type: 'button', class: 'pb-x', 'aria-label': 'Not now', title: 'Not now', onclick: () => { dismissed = sig; paintBar(); } }, ico('x', 12)));
    bar.hidden = false;
    return;
  }
  bar.hidden = true;
  bar.replaceChildren();
}

/* ---------- Settings › Routing ---------- */

function switchRow(name, note, checked, onChange) {
  const input = el('input', { type: 'checkbox', 'aria-label': name });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('div', 'prov', el('div', 'grow', el('div', 'p-n', name), el('div', 'p-c', note)), el('label', 'switch', input, el('span', 'tr')));
}

/** The Privacy section of Settings › Routing. */
export function privacySettings() {
  const s = localStatus();
  const sec = el('div', 'set-sec privacy-set');
  const redraw = () => sec.replaceWith(privacySettings());
  const servers = (s.servers || []).map((v) => `${v.name}: ${v.available ? v.models.join(', ') : v.reason}`);
  const status = s.available ? servers.filter((x, i) => s.servers[i].available).join(' · ') : (s.reason || NO_LOCAL_MODEL);
  const modelRow = el('div', 'prov',
    el('div', 'grow', el('div', 'p-n', 'Local models'), el('div', `p-c${s.available ? ' ok' : ''}`, status),
      s.refused && s.refused.length ? el('div', 'p-c', `Ignored (not on this Mac): ${s.refused.join('; ')}`) : null),
    s.available && (s.models || []).length > 1 ? modelPicker(s) : null,
    el('button', { type: 'button', class: 'cap', onclick: async () => { await checkLocal(); redraw(); } }, 'Check again'));
  sec.append(el('h3', '', 'Privacy'),
    el('div', 'icard',
      switchRow('Private by default', 'New chats stay on this Mac: a local model answers, never a cloud one.', !!state.settings.privacyDefault, (v) => {
        state.settings.privacyDefault = v; saveSettings(); paint(); toast(v ? 'New chats start private' : 'New chats are routed to cloud models');
      }),
      switchRow('Suggest privacy for sensitive messages', 'Checked in this browser as you type (passwords, keys, ID, card and bank numbers, health details). Nothing is sent anywhere to decide.', state.settings.sensitiveCheck !== false, (v) => {
        state.settings.sensitiveCheck = v; saveSettings(); paintBar();
      }),
      modelRow),
    el('p', 'sp-note', hosted()
      ? 'On askeden.com, private chats are answered by a local model on your Mac (Ollama or LM Studio), through its link (J.A.R.V.I.S. Settings › Account › Eden on the web reaches this Mac); never by a cloud model. Each reply shows where it was computed.'
      : 'Privacy mode uses a model running on this Mac: install Ollama (ollama.com) or LM Studio, load a model, and keep it running. Web search is off in private chats. Each reply shows where it was computed.'));
  return sec;
}

/* ---------- start ---------- */

export function initPrivacy(handlers = {}) {
  H = handlers;
  const btn = $('btnPrivacy');
  if (btn) btn.addEventListener('click', () => setPrivacy(!privacyOn()));
  const input = $('deck-input');
  if (input) {
    const check = debounce(() => {
      hits = isChat(state.current) && !privacyOn() ? detectSensitive(input.value) : [];
      if (!hits.length) dismissed = '';
      paintBar();
    }, 250);
    input.addEventListener('input', check);
  }
  paint();
}
