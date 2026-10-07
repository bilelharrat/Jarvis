// Help inside Eden: the Help Center (web/help: the FAQ, its pictures and its interface, the same
// as askeden.com/help) in a sheet, opened from Settings › About, ⌘K ("Help", "Ask Help…"), the
// "?" in the title bar, #help in the address, or the iPhone app's Settings (eden:help).
//
// Ask Help answers from the FAQ only and lives apart from the person's conversations (its own
// session storage, never state.convs): askeden.com → POST /api/help/ask (the Worker, free and
// capped); Eden on the Mac → POST /api/chat/help (src/chat/help.ts, router level 1). In mock or
// practice mode the answers are practice ones made here from the pages (no model), unless
// ?help=live asks the real local server.

import { $, el, ico } from './util.js';
import { state } from './state.js';
import { API_ROOT, isMock } from './api.js';
import { PRACTICE } from './practice.js';

const LIVE = new URLSearchParams(location.search).get('help') === 'live';
const SETTINGS_TAB = { keys: 0, accounts: 1, appearance: 2, routing: 3, about: 4 };

let host = {}; // what app.js lends: runCommand, openSettings, openPalette, startTour
let loaded = null; // { faq, core, ui }
let ui = null;
let returnTo = null;

const hosted = () => Boolean(state.meta && state.meta.hosted);
const practice = () => PRACTICE || (isMock && !LIVE);

async function load() {
  if (loaded) return loaded;
  const base = `${API_ROOT}/help/`;
  const [faq, core, view] = await Promise.all([
    fetch(`${base}faq.json`, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`Help couldn’t load (${r.status}).`); return r.json(); }),
    import(`${base}help-core.js`),
    import(`${base}help-ui.js`),
  ]);
  loaded = { faq, core, view, base };
  return loaded;
}

function sheet() {
  let s = $('helpSheet');
  if (s) return s;
  const close = el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close Help', onclick: closeHelp }, ico('x'));
  const tab = el('a', { class: 'cap help-tab', href: `${API_ROOT}/help`, target: '_blank', rel: 'noopener', title: 'Open Help in its own tab' }, 'Open in a tab');
  s = el('div', { class: 'sheet help-sheet', id: 'helpSheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'helpTitle' },
    el('div', 'sheet-card glass help-card',
      el('div', 'sheet-head', el('h2', { id: 'helpTitle' }, 'Help'), tab, close),
      el('div', { class: 'sheet-body help-body', id: 'helpRoot' }, el('div', 'muted', 'Loading Help…'))));
  s.addEventListener('click', (e) => { if (e.target === s) closeHelp(); });
  s.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeHelp(); }
  });
  document.body.append(s);
  return s;
}

/** Run an answer's "open" action. */
function run(open) {
  if (!open) return false;
  closeHelp({ refocus: false });
  if (open.command === '__palette') host.openPalette?.();
  else if (open.command === '__jarvis') host.openSettings?.(SETTINGS_TAB.accounts);
  else if (open.command) host.runCommand?.(open.command);
  else if (open.settings) host.openSettings?.(SETTINGS_TAB[open.settings] ?? 0);
  else if (open.click) document.querySelector(open.click)?.click();
  return true;
}
function canRun(open) {
  if (!open) return false;
  if (open.command) return open.command.startsWith('__') ? Boolean(host.openPalette) : Boolean(host.hasCommand?.(open.command));
  if (open.settings) return Object.hasOwn(SETTINGS_TAB, open.settings) && Boolean(host.openSettings);
  if (open.click) { const n = document.querySelector(open.click); return Boolean(n && !n.hidden && !n.closest('[hidden]')); }
  return false; // links (/signin…) are for the public page
}

async function ask(payload, signal) {
  const { faq, core } = loaded;
  if (practice()) {
    await new Promise((r) => setTimeout(r, 450));
    const index = core.buildIndex(faq);
    return practiceAnswerFor(core, faq, index, payload);
  }
  const path = hosted() ? '/api/help/ask' : '/api/chat/help';
  let res;
  try {
    res = await fetch(`${API_ROOT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Can’t reach Help right now. The Help pages still work.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Help couldn’t answer (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function practiceAnswerFor(core, faq, index, payload) {
  return core.practiceAnswer(faq, index, { question: payload.question, image: Boolean(payload.image) });
}

async function askState() {
  const { core } = loaded;
  const d = core.HELP_DEFAULTS;
  if (practice()) return { ok: true, note: 'Practice answers: matched from the Help pages in this browser, no model (mock mode).' };
  if (hosted()) return { ok: true, note: `Free, up to ${d.messagesPerDay} questions and ${d.screenshotsPerDay} screenshots a day.` };
  return { ok: true, note: 'Answered on this Mac by a low-cost model (router level 1), from the Help pages.' };
}

/** Opens Help: at a page (`id`), on Ask Help (`ask: true`, with `text`), or where it was. */
export async function openHelp({ id = null, ask: toAsk = false, text = '' } = {}) {
  const s = sheet();
  returnTo = document.activeElement;
  host.beforeOpen?.();
  s.classList.add('open');
  try {
    const { faq, core, view, base } = await load();
    if (!ui) {
      ui = view.mountHelp($('helpRoot'), {
        faq,
        core,
        imgBase: base,
        mode: 'panel',
        theme: () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
        ask,
        askState,
        canRun,
        run,
        links: false,
        tour: host.startTour ? (chapter) => { closeHelp({ refocus: false }); host.startTour(chapter ? { chapter } : {}); } : null,
        surface: hosted() ? 'Eden on askeden.com' : isMock ? 'Eden (mock mode)' : 'Eden on your Mac',
      });
    }
    if (id) ui.show(id);
    else if (toAsk) ui.askView(text);
    requestAnimationFrame(() => ui.focus());
  } catch (e) {
    $('helpRoot').replaceChildren(el('div', 'sp-warn', el('b', '', 'Help didn’t load'), e.message));
  }
}

export function closeHelp({ refocus = true } = {}) {
  const s = $('helpSheet');
  if (!s || !s.classList.contains('open')) return false;
  ui?.stop?.();
  s.classList.remove('open');
  if (refocus && returnTo && document.contains(returnTo)) returnTo.focus();
  return true;
}
export const helpOpen = () => Boolean($('helpSheet')?.classList.contains('open'));

/** Palette entries (app.js commands()). */
export function helpCommands() {
  return [
    { t: 'Help', s: 'FAQ, how-tos and fixes', i: 'quote', run: () => openHelp() },
    { t: 'Ask Help…', s: 'Questions about Eden, screenshots', i: 'spark', run: () => openHelp({ ask: true }) },
  ];
}

/** A "Help" button for Settings › About. */
export function helpButton(onBefore) {
  return el('button', { type: 'button', class: 'btn', onclick: () => { onBefore?.(); openHelp(); } }, 'Help and FAQ');
}

export function initHelp(lend = {}) {
  host = lend;
  const link = (href) => { if (!document.querySelector(`link[href="${href}"]`)) document.head.append(el('link', { rel: 'stylesheet', href })); };
  link('help.css');
  link(`${API_ROOT}/help/help.css`);
  // the "?" in the title bar, beside ⌘K
  const pal = $('btnPalette');
  if (pal && !$('btnHelp')) pal.before(el('button', { type: 'button', class: 'iconbtn help-q', id: 'btnHelp', title: 'Help', 'aria-label': 'Help', onclick: () => openHelp() }, '?'));
  // the iPhone app's Settings › Help (ios/Eden/SettingsView.swift), and links into Help
  addEventListener('eden:help', (e) => openHelp(e.detail && typeof e.detail === 'object' ? e.detail : {}));
  const fromHash = () => {
    const m = /^#help(?:=([a-z0-9-]{2,60}))?$/.exec(location.hash);
    if (!m) return;
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    openHelp(m[1] ? { id: m[1] } : {});
  };
  addEventListener('hashchange', fromHash);
  fromHash();
}
