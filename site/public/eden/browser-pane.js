// The browser panel (the globe in the title bar, ⌘⇧B, "Browser" in ⌘K): docked beside the
// conversation, as the canvas is; full screen with a close button on a phone. Open or closed
// is remembered per viewer (browser-model.js has the logic, its tests the rules).
//
// In the J.A.R.V.I.S. app's Ask Eden window it IS Jarvis's built-in browser: the app draws the
// tab on show in the panel's slot (its tabs, adblock and gates), and this page draws the tabs,
// the address bar and the buttons from the state the app sends. Anywhere else it's a live look
// at a tab of its own in that browser on the linked Mac (browser_view): the owner says yes on a
// card on the Mac first; from here only an address, back, forward and reload, never a click or
// a keystroke in the page (that's "Do this on a website…", a browser task, which asks there).
// What pages say is data: shown as text and pictures only.

import { $, el, ico, toast, isMobile } from './util.js';
import { state } from './state.js';
import { api } from './api.js';
import {
  appBridge, paneMode, wasOpen, keepOpen, keptView, keepView, typed, startUrl, shownUrl, isSecure, nextPoll, VIEW_WORDS,
} from './browser-model.js';

const DOWNLOAD = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? 'https://askeden.com' : '';
const H = { openSpace: null }; // app.js hands over the space panel (a browser task)
let pane = null; // the section, made on first open
let mode = '';
let bridge = null;
let stopMode = () => {};

const local = () => { try { return localStorage; } catch { return null; } };
const session = () => { try { return sessionStorage; } catch { return null; } };

export const browserOpen = () => document.body.classList.contains('browser-open');

/** app.js: wire the button, the shortcut's handler and what the panel may open. */
export function initBrowserPane(hooks = {}) {
  Object.assign(H, hooks);
  bridge = appBridge(window);
  const btn = $('btnBrowser');
  if (btn) btn.addEventListener('click', () => toggleBrowser());
  if (wasOpen(local())) toggleBrowser(true, { quiet: true });
}

/** Open or close it (force: true or false); remembered for this viewer. */
export function toggleBrowser(force, { quiet = false } = {}) {
  const on = force === undefined ? !browserOpen() : !!force;
  if (on === browserOpen()) { if (on && !quiet) focusAddress(); return; }
  document.body.classList.toggle('browser-open', on);
  const btn = $('btnBrowser');
  if (btn) btn.setAttribute('aria-pressed', String(on));
  keepOpen(local(), on);
  if (on) { build(); start(); if (!quiet) focusAddress(); } else stop();
}
export function closeBrowser() { if (!browserOpen()) return false; toggleBrowser(false); const b = $('btnBrowser'); if (b) b.focus(); return true; }

/** Jarvis became reachable, or stopped being: the panel follows. */
export function browserJarvisChanged() {
  if (!browserOpen() || mode === 'app') return;
  if (paneMode({ bridge, jarvisAvailable: state.jarvis.available }) !== mode) { stop(); start(); }
}

/* ---------- the panel's frame ---------- */

const parts = {};
function build() {
  if (pane) return;
  const back = navBtn('chevl', 'Back', () => act('back'));
  const fwd = navBtn('chevr', 'Forward', () => act('forward'));
  const reload = navBtn('retry', 'Reload', () => act('reload'));
  const addr = el('input', { type: 'text', class: 'br-url', id: 'brUrl', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go', placeholder: 'Search or enter address', 'aria-label': 'Address' });
  const lock = el('span', { class: 'br-lock', 'aria-hidden': 'true' }, ico('lock', 11));
  const form = el('form', { class: 'br-addr', role: 'search', onsubmit: (e) => { e.preventDefault(); go(addr.value); } }, lock, addr);
  addr.addEventListener('focus', () => { addr.value = parts.url || addr.value; addr.select(); });
  addr.addEventListener('blur', () => { addr.value = shownUrl(parts.url) || parts.url || ''; });
  addr.addEventListener('keydown', (e) => { if (e.key === 'Escape' && addr.value !== (shownUrl(parts.url) || '')) { e.stopPropagation(); addr.value = shownUrl(parts.url) || ''; addr.blur(); } });
  const shield = el('button', { type: 'button', class: 'br-shield', hidden: true, title: 'Ad and tracker blocking', 'aria-pressed': 'true', onclick: () => bridge && bridge.shields() }, el('span', 'br-shield-ico', '◈'), el('span', 'br-shield-n', ''));
  const close = el('button', { type: 'button', class: 'iconbtn br-close', title: 'Close browser · ⌘⇧B', 'aria-label': 'Close browser', onclick: () => closeBrowser() }, ico('x', 15));
  const where = el('span', 'br-where', '');
  const tabs = el('div', { class: 'br-tabs', role: 'tablist', 'aria-label': 'Tabs', hidden: true });
  const body = el('div', 'br-body');
  const foot = el('div', 'br-foot');
  pane = el('section', { id: 'browserPane', class: 'glass', 'aria-label': 'Browser' },
    el('div', 'br-head', el('span', 'br-title', ico('globe', 14), el('b', '', 'Browser')), where, el('span', 'br-sp'), close),
    tabs,
    el('div', 'br-bar', back, fwd, reload, form, shield),
    body, foot);
  Object.assign(parts, { back, fwd, reload, addr, lock, shield, where, tabs, body, foot, url: '' });
  $('split').append(pane);
}
function navBtn(icon, label, run) {
  return el('button', { type: 'button', class: 'iconbtn br-nav', title: label, 'aria-label': label, disabled: true, onclick: run }, ico(icon, 14));
}
function focusAddress() { if (!isMobile()) requestAnimationFrame(() => { if (parts.addr && !parts.addr.disabled) parts.addr.focus(); }); }

function setNav({ back = false, fwd = false, reload = false, addr = false } = {}) {
  parts.back.disabled = !back;
  parts.fwd.disabled = !fwd;
  parts.reload.disabled = !reload;
  parts.addr.disabled = !addr;
}
function setUrl(url) {
  parts.url = url || '';
  parts.lock.classList.toggle('on', isSecure(url));
  if (document.activeElement !== parts.addr) parts.addr.value = shownUrl(url) || url || '';
}

function start() {
  mode = paneMode({ bridge, jarvisAvailable: state.jarvis.available });
  pane.dataset.mode = mode;
  parts.body.replaceChildren();
  parts.foot.replaceChildren();
  parts.tabs.hidden = true;
  parts.shield.hidden = true;
  parts.where.textContent = '';
  setUrl('');
  stopMode = mode === 'app' ? startApp() : mode === 'remote' ? startRemote() : startOffline();
}
function stop() { stopMode(); stopMode = () => {}; }

function go(text) {
  const t = typed(text);
  if (!t.ok) { if (t.why === 'scheme') toast('Only web addresses (http or https)'); return; }
  parts.addr.blur();
  act('go', t.value);
}
let act = () => {};

/* ---------- in the J.A.R.V.I.S. app: Jarvis's own browser in the slot ---------- */

function startApp() {
  const slot = el('div', { class: 'br-slot', 'aria-label': 'Page' }, el('span', 'br-slot-note', 'The page shows here when nothing of Eden’s is over it.'));
  parts.body.append(slot);
  parts.where.textContent = 'J.A.R.V.I.S.';
  parts.tabs.hidden = false;
  setNav({ addr: true, reload: true });
  act = (action, url) => {
    if (action === 'go' || action === 'back' || action === 'forward' || action === 'reload') bridge.nav(action, url || '');
  };
  let shown = false, raf = 0, alive = true;
  const rect = () => { const r = slot.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
  // Eden's own layers (the palette, a sheet, a menu, a waiting task's card) are drawn by this
  // page under the app's view: it steps out while anything of Eden's is over the slot.
  const covered = () => {
    if (document.querySelector('#palette.open, .sheet.open, #spacePanel.open, .jc-menu:not([hidden]), #chipPop.open')) return true;
    const r = slot.getBoundingClientRect();
    for (const fx of [0.04, 0.5, 0.96]) {
      for (const fy of [0.04, 0.5, 0.96]) {
        const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
        if (hit && hit !== slot && !slot.contains(hit)) return true;
      }
    }
    return false;
  };
  const place = () => {
    raf = 0;
    if (!alive) return;
    const r = rect();
    const want = r.width > 40 && r.height > 40 && !covered() && document.visibilityState === 'visible';
    if (want && !shown) { shown = true; bridge.show(r); } else if (want) bridge.bounds(r);
    else if (!want && shown) { shown = false; bridge.hide(); }
  };
  const soon = () => { if (!raf) raf = requestAnimationFrame(place); };
  const ro = new ResizeObserver(soon);
  ro.observe(slot);
  const mo = new MutationObserver(soon);
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  addEventListener('resize', soon);
  document.addEventListener('visibilitychange', soon);
  bridge.onState((s) => { if (alive) drawApp(s); });
  Promise.resolve(bridge.open(true)).then(() => { soon(); bridge.state(); });
  return () => {
    alive = false;
    ro.disconnect(); mo.disconnect();
    removeEventListener('resize', soon);
    document.removeEventListener('visibilitychange', soon);
    if (raf) cancelAnimationFrame(raf);
    bridge.hide();
    bridge.open(false);
  };
}

function drawApp(s) {
  if (!s || typeof s !== 'object') return;
  setUrl(String(s.url || ''));
  setNav({ back: !!s.canBack, fwd: !!s.canForward, reload: true, addr: true });
  parts.reload.replaceChildren(ico(s.loading ? 'x' : 'retry', 14));
  parts.reload.setAttribute('aria-label', s.loading ? 'Stop' : 'Reload');
  parts.reload.title = s.loading ? 'Stop' : 'Reload';
  parts.reload.onclick = () => bridge.nav(s.loading ? 'stop' : 'reload');
  const sh = s.shields || {};
  parts.shield.hidden = !sh.ready;
  parts.shield.setAttribute('aria-pressed', String(!!sh.on));
  parts.shield.classList.toggle('off', !sh.on);
  parts.shield.title = sh.on ? `Blocking ads and trackers${sh.blocked ? `: ${sh.blocked} on this page` : ''}. Click to turn off.` : 'Ad and tracker blocking is off. Click to turn on.';
  parts.shield.lastElementChild.textContent = sh.on && sh.blocked ? String(sh.blocked > 99 ? '99+' : sh.blocked) : '';
  const list = Array.isArray(s.tabs) ? s.tabs.slice(0, 30) : [];
  parts.tabs.replaceChildren(...list.map((t) => el('div', { class: `br-tab${t.active ? ' on' : ''}`, role: 'presentation' },
    el('button', { type: 'button', class: 'br-tab-b', role: 'tab', 'aria-selected': String(!!t.active), title: String(t.title || t.url || 'New tab'), onclick: () => bridge.tab('select', t.id) },
      t.loading ? el('span', 'act-spin', '') : ico('globe', 11), el('span', 'br-tab-t', String(t.title || shownUrl(t.url) || 'New tab'))),
    list.length > 1 ? el('button', { type: 'button', class: 'br-tab-x', 'aria-label': `Close ${String(t.title || 'tab')}`, onclick: () => bridge.tab('close', t.id) }, ico('x', 10)) : null)),
  el('button', { type: 'button', class: 'iconbtn br-tab-new', title: 'New tab', 'aria-label': 'New tab', onclick: () => bridge.tab('new') }, ico('plus', 13)));
}

/* ---------- on the web: a live look at a tab on the linked Mac ---------- */

async function viewCall(args) {
  const r = await api.jarvis('browser_view', args);
  if (r.is_error) throw new Error(String(r.text || 'Jarvis said no.'));
  try { return JSON.parse(r.text); } catch { throw new Error('Jarvis sent something Eden can’t read. Is it up to date?'); }
}

function startRemote() {
  parts.where.textContent = 'Your Mac';
  let id = keptView(session());
  let timer = 0, alive = true, busy = false, last = null, failed = false;
  const shot = el('img', { class: 'br-shot', alt: '', hidden: true, draggable: 'false' });
  const status = el('div', { class: 'br-status', 'aria-live': 'polite' });
  const live = el('div', 'br-live', shot, status);
  const ask = el('button', { type: 'button', class: 'cap', onclick: () => { if (H.openSpace) H.openSpace('web', { url: parts.url }); } }, ico('spark', 12), 'Ask Jarvis to do something here');
  parts.body.append(live);
  parts.foot.append(el('span', 'br-foot-t', 'A tab of its own in J.A.R.V.I.S. on your Mac. Clicking and typing in the page happen there.'), ask);
  ask.hidden = true;

  const draw = (v) => {
    last = v;
    setUrl(v.url || '');
    const on = v.status === 'live';
    setNav({ back: on, fwd: on, reload: on, addr: on || !id });
    ask.hidden = !on;
    pane.dataset.view = v.status;
    if (on && v.shot) { shot.src = v.shot; shot.alt = v.title ? `The page: ${v.title}` : 'The page on your Mac'; shot.hidden = false; }
    if (!on) shot.hidden = true;
    const words = VIEW_WORDS[v.status] || v.status;
    if (on) status.replaceChildren(...(v.message ? [el('div', 'br-note', v.message)] : []));
    else if (v.status === 'waiting_owner') status.replaceChildren(el('div', 'br-card', el('span', 'act-spin', ''), el('b', '', words), el('p', '', 'J.A.R.V.I.S. is asking “Show Eden a tab of the built-in browser?” on your Mac. Answer it there.'), el('button', { type: 'button', class: 'btn', onclick: () => end() }, 'Cancel')));
    else status.replaceChildren(el('div', 'br-card', ico('globe', 22), el('b', '', words), v.message ? el('p', '', v.message) : null, el('button', { type: 'button', class: 'btn primary', onclick: () => begin() }, 'Show it again')));
  };
  const intro = () => {
    pane.dataset.view = 'intro';
    setNav({ addr: true });
    shot.hidden = true;
    ask.hidden = true;
    status.replaceChildren(el('div', 'br-card', ico('globe', 22), el('b', '', 'Browse on your Mac from here'),
      el('p', '', 'Eden shows a tab of its own in the J.A.R.V.I.S. browser on your Mac, live. You say yes on your Mac first. Type an address above, or start with a search page.'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => begin() }, 'Show my Mac’s browser')));
  };
  const schedule = (justActed) => {
    clearTimeout(timer);
    if (!alive || !last) return;
    const ms = nextPoll({ status: last.status, hidden: document.visibilityState !== 'visible', failed, justActed });
    if (ms) timer = setTimeout(tick, ms);
  };
  const tick = async (op = 'status', url) => {
    if (!alive || !id) return;
    if (busy && op === 'status') { schedule(false); return; }
    busy = true;
    try {
      const v = await viewCall({ op, id, ...(url ? { url } : {}) });
      failed = false;
      if (!alive) return;
      draw(v);
    } catch (e) {
      if (!alive) return;
      if (/No browser view/.test(e.message)) { id = ''; keepView(session(), ''); last = null; intro(); return; }
      if (op !== 'status') toast(e.message);
      failed = true;
      status.replaceChildren(el('div', 'br-note warn', el('b', '', 'Can’t reach your Mac. '), e.message));
    } finally { busy = false; }
    schedule(op !== 'status');
  };
  const begin = async (url) => {
    try {
      const v = await viewCall({ op: 'start', ...(url ? { url } : {}) });
      if (!alive) { viewCall({ op: 'stop', id: v.id }).catch(() => {}); return; }
      id = v.id;
      keepView(session(), id);
      draw(v);
      schedule(true);
    } catch (e) { toast(e.message); }
  };
  const end = () => { if (id) viewCall({ op: 'stop', id }).catch(() => {}); id = ''; keepView(session(), ''); last = null; clearTimeout(timer); intro(); };
  act = (action, url) => {
    if (!id || !last || last.status !== 'live') { if (action === 'go') begin(startUrl(url).value); return; }
    tick(action, url);
  };
  const vis = () => { if (document.visibilityState === 'visible' && last) tick(); };
  document.addEventListener('visibilitychange', vis);
  if (id) { last = { status: 'live' }; tick(); } else intro();
  return () => {
    alive = false;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', vis);
    if (id) viewCall({ op: 'stop', id }).catch(() => {}); // its tab closes on the Mac
    keepView(session(), '');
  };
}

/* ---------- no Mac to ask ---------- */

function startOffline() {
  setNav({});
  act = () => {};
  parts.body.append(el('div', 'br-live', el('div', 'br-status', el('div', 'br-card',
    ico('globe', 22),
    el('b', '', 'The browser is in J.A.R.V.I.S. on your Mac'),
    el('p', '', `Websites can’t be shown inside this page, so Eden uses the built-in browser of J.A.R.V.I.S., the Mac app: here, a live view of it. ${state.jarvis.reason ? `Right now: ${String(state.jarvis.reason).replace(/\.+$/, '')}.` : 'No Mac is linked or online.'}`),
    el('div', 'br-acts',
      el('a', { class: 'btn primary', href: `${DOWNLOAD}/download` }, 'Get J.A.R.V.I.S.'),
      el('a', { class: 'btn', href: `${DOWNLOAD}/link` }, ico('lock', 13), 'Link this Mac'))))));
  return () => {};
}
