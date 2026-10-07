// The browser panel (the globe at the right end of the title bar, ⌘⇧B, "Browser" in ⌘K): docked
// beside the conversation, as the canvas is; full screen with a close button on a phone. Open or
// closed is remembered per viewer (browser-model.js has the logic, its tests the rules).
//
// In the J.A.R.V.I.S. app's Ask Eden window it IS Jarvis's built-in browser: the app draws the
// tab on show in the panel's slot (its tabs, adblock and gates), and this page draws the tabs,
// the address bar and the buttons from the state the app sends.
//
// Anywhere else it's Eden's cloud browser: a real Chrome on Cloudflare, one per account (the
// server's browser/session.js), as J.A.R.V.I.S.'s browser looks and works: tabs, the address bar
// with suggestions from history and bookmarks, back, forward, reload and stop, the loading bar,
// ad and tracker blocking with its count, bookmarks and history, find in page, zoom, downloads
// (offered as a link), Ask Eden about the page, and open in your own browser. The page is a live
// picture (JPEG frames over a WebSocket, drawn on a canvas); clicks, scrolling and keys go back.
// What pages say is data: shown as pictures, and as text only when the viewer hands it to chat.

import { $, el, ico, toast, isMobile, isTouch, copyText } from './util.js';
import { API_BASE, isMock } from './api.js';
import { openMenu } from './composer.js';
import { IN_APP, openAppBrowser } from './native.js';
import {
  appBridge, paneMode, wasOpen, keepOpen, typed, shownUrl, isSecure, siteOf, socketUrl, reconnectDelay,
  pointerMsg, wheelMsg, touchScroll, TAP_SLOP, shortcut, keyMsg, downloadName, zoomLabel, blockedLabel,
  densityOf, viewSize, frameBox, mergeWheel, flingVelocity, flingStep, pinchZoom, omnibox, cursorCss, iconSrc, progressAt,
} from './browser-model.js';

const H = { openSpace: null, addContext: null, sendMessage: null, focusComposer: null, openPalette: null }; // app.js hands these over
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const ENGINES = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing', brave: 'Brave', kagi: 'Kagi' };
let pane = null; // the section, made on first open
let mode = '';
let bridge = null;
let stopMode = () => {};

const local = () => { try { return localStorage; } catch { return null; } };

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
  // In the Eden app the app's own browser opens instead (never on its own at load: quiet).
  if (on && !browserOpen() && (quiet ? IN_APP : openAppBrowser())) return;
  if (on === browserOpen()) { if (on && !quiet) focusAddress(); return; }
  document.body.classList.toggle('browser-open', on);
  const btn = $('btnBrowser');
  if (btn) btn.setAttribute('aria-pressed', String(on));
  keepOpen(local(), on);
  if (on) { build(); start(); if (!quiet) focusAddress(); } else stop();
}
export function closeBrowser() { if (!browserOpen()) return false; toggleBrowser(false); const b = $('btnBrowser'); if (b) b.focus(); return true; }

/** Kept for app.js: the panel no longer depends on the Mac. */
export function browserJarvisChanged() {}

/* ---------- the panel's frame (J.A.R.V.I.S.'s browser: tabs, then the bar) ---------- */

const P = {};
function build() {
  if (pane) return;
  const back = iconBtn('chevl', 'Back · ⌘[', () => act('back'));
  const fwd = iconBtn('chevr', 'Forward · ⌘]', () => act('forward'));
  const reload = iconBtn('retry', 'Reload · ⌘R', () => act(P.loading ? 'stop' : 'reload'));
  const addr = el('input', { type: 'text', class: 'br-url', id: 'brUrl', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go', placeholder: 'Search or enter address', 'aria-label': 'Address', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'brSuggest' });
  const site = el('button', { type: 'button', class: 'bd-lock', title: 'Site settings', 'aria-label': 'Site settings', onclick: (e) => siteMenu(e.currentTarget) }, ico('lock', 12));
  const shield = el('button', { type: 'button', class: 'bd-shield', hidden: true, title: 'Ad and tracker blocking', 'aria-pressed': 'true', onclick: () => act('shield') }, el('span', 'bd-shield-ico', ico('shield', 13)), el('span', 'bd-blocked', ''));
  const star = el('button', { type: 'button', class: 'bd-star', hidden: true, title: 'Bookmark this page · ⌘D', 'aria-label': 'Bookmark this page', 'aria-pressed': 'false', onclick: () => act('bookmark') }, '☆');
  const suggest = el('ul', { class: 'bd-suggest', id: 'brSuggest', role: 'listbox', hidden: true });
  const form = el('form', { class: 'bd-url', role: 'search', onsubmit: (e) => { e.preventDefault(); go(addr.value); } }, site, addr, shield, star);
  addr.addEventListener('focus', () => { addr.value = P.url || addr.value; addr.select(); });
  addr.addEventListener('blur', () => { setTimeout(() => hideSuggest(), 150); addr.value = barText(P.url); });
  addr.addEventListener('input', () => suggestNow());
  addr.addEventListener('keydown', onAddrKey);
  const zoom = el('button', { type: 'button', class: 'bd-zoom', hidden: true, title: 'Reset zoom · ⌘0', onclick: () => act('zoom', 0) }, '');
  const ai = el('button', { type: 'button', class: 'bd-ask', title: 'Ask Eden about this page', 'aria-haspopup': 'menu', onclick: (e) => aiMenu(e.currentTarget) }, ico('spark', 14), el('span', 'bd-ask-t', 'Ask Eden'));
  const wide = iconBtn('expand', 'Wide · ⌘⇧E', () => toggleWide());
  const lib = iconBtn('list', 'Bookmarks and history · ⌘Y', () => act('library', 'bookmarks'));
  const more = iconBtn('more', 'More', (e) => moreMenu(e.currentTarget));
  more.setAttribute('aria-haspopup', 'menu');
  const progress = el('div', { class: 'bd-progress', hidden: true }, el('i', ''));
  const close = el('button', { type: 'button', class: 'iconbtn br-close', title: 'Close browser · ⌘⇧B', 'aria-label': 'Close browser', onclick: () => closeBrowser() }, ico('x', 15));
  const tabs = el('div', { class: 'bd-tabs', role: 'tablist', 'aria-label': 'Tabs' });
  const strip = el('div', 'bd-strip', tabs, wide, close);
  const findIn = el('input', { type: 'search', class: 'bd-find-input', placeholder: 'Find in page', 'aria-label': 'Find in page', maxlength: '200' });
  const findCount = el('span', 'bd-find-count', '');
  const find = el('div', { class: 'bd-find', hidden: true, role: 'search' }, findIn, findCount,
    iconBtn('chevl', 'Previous match', () => act('find', { q: findIn.value, dir: -1 }), 'rot'),
    iconBtn('chevr', 'Next match', () => act('find', { q: findIn.value, dir: 1 }), 'rot'),
    el('button', { type: 'button', class: 'bd-find-done', onclick: () => closeFind() }, 'Done'));
  let findT = 0;
  findIn.addEventListener('input', () => { clearTimeout(findT); findT = setTimeout(() => act('find', { q: findIn.value, dir: 1, fresh: true }), 160); });
  findIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); act('find', { q: findIn.value, dir: e.shiftKey ? -1 : 1 }); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); } });
  const slot = el('div', { class: 'browser-slot', 'aria-label': 'Page' });
  const downloads = el('ul', { class: 'bd-downloads', hidden: true, 'aria-label': 'Downloads' });
  pane = el('section', { id: 'browserPane', class: 'glass', 'aria-label': 'Browser' },
    strip,
    el('div', 'browser-bar', back, fwd, reload, form, zoom, ai, lib, more, progress),
    suggest, find, slot, downloads);
  Object.assign(P, { back, fwd, reload, addr, site, shield, star, suggest, zoom, ai, lib, more, progress, tabs, find, findIn, findCount, slot, downloads, wide, url: '', loading: false });
  $('split').append(pane);
}
/** Wide: the panel over the whole window (and on request truly full screen, where ⌘T and ⌘W reach it too). */
function toggleWide(on = !pane.classList.contains('full')) {
  pane.classList.toggle('full', on);
  P.wide.replaceChildren(ico(on ? 'collapse' : 'expand', 15));
  P.wide.title = on ? 'Back to the side · ⌘⇧E' : 'Wide · ⌘⇧E';
  P.wide.setAttribute('aria-pressed', String(on));
  if (!on && document.fullscreenElement === pane) document.exitFullscreen().catch(() => {});
}
async function fullScreen() {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    toggleWide(true);
    await pane.requestFullscreen({ navigationUI: 'hide' });
    // In full screen Chrome lets a page have ⌘T, ⌘W and ⌘N: the cloud browser's tabs get them.
    if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock(['KeyT', 'KeyW', 'KeyN', 'KeyL', 'KeyR', 'Escape']).catch(() => {});
  } catch { toast('Full screen isn’t available here'); }
}
function iconBtn(icon, label, run, cls = '') {
  return el('button', { type: 'button', class: `bd-icon ${cls}`.trim(), title: label, 'aria-label': label.replace(/ · .*$/, ''), onclick: run }, ico(icon, 15));
}
function focusAddress() { if (!isMobile()) requestAnimationFrame(() => { if (P.addr && !P.addr.disabled) P.addr.focus(); }); }

function setNav({ back = false, fwd = false, reload = false, addr = true } = {}) {
  P.back.disabled = !back;
  P.fwd.disabled = !fwd;
  P.reload.disabled = !reload;
  P.addr.disabled = !addr;
}
/** The bar at rest shows the site (as Safari does); the whole address once it has the focus. */
const barText = (url) => siteOf(url) || shownUrl(url) || url || '';
let optimistic = 0;
function setUrl(url) {
  P.url = url || '';
  P.site.classList.toggle('secure', isSecure(url));
  P.site.hidden = !url;
  if (document.activeElement !== P.addr) P.addr.value = barText(url);
}
let loadT0 = 0, loadRaf = 0, loadDone = 0;
function setLoading(on) {
  on = !!on;
  if (on !== P.loading) {
    const bar = P.progress.firstChild;
    cancelAnimationFrame(loadRaf); clearTimeout(loadDone);
    if (on) {
      loadT0 = performance.now();
      P.progress.hidden = false; P.progress.classList.remove('done');
      const step = () => { bar.style.transform = `scaleX(${progressAt(performance.now() - loadT0)})`; loadRaf = requestAnimationFrame(step); };
      step();
    } else if (!P.progress.hidden) {
      bar.style.transform = 'scaleX(1)';
      P.progress.classList.add('done');
      loadDone = setTimeout(() => { P.progress.hidden = true; P.progress.classList.remove('done'); bar.style.transform = 'scaleX(0)'; }, 380);
    }
  }
  P.loading = on;
  P.reload.replaceChildren(ico(on ? 'x' : 'retry', 15));
  P.reload.title = on ? 'Stop' : 'Reload · ⌘R';
  P.reload.setAttribute('aria-label', on ? 'Stop' : 'Reload');
}
function setShield({ ready, on, blocked }) {
  P.shield.hidden = !ready;
  P.shield.setAttribute('aria-pressed', String(!!on));
  P.shield.classList.toggle('off', !on);
  P.shield.title = on ? `Blocking ads and trackers${blocked ? `: ${blocked} on this page` : ''}. Click to turn off for this site.` : 'Ad and tracker blocking is off here. Click to turn on.';
  P.shield.lastElementChild.textContent = on ? blockedLabel(blocked) : '';
}
function drawTabs(list, onSelect, onClose, onNew) {
  P.tabs.replaceChildren(...list.map((t) => el('div', { class: `bd-tab${t.active ? ' active' : ''}${t.loading ? ' loading' : ''}`, role: 'presentation' },
    el('button', { type: 'button', class: 'bd-tab-b', role: 'tab', 'aria-selected': String(!!t.active), title: String(t.title || t.url || 'New tab'), onclick: () => onSelect(t.id) },
      t.loading ? el('span', 'act-spin', '') : iconSrc(t.icon) ? el('img', { class: 'bd-fav', src: iconSrc(t.icon), alt: '', width: '14', height: '14', draggable: 'false' }) : ico('globe', 12), el('span', 'bd-tab-title', String(t.title || shownUrl(t.url) || 'New tab'))),
    el('button', { type: 'button', class: 'bd-tab-x', 'aria-label': `Close ${String(t.title || 'tab')}`, onclick: () => onClose(t.id) }, ico('x', 10)))),
  el('button', { type: 'button', class: 'bd-tab-new', title: 'New tab · ⌘T', 'aria-label': 'New tab', onclick: onNew }, ico('plus', 13)));
  const on = P.tabs.querySelector('.bd-tab.active');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function start() {
  mode = paneMode({ bridge });
  pane.dataset.mode = mode;
  P.slot.replaceChildren();
  P.downloads.replaceChildren();
  P.downloads.hidden = true;
  P.ai.hidden = mode === 'app';
  P.lib.hidden = mode === 'app';
  P.star.hidden = true;
  P.zoom.hidden = true;
  setShield({ ready: false });
  setLoading(false);
  setUrl('');
  stopMode = mode === 'app' ? startApp() : startCloud();
}
function stop() { stopMode(); stopMode = () => {}; closeFind(); hideSuggest(); }

function go(text) {
  const t = typed(text);
  if (!t.ok) { if (t.why === 'scheme') toast('Only web addresses (http or https)'); return; }
  P.addr.blur();
  hideSuggest();
  act('go', t.value);
}
let act = () => {};

/* ---------- the address bar's suggestions ---------- */

let sugRows = [];
let sugI = -1;
function showSuggest(rows) {
  const guess = omnibox(P.addr.value);
  const engine = ENGINES[(cloud.state && cloud.state.engine) || 'google'] || 'Google';
  const first = guess ? [{ kind: 'go', url: guess.kind === 'url' ? guess.url : guess.q, title: guess.kind === 'url' ? guess.label : `${guess.label}`, note: guess.kind === 'url' ? 'Open' : `Search ${engine}`, search: guess.kind === 'search' }] : [];
  sugRows = [...first, ...(rows || []).filter((r) => !guess || r.url !== guess.url).slice(0, 7)];
  sugI = guess ? 0 : -1;
  if (!sugRows.length || document.activeElement !== P.addr) { hideSuggest(); return; }
  P.suggest.replaceChildren(...sugRows.map((r, i) => el('li', { role: 'option', id: `brSug${i}`, class: `bd-sug ${r.kind}${i === sugI ? ' on' : ''}`, onmousedown: (e) => { e.preventDefault(); pick(r); } },
    el('span', 'bd-sug-k', r.kind === 'go' ? ico(r.search ? 'search' : 'globe', 13) : r.kind === 'tab' ? 'Tab' : r.kind === 'bookmark' ? '★' : ico('clock', 12)),
    el('span', 'bd-sug-t', r.title || shownUrl(r.url)), el('span', 'bd-sug-u', r.kind === 'go' ? r.note : shownUrl(r.url)))));
  P.suggest.hidden = false;
  P.addr.setAttribute('aria-expanded', 'true');
}
function hideSuggest() { if (!P.suggest) return; P.suggest.hidden = true; sugRows = []; P.addr.setAttribute('aria-expanded', 'false'); P.addr.removeAttribute('aria-activedescendant'); }
function pick(r) { hideSuggest(); P.addr.blur(); if (r.kind === 'tab' && r.tab) act('tab', { op: 'select', id: r.tab }); else act('go', r.url); }
function suggestNow() {
  if (!P.addr.value.trim()) { hideSuggest(); return; }
  showSuggest(sugRows.filter((r) => r.kind !== 'go')); // the first row at once, the rest when the server answers
  act('suggest', P.addr.value);
}
function onAddrKey(e) {
  if (!P.suggest.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    if (e.key === 'ArrowDown') sugI = sugI + 1 >= sugRows.length ? 0 : sugI + 1;
    else sugI = sugI - 1 < 0 ? sugRows.length - 1 : sugI - 1;
    [...P.suggest.children].forEach((li, i) => li.classList.toggle('on', i === sugI));
    if (sugI >= 0) { P.addr.setAttribute('aria-activedescendant', `brSug${sugI}`); } else P.addr.removeAttribute('aria-activedescendant');
    return;
  }
  if (e.key === 'Enter' && sugI >= 0 && sugRows[sugI]) { e.preventDefault(); pick(sugRows[sugI]); return; }
  if (e.key === 'Escape') {
    e.stopPropagation();
    if (!P.suggest.hidden) { hideSuggest(); return; }
    P.addr.value = barText(P.url);
    P.addr.blur();
  }
}

/* ---------- find in page ---------- */

function openFind() {
  P.find.hidden = false;
  P.findIn.focus();
  P.findIn.select();
  if (P.findIn.value) act('find', { q: P.findIn.value, dir: 1, fresh: true });
}
function closeFind() {
  if (!P.find || P.find.hidden) return;
  P.find.hidden = true;
  P.findCount.textContent = '';
  act('find', { q: '', dir: 1 });
}

/* ---------- menus ---------- */

function moreMenu(anchor) {
  const s = cloud.state || {};
  const page = Boolean(s.url);
  openMenu(anchor, [
    { label: 'New tab', key: '⌘T', run: () => act('tab', { op: 'new' }) },
    { label: 'Find in page…', key: '⌘F', disabled: !page, run: openFind },
    { label: 'Zoom in', key: '⌘+', disabled: !page, run: () => act('zoom', 1) },
    { label: 'Zoom out', key: '⌘−', disabled: !page, run: () => act('zoom', -1) },
    { label: 'Actual size', key: '⌘0', disabled: !page || s.zoom === 1, run: () => act('zoom', 0) },
    '-',
    { label: 'Bookmarks', run: () => act('library', 'bookmarks') },
    { label: 'History', key: '⌘Y', run: () => act('library', 'history') },
    '-',
    { label: 'Copy address', disabled: !page, run: () => copyText(s.url) },
    { label: 'Open in your browser', disabled: !page, run: () => openOutside(s.url) },
    { label: pane.classList.contains('full') ? 'Back to the side' : 'Wide', key: '⌘⇧E', run: () => toggleWide() },
    { label: document.fullscreenElement ? 'Exit full screen' : 'Full screen', note: document.fullscreenElement ? '' : '⌘T and ⌘W work here too', disabled: !pane.requestFullscreen || isMobile(), run: () => fullScreen() },
    { label: 'Clear browsing data…', run: () => clearData() },
    '-',
    { label: 'Block ads and trackers', switch: s.adblock !== false, run: () => cloud.send({ t: 'adblock', on: s.adblock === false }) },
    { label: `Search with ${ENGINES[s.engine] || 'Google'}`, sub: () => Object.entries(ENGINES).map(([id, name]) => ({ label: name, checked: (s.engine || 'google') === id, run: () => cloud.send({ t: 'engine', id }) })) },
    '-',
    { label: 'Close the cloud browser', disabled: !s.running, run: () => cloud.send({ t: 'end' }) },
    { label: 'A browser in the cloud, for you only', note: Number.isFinite(s.minutesLeft) ? `${s.minutesLeft} browser minutes left this month` : '', disabled: true },
  ]);
}
function siteMenu(anchor) {
  const s = cloud.state || {};
  if (mode === 'app' || !s.url) return;
  const site = siteOf(s.url);
  openMenu(anchor, [
    { heading: site },
    { label: isSecure(s.url) ? 'Connection is secure' : 'Connection isn’t secure', note: isSecure(s.url) ? 'https' : 'http: what you send can be read on the way', disabled: true },
    { label: 'Block ads and trackers here', switch: s.siteAdblock !== false, disabled: s.adblock === false, run: () => cloud.send({ t: 'adblock', site: true, on: s.siteAdblock === false }) },
    { label: 'Camera, microphone, location, notifications: off', note: 'The cloud browser isn’t on your device, so sites can’t ask for them', disabled: true },
    { label: 'Open in your browser', run: () => openOutside(s.url) },
  ]);
}
function aiMenu(anchor) {
  const s = cloud.state || {};
  openMenu(anchor, [
    { label: 'Ask about this page', note: 'The page’s text goes with your next message', disabled: !s.url, run: () => cloud.send({ t: 'pagetext', for: 'ask' }) },
    { label: 'Summarize this page', disabled: !s.url, run: () => cloud.send({ t: 'pagetext', for: 'summarize' }) },
    { label: 'Use the selected text', disabled: !s.url, run: () => { cloud.wantSelection = true; cloud.send({ t: 'copy' }); } },
    { label: 'Do this on a website…', note: 'J.A.R.V.I.S.’s browser agent, on your Mac', run: () => { if (H.openSpace) H.openSpace('web', { url: s.url }); } },
  ]);
}
function clearData() {
  openMenu(P.more, [
    { heading: 'Clear browsing data' },
    { label: 'History', run: () => cloud.send({ t: 'history-clear' }) },
    { label: 'Close the browser (cookies, sign-ins, tabs)', note: 'Each cloud browser starts fresh', disabled: !(cloud.state && cloud.state.running), run: () => cloud.send({ t: 'end' }) },
  ]);
}
function openOutside(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return;
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (w) w.opener = null;
}

/* ---------- in the J.A.R.V.I.S. app: Jarvis's own browser in the slot ---------- */

function startApp() {
  const slot = el('div', { class: 'br-slot', 'aria-label': 'Page' }, el('span', 'br-slot-note', 'The page shows here when nothing of Eden’s is over it.'));
  P.slot.append(slot);
  setNav({ addr: true, reload: true });
  act = (action, arg) => {
    if (['go', 'back', 'forward', 'reload', 'stop'].includes(action)) bridge.nav(action, typeof arg === 'string' ? arg : '');
    else if (action === 'shield' && bridge.shields) bridge.shields();
    else if (action === 'tab') bridge.tab(arg.op, arg.id);
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
  setLoading(!!s.loading);
  const sh = s.shields || {};
  setShield({ ready: sh.ready, on: sh.on, blocked: sh.blocked });
  const list = Array.isArray(s.tabs) ? s.tabs.slice(0, 30) : [];
  drawTabs(list, (id) => bridge.tab('select', id), (id) => bridge.tab('close', id), () => bridge.tab('new'));
}

/* ---------- anywhere else: Eden's cloud browser ---------- */

const cloud = { ws: null, state: null, send: () => {}, wantSelection: false };

function startCloud() {
  let alive = true, attempt = 0, retry = 0, gone = '';
  const canvas = el('canvas', { class: 'bd-page', tabindex: '-1', 'aria-label': 'The page (a live picture of the cloud browser)' });
  const sink = el('textarea', { class: 'bd-keys', 'aria-label': 'Type into the page', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', rows: '1' });
  const cover = el('div', { class: 'bd-cover', 'aria-live': 'polite' });
  const kbd = el('button', { type: 'button', class: 'bd-kbd', hidden: true, title: 'Keyboard', 'aria-label': 'Show the keyboard', onclick: () => sink.focus() }, '⌨︎');
  const ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const banner = el('div', { class: 'bd-banner', hidden: true, role: 'status' });
  P.slot.append(canvas, sink, cover, banner, kbd);
  setNav({ addr: true });
  const box = () => viewSize(P.slot.getBoundingClientRect(), densityOf(window), isTouch());
  let shownDpr = densityOf(window);

  const send = (m) => { if (cloud.ws && cloud.ws.readyState === 1) { cloud.ws.send(JSON.stringify(m)); return true; } return false; };
  cloud.send = send;

  const card = (title, text, ...buttons) => cover.replaceChildren(el('div', 'br-card', ico('globe', 22), el('b', '', title), text ? el('p', '', text) : null, buttons.length ? el('div', 'br-acts', ...buttons) : null));
  const btn = (label, run, primary = false) => el('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, onclick: run }, label);
  const tile = (b) => el('button', { type: 'button', class: 'bd-ntp-mark', title: b.url, onclick: () => act('go', b.url) },
    el('span', 'bd-ntp-i', iconSrc(b.icon) ? el('img', { src: iconSrc(b.icon), alt: '', width: '22', height: '22', draggable: 'false' }) : ((b.title || siteOf(b.url)).trim()[0] || '•').toUpperCase()),
    el('span', '', b.title || siteOf(b.url)));
  const newTabPage = (s) => {
    const marks = (s.bookmarks || []).slice(0, 8);
    const recent = (s.recent || []).filter((r) => !marks.some((b) => siteOf(b.url) === r.site)).slice(0, 8);
    const ntpQ = el('input', { type: 'search', class: 'bd-ntp-q', placeholder: `Search ${ENGINES[s.engine] || 'Google'} or type an address`, 'aria-label': 'Search or enter address', enterkeyhint: 'go', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    ntpQ.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(ntpQ.value); } });
    ntpQ.addEventListener('input', () => { if (!s.running) prewarm(); });
    cover.replaceChildren(el('div', 'bd-ntp',
      el('div', 'bd-ntp-orb', ico('globe', 26)),
      ntpQ,
      marks.length ? el('div', 'bd-ntp-sec', el('h3', '', 'Bookmarks'), el('div', 'bd-ntp-marks', ...marks.map(tile))) : null,
      recent.length ? el('div', 'bd-ntp-sec', el('h3', '', 'Recent'), el('div', 'bd-ntp-marks', ...recent.map(tile))) : null,
      el('p', 'bd-ntp-note', `A private browser in the cloud, ads and trackers blocked.${Number.isFinite(s.minutesLeft) ? ` ${s.minutesLeft} browser minutes left this month.` : ''}`)));
    if (!isTouch()) requestAnimationFrame(() => { if (document.activeElement !== P.addr) ntpQ.focus({ preventScroll: true }); });
  };
  const failPage = (f) => cover.replaceChildren(el('div', 'br-card bd-fail',
    el('div', 'bd-fail-ico', ico('globe', 24)), el('b', '', f.title || 'Couldn’t open that page'), el('p', '', f.text || ''),
    el('p', 'bd-fail-u', `${siteOf(f.url) || ''}${f.code ? ` · ${f.code}` : ''}`),
    el('div', 'br-acts', btn('Try again', () => act('go', f.url), true), btn('Open in my browser', () => openOutside(f.url)))));
  let warm = false;
  const prewarm = () => { if (!warm && cloud.state && !cloud.state.running) { warm = true; send({ t: 'start' }); } };
  let ntpKey = '';

  const draw = (s) => {
    cloud.state = s;
    const tab = (s.tabs || []).find((t) => t.id === s.active);
    setUrl(s.url || '');
    setNav({ back: s.canBack, fwd: s.canForward, reload: Boolean(s.url) });
    setLoading(s.loading);
    setShield({ ready: Boolean(s.url), on: s.adblock && s.siteAdblock, blocked: s.blocked });
    P.star.hidden = !s.url;
    P.star.textContent = s.bookmarked ? '★' : '☆';
    P.star.setAttribute('aria-pressed', String(!!s.bookmarked));
    P.star.classList.toggle('on', !!s.bookmarked);
    const z = zoomLabel(s.zoom);
    P.zoom.hidden = !z;
    P.zoom.textContent = z;
    const tabList = (s.tabs || []).length ? s.tabs.map((t) => ({ ...t, active: t.id === s.active })) : [{ id: '', title: 'New tab', active: true }];
    drawTabs(tabList, (id) => { if (id) send({ t: 'tab', op: 'select', id }); }, (id) => { if (id) send({ t: 'tab', op: 'close', id }); }, () => act('tab', { op: 'new' }));
    if (!s.running) warm = false;
    canvas.hidden = !tab || !tab.url || Boolean(s.failed);
    if (s.minutesLeft === 0 && !s.running) { ntpKey = ''; card('No browser minutes left this month', s.plus ? 'They come back on the 1st.' : 'They come back on the 1st, or get more with Eden Plus.'); }
    else if (s.failed) { ntpKey = ''; failPage(s.failed); }
    else if (!tab || !tab.url) {
      // Drawn again only when what it shows changed (typing in its box survives state updates).
      const key = JSON.stringify([s.running, s.engine, s.minutesLeft, (s.bookmarks || []).map((b) => [b.url, !!b.icon]), (s.recent || []).map((r) => [r.url, !!r.icon])]);
      if (key !== ntpKey || !cover.querySelector('.bd-ntp')) { ntpKey = key; newTabPage(s); }
    } else { ntpKey = ''; if (!cover.querySelector('.bd-dialog')) cover.replaceChildren(); }
    banner.hidden = !s.wall || canvas.hidden;
    if (!banner.hidden) banner.replaceChildren(ico('shield', 14), el('span', '', `${siteOf(s.url)} may turn away cloud browsers.`), el('button', { type: 'button', class: 'cap', onclick: () => openOutside(s.url) }, 'Open in my browser'));
    kbd.hidden = !isTouch() || canvas.hidden;
  };

  // The picture: frames decode as they come and the newest is drawn on the next paint (each
  // acked once drawn, so the server sends no more than the viewer can show). A frame is drawn at
  // its own pixels (2x on Retina), sized to the CSS pixels it was made for: never stretched.
  let next = null, paintRaf = 0, decoding = Promise.resolve();
  const paint = () => {
    paintRaf = 0;
    const bmp = next; next = null;
    if (!bmp) return;
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
    const fb = frameBox(bmp.width, bmp.height, shownDpr);
    canvas.style.width = `${fb.width}px`; canvas.style.height = `${fb.height}px`;
    ctx2d.drawImage(bmp, 0, 0);
    bmp.close();
  };
  const frame = (buf) => {
    decoding = decoding.then(async () => {
      try {
        const bmp = await createImageBitmap(new Blob([buf]));
        if (next) next.close();
        next = bmp;
        if (!paintRaf) paintRaf = requestAnimationFrame(paint);
      } catch { /* a bad frame: the next one comes */ }
      send({ t: 'ack' });
    });
  };

  const onMsg = (ev) => {
    if (typeof ev.data !== 'string') { frame(ev.data); return; }
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.t) {
      case 'state': draw(m); break;
      case 'cursor': if (!touch) canvas.style.cursor = cursorCss(m.c); break;
      case 'hit': if (hitWait && hitWait.id === m.id) { hitWait.done(m); hitWait = null; } break;
      case 'suggest': if (document.activeElement === P.addr && m.q === P.addr.value) showSuggest(m.rows); break;
      case 'find': P.findCount.textContent = m.q ? (m.n ? `${m.i} of ${m.n}${m.n >= 1000 ? '+' : ''}` : 'No matches') : ''; break;
      case 'error': toast(String(m.message || 'That didn’t work.')); break;
      case 'closed': if (m.message) toast(String(m.message)); break;
      case 'replaced': gone = 'replaced'; card('Open in another tab', 'Your cloud browser is showing in another Eden window or tab.', btn('Use it here', () => { gone = ''; attempt = 0; connect(); }, true)); break;
      case 'copied':
        if (cloud.wantSelection) {
          cloud.wantSelection = false;
          if (H.addContext && m.text) H.addContext({ title: `From ${siteOf(cloud.state && cloud.state.url) || 'the page'}`.slice(0, 70), text: String(m.text) });
        } else if (m.text) copyText(String(m.text));
        break;
      case 'pagetext': pageToChat(m); break;
      case 'download': addDownload(m); break;
      case 'dialog': showDialog(m); break;
      case 'library': showLibrary(m); break;
      default:
    }
  };

  const pageToChat = (m) => {
    if (m.error) { toast(m.error); return; }
    const block = { title: `Page: ${m.title || siteOf(m.url)}`.slice(0, 80), text: `${m.title || ''}\n${m.url}\n\n${m.text || ''}`.trim() };
    if (m.for === 'summarize' && H.sendMessage) { H.sendMessage(`Summarize this page: ${m.title || m.url}`, [], { context: [block] }); return; }
    if (H.addContext) H.addContext(block);
    if (H.focusComposer) H.focusComposer();
  };

  const addDownload = (m) => {
    const name = downloadName(m.name, m.url);
    const li = el('li', 'bd-dl', ico('down', 13), el('span', 'bd-dl-n', name),
      el('a', { class: 'cap', href: m.url, target: '_blank', rel: 'noopener noreferrer', download: name }, 'Download'),
      el('button', { type: 'button', class: 'bd-tab-x', 'aria-label': 'Dismiss', onclick: () => { li.remove(); P.downloads.hidden = !P.downloads.children.length; } }, ico('x', 10)));
    P.downloads.prepend(li);
    while (P.downloads.children.length > 10) P.downloads.lastChild.remove();
    P.downloads.hidden = false;
    toast(`“${name}” is ready to download`);
  };

  const showDialog = (m) => {
    const old = cover.querySelector('.bd-dialog');
    if (m.done) { if (old) old.remove(); return; }
    const input = m.kind === 'prompt' ? el('input', { type: 'text', class: 'bd-dialog-in', value: m.value || '' }) : null;
    const answer = (ok) => { send({ t: 'dialog', ok, ...(input ? { text: input.value } : {}) }); box2.remove(); };
    const box2 = el('div', { class: 'bd-dialog', role: 'alertdialog', 'aria-label': `${m.site} says` },
      el('b', '', `${m.site || 'This page'} says`), el('p', '', String(m.message || '')), input,
      el('div', 'br-acts', m.kind === 'alert' ? null : btn('Cancel', () => answer(false)), btn('OK', () => answer(true), true)));
    if (old) old.remove();
    cover.append(box2);
    (input || box2.querySelector('.btn.primary')).focus();
  };

  const showLibrary = (m) => {
    const what = m.what === 'history' ? 'history' : 'bookmarks';
    const q = el('input', { type: 'search', class: 'bd-lib-q', placeholder: `Search ${what}`, value: m.q || '' });
    let t = 0;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => send({ t: 'library', what, q: q.value }), 150); });
    const seg = el('div', 'bd-lib-seg', ...['bookmarks', 'history'].map((w) => el('button', { type: 'button', class: w === what ? 'on' : '', 'aria-pressed': String(w === what), onclick: () => send({ t: 'library', what: w }) }, w === 'history' ? 'History' : 'Bookmarks')));
    const rows = (m.rows || []).map((r) => el('li', 'bd-lib-row',
      el('button', { type: 'button', class: 'bd-lib-go', title: r.url, onclick: () => { lib.remove(); send({ t: 'go', url: r.url }); } }, el('span', 'bd-sug-t', r.title || shownUrl(r.url)), el('span', 'bd-sug-u', shownUrl(r.url))),
      el('button', { type: 'button', class: 'bd-tab-x', 'aria-label': 'Remove', onclick: () => send({ t: 'library-remove', what, url: r.url, q: q.value }) }, ico('x', 10))));
    const lib = el('div', { class: 'bd-lib', role: 'dialog', 'aria-label': what === 'history' ? 'History' : 'Bookmarks' },
      el('div', 'bd-lib-head', seg, el('span', 'br-sp'), what === 'history' && rows.length ? el('button', { type: 'button', class: 'cap', onclick: () => send({ t: 'history-clear' }) }, 'Clear history') : null, el('button', { type: 'button', class: 'bd-icon', 'aria-label': 'Close', onclick: () => lib.remove() }, ico('x', 13))),
      q, rows.length ? el('ul', 'bd-lib-list', ...rows) : el('p', 'bd-lib-empty', what === 'history' ? 'No pages visited yet.' : 'No bookmarks yet: the star in the address bar adds one.'));
    const old = P.slot.querySelector('.bd-lib');
    if (old) old.remove();
    P.slot.append(lib);
    if (!m.q) q.focus();
  };

  act = (action, arg) => {
    switch (action) {
      case 'go':
        setLoading(true); // at once; the server's state takes over (or, if it never says so, it stops)
        clearTimeout(optimistic);
        optimistic = setTimeout(() => { if (!(cloud.state && cloud.state.loading)) setLoading(false); }, 4000);
        if (!send({ t: 'go', url: arg })) { setLoading(false); toast('The browser isn’t connected yet'); }
        break;
      case 'back': case 'forward': case 'reload': case 'stop': send({ t: action }); break;
      case 'shield': if (cloud.state && cloud.state.adblock === false) send({ t: 'adblock', on: true }); else send({ t: 'adblock', site: true, on: !(cloud.state && cloud.state.siteAdblock) }); break;
      case 'bookmark': send({ t: 'bookmark' }); break;
      case 'suggest': send({ t: 'suggest', q: String(arg || '') }); break;
      case 'tab': send({ t: 'tab', ...arg }); if (arg.op === 'new') focusAddress(); break;
      case 'zoom': send({ t: 'zoom', dir: arg }); break;
      case 'find': send({ t: 'find', q: arg.q, dir: arg.dir }); break;
      case 'library': send({ t: 'library', what: arg }); break;
      default:
    }
  };

  // ── the viewer's mouse, touch and keys ──
  // Clicks and keys go at once; moves and wheel turns are merged into one per frame (wheel
  // deltas added up, so nothing of a trackpad's scroll is lost); touch scrolls follow the finger
  // and fling on with momentum; two fingers zoom; a long press is a right-click.
  const rectOf = () => canvas.getBoundingClientRect();
  let raf = 0, lastMove = null, wheel = null, touch = null, fling = 0, pinch = null, hitWait = null, hitSeq = 0;
  const flush = () => {
    raf = 0;
    if (lastMove) { send(pointerMsg('move', lastMove, rectOf())); lastMove = null; }
    if (wheel) { send(wheel); wheel = null; }
  };
  const soon = () => { if (!raf) raf = requestAnimationFrame(flush); };
  const now = () => { if (raf) { cancelAnimationFrame(raf); flush(); } };
  const focusPage = () => { if (!isTouch()) sink.focus({ preventScroll: true }); };
  const stopFling = () => { if (fling) { cancelAnimationFrame(fling); fling = 0; } };
  const pointers = new Map();
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      stopFling();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        clearTimeout(touch && touch.long);
        touch = null;
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: (cloud.state && cloud.state.zoom) || 1, now: 0 };
        return;
      }
      touch = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, trail: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
      touch.long = setTimeout(() => { if (touch && !touch.moved) { touch.held = true; contextAt(touch.sx, touch.sy); } }, 520);
      return;
    }
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    focusPage();
    now();
    if (e.button === 2) return; // the menu is Eden's (contextmenu below)
    send(pointerMsg('down', e, rectOf()));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        pinch.now = pinchZoom(pinch.z, pinch.d, Math.hypot(a.x - b.x, a.y - b.y));
        canvas.style.transformOrigin = `${(a.x + b.x) / 2 - rectOf().left}px ${(a.y + b.y) / 2 - rectOf().top}px`;
        canvas.style.transform = `scale(${pinch.now / pinch.z})`;
        return;
      }
      if (!touch) return;
      touch.trail.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      if (touch.trail.length > 12) touch.trail.shift();
      if (!touch.moved && Math.hypot(e.clientX - touch.sx, e.clientY - touch.sy) < TAP_SLOP) return;
      touch.moved = true;
      clearTimeout(touch.long);
      const r = rectOf();
      wheel = mergeWheel(wheel, touchScroll(e.clientX - touch.x, e.clientY - touch.y, { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) }));
      soon();
      touch.x = e.clientX; touch.y = e.clientY;
      return;
    }
    lastMove = e;
    soon();
  });
  const endTouch = (e) => {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (!pointers.size) {
        const z = pinch.now;
        pinch = null;
        canvas.style.transform = '';
        if (z && Math.abs(z - ((cloud.state && cloud.state.zoom) || 1)) > 0.04) send({ t: 'zoom', to: z });
      }
      return;
    }
    if (!touch) return;
    clearTimeout(touch.long);
    const t = touch;
    touch = null;
    if (t.held) return;
    const r = rectOf();
    if (!t.moved) { send(pointerMsg('down', e, r, { b: 0, n: 1 })); send(pointerMsg('up', e, r, { b: 0, n: 1 })); return; }
    // Let go while moving: the page keeps going and slows, as on iOS.
    let v = flingVelocity(t.trail, e.timeStamp);
    let at = performance.now();
    const at0 = { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
    const step = (ts) => {
      const st = flingStep(v, Math.min(48, ts - at));
      at = ts;
      if (!st) { fling = 0; return; }
      v = st.v;
      wheel = mergeWheel(wheel, touchScroll(st.dx, st.dy, at0));
      flush();
      fling = requestAnimationFrame(step);
    };
    if (Math.hypot(v.vx, v.vy) > 0.25) fling = requestAnimationFrame(step);
  };
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') { endTouch(e); return; }
    now();
    if (e.button === 2) return;
    send(pointerMsg('up', e, rectOf()));
  });
  canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); if (touch) clearTimeout(touch.long); touch = null; pinch = null; canvas.style.transform = ''; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) { // a trackpad pinch: zoom the page
      pinchWheel += e.deltaY;
      clearTimeout(pinchWheelT);
      pinchWheelT = setTimeout(() => { const z = pinchZoom((cloud.state && cloud.state.zoom) || 1, 100, 100 - pinchWheel); pinchWheel = 0; send({ t: 'zoom', to: z }); }, 120);
      return;
    }
    wheel = mergeWheel(wheel, wheelMsg(e, rectOf()));
    soon();
  }, { passive: false });
  let pinchWheel = 0, pinchWheelT = 0;

  // Right-click (or a long press): Eden's menu, for what's under the pointer in the page.
  const contextAt = async (cx, cy) => {
    const r = rectOf();
    const x = Math.round(cx - r.left), y = Math.round(cy - r.top);
    const id = ++hitSeq;
    if (hitWait) hitWait.done({});
    const hit = cloud.state && cloud.state.url ? await new Promise((done) => { hitWait = { id, done }; send({ t: 'hit', id, x, y }); setTimeout(() => { if (hitWait && hitWait.id === id) { hitWait = null; done({}); } }, 900); }) : {};
    if (id !== hitSeq) return;
    const spot = el('div', { class: 'bd-spot', style: `left:${cx}px;top:${cy}px` });
    document.body.append(spot);
    const s = cloud.state || {};
    openMenu(spot, [
      hit.link ? { label: 'Open link in new tab', run: () => send({ t: 'tab', op: 'new', url: hit.link }) } : null,
      hit.link ? { label: 'Open link in my browser', run: () => openOutside(hit.link) } : null,
      hit.link ? { label: 'Copy link', run: () => copyText(hit.link) } : null,
      hit.image ? { label: 'Open image in new tab', run: () => send({ t: 'tab', op: 'new', url: hit.image }) } : null,
      hit.image ? { label: 'Copy image address', run: () => copyText(hit.image) } : null,
      hit.selection ? { label: 'Copy', key: '⌘C', run: () => copyText(hit.selection) } : null,
      hit.selection ? { label: 'Ask Eden about the selection', run: () => { if (H.addContext) H.addContext({ title: `From ${siteOf(s.url) || 'the page'}`.slice(0, 70), text: hit.selection }); if (H.focusComposer) H.focusComposer(); } } : null,
      hit.editable ? { label: 'Paste', key: '⌘V', run: async () => { try { const t = await navigator.clipboard.readText(); if (t) send({ t: 'text', text: t }); } catch { toast('Press ⌘V to paste'); } } } : null,
      (hit.link || hit.image || hit.selection || hit.editable) ? '-' : null,
      { label: 'Back', key: '⌘[', disabled: !s.canBack, run: () => send({ t: 'back' }) },
      { label: 'Forward', key: '⌘]', disabled: !s.canForward, run: () => send({ t: 'forward' }) },
      { label: 'Reload', key: '⌘R', run: () => send({ t: 'reload' }) },
      '-',
      { label: 'Copy page address', disabled: !s.url, run: () => copyText(s.url) },
      { label: 'Ask Eden about this page', disabled: !s.url, run: () => send({ t: 'pagetext', for: 'ask' }) },
    ], { noFocus: isTouch() });
    setTimeout(() => spot.remove(), 0);
  };
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (e.pointerType === 'touch' || isTouch() && !e.button) return; contextAt(e.clientX, e.clientY); });

  sink.addEventListener('keydown', (e) => {
    now(); // moves before a key, in order
    const sc = shortcut(e, MAC);
    if (sc) { e.preventDefault(); e.stopPropagation(); runShortcut(sc); return; }
    const k = keyMsg(e, 'down');
    if (k === 'paste' || k === null) { e.stopPropagation(); return; } // text and pastes arrive as input
    e.preventDefault();
    e.stopPropagation();
    send(k);
  });
  sink.addEventListener('keyup', (e) => { const k = keyMsg(e, 'up'); if (k && k !== 'paste') { e.preventDefault(); send(k); } e.stopPropagation(); });
  let composing = false;
  sink.addEventListener('compositionstart', () => { composing = true; });
  sink.addEventListener('compositionend', () => { composing = false; if (sink.value) { send({ t: 'text', text: sink.value }); sink.value = ''; } });
  sink.addEventListener('input', () => { if (composing) return; if (sink.value) { send({ t: 'text', text: sink.value }); sink.value = ''; } });
  sink.addEventListener('paste', (e) => { const t = e.clipboardData && e.clipboardData.getData('text/plain'); e.preventDefault(); if (t) send({ t: 'text', text: t }); });

  // Shortcuts while the address bar or the panel has the keys, too.
  const paneKeys = (e) => {
    if (e.target === sink) return;
    const sc = shortcut(e, MAC);
    if (!sc || sc === 'palette') return;
    if (['address', 'newtab', 'closetab', 'reload', 'back', 'forward', 'find', 'bookmark', 'history', 'zoomin', 'zoomout', 'zoomreset', 'nexttab', 'prevtab', 'wide'].includes(sc) || /^tab\d$/.test(sc)) {
      if (e.target === P.addr && ['back', 'forward'].includes(sc)) return;
      e.preventDefault(); e.stopPropagation(); runShortcut(sc);
    }
  };
  pane.addEventListener('keydown', paneKeys);
  const runShortcut = (sc) => {
    const s = cloud.state || {};
    const tabs = s.tabs || [];
    const at = tabs.findIndex((t) => t.id === s.active);
    switch (sc) {
      case 'address': P.addr.focus(); P.addr.select(); break;
      case 'newtab': act('tab', { op: 'new' }); break;
      case 'closetab': if (s.active) send({ t: 'tab', op: 'close', id: s.active }); break;
      case 'reload': send({ t: 'reload' }); break;
      case 'back': case 'forward': send({ t: sc }); break;
      case 'find': openFind(); break;
      case 'bookmark': send({ t: 'bookmark' }); break;
      case 'history': send({ t: 'library', what: 'history' }); break;
      case 'zoomin': send({ t: 'zoom', dir: 1 }); break;
      case 'zoomout': send({ t: 'zoom', dir: -1 }); break;
      case 'zoomreset': send({ t: 'zoom', dir: 0 }); break;
      case 'wide': toggleWide(); break;
      case 'nexttab': case 'prevtab': if (tabs.length > 1) send({ t: 'tab', op: 'select', id: tabs[(at + (sc === 'nexttab' ? 1 : -1) + tabs.length) % tabs.length].id }); break;
      case 'closepanel': closeBrowser(); break;
      case 'palette': if (H.openPalette) H.openPalette(); break;
      default: {
        const n = Number(sc.slice(3));
        const t = n === 9 ? tabs.at(-1) : tabs[n - 1];
        if (t) send({ t: 'tab', op: 'select', id: t.id });
      }
    }
  };

  // ── size: the cloud browser's viewport is the panel's, at the screen's density ──
  let sizeT = 0;
  const resized = () => { clearTimeout(sizeT); sizeT = setTimeout(() => { shownDpr = densityOf(window); send({ t: 'resize', ...box() }); }, 90); };
  const ro = new ResizeObserver(resized);
  ro.observe(P.slot);
  let dprMq = matchMedia(`(resolution: ${densityOf(window)}dppx)`);
  const dprChanged = () => { resized(); dprMq.removeEventListener('change', dprChanged); dprMq = matchMedia(`(resolution: ${densityOf(window)}dppx)`); dprMq.addEventListener('change', dprChanged); };
  dprMq.addEventListener('change', dprChanged);

  // ── warm: while the panel is open and looked at, the cloud browser isn't closed for idling ──
  let touched = Date.now();
  const mark = () => { touched = Date.now(); };
  pane.addEventListener('pointerdown', mark, true);
  pane.addEventListener('keydown', mark, true);
  const ping = setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - touched < 20 * 60000 && cloud.state && cloud.state.running) send({ t: 'ping' }); }, 60000);

  // ── the socket ──
  const connect = () => {
    clearTimeout(retry);
    if (!alive) return;
    let ws;
    try {
      ws = isMock ? new MockSocket() : new WebSocket(socketUrl(API_BASE, location.href));
    } catch { card('The cloud browser isn’t available here', 'It runs on askeden.com.'); return; }
    ws.binaryType = 'arraybuffer';
    cloud.ws = ws;
    let opened = false;
    ws.onopen = () => { opened = true; attempt = 0; shownDpr = densityOf(window); send({ t: 'hello', ...box() }); };
    ws.onmessage = (ev) => { if (cloud.ws === ws) onMsg(ev); };
    ws.onclose = () => {
      if (cloud.ws !== ws) return;
      cloud.ws = null;
      if (!alive || gone) return;
      if (!opened && attempt >= 2) { card('Can’t reach the cloud browser', navigator.onLine === false ? 'You’re offline.' : 'Sign in to Eden on askeden.com to use it, or try again in a minute.', btn('Try again', () => { attempt = 0; connect(); }, true)); return; }
      const ms = reconnectDelay(attempt++);
      if (ms) retry = setTimeout(connect, ms);
    };
  };
  card('Connecting…', '');
  connect();
  const vis = () => { if (document.visibilityState === 'visible' && !cloud.ws && alive && !gone) { attempt = 0; connect(); } };
  document.addEventListener('visibilitychange', vis);

  return () => {
    alive = false;
    clearTimeout(retry); clearTimeout(sizeT); clearInterval(ping); stopFling();
    ro.disconnect();
    dprMq.removeEventListener('change', dprChanged);
    pane.removeEventListener('pointerdown', mark, true);
    pane.removeEventListener('keydown', mark, true);
    pane.removeEventListener('keydown', paneKeys);
    document.removeEventListener('visibilitychange', vis);
    if (cloud.ws) { const w = cloud.ws; cloud.ws = null; try { w.close(1000, 'panel closed'); } catch { /* gone */ } }
    cloud.state = null;
    cloud.send = () => {};
  };
}

/* ---------- mock mode (?mock=1): a pretend cloud browser in the page, for the tour and tests ---------- */

class MockSocket {
  constructor() {
    this.readyState = 0;
    this.s = { running: false, tabs: [], active: '', url: '', title: '', loading: false, canBack: false, canForward: false, zoom: 1, blocked: 0, adblock: true, siteAdblock: true, bookmarked: false, bookmarks: [{ url: 'https://en.wikipedia.org/', title: 'Wikipedia' }], engine: 'google', minutesLeft: 60 };
    this.n = 0; this.size = { w: 800, h: 600 }; this.hist = [];
    setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 120);
  }
  close() { this.readyState = 3; }
  emit(m) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: typeof m === 'string' || m instanceof ArrayBuffer ? m : JSON.stringify(m) }); }
  tab() { return this.s.tabs.find((t) => t.id === this.s.active); }
  state() { const t = this.tab(); Object.assign(this.s, { url: t ? t.url : '', title: t ? t.title : '', canBack: Boolean(t && t.i > 0) }); this.emit({ t: 'state', ...this.s }); }
  async paint() {
    const t = this.tab();
    if (!t || !t.url) return;
    const { w, h, dpr = 1 } = this.size;
    const c = new OffscreenCanvas(Math.round(w * dpr), Math.round(h * dpr));
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f3f5'; g.fillRect(0, 0, w, 56);
    g.fillStyle = '#1d1d1f'; g.font = '600 18px -apple-system, Helvetica'; g.fillText(t.title, 20, 35);
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 3 ? '#d6d9df' : '#1a0dab'; g.fillRect(20, 90 + i * 34, (w - 40) * (i % 3 ? 0.9 - i * 0.04 : 0.5), i % 3 ? 10 : 14); }
    g.fillStyle = '#888'; g.font = '12px -apple-system, Helvetica'; g.fillText(`A pretend page (mock mode) · ${t.url}`, 20, h - 20);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    this.emit(await blob.arrayBuffer());
  }
  open(url) {
    let t = this.tab();
    if (!t) { t = { id: `t${++this.n}`, url: '', title: '', i: -1 }; this.s.tabs.push(t); this.s.active = t.id; }
    if (url) {
      const u = /^https?:\/\//.test(url) ? url : /\s/.test(url) || !/\./.test(url) ? `https://www.google.com/search?q=${encodeURIComponent(url)}` : `https://${url}`;
      Object.assign(t, { url: u, title: (() => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } })(), i: t.i + 1 });
      this.hist.unshift({ url: u, title: t.title });
      this.s.blocked = 3;
    }
    this.state();
    this.paint();
  }
  send(text) {
    const m = JSON.parse(text);
    switch (m.t) {
      case 'hello': case 'resize': this.size = { w: m.w, h: m.h, dpr: m.dpr }; this.state(); this.paint(); break;
      case 'hit': this.emit({ t: 'hit', id: m.id, link: 'https://en.wikipedia.org/wiki/Web_browser', image: '', selection: '', editable: false }); break;
      case 'mouse': if (m.e === 'move') this.emit({ t: 'cursor', c: m.y > 90 && m.y < 110 ? 'pointer' : 'default' }); break;
      case 'start': this.s.running = true; this.open(''); break;
      case 'go': this.s.running = true; this.open(m.url); break;
      case 'tab':
        if (m.op === 'new') { this.s.running = true; const t = { id: `t${++this.n}`, url: '', title: '', i: -1 }; this.s.tabs.push(t); this.s.active = t.id; }
        if (m.op === 'select') this.s.active = m.id;
        if (m.op === 'close') { this.s.tabs = this.s.tabs.filter((t) => t.id !== m.id); if (this.s.active === m.id) this.s.active = (this.s.tabs.at(-1) || {}).id || ''; }
        this.state(); this.paint(); break;
      case 'bookmark': { const t = this.tab(); if (!t) break; this.s.bookmarked = !this.s.bookmarked; this.s.bookmarks = this.s.bookmarked ? [{ url: t.url, title: t.title }, ...this.s.bookmarks] : this.s.bookmarks.filter((b) => b.url !== t.url); this.state(); break; }
      case 'zoom': this.s.zoom = m.to ? m.to : m.dir === 0 ? 1 : Math.round(this.s.zoom * (m.dir > 0 ? 1.1 : 1 / 1.1) * 100) / 100; this.state(); break;
      case 'adblock': if (m.site) this.s.siteAdblock = m.on; else this.s.adblock = m.on; this.state(); break;
      case 'engine': this.s.engine = m.id; this.state(); break;
      case 'suggest': this.emit({ t: 'suggest', q: m.q, rows: [...this.s.bookmarks.map((b) => ({ ...b, kind: 'bookmark' })), ...this.hist.map((h) => ({ ...h, kind: 'history' }))].filter((r) => m.q && (r.url + r.title).toLowerCase().includes(m.q.toLowerCase())).slice(0, 8) }); break;
      case 'find': this.emit({ t: 'find', q: m.q, n: m.q ? 4 : 0, i: 1 }); break;
      case 'library': this.emit({ t: 'library', what: m.what, q: m.q || '', rows: m.what === 'history' ? this.hist : this.s.bookmarks }); break;
      case 'history-clear': this.hist = []; this.emit({ t: 'library', what: 'history', rows: [] }); break;
      case 'pagetext': { const t = this.tab(); this.emit({ t: 'pagetext', url: t && t.url, title: t && t.title, text: 'A pretend page’s words (mock mode).', for: m.for }); break; }
      case 'copy': this.emit({ t: 'copied', text: 'selected words' }); break;
      case 'end': this.s = { ...this.s, running: false, tabs: [], active: '' }; this.state(); break;
      default:
    }
  }
}
