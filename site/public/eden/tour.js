// The try-it tour (ROADMAP I1): a welcome sheet with the chapters, then one feature at a time
// with a spotlight and a glass callout that asks the person to do it, notices when they have
// (tour-steps.js checks, tour-model.js detector), shows a check and moves on. It runs in
// practice mode (practice.js: sample data, the mock, nothing leaves the page) and keeps its
// progress in the real localStorage (eden:tour), so it can be left and picked up again.
//
// On the real page: the welcome opens on a first visit (not on dev pages or in the iPhone
// app, whose own welcome hands off here), "Take the tour" is in ⌘K and Settings › About, and
// "What's this?" on each feature's sheet opens its chapter. Starting goes to the practice
// address; leaving comes back to the real page, untouched.

import { state } from './state.js';
import { $, el, ico, toast, isMobile } from './util.js';
import { setComposerText, addFile, clearAttachments, setMode, renderAttachments } from './composer.js';
import { setOverride } from './router.js';
import { closeArtifact } from './artifact.js';
import { closeSpace } from './panels.js';
import { closeCalendar, calendarOpen } from './calendar.js';
import { closeBrief, briefOpen } from './brief.js';
import { closeMemory, memoryOpen } from './memory.js';
import { closeTasks, tasksOpen } from './tasks.js';
import { closeWorkflows, workflowsOpen } from './workflows.js';
import { openAccount, closeAccount, accountOpen } from './account.js';
import { closePane } from './files.js';
import { IN_APP } from './native.js';
import { CHAPTERS, STEPS, WHATS_THIS, stepsOf } from './tour-steps.js';
import * as M from './tour-model.js';
import { PRACTICE, realStorage, practiceUrl, leavePractice, resetPractice } from './practice.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = () => realStorage();
const load = () => M.loadProgress(store());
const save = (p) => M.saveProgress(store(), p);
const params = new URLSearchParams(location.search);

/* ---------------- the helpers a step's start() uses ---------------- */

const isOpen = (id, cls = 'open') => { const n = $(id); return !!n && n.classList.contains(cls); };
const A = {
  newChat: () => { const b = $('btnNew'); if (b) b.click(); },
  openInspector: (tab) => dispatchEvent(new CustomEvent('eden:open-inspector', { detail: { tab } })),
  closeInspector: () => { const i = $('inspector'); if (i && (i.classList.contains('open') || !i.classList.contains('closed'))) $('btnInspClose').click(); },
  expandComposer: () => { const o = $('jc-orb'); if (o && o.getAttribute('aria-expanded') !== 'true') o.click(); },
  resetModel: () => { try { setOverride(null); } catch { /* not ready */ } },
  prefill: (text) => setComposerText(text),
  chatMode: () => { if (!state.current || state.current.kind !== 'code') { try { setMode('chat'); } catch { /* not ready */ } } },
  clearComposer: () => setComposerText(''),
  clearAttachments: () => clearAttachments(),
  clearContext: () => { state.draftContext = []; renderAttachments(); },
  closeArtifact: () => closeArtifact(),
  closeDialog: () => { if (isOpen('dlg')) $('btnDlgClose').click(); },
  closeSettings: () => { if (isOpen('settingsSheet')) $('btnSetClose').click(); },
  closePalette: () => { const p = $('palette'); if (p) p.classList.remove('open'); },
  openSidebar: () => { if (isMobile() && !isOpen('sidebar')) $('btnHamburger').click(); },
  calWeek: () => { const b = document.querySelector(`.cal-seg [data-view="${isMobile() ? 'day' : 'week'}"]`); if (b && !b.classList.contains('on')) b.click(); },
  /** Opens a saved chat that has a finished reply, unless this one has one. */
  ensureReply: () => {
    if (document.querySelector('.msg.assistant .msg-acts')) return;
    const c = state.convs.find((x) => !x.temp && x.kind !== 'code' && Object.values(x.nodes || {}).some((n) => n.role === 'assistant' && !n.streaming));
    if (!c) return;
    const b = [...document.querySelectorAll('#sideScroll .sitem')].find((x) => x.title === c.title);
    if (b) b.click();
  },
  closePopovers: () => { for (const id of ['spendPop', 'costPop', 'chipPop']) { const n = $(id); if (n) n.classList.remove('show'); } },
  openAccount: () => { try { if (!accountOpen()) openAccount(); } catch { /* not here */ } },
  /** Closes every sheet, panel and page the earlier steps opened. */
  closeSurfaces: () => {
    A.closePalette(); A.closeDialog(); A.closeSettings();
    A.closePopovers();
    try { closeSpace(); } catch { /* none */ }
    try { if (calendarOpen()) closeCalendar(); } catch { /* none */ }
    try { if (briefOpen()) closeBrief(); } catch { /* none */ }
    try { if (memoryOpen()) closeMemory(); } catch { /* none */ }
    try { if (tasksOpen()) closeTasks(); } catch { /* none */ }
    try { if (workflowsOpen()) closeWorkflows(); } catch { /* none */ }
    try { if (accountOpen()) closeAccount(); } catch { /* none */ }
    try { closePane(); } catch { /* none */ }
    if (isMobile()) { const s = $('sidebar'); if (s) s.classList.remove('open'); const sc = $('scrim'); if (sc) sc.classList.remove('on'); }
  },
};

/* ---------------- the real page: what's available, and going into practice ---------------- */

/** This page's address, to come back to (without the tour's own parameters). */
function hereUrl() {
  const u = new URL(location.href);
  for (const k of ['tour', 'step', 'practice']) u.searchParams.delete(k);
  return `${u.pathname}${u.search}`;
}

function realCtx() {
  const acct = $('btnAccount');
  return { hosted: !!(state.meta && state.meta.hosted), mac: !!(state.jarvis && state.jarvis.available), signedIn: !!(acct && !acct.hidden), inApp: IN_APP };
}

/** Into practice mode at `step` (or where the tour was). `fresh`: start over with new sample data. */
function enterPractice({ step = null, fresh = false } = {}) {
  if (state.streams && state.streams.size) { toast('Wait for the reply to finish (or stop it), then start the tour.'); return; }
  let p = load();
  if (fresh) { p = { ...M.newProgress(), seen: true }; resetPractice(); }
  p = { ...p, seen: true, optOut: false, active: true, step: step || p.step, ctx: PRACTICE ? p.ctx : realCtx(), returnTo: PRACTICE ? p.returnTo : hereUrl() };
  save(p);
  if (PRACTICE) { closeSheet(); runFrom(step ? STEPS.find((s) => s.id === step) : M.resumeStep(STEPS, p)); return; }
  location.assign(practiceUrl({ step: p.step }));
}

/* ---------------- the welcome sheet (chapters) ---------------- */

let sheetEl = null;
let sheetReturn = null;
function closeSheet() {
  if (!sheetEl) return;
  sheetEl.remove();
  sheetEl = null;
  document.documentElement.classList.remove('tour-sheet-on');
  if (sheetReturn && document.contains(sheetReturn)) sheetReturn.focus();
}
function openSheet(card, label) {
  closeSheet();
  sheetReturn = document.activeElement;
  sheetEl = el('div', { class: 'tour-scrim tour-ui', role: 'presentation' }, card);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', label);
  sheetEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(); if (PRACTICE && cur) focusCard(); return; }
    if (e.key !== 'Tab') return;
    const f = [...card.querySelectorAll('button:not([disabled]), [href], input')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  });
  document.body.append(sheetEl);
  document.documentElement.classList.add('tour-sheet-on');
  requestAnimationFrame(() => { const f = card.querySelector('.tour-primary') || card.querySelector('button'); if (f) f.focus({ preventScroll: true }); card.scrollTop = 0; });
}

/** The welcome: what the tour is, its chapters with minutes and progress, Start or Resume. */
export function openWelcome({ chapter = null } = {}) {
  const p = load();
  const chapters = M.chapterStatus(CHAPTERS, STEPS, p);
  const total = chapters.reduce((m, c) => m + c.minutes, 0);
  const started = p.done.length + p.skipped.length > 0;
  const ctx = PRACTICE ? p.ctx : realCtx();
  const chList = el('ul', { class: 'tour-chapters', role: 'list' }, ...chapters.map((c) => {
    const here = stepsOf(c.id).map((s) => M.unavailableReason(s, ctx)).find(Boolean);
    const pct = c.total ? Math.round(((c.done + c.skipped) / c.total) * 100) : 0;
    const b = el('button', { type: 'button', class: `tour-ch${c.id === chapter ? ' sel' : ''}${c.complete ? ' complete' : ''}`, 'data-ch': c.id,
      'aria-label': `${c.title}: ${c.total} steps, about ${c.minutes} minute${c.minutes === 1 ? '' : 's'}${c.complete ? ', done' : c.done ? `, ${c.done} done` : ''}${here ? '. Practice version here' : ''}`,
      onclick: () => enterPractice({ step: (stepsOf(c.id).find((s) => !p.done.includes(s.id)) || stepsOf(c.id)[0]).id }) },
    el('span', 'tour-ch-ic', ico(c.icon, 18)),
    el('span', 'tour-ch-t', el('b', '', c.title), el('span', '', c.blurb), here ? el('span', 'tour-tag', 'Practice version here') : null),
    el('span', 'tour-ch-meta', c.complete ? el('span', 'tour-ch-done', ico('check', 14)) : el('span', { class: 'tour-ring', style: { '--p': pct } }), `${c.minutes} min`));
    return el('li', '', b);
  }));
  const primary = el('button', { type: 'button', class: 'btn primary tour-primary', onclick: () => enterPractice({ step: chapter ? (stepsOf(chapter).find((s) => !p.done.includes(s.id)) || stepsOf(chapter)[0]).id : null }) },
    chapter ? `Try ${CHAPTERS.find((c) => c.id === chapter).title}` : started ? 'Resume the tour' : 'Start the tour');
  const card = el('section', { class: 'tour-welcome glass' },
    el('div', 'tour-hero', el('div', { class: 'orb tour-orb', 'aria-hidden': 'true' }),
      el('h2', { id: 'tourWelcomeT' }, started ? 'Welcome back' : 'Try Eden'),
      el('p', '', 'A hands-on tour: each step shows you a feature, then you try it. It runs in practice mode, with sample chats, mail and calendars. Nothing is sent anywhere, and your own chats and settings stay exactly as they are.')),
    el('div', 'tour-sub', el('span', '', `${STEPS.length} steps in ${CHAPTERS.length} chapters · about ${total} minutes`), started ? el('span', '', `${M.percent(STEPS, p)}% done`) : null),
    chList,
    el('div', 'tour-foot',
      el('button', { type: 'button', class: 'btn', onclick: () => {
        if (PRACTICE) { closeSheet(); if (cur) focusCard(); else confirmLeave(); return; }
        save({ ...load(), seen: true, optOut: true, active: false }); closeSheet();
        toast('No tour for now. It’s in ⌘K › Take the tour whenever you like.');
      } }, PRACTICE ? 'Close' : 'Not now'),
      started && !PRACTICE ? el('button', { type: 'button', class: 'btn', onclick: () => enterPractice({ fresh: true }) }, 'Start over') : null,
      el('span', 'grow'),
      primary));
  openSheet(card, 'tourWelcomeT');
  if (chapter) requestAnimationFrame(() => { const s = card.querySelector('.tour-ch.sel'); if (s) s.scrollIntoView({ block: 'nearest' }); });
}

/** ⌘K › Take the tour, Settings › About, /tour. */
export function startTour(opts = {}) { openWelcome(opts); }

/* ---------------- practice: the badge ---------------- */

function badge() {
  const b = el('div', { class: 'tour-badge tour-ui', role: 'status' },
    el('span', 'tour-badge-dot', ''),
    el('b', '', 'Practice'),
    el('span', 'tour-badge-sub', 'Sample data · nothing leaves this page'),
    el('button', { type: 'button', class: 'tour-badge-btn', onclick: () => openWelcome() }, 'Chapters'),
    el('button', { type: 'button', class: 'tour-badge-btn', onclick: () => confirmLeave() }, 'Leave'));
  document.body.append(b);
}

function confirmLeave() {
  const p = load();
  const card = el('section', { class: 'tour-welcome tour-small glass' },
    el('h2', { id: 'tourLeaveT' }, 'Leave the tour?'),
    el('p', '', `You’re ${M.percent(STEPS, p)}% through. Your progress is kept: pick it up any time from ⌘K › Take the tour. The sample data goes, and your own chats and settings are just as you left them.`),
    el('div', 'tour-foot', el('button', { type: 'button', class: 'btn tour-primary', onclick: () => { closeSheet(); if (cur) focusCard(); } }, 'Keep going'), el('span', 'grow'),
      el('button', { type: 'button', class: 'btn primary', onclick: leave }, 'Leave')));
  openSheet(card, 'tourLeaveT');
}
function leave() {
  stopDetect();
  const p = load();
  save({ ...p, active: false });
  leavePractice({ to: p.returnTo });
}

/* ---------------- practice: the spotlight and the callout ---------------- */

let layer = null; // { root, hole, card, … }
let cur = null; // the step on screen
let ok = false; // its check passed
let events = [];
let base = {};
let simulated = false;
let ready = false; // the step's "before" is measured: checks may run
const live = () => $('tourLive');

function announce(text) {
  const n = live();
  if (!n) return;
  n.textContent = '';
  setTimeout(() => { n.textContent = text; }, 60);
}

function buildLayer() {
  const hole = el('div', { class: 'tour-hole', 'aria-hidden': 'true' });
  const title = el('h2', { id: 'tourTitle', tabindex: '-1' });
  const chap = el('span', 'tour-chap');
  const bar = el('i');
  const body = el('p', 'tour-body');
  const avail = el('p', { class: 'tour-avail', hidden: true });
  const tryTxt = el('span', 'tour-try-t');
  const tryRow = el('div', 'tour-try', el('span', { class: 'tour-try-ic', 'aria-hidden': 'true' }, el('i')), el('b', '', 'Try it'), tryTxt);
  const extra = el('div', 'tour-extra');
  const okRow = el('div', { class: 'tour-ok', hidden: true },
    el('span', { class: 'tour-check', 'aria-hidden': 'true' }, (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); const pth = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pth.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5'); s.append(pth); return s; })()),
    el('span', 'tour-ok-t'));
  const show = el('button', { type: 'button', class: 'cap', onclick: () => { const t = target(); if (t) { t.scrollIntoView({ block: 'nearest' }); (t.matches('button, input, textarea, select, a, [tabindex]') ? t : t.querySelector('button, input, textarea, select, a, [tabindex]') || t).focus(); } else toast('It isn’t on screen yet: follow the steps above.'); } }, 'Go there');
  const skip = el('button', { type: 'button', class: 'cap', onclick: () => skipStep() }, 'Skip');
  const back = el('button', { type: 'button', class: 'cap', onclick: () => prevStep() }, 'Back');
  const min = el('button', { type: 'button', class: 'iconbtn tour-min', 'aria-label': 'Make the tour card smaller', 'aria-expanded': 'true', onclick: () => setMin(!card.classList.contains('min')) }, ico('chevd', 15));
  const close = el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Leave the tour', onclick: () => confirmLeave() }, ico('x', 15));
  const card = el('section', { class: 'tour-card glass tour-ui', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tourTitle', 'aria-describedby': 'tourDesc' },
    el('div', 'tour-top', chap, el('span', 'grow'), min, close),
    el('div', { class: 'tour-bar', 'aria-hidden': 'true' }, bar),
    title, el('div', { id: 'tourDesc' }, body, avail), tryRow, extra, okRow,
    el('div', 'tour-acts', el('button', { type: 'button', class: 'cap', onclick: () => openWelcome() }, 'Chapters'), back, el('span', 'grow'), show, skip));
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setMin(true); } });
  const root = el('div', { class: 'tour-layer' }, hole, card);
  document.body.append(root);
  layer = { root, hole, card, title, chap, bar, body, avail, tryRow, tryTxt, extra, okRow, back };
}

function setMin(on) {
  layer.card.classList.toggle('min', on);
  layer.card.querySelector('.tour-min').setAttribute('aria-expanded', String(!on));
  layer.card.querySelector('.tour-min').setAttribute('aria-label', on ? 'Show the tour card' : 'Make the tour card smaller');
  place();
}
function focusCard() { if (layer) { setMin(false); layer.title.focus(); } }

/** The step's target on screen: the first of its selectors that's visible. */
function target() {
  if (!cur) return null;
  const sels = [...[].concat(cur.target || [])];
  if (cur.side && isMobile() && !isOpen('sidebar')) sels.push('#btnHamburger');
  for (const s of sels) {
    let partial = null;
    for (const n of document.querySelectorAll(s)) {
      if (n.closest('.tour-ui')) continue;
      const r = n.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0) || getComputedStyle(n).visibility === 'hidden') continue;
      if (r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth) return n; // wholly on screen: the best
      if (!partial && r.bottom > 0 && r.top < innerHeight) partial = n;
    }
    if (partial) return partial;
  }
  return null;
}

let lastRect = '';
// what the callout must not cover besides the target: menus and popovers the step opens
const AVOID = ['#jc-attach:not([hidden])', '#jc-queue:not([hidden])', '#jc-estimate', '#jc-menu:not([hidden])', '#jc-submenu:not([hidden])', '#chipPop.show', '#costPop.show', '#spendPop.show', '#cc-slash:not([hidden])', '#citePop.open', '.cw-pop:not([hidden])', '.cw-sug:not([hidden])', '.cal-colors', '.sheet.open > .sheet-card', '#palette.open .pal-box', '#macPane.open', '#spacePanel.open'];
function avoidRects() {
  const out = [];
  for (const s of AVOID) for (const n of document.querySelectorAll(s)) { const r = n.getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push(r); }
  return out;
}
function place() {
  if (!layer || !cur) return;
  const t = target();
  const { hole, card } = layer;
  const r = t ? t.getBoundingClientRect() : null;
  const avoid = avoidRects();
  const key = [r ? `${r.left | 0},${r.top | 0},${r.width | 0},${r.height | 0}` : 'none', innerWidth, innerHeight, card.classList.contains('min'), ok, ...avoid.map((a) => `${a.left | 0},${a.top | 0},${a.width | 0}`)].join('|');
  if (key === lastRect) return;
  lastRect = key;
  const big = r && r.width * r.height > innerWidth * innerHeight * 0.55;
  hole.hidden = !r;
  hole.classList.toggle('nodim', !!big || ok);
  if (r) {
    const pad = 6;
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  }
  // a phone: a sheet at the bottom, or at the top when the target (or a menu it opened) is down there
  if (isMobile()) {
    const ref = r || avoid[0];
    const low = !!ref && ref.top + ref.height / 2 > innerHeight * 0.5;
    card.classList.add('sheet-mode');
    card.classList.toggle('at-top', !!low);
    Object.assign(card.style, { left: '', top: '', right: '', bottom: '' });
    // a menu the step opened reaches under the sheet: the sheet folds down to its "Try it" line
    card.classList.remove('squeeze');
    const cr = card.getBoundingClientRect();
    card.classList.toggle('squeeze', avoid.some((a) => a.left < cr.right && a.right > cr.left && a.top < cr.bottom && a.bottom > cr.top));
    return;
  }
  card.classList.remove('sheet-mode', 'at-top');
  const cw = card.offsetWidth || 360;
  const ch = card.offsetHeight || 220;
  const m = 14;
  const top0 = 52; // under practice mode's badge
  const spots = [];
  if (r) {
    spots.push([r.left + r.width / 2 - cw / 2, r.bottom + m], [r.left + r.width / 2 - cw / 2, r.top - m - ch], [r.right + m, r.top + r.height / 2 - ch / 2], [r.left - m - cw, r.top + r.height / 2 - ch / 2]);
  }
  spots.push([innerWidth - cw - 24, innerHeight - ch - 24], [innerWidth - cw - 24, top0], [24, top0], [24, innerHeight - ch - 24]);
  const box = $('deck-composer'); // where the person types: never under the callout
  // the dialog the target sits in (a review sheet, a popover), unless it fills the screen
  const dlg = t && t.parentElement && t.parentElement.closest('[role="dialog"], [role="alertdialog"], .sheet-card');
  const dr = dlg ? dlg.getBoundingClientRect() : null;
  const keep = [r, ...avoid, box && box.offsetParent ? box.getBoundingClientRect() : null, dr && dr.width * dr.height < innerWidth * innerHeight * 0.5 ? dr : null].filter(Boolean);
  const fit = ([x, y]) => {
    const cx = Math.max(12, Math.min(innerWidth - cw - 12, x));
    const cy = Math.max(top0, Math.min(innerHeight - ch - 12, y));
    const box = { left: cx, top: cy, right: cx + cw, bottom: cy + ch };
    // how much of what matters it would cover (the target counts double)
    const cover = keep.reduce((n, k, i) => n + Math.max(0, Math.min(box.right, k.right) - Math.max(box.left, k.left)) * Math.max(0, Math.min(box.bottom, k.bottom) - Math.max(box.top, k.top)) * (i === 0 && r ? 2 : 1), 0);
    return { cx, cy, cover };
  };
  const all = spots.map(fit);
  const best = all.find((s) => s.cover === 0) || all.reduce((a, b) => (b.cover < a.cover ? b : a));
  Object.assign(card.style, { left: `${best.cx}px`, top: `${best.cy}px`, right: 'auto', bottom: 'auto' });
}

function paintStep(step) {
  const p = load();
  const pos = M.position(STEPS, step.id);
  const ch = CHAPTERS.find((c) => c.id === step.chapter);
  const { card, title, chap, bar, body, avail, tryTxt, extra, okRow, back } = layer;
  card.classList.remove('ok');
  card.classList.add('enter');
  setTimeout(() => card.classList.remove('enter'), 400);
  chap.replaceChildren(ico(ch.icon, 13), `${ch.title} · ${pos.inChapter + 1} of ${pos.chapterTotal}`);
  bar.style.width = `${M.percent(STEPS, p)}%`;
  title.textContent = step.title;
  body.textContent = step.body;
  const why = M.unavailableReason(step, p.ctx);
  avail.hidden = !why;
  avail.replaceChildren(...(why ? [el('b', '', 'In your Eden: '), why, ' This is the practice version, with sample data.'] : []));
  tryTxt.textContent = step.tryIt;
  layer.tryRow.hidden = false;
  okRow.hidden = true;
  back.disabled = pos.index === 0;
  extra.replaceChildren();
  if (step.sample) extra.append(el('button', { type: 'button', class: 'cap primary', onclick: () => useSample(step.sample) }, ico('doc', 13), 'Use a sample file'));
  lastRect = '';
  place();
  layer.root.dataset.step = step.id;
  document.documentElement.dataset.tourStep = step.id; // tour.css: the tasks' floating approval waits for its own step
}

/* ---------------- running a step ---------------- */

let runToken = 0;
async function runFrom(step) {
  if (!step) { finale(); return; }
  const token = ++runToken;
  cur = step; ok = false; events = []; base = {}; simulated = false; ready = false;
  save({ ...load(), active: true, step: step.id });
  if (!layer) buildLayer();
  setMin(false);
  paintStep(step);
  try { if (step.start) step.start(A); } catch { /* the step still runs */ }
  await sleep(260);
  if (token !== runToken) return;
  try { base = step.base ? step.base(view({})) || {} : {}; } catch { base = {}; }
  // the target exists but is scrolled away (in the inspector, a long sheet): bring it into view once
  if (!target() && !step.noScroll) {
    const away = [].concat(step.target || []).map((sel) => document.querySelector(sel)).find((n) => n && !n.closest('.tour-ui') && n.getClientRects().length);
    if (away) away.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  }
  events = []; // what start() itself did doesn't count
  watched = selectorsOf(step);
  ready = true;
  const pos = M.position(STEPS, step.id);
  announce(`Step ${pos.index + 1} of ${pos.total}: ${step.title}. ${step.tryIt}`);
  lastRect = '';
  place();
  evaluate();
}

function view(b = base) {
  return M.detector({
    events, base: b, state,
    query: (s) => document.querySelector(s),
    queryAll: (s) => [...document.querySelectorAll(s)],
    stored: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    inView: (s) => { const n = document.querySelector(s); if (!n) return false; const r = n.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.top < innerHeight - 40; },
  });
}

function evaluate() {
  if (!cur || ok || !ready) return;
  if (M.passes(cur, view())) succeed();
}

function succeed() {
  ok = true;
  const step = cur;
  save(M.markDone({ ...load(), step: step.id }, step.id));
  const { card, okRow, tryRow, bar } = layer;
  okRow.querySelector('.tour-ok-t').textContent = step.done || 'Done.';
  tryRow.hidden = true;
  okRow.hidden = false;
  card.classList.add('ok');
  bar.style.width = `${M.percent(STEPS, load())}%`;
  lastRect = '';
  place();
  const next = M.nextStep(STEPS, load(), step.id);
  announce(`Done. ${step.done || ''}${next ? ` Next: ${next.title}.` : ''}`);
  const token = runToken;
  const go = () => {
    if (token !== runToken) return;
    if (simulated) { setTimeout(go, 400); return; } // let a practice demo (Talk) finish first
    try { if (step.after) step.after(A); } catch { /* fine */ }
    runFrom(next || M.nextStep(STEPS, load(), null));
  };
  setTimeout(go, reduced() ? 1100 : 1500);
}

function skipStep() {
  if (!cur) return;
  const step = cur;
  save(M.markSkipped(load(), step.id));
  try { if (step.after) step.after(A); } catch { /* fine */ }
  runFrom(M.nextStep(STEPS, load(), step.id) || M.nextStep(STEPS, load(), null));
}
function prevStep() {
  if (!cur) return;
  const i = STEPS.findIndex((s) => s.id === cur.id);
  if (i > 0) runFrom(STEPS[i - 1]);
}

function finale() {
  cur = null; runToken++;
  if (layer) { layer.root.remove(); layer = null; }
  const p = { ...load(), active: false };
  save(p);
  const tried = p.done.length;
  const skipped = STEPS.filter((s) => p.skipped.includes(s.id) && !p.done.includes(s.id));
  const card = el('section', { class: 'tour-welcome tour-small tour-finale glass' },
    el('div', 'tour-hero', el('span', { class: 'tour-check big', 'aria-hidden': 'true' }, ico('check', 30)),
      el('h2', { id: 'tourDoneT' }, 'You’ve seen all of Eden'),
      el('p', '', `You tried ${tried} of ${STEPS.length} features${skipped.length ? `, and skipped ${skipped.length}` : ''}. Everything here was practice: back in your Eden, your chats and settings are just as you left them.`)),
    el('div', 'tour-foot',
      skipped.length ? el('button', { type: 'button', class: 'btn', onclick: () => { save({ ...load(), skipped: [], active: true }); closeSheet(); runFrom(skipped[0]); } }, 'Try the skipped ones') : null,
      el('span', 'grow'),
      el('button', { type: 'button', class: 'btn primary tour-primary', onclick: leave }, 'Back to my Eden')));
  openSheet(card, 'tourDoneT');
  announce('Tour finished.');
}

/* ---------------- detection: what the person did ---------------- */

const EVENT_TYPES = ['click', 'input', 'change', 'keydown', 'submit', 'pointerdown', 'contextmenu'];
const APP_EVENTS = ['eden:choice', 'eden:task', 'eden:conv-saved'];
let mo = null;
let tick = null;
let pending = false;
let watched = []; // the selectors the step's check asks about: matched when the event happens,
// since a click often re-draws (detaches) the very button it landed on
function selectorsOf(step) {
  const out = new Set();
  for (const answer of [false, true]) {
    const probe = { ...view({}), base: base || {}, saw: (type, sel) => { if (sel) out.add(sel); return answer; } };
    try { step.check(probe); } catch { /* a probe only */ }
  }
  return [...out];
}
function record(e) {
  if (!cur || ok) return;
  const t = e.target;
  if (t && t.closest && t.closest('.tour-ui')) return;
  const live = (sel) => { try { return !!(t && t.closest && t.closest(sel)); } catch { return false; } };
  const hits = Object.fromEntries(watched.map((sel) => [sel, live(sel)]));
  events.push({
    type: e.type, key: e.key, mod: !!(e.metaKey || e.ctrlKey), shift: !!e.shiftKey, alt: !!e.altKey, detail: e.detail,
    match: (sel) => (sel in hits ? hits[sel] : live(sel)),
  });
  if (events.length > 300) events.splice(0, 100);
  setTimeout(evaluate, 0);
  setTimeout(evaluate, 400);
}
function schedule() {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; evaluate(); place(); }, 120);
}
function startDetect() {
  for (const t of EVENT_TYPES) document.addEventListener(t, record, true);
  for (const t of APP_EVENTS) addEventListener(t, record);
  mo = new MutationObserver(schedule);
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-pressed', 'aria-expanded', 'aria-checked', 'open'] });
  tick = setInterval(() => { evaluate(); place(); }, 700);
  addEventListener('resize', () => { lastRect = ''; place(); });
  addEventListener('scroll', () => { lastRect = ''; place(); }, true);
}
function stopDetect() {
  for (const t of EVENT_TYPES) document.removeEventListener(t, record, true);
  for (const t of APP_EVENTS) removeEventListener(t, record);
  if (mo) mo.disconnect();
  clearInterval(tick);
}

/* ---------------- practice: the microphone stays off ---------------- */

const DICTATED = 'Remind me to call Ana at five tomorrow.';
function onVoiceClick(e) {
  const mic = e.target.closest && e.target.closest('#jc-dictate');
  const talk = e.target.closest && e.target.closest('#jc-talk');
  if (!mic && !talk) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (mic) simulateDictation(mic); else simulateTalk();
}
async function simulateDictation(mic) {
  if (simulated) return;
  simulated = true;
  mic.classList.add('live');
  mic.setAttribute('aria-pressed', 'true');
  announce('Listening (practice: a sample sentence).');
  let text = '';
  for (const w of DICTATED.split(' ')) {
    await sleep(reduced() ? 40 : 170);
    text = text ? `${text} ${w}` : w;
    setComposerText(text);
    $('deck-input').dispatchEvent(new Event('input', { bubbles: true }));
  }
  mic.classList.remove('live');
  mic.setAttribute('aria-pressed', 'false');
  simulated = false;
  evaluate();
}
async function simulateTalk() {
  if (!layer) { toast('Talk: practice only shows how it goes.'); return; }
  const lines = [['you', 'What’s on my calendar this afternoon?'], ['eden', 'Two things: the design review at two, and a call with Sam at four.'], ['you', 'Move Sam to five.'], ['eden', 'I’ll move it to five. Shall I?']];
  if (simulated) return;
  simulated = true;
  const box = el('div', { class: 'tour-talk', role: 'log', 'aria-label': 'Practice conversation' }, el('div', { class: 'orb tour-talk-orb', 'aria-hidden': 'true' }));
  layer.extra.replaceChildren(box);
  lastRect = ''; place();
  for (const [who, t] of lines) {
    await sleep(reduced() ? 150 : 900);
    box.append(el('p', `tour-talk-${who}`, el('b', '', who === 'you' ? 'You' : 'Eden'), ` ${t}`));
    announce(`${who === 'you' ? 'You' : 'Eden'}: ${t}`);
    lastRect = ''; place();
  }
  await sleep(reduced() ? 300 : 1600);
  simulated = false;
}

/** A sample file for the composer, or dropped on the email being written. */
function useSample(where) {
  const file = new File(['Lisbon trip notes\n- Fly Friday 18:05\n- Hotel in Alfama, 2 nights\n- Book the Tile Museum\n'], 'trip-notes.txt', { type: 'text/plain' });
  if (where === 'composer') { addFile(file); return; }
  const w = [...document.querySelectorAll('section.cw')].at(-1);
  if (!w) { toast('Open New email first.'); return; }
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    w.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 0, clientY: 0 }));
  } catch { toast('This browser can’t attach the sample: use the paper clip.'); }
}

/* ---------------- "What's this?" on each feature ---------------- */

function whatsThis() {
  for (const w of WHATS_THIS) {
    for (const head of document.querySelectorAll(w.sel)) {
      if (head.querySelector(':scope > .tour-whats') || head.closest('.tour-ui')) continue;
      const ch = typeof w.chapter === 'function' ? w.chapter(($('spTitle') || {}).textContent || '') : w.chapter;
      if (!ch && typeof w.chapter !== 'function') continue;
      const b = el('button', { type: 'button', class: 'iconbtn tour-whats', title: 'What’s this? Try it in the tour', 'aria-label': 'What’s this? Try it in the tour',
        onclick: (e) => {
          e.stopPropagation();
          const chapter = typeof w.chapter === 'function' ? w.chapter(($('spTitle') || {}).textContent || '') : w.chapter;
          if (PRACTICE) { const s = stepsOf(chapter || 'basics')[0]; if (s) runFrom(s); return; }
          A.closeSurfaces(); openWelcome({ chapter });
        } }, '?');
      const close = head.querySelector('.iconbtn:last-child, [aria-label^="Close"]');
      if (close && close.parentNode === head) head.insertBefore(b, close); else head.append(b);
    }
  }
}

/* ---------------- start ---------------- */

let inited = false;
export function initTour() {
  if (inited) return;
  inited = true;
  document.body.append(el('div', { id: 'tourLive', class: 'sr-only', 'aria-live': 'polite', role: 'status' }));
  // "What's this?": added as feature sheets open
  let wt = false;
  new MutationObserver(() => { if (wt) return; wt = true; requestAnimationFrame(() => { wt = false; whatsThis(); }); }).observe(document.body, { childList: true, subtree: true });
  // the iPhone app's welcome hands off here (ios/Eden/Onboarding.swift, through the bridge)
  addEventListener('eden:from-app', (e) => {
    let m = e.detail;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
    if (m && m.kind === 'tour' && m.op === 'start') enterPractice({ step: m.step || null, fresh: !!m.fresh });
  });
  if (PRACTICE) {
    document.documentElement.classList.add('eden-practice');
    startDetect(); // first, so a step sees the microphone tap the next listener keeps from the real one
    document.addEventListener('click', onVoiceClick, true);
    for (const id of ['jc-dictate', 'jc-talk']) { const b = $(id); if (b) b.hidden = false; } // practice runs them without a microphone
    badge();
    const p = load();
    const want = params.get('step');
    const step = want ? STEPS.find((s) => s.id === want) : null;
    if (step || p.active) {
      save({ ...p, active: true, seen: true });
      setTimeout(() => runFrom(step || M.resumeStep(STEPS, p)), 500);
    } else setTimeout(() => openWelcome(), 400);
    return;
  }
  const p = load();
  // practice left for good: anything its page wrote while unloading goes too (a resumable tour keeps its sample data)
  if (!p.active) resetPractice();
  if (M.shouldAutoStart({ progress: p, params, inApp: IN_APP, webdriver: !!navigator.webdriver })) setTimeout(() => openWelcome(), 700);
  else if (p.active && !IN_APP) setTimeout(() => toast('Pick up the tour where you left off?', { label: 'Resume', run: () => enterPractice() }), 1200);
}

export { enterPractice, A as tourActions };
