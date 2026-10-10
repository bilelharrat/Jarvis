// The spending autopilot in the page (ROADMAP H3): the month's spend against a budget, its
// forecast, and routing that steps down as it fills (the rules: autopilot-model.js; the Mac's
// server applies them in src/chat/learned.ts, askeden.com's Worker in site/src/eden/chat.js,
// where the account's included AI is the budget).
//  - GET /api/chat/spend: the month (D16's spend shape) with `autopilot` (stage, forecast) and
//    `savedVsTop` ("Saved $X vs always-Opus": the routes' real costs against the top model's
//    price for the same tokens). On askeden.com the savings come from this browser's replies.
//  - On the estimate line: "Autopilot: saving for the month", explained, with "Use my level this
//    time" for one message (sent as `autopilot: false`); a model picked for one message skips it too.
//  - The header's ring (context and spend) opens the month's popover; the Route console has a
//    card; Settings › Routing has the monthly budget (on the Mac).

import { $, el, toast, placePopup } from './util.js';
import { state, ui } from './state.js';
import { getJSON, postJSON } from './api.js';
import { autopilotWhy, savedVsTop, usd, monthBounds } from './autopilot-model.js';
import { planRows } from './plan.js';
import { locale } from './i18n.js';

let status = null; // the last GET /api/chat/spend
let loading = null;
let skip = false; // "Use my level this time": the next message only
const hosted = () => !!(state.meta && state.meta.hosted);

/** The month's state, or null before it loads. */
export function spendStatus() { return status; }
/** The autopilot's stage now (0 when off or unknown). */
export function autopilotStage() { return (status && status.autopilot && status.autopilot.stage) || 0; }

export async function refreshSpend() {
  if (loading) return loading;
  loading = getJSON('/api/chat/spend')
    .then((s) => { status = s; paint(); return s; })
    .catch(() => status)
    .finally(() => { loading = null; });
  return loading;
}

/** What a send or preview carries: `autopilot: false` for "Use my level this time"; on askeden.com the preview gets the stage. */
export function autopilotBody({ preview = false } = {}) {
  if (skip) return { autopilot: false };
  if (preview && hosted() && autopilotStage()) return { autopilot: { stage: autopilotStage() } };
  return {};
}
/** After a send: "Use my level this time" was for that message. */
export function endAutopilotSkip() { if (skip) { skip = false; paint(); } }

/* ---------- savings ---------- */

/** This month's saving against always the top model: the server's (the Mac), else this browser's replies (askeden.com). */
export function monthSavings() {
  if (status && status.savedVsTop && !hosted()) return status.savedVsTop;
  const { start } = monthBounds(Date.now(), { utc: hosted() });
  const turns = [];
  for (const c of state.convs) {
    for (const n of Object.values(c.nodes || {})) {
      if (n.role !== 'assistant' || !n.usage || (n.created || 0) < start) continue;
      turns.push({ costUSD: n.usage.costUSD, topUSD: n.usage.topUSD, notional: n.usage.notional });
    }
  }
  return { ...savedVsTop(turns), modelName: (status && status.savedVsTop && status.savedVsTop.modelName) || 'Claude Opus 5.5' };
}

/* ---------- the estimate line's tag (compare.js puts it there) ---------- */

export function autopilotTag() {
  const st = status && status.autopilot;
  if (!st || !st.stage) return null;
  if (state.turnOverride) return null; // your pick for this message: no autopilot
  const label = skip ? 'Autopilot off for this message' : st.label;
  const b = el('button', { type: 'button', class: `jc-est-ap${skip ? ' off' : ''} s${st.stage}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label, title: `${autopilotWhy(st, { when: renewWords(st) })} Tap for this message.` }, el('span', { class: 'ap-dot', 'aria-hidden': 'true' }), el('span', 'ap-l', label), el('span', { class: 'ap-s', 'aria-hidden': 'true' }, skip ? 'Off once' : 'Autopilot'));
  b.addEventListener('click', (e) => { e.stopPropagation(); openTagMenu(b, st); });
  return b;
}

let menuH = null; // { openMenu, closeMenu } from composer.js (compare.js passes them on)
export function setAutopilotMenus(h) { menuH = h; }

function openTagMenu(anchor, st) {
  const items = [{ heading: st.stage >= 3 ? 'Budget reached' : 'Saving for the month' }, { foot: autopilotWhy(st, { when: renewWords(st) }) }, '-'];
  if (skip) items.push({ icon: 'router', label: 'Let the autopilot route', note: `${st.what} again`, run: () => { skip = false; afterChange(); } });
  else items.push({ icon: 'up', label: 'Use my level this time', note: `Level ${state.settings.level} for the next message only`, run: () => { skip = true; afterChange(); } });
  items.push({ label: 'Budget and spend…', note: hosted() ? 'Your included AI this month' : 'Settings › Routing', run: () => dispatchEvent(new CustomEvent('eden:open-settings', { detail: { tab: 3 } })) });
  items.push({ foot: 'Claude through your subscription is quota, not dollars: it never counts toward the budget.' });
  if (menuH) menuH.openMenu(anchor, items);
  else toast(autopilotWhy(st));
}

function afterChange() {
  paint();
  // the preview routes again with (or without) the autopilot
  dispatchEvent(new CustomEvent('eden:reroute'));
}

function renewWords(st) {
  if (!st || !st.periodEnd) return '';
  const d = new Date(st.periodEnd);
  return Number.isNaN(d.getTime()) ? '' : `it renews ${d.toLocaleDateString(locale(), { month: 'short', day: 'numeric', ...(hosted() ? { timeZone: 'UTC' } : {}) })}`;
}
function endWords(st) {
  const d = new Date(new Date(st.periodEnd).getTime() - 1);
  return Number.isNaN(d.getTime()) ? 'month end' : d.toLocaleDateString(locale(), { month: 'short', day: 'numeric', ...(hosted() ? { timeZone: 'UTC' } : {}) });
}

/* ---------- the month, drawn (popover, console card, settings) ---------- */

function meter(frac, forecastFrac, stage) {
  const m = el('div', { class: `ap-meter s${stage}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(frac * 100)), 'aria-label': 'Spent of the monthly budget' },
    el('span', 'ap-fill'), el('span', 'ap-fc'));
  m.style.setProperty('--w', `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`);
  m.style.setProperty('--f', `${Math.min(100, Math.max(0, forecastFrac * 100)).toFixed(1)}%`);
  return m;
}

const pctOf = (f) => `${Math.max(0, Math.min(100, Math.round((Number(f) || 0) * 100)))}%`; // the hosted site shows shares, never dollars

/** The month as rows: spend and budget, forecast, the stage, the savings, the subscription. */
export function monthView({ compact = false } = {}) {
  const s = status;
  const kids = [];
  if (!s) { kids.push(el('div', 'muted', loading ? 'Loading this month…' : 'This month’s spend isn’t available.')); return kids; }
  const st = s.autopilot || {};
  const budget = st.budgetUSD || s.budgetUSD || 0;
  const spent = typeof s.totalUSD === 'number' ? s.totalUSD : st.spentUSD || 0;
  if (budget > 0) {
    kids.push(el('div', 'ap-row', el('span', '', hosted() ? 'Included AI this month' : 'This month'), el('b', '', hosted() ? `${pctOf(1 - spent / budget)} left` : `${usd(spent)} of ${usd(budget)}`)));
    kids.push(meter(spent / budget, (st.forecastUSD || spent) / budget, st.stage || 0));
    kids.push(el('div', 'ap-sub', `Forecast ${hosted() ? `${pctOf((st.forecastUSD || 0) / budget)} used` : usd(st.forecastUSD)} by ${endWords(st)}${st.method === 'weekday' ? ' · your weekday pattern counted' : ''}`));
    kids.push(el('div', { class: `ap-state s${st.stage || 0}` }, el('span', { class: 'ap-dot', 'aria-hidden': 'true' }), el('span', '', st.stage ? `${st.label}: ${st.what}` : 'Autopilot: on track, routing as you set it')));
  } else {
    kids.push(el('div', 'ap-row', el('span', '', 'This month'), el('b', '', hosted() ? '' : usd(spent))));
    kids.push(el('div', 'ap-sub', hosted() ? 'Your included AI isn’t known yet.' : 'No monthly budget: the autopilot is off. Set one in Settings › Routing.'));
  }
  const sv = monthSavings();
  if (sv && sv.turns) kids.push(el('div', 'ap-row ap-saved', el('span', '', `Saved vs always-${String(sv.modelName || 'Opus').replace(/^Claude /, '').replace(/ [\d.]+$/, '')} this month`), el('b', '', hosted() ? pctOf(sv.usd / Math.max(1e-9, spent + Math.max(0, sv.usd))) : sv.usd >= 0 ? usd(sv.usd) : `−${usd(-sv.usd)}`)));
  if (sv && sv.turns && !compact && !hosted()) kids.push(el('div', 'ap-sub', `${sv.turns} repl${sv.turns === 1 ? 'y' : 'ies'} billed in dollars, against ${sv.modelName || 'Claude Opus'}’s price for the same tokens.`));
  if (s.notionalCalls) kids.push(el('div', 'ap-sub', `Claude on your subscription: ${s.notionalCalls} repl${s.notionalCalls === 1 ? 'y' : 'ies'} ${hosted() ? '' : `(${usd(s.notionalUSD)} at API prices) `}counted as quota, not dollars.`));
  if (!compact && Array.isArray(s.byModel) && s.byModel.length) {
    const rows = s.byModel.filter((r) => r.usd > 0).slice(0, 4);
    const top = Math.max(...rows.map((r) => r.usd), 1e-9);
    if (rows.length) kids.push(el('ul', 'ap-models', ...rows.map((r) => { const li = el('li', '', el('span', 'n', String(r.name || r.model).replace(/^Claude /, '')), el('span', 'bar', el('i')), el('b', '', hosted() ? pctOf(r.usd / Math.max(1e-9, spent)) : usd(r.usd))); li.querySelector('i').style.width = `${Math.max(3, (r.usd / top) * 100)}%`; return li; })));
  }
  return kids;
}

/* ---------- the header ring's popover ---------- */

let pop = null;
function ensurePop() {
  if (pop && document.contains(pop)) return pop;
  pop = el('div', { id: 'spendPop', class: 'glass', role: 'dialog', 'aria-label': 'Spend this month' });
  document.body.append(pop);
  return pop;
}
function fillPop(p) {
  const ctx = ($('tbCtxPct') && $('tbCtxPct').textContent) || '0%';
  const cost = ($('tbCost') && $('tbCost').textContent) || '$0.00';
  p.replaceChildren(
    el('div', 'cp-t', 'This chat'), el('div', 'ap-row', el('span', '', `Context window ${ctx}`), el('b', '', cost)),
    el('div', 'cp-t ap-t2', 'This month'), ...monthView({ compact: true }),
    ...planRows(() => closePop()),
    el('button', { type: 'button', class: 'cp-link', onclick: () => { closePop(); dispatchEvent(new CustomEvent('eden:open-inspector', { detail: { tab: 'Route' } })); } }, 'Open Route console →'));
}
function openPop() {
  const a = $('tbCtx');
  const p = ensurePop();
  if (p.classList.contains('show')) { closePop(true); return; }
  fillPop(p);
  p.classList.add('show');
  a.setAttribute('aria-expanded', 'true');
  placePopup(p, a, 'below');
  refreshSpend().then(() => { if (p.classList.contains('show')) { fillPop(p); placePopup(p, a, 'below'); } });
}
function closePop(refocus) {
  if (!pop || !pop.classList.contains('show')) return false;
  pop.classList.remove('show');
  const a = $('tbCtx');
  if (a) { a.setAttribute('aria-expanded', 'false'); if (refocus) a.focus(); }
  return true;
}

/* ---------- the Route console's card ---------- */

function ensureCard() {
  let card = $('autopilotCard');
  if (card) return card;
  const tab = $('tab-Route');
  if (!tab) return null;
  card = el('div', { class: 'icard ap-card', id: 'autopilotCard' });
  const grp = el('div', { class: 'igrp', id: 'autopilotGrp' }, el('div', 'g-t', 'Spending autopilot'), card);
  const learned = $('learnedGrp');
  if (learned && learned.parentElement === tab) learned.after(grp);
  else tab.insertBefore(grp, $('scopeNote'));
  return card;
}
function renderCard() {
  const card = ensureCard();
  if (!card) return;
  card.replaceChildren(...monthView(), hosted() ? null : el('button', { type: 'button', class: 'cp-link', onclick: () => dispatchEvent(new CustomEvent('eden:open-settings', { detail: { tab: 3 } })) }, status && status.budgetUSD ? 'Change the budget →' : 'Set a monthly budget →'));
}

/* ---------- Settings › Routing ---------- */

export function autopilotSettings() {
  const sec = el('div', 'set-sec', el('h3', '', 'Spending autopilot'));
  if (hosted()) {
    sec.append(el('p', 'sp-note', 'On askeden.com your budget is the AI included with your account. As it runs low, Eden routes one or two levels cheaper, and once it’s used up only the cheapest model. Pick a model for one message to go past it.'), el('div', 'icard', ...monthView()));
    return sec;
  }
  const input = el('input', { type: 'number', class: 'acct-input', min: '0', max: '100000', step: '1', inputmode: 'decimal', placeholder: 'No budget', 'aria-label': 'Monthly budget in dollars', value: status && status.budgetUSD ? String(status.budgetUSD) : '' });
  const save = async () => {
    const v = input.value.trim();
    try {
      status = await postJSON('/api/chat/spend', { budgetUSD: v === '' ? 0 : Number(v) });
      toast(status.budgetUSD ? (hosted() ? 'Your included AI is on' : `Budget: ${usd(status.budgetUSD)} a month`) : 'No monthly budget: the autopilot is off');
      paint();
      body.replaceChildren(...monthView());
      dispatchEvent(new CustomEvent('eden:reroute'));
    } catch (e) { toast(`Couldn’t save the budget: ${e.message}`); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const body = el('div', 'ap-set-body', ...monthView());
  sec.append(
    el('div', 'icard',
      el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Monthly budget ($)'), el('div', 'p-c', 'Across your API-key providers. Claude through your subscription counts as quota, not dollars.')),
        el('div', 'ap-budget', input, el('button', { type: 'button', class: 'cap primary', onclick: save }, 'Save'))),
      body),
    el('p', 'sp-note', 'At 80% of the forecast, routing goes one level cheaper; at 95%, two levels and no top-tier models billed in dollars; once the budget is spent, only the cheapest models, unless you pick a model for a message. The forecast is this month’s pace, with your weekday pattern once there are two weeks of history.'));
  refreshSpend().then(() => { if (!input.value && status && status.budgetUSD) input.value = String(status.budgetUSD); body.replaceChildren(...monthView()); });
  return sec;
}

/* ---------- wiring ---------- */

function paint() {
  renderCard();
  ui.renderComposer(); // the estimate line's tag
  const a = $('tbCtx');
  const st = status && status.autopilot;
  if (a) a.classList.toggle('ap-on', !!(st && st.stage));
}

let saveT = 0;
export function initAutopilot() {
  const a = $('tbCtx');
  if (a) {
    a.setAttribute('role', 'button');
    a.setAttribute('tabindex', '0');
    a.setAttribute('aria-haspopup', 'dialog');
    a.setAttribute('aria-expanded', 'false');
    a.addEventListener('click', (e) => { e.stopPropagation(); openPop(); });
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPop(); } });
  }
  document.addEventListener('pointerdown', (e) => { if (pop && pop.classList.contains('show') && !pop.contains(e.target) && !(a && a.contains(e.target))) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && closePop(true)) e.stopPropagation(); }, true);
  addEventListener('resize', () => closePop());
  // a reply finished (its usage counted): the month again, a moment later
  addEventListener('eden:conv-saved', () => {
    if (state.streams.size) return;
    clearTimeout(saveT);
    saveT = setTimeout(refreshSpend, 1500);
  });
  // fresh whenever the inspector shows
  let last = 0;
  const fresh = () => { if (Date.now() - last > 2000) { last = Date.now(); refreshSpend(); } };
  for (const id of ['btnInspector', 'inspSeg']) { const b = $(id); if (b) b.addEventListener('click', fresh); }
  const base = ui.renderInspector;
  ui.renderInspector = (...x) => { base(...x); fresh(); };
  renderCard();
  refreshSpend();
}
