// The page side of Eden's trip tools (trip-tools.js; the Worker's site/src/travel/*): whether askeden.com has Travel
// on, the reads going to /api/chat/travel, and the proposal / new-trip cards. Never in the iPhone/Android app
// (tools-ui.js only calls this when !IN_APP). The card's Apply (or Create) button is the only thing that sends confirm: true.

import { bookingCardNote } from './travel-perks.js';
import { el, ico } from './util.js';
import { apiUrl, getJSON, postJSON } from './api.js';
import { saveConversation, ui } from './state.js';
import * as TT from './trip-tools.js';
import { liveFlight } from './travel-live.js';
import * as PJ from './trip-planjob.js';

let st = { enabled: false, maps: null, at: 0 };
/** Is Travel on (the Worker's EDEN_TRAVEL=1)? Cached for a minute; a server without it (404) says no. */
export async function travelStatus() {
  if (Date.now() - st.at < 60_000) return st;
  try {
    const j = await getJSON('/api/chat/travel', { timeout: 5000 });
    st = { enabled: Boolean(j && Array.isArray(j.trips)), plus: !(j && j.plus === false), maps: (j && j.maps) || null, at: Date.now() }; // plus: false: Eden Travel is part of Plus (the server says)
  } catch { st = { enabled: false, maps: null, at: Date.now() }; }
  return st;
}
export const tripGet = (id) => getJSON(id ? `/api/chat/travel?id=${encodeURIComponent(id)}` : '/api/chat/travel', { timeout: 30_000 });
const CHANGES = new Set(['apply', 'undo', 'edit', 'update', 'create', 'sample', 'delete', 'discard', 'mark-booked', 'unbook', 'mail-import', 'cards-save', 'propose', 'shared-propose', 'stays-book', 'stays-cancel', 'rail-book']); // propose: Eden noticed shows the new proposal at once
/** POST /api/chat/travel; a change to a trip tells Eden Travel (travel.js) to show it again. */
/**
 * A booking that Ask Eden's Duffel balance pays for: with traveller payments on (the Worker's travel/pay.js), the card is
 * held at Stripe first and the page goes there; Eden books once the hold is in, then charges it (or releases it). With
 * them off (or no Eden Travel here), `direct` books as before. kind: flight | flight_pay | stay; args: the booking's own.
 */
export async function payFirst(kind, args, direct) {
  let r;
  try { r = await postJSON(apiUrl('/api/chat/travel'), { action: 'pay-start', args: { kind, args } }, { timeout: 30_000 }); }
  catch (e) { if (/not.?found|404/i.test(String(e.message || e))) return direct(); throw e; }
  if (!r || !r.required) return direct();
  location.assign(r.url); // Stripe's Checkout; back at /travel#trip-paid (watchPayment)
  return new Promise(() => {}); // the page is leaving
}

/** Back from Stripe: what happened to the booking (it may still be being made), said once. */
export async function watchPayment(say) {
  const h = location.hash;
  if (h !== '#trip-paid' && h !== '#trip-pay-cancelled') return;
  history.replaceState(null, '', location.pathname + location.search);
  if (h === '#trip-pay-cancelled') return say('Payment cancelled. Nothing was booked or charged.');
  for (let i = 0; i < 30; i++) {
    let r = null;
    try {
      r = await postJSON(apiUrl('/api/chat/travel'), { action: 'pay-latest', args: {} }, { timeout: 15_000 });
      if (r && r.status === 'pending' && r.pay_id) r = await postJSON(apiUrl('/api/chat/travel'), { action: 'pay-complete', args: { pay_id: r.pay_id } }, { timeout: 120_000 });
    } catch { /* try again */ }
    if (r && r.status === 'paid') {
      dispatchEvent(new CustomEvent('eden:trip-changed', { detail: { id: null } }));
      return say(`Booked and paid: ${r.title} (${r.total_text})${r.result && (r.result.booking_reference || r.result.reference) ? `, reference ${r.result.booking_reference || r.result.reference}` : ''}.`);
    }
    if (r && r.status === 'booked') return say(`Booked: ${r.title}. The card charge didn’t go through yet; Eden will sort it out.`);
    if (r && r.status === 'failed') return say(r.error || 'Not booked. Nothing was charged.');
    if (r && r.status === 'none') return;
    await new Promise((res) => setTimeout(res, 2000));
  }
  say('Still booking. Eden will show it on your trip once it’s done.');
}

export async function tripPost(action, args) {
  const r = await postJSON('/api/chat/travel', { action, args }, { timeout: 30_000 });
  if (CHANGES.has(action)) dispatchEvent(new CustomEvent('eden:trip-changed', { detail: { id: (r && r.trip && r.trip.id) || (args && args.id) || null } }));
  return r;
}

/** A new trip from Eden's planner (site travel/planner.js): drafted with web search, checked and fixed on Google Maps. About
 *  a minute; nothing is saved (the plan's Create button sends it to create). The checks are left out of what's kept. */
export async function tripPlan(args) {
  const r = await postJSON('/api/chat/travel', { action: 'plan', args }, { timeout: 760_000 }) // the server's own deadline is 12 min (no time limit the person sees, owner 2026-10-28);
  return { ...r, checks: undefined };
}

/** A plan as a job (the Worker's travel/planjob.js): → a view (trip-planjob.js) to follow. A server without jobs (older
 *  Worker) answers 400 on the action: `null`, and the caller plans the old way (tripPlan). */
export async function startPlanJob(args) {
  let r;
  try { r = await postJSON('/api/chat/travel', { action: 'plan-start', args }, { timeout: 30_000 }); }
  catch (e) { if (/action must be one of/i.test(String(e.message || e))) return null; throw e; }
  return PJ.planState(r.job);
}
const planPost = (action, args) => postJSON('/api/chat/travel', { action, args }, { timeout: 20_000 });
/** Follows a job's steps until it ends (onUpdate after each answer); → the view, with `result` as tripPlan's (no checks). */
export const followPlanJob = (v, onUpdate, signal) => PJ.followPlan(v, { post: planPost, onUpdate, signal });
export const cancelPlanJob = (job) => planPost('plan-cancel', { job }).catch(() => {});

/**
 * The plan being made, shown as it happens: the step and the clock, the first sketch (not checked), then the draft's
 * days with each place ticking in as Google Maps answers, and each change. `seen`: keys already drawn, so only what's new
 * fades in (a repaint never replays it; nothing moves under reduced motion).
 */
export function planProgress(v, seen = new Set()) {
  ensurePlanCss();
  const fresh = (k) => { if (seen.has(k)) return ''; seen.add(k); return ' tp-new'; };
  const sum = PJ.summary(v);
  const root = el('div', { class: 'tp-live' });
  root.append(el('div', 'tp-head',
    el('span', { class: 'tp-step', role: 'status', 'aria-live': 'polite' }, !v.draft || v.state !== 'running' || v.stageKey === 'checking' ? sum.text : `${sum.text}. ${v.stage || ''}`),
    el('span', { class: 'tp-clock', 'aria-hidden': 'true' }, sum.clock)));
  if (!v.draft && v.state === 'running') root.append(el('div', 'tp-said', 'The draft searches Google for each place’s days and hours: usually about a minute and a half. Then every place is checked on Google Maps, here, one by one.'));
  const days = (list, sketch) => planDays(list, seen, sketch);
  if (v.sketch) {
    root.append(el('div', { class: `tp-sketch${fresh('sketch')}` },
      el('div', 'tp-tag', `First sketch · ${v.sketch.label || 'a fast model'}, from what it knows · not checked yet`),
      ...days(v.sketch.days, true)));
  }
  if (v.draft) {
    root.append(el('div', { class: `tp-tag${fresh('drafthead')}` }, `Draft · ${v.draft.label || 'the planner'} · each place checked on Google Maps`), ...days(v.draft.days, false));
  }
  return root;
}
// a day's own name without the model's "Day 1:" (the head says the day already)
const dayTitle = (t) => String(t || '').replace(/^day\s*\d+\s*[:·.–-]?\s*/i, '').trim();
/** Days as the live view draws them (planProgress, and the finished plan): each stop with its mark and Google's words. */
export function planDays(list, seen = new Set(), sketch = false) {
  const fresh = (k) => { if (seen.has(k)) return ''; seen.add(k); return ' tp-new'; };
  return list.map((d, i) => el('div', { class: `tp-day${fresh(`${sketch ? 's' : 'd'}day${i}`)}` },
    el('div', 'tp-dayhead', PJ.dayHead(d, i), dayTitle(d.title) ? el('span', 'tp-daytitle', ` · ${dayTitle(d.title)}`) : ''),
    el('ol', 'tp-stops', ...d.stops.map((s, j) => {
      if (sketch) return el('li', { class: `tp-stop sketch${fresh(`s${i}:${j}`)}`, style: { "--i": Math.min(j, 8) } }, el('span', 'tp-at', s.at), el('span', { class: 'tp-name', 'data-no-i18n': '' }, s.name));
      const l = PJ.stopLine(s);
      return el('li', { class: `tp-stop ${l.mark}${fresh(`d${s.id}`)}`, style: { "--i": Math.min(j, 8) } },
        el('span', { class: `tp-mark${fresh(`m${s.id}:${l.mark}`)}`, 'aria-label': { ok: 'Checked', bad: 'Problem', fixed: 'Fixed', gone: 'Left out', info: 'Found', wait: 'Checking', plain: null }[l.mark] }, { ok: '✓', bad: '!', fixed: '↻', gone: '×', info: 'i', wait: '', plain: '' }[l.mark]),
        el('span', 'tp-at', s.at),
        el('span', 'tp-body', el('span', { class: 'tp-name', 'data-no-i18n': '' }, s.name), el('span', { class: 'tp-said', 'data-no-i18n': '' }, l.said),
          l.change ? el('span', { class: 'tp-change', 'data-no-i18n': '' }, `${l.change}: ${l.why}`) : ''));
    }), d.stops.length ? '' : el('li', 'tp-stop empty', 'Nothing planned'))));
}
export function ensurePlanCss() {
  if (typeof document !== 'undefined' && !document.querySelector('link[href$="trip-planjob.css"]')) document.head.append(el('link', { rel: 'stylesheet', href: 'trip-planjob.css' }));
}

/** What Eden checked and changed on a plan (TT.planView), for the chat card and the Travel page's form. */
export function planSection(v) {
  const list = (items) => el('ul', 'tc-list', ...items.map((x) => el('li', { 'data-no-i18n': '' }, x)));
  const head = (t) => el('div', 'tc-notice', el('strong', '', t));
  return [
    head('What Eden checked and changed'),
    el('div', 'tc-why', v.checked),
    v.note ? el('div', 'tc-notice', v.note) : null,
    v.changes.length ? list(v.changes) : el('div', 'tc-why', 'Nothing needed changing.'),
    ...(v.unresolved.length ? [head('Still to look at'), list(v.unresolved)] : []),
    v.notes ? el('details', 'tc-raw', el('summary', '', 'The planner’s notes'), el('div', { class: 'tc-why', 'data-no-i18n': '' }, v.notes)) : null,
    v.sources.length ? el('details', 'tc-raw', el('summary', '', `Sources (${v.sources.length})`), el('ul', 'tc-list', ...v.sources.map((x) => el('li', '', el('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', 'data-no-i18n': '' }, x.title))))) : null,
  ].filter(Boolean);
}

// The trip Eden Travel shows right now (travel.js sets it), so Ask Eden knows what "this day" means.
let viewingNow = null;
export const setViewing = (v) => { viewingNow = v; };
export const viewing = () => (document.body.classList.contains('travel-open') ? viewingNow : null);

const LOADING = new WeakSet(); // cards fetching their preview (not saved with the chat)

/** The in-flight map on its own (Eden Travel's flight stops): the same view as the chat card. */
export const flightMapView = (ident, date) => flightMapCard(null, null, { state: 'pending' }, { name: 'trip_flight_map', args: { ident, date } });

/** The card for a trip_propose / trip_create / trip_book / trip_mark_booked call. `t` is the saved tool state on the reply. */
export function tripCard(c, node, t, call) {
  const redraw = () => { saveConversation(c); ui.updateMessage(c, node); };
  if (call.name === 'trip_book' || call.name === 'trip_mark_booked') return bookingCard(t, call, redraw);
  if (call.name === 'trip_stays_book') return stayCard(t, call, redraw);
  if (call.name === 'trip_rail_book') return railCard(t, call, redraw);
  if (call.name === 'trip_suggest') {
    // a suggestion to the organiser of a shared trip: its button sends it; the organiser applies it or not
    const root = el('div', { class: `toolcard ${t.state}`, role: 'group', 'aria-label': 'Send this suggestion?', 'data-tool': call.name });
    root.append(el('div', 'tc-title', ico('globe', 15), call.args.title));
    if (call.args.reason) root.append(el('div', 'tc-notice', call.args.reason));
    if (t.rows) root.append(el('dl', 'tc-rows', ...t.rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', { 'data-no-i18n': '' }, String(v))])));
    if (t.state === 'done') { root.append(el('div', 'tc-done', ico('check', 14), t.result)); return root; }
    if (t.state === 'running') { root.append(el('div', 'tc-notice', 'Working…')); return root; }
    if (t.error) root.append(el('div', 'tc-error', t.error));
    root.append(el('div', 'tc-acts',
      el('button', { type: 'button', class: 'cap primary', onclick: async () => {
        t.state = 'running'; delete t.error; redraw();
        try { const r = await tripPost('shared-propose', call.args); t.rows = TT.previewRows(r.preview); t.state = 'done'; t.result = 'Sent to the organiser: they see it in Eden noticed and decide.'; }
        catch (e) { t.state = 'error'; t.error = String(e.message || e); }
        redraw();
      } }, 'Send suggestion'),
      el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'done'; t.result = 'Not sent.'; redraw(); } }, 'Cancel')));
    return root;
  }
  if (call.name === 'trip_stays_cancel') {
    const root = el('div', { class: `toolcard ${t.state}`, role: 'group', 'aria-label': 'Cancel this hotel booking?', 'data-tool': call.name });
    root.append(el('div', 'tc-title', ico('globe', 15), 'Cancel this hotel booking?'), el('dl', 'tc-rows', el('dt', '', 'Booking'), el('dd', { 'data-no-i18n': '' }, call.args.booking_id)));
    if (t.state === 'done') { root.append(el('div', 'tc-done', ico('check', 14), t.result)); return root; }
    if (t.state === 'running') { root.append(el('div', 'tc-notice', 'Working…')); return root; }
    if (t.error) root.append(el('div', 'tc-error', t.error));
    root.append(el('div', 'tc-acts',
      el('button', { type: 'button', class: 'cap danger', onclick: async () => { t.state = 'running'; redraw(); try { const b = await tripPost('stays-cancel', { booking_id: call.args.booking_id, confirm: true }); t.state = 'done'; t.result = `Cancelled (${b.status || 'cancelled'}).${b.card_refund_text ? ` ${b.card_refund_text}` : ''}`; } catch (e) { t.state = 'error'; t.error = String(e.message || e); } redraw(); } }, 'Cancel booking'),
      el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'done'; t.result = 'Kept.'; redraw(); } }, 'Keep it')));
    return root;
  }
  if (call.name === 'trip_cards_save') return cardsCard(t, call, redraw);
  if (call.name === 'trip_mail_import') return mailCard(t, call, redraw);
  if (call.name === 'trip_flight_map') return flightMapCard(c, node, t, call);
  if (call.name === 'trip_plan') return planCard(t, call, redraw);
  const propose = call.name === 'trip_propose';
  const title = propose ? call.args.title : 'Start this trip?';
  const root = el('div', { class: `toolcard ${t.state}`, role: 'group', 'aria-label': title, 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico('globe', 15), title));
  if (propose && call.args.reason) root.append(el('div', 'tc-notice', call.args.reason));
  const rows = (list) => root.append(el('dl', 'tc-rows', ...list.flatMap(([k, v]) => [el('dt', '', k), el('dd', { 'data-no-i18n': '' }, String(v))])));

  if (propose) {
    // the preview comes from the server (it checks the change against the trip as it is now); nothing is changed yet
    if (!t.preview && t.state === 'pending' && !LOADING.has(t)) {
      LOADING.add(t);
      tripPost('propose', { ...call.args, by: 'eden' })
        .then((r) => { t.preview = { proposal: r.proposal.id, rows: TT.previewRows(r.preview), standin: r.preview.maps === 'standin' }; })
        .catch((e) => { t.state = 'error'; t.error = String(e.message || e); t.stale = true; })
        .finally(() => { LOADING.delete(t); redraw(); });
    }
    if (t.preview) rows(t.preview.rows);
    else if (t.state === 'pending') root.append(el('div', 'tc-done muted', 'Checking the change against your trip…'));
  } else rows(TT.createRows(call.args));

  if (t.state === 'done') {
    root.append(el('div', 'tc-done', ico('check', 14), t.result || 'Done.'));
    const tripId = propose ? call.args.id : t.trip;
    root.append(el('div', 'tc-acts',
      propose && !t.undone ? el('button', { type: 'button', class: 'cap', onclick: () => undo(t, call, redraw) }, 'Undo') : null,
      tripId ? el('button', { type: 'button', class: 'cap', onclick: () => dispatchEvent(new CustomEvent('eden:travel-open', { detail: { id: tripId } })) }, 'Open in Eden Travel') : null));
    return root;
  }
  if (t.state === 'cancelled') { root.append(el('div', 'tc-done muted', 'Discarded. Nothing was changed.')); return root; }
  if (t.state === 'running') { root.append(el('div', 'tc-done muted', 'Working…')); return root; }
  root.append(el('div', 'tc-notice', `Nothing changes until you press ${propose ? 'Apply' : 'Create'}.${t.preview && t.preview.standin ? ' Hours and travel times are stand-in samples, not checked yet.' : ''}`));
  if (t.state === 'error') root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', t.stale ? `${t.error} Ask Eden again.` : t.error)));
  const acts = el('div', 'tc-acts');
  if (!propose || (t.preview && !t.stale)) acts.append(el('button', { type: 'button', class: 'cap primary', onclick: () => press(t, call, redraw) }, propose ? 'Apply' : 'Create trip'));
  acts.append(el('button', { type: 'button', class: 'cap', onclick: () => discard(t, call, redraw) }, propose ? 'Discard' : 'Cancel'));
  root.append(acts);
  return root;
}

// trip_plan: the server plans as a job (about 100 s) and the card shows each step as it happens (planProgress), then it is
// the create card with what Eden checked and changed. The job id is saved with the card (t.job), so a reload follows the
// same job instead of paying for a second plan; a card whose plan was never started shows Plan again.
const PLANNING = new WeakMap(); // card → { v, seen, ctl } while following its job here
const DONE = new WeakMap(); // card → its job's last view (Google's words per stop), for the finished plan's days
const SEEN = new WeakMap(); // card → what it has drawn (an entrance plays once, never on a repaint)
const seenOf = (t) => { let x = SEEN.get(t); if (!x) SEEN.set(t, (x = new Set())); return x; };
function planCard(t, call, redraw) {
  const root = el('div', { class: `toolcard ${t.state}`, role: 'group', 'aria-label': t.plan ? 'Start this trip?' : 'Planning your trip', 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico('globe', 15), t.plan ? 'Start this trip?' : 'Planning your trip'));
  const follow = (v) => {
    const run = { v, seen: seenOf(t), ctl: new AbortController() };
    PLANNING.set(t, run);
    followPlanJob(v, () => redraw(), run.ctl.signal).then((end) => {
      if (run.ctl.signal.aborted) return;
      if (end.state === 'done') { t.plan = { ...end.result, checks: undefined }; DONE.set(t, end); }
      else if (end.state === 'cancelled') t.state = 'cancelled';
      else { t.state = 'error'; t.error = end.error || 'The plan stopped.'; }
    }).catch((e) => { t.state = 'error'; t.error = String(e.message || e); }).finally(() => { if (!run.ctl.signal.aborted) { PLANNING.delete(t); redraw(); } });
  };
  const start = () => {
    t.asked = true; t.state = 'pending'; delete t.error; delete t.job;
    PLANNING.set(t, { v: PJ.planState(null), seen: seenOf(t), ctl: new AbortController() });
    startPlanJob(call.args).then((v) => {
      if (!v) { // an older server: one long call, as before
        return tripPlan(call.args).then((r) => { t.plan = r; }).catch((e) => { t.state = 'error'; t.error = String(e.message || e); }).finally(() => { PLANNING.delete(t); redraw(); });
      }
      t.job = v.job; t.jobAt = v.startedAt; redraw(); // saved with the chat: a reload follows this job
      follow(v);
    }).catch((e) => { PLANNING.delete(t); t.state = 'error'; t.error = String(e.message || e); redraw(); });
  };
  const run = () => { start(); redraw(); };
  const cancel = () => {
    const p = PLANNING.get(t);
    if (p) p.ctl.abort();
    PLANNING.delete(t);
    if (t.job) cancelPlanJob(t.job);
    t.state = 'cancelled'; redraw();
  };
  if (!t.plan && t.state === 'pending' && !t.asked && !PLANNING.has(t)) start();
  // a reload (or a new tab) mid-plan: follow the saved job from its first step
  else if (!t.plan && t.state === 'pending' && t.job && !PLANNING.has(t)) follow(PJ.planState(t.job, t.jobAt || Date.now()));
  if (!t.plan) {
    if (t.state === 'cancelled') { root.append(el('div', 'tc-done muted', 'Not planned. Nothing was saved.')); return root; }
    const p = PLANNING.get(t);
    if (p) {
      root.append(planProgress(p.v, p.seen));
      root.append(el('div', 'tc-acts', el('button', { type: 'button', class: 'cap', onclick: cancel }, 'Stop planning')));
      return root;
    }
    if (t.error) root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', t.error)));
    else root.append(el('div', 'tc-notice', 'The plan was interrupted.'));
    root.append(el('div', 'tc-acts', el('button', { type: 'button', class: 'cap primary', onclick: run }, 'Plan again'), el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'cancelled'; redraw(); } }, 'Cancel')));
    return root;
  }
  const v = TT.planView(t.plan);
  ensurePlanCss();
  root.append(el('dl', 'tc-rows', ...v.rows.flatMap(([k, x]) => [el('dt', '', k), el('dd', { 'data-no-i18n': '' }, String(x))])),
    el('div', 'tp-live', ...planDays(PJ.finalDays(t.plan, DONE.get(t)), seenOf(t))), ...planSection(v));
  if (t.state === 'done') {
    root.append(el('div', 'tc-done', ico('check', 14), t.result || 'Done.'));
    if (t.trip) root.append(el('div', 'tc-acts', el('button', { type: 'button', class: 'cap', onclick: () => dispatchEvent(new CustomEvent('eden:travel-open', { detail: { id: t.trip } })) }, 'Open in Eden Travel')));
    return root;
  }
  if (t.state === 'cancelled') { root.append(el('div', 'tc-done muted', 'Discarded. Nothing was saved.')); return root; }
  if (t.state === 'running') { root.append(el('div', 'tc-done muted', 'Working…')); return root; }
  root.append(el('div', 'tc-notice', 'Nothing is saved until you press Create.'));
  if (t.state === 'error') root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', t.error)));
  root.append(el('div', 'tc-acts',
    el('button', { type: 'button', class: 'cap primary', onclick: () => press(t, call, redraw) }, 'Create trip'),
    el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'cancelled'; redraw(); } }, 'Cancel')));
  return root;
}

/** Apply (or Create): one step, run once (the card shows Working… meanwhile). */
async function press(t, call, redraw) {
  t.state = 'running'; delete t.error; redraw();
  try {
    if (call.name === 'trip_propose') {
      const r = await tripPost('apply', { id: call.args.id, proposal: t.preview.proposal, confirm: true });
      t.state = 'done';
      t.result = `Applied to “${r.trip.title}”.${r.checks.alerts.length ? ` ${r.checks.alerts.length} alert${r.checks.alerts.length === 1 ? '' : 's'} left.` : ''}`;
    } else {
      const r = await tripPost('create', { trip: call.name === 'trip_plan' ? t.plan.trip : call.args });
      t.state = 'done';
      t.trip = r.trip.id;
      t.result = `Trip started: “${r.trip.title}”.${r.checks.alerts.length ? ` ${r.checks.alerts.length} thing${r.checks.alerts.length === 1 ? '' : 's'} to look at.` : ''}`;
    }
  } catch (e) {
    t.state = 'error';
    t.error = String(e.message || e);
    // a trip that changed, or a proposal gone or a day old, can't be applied from this card: Eden proposes again
    t.stale = ['stale', 'gone', 'locked'].includes(e.code) || /Ask Eden again/i.test(t.error);
  }
  redraw();
}

async function discard(t, call, redraw) {
  if (call.name === 'trip_propose' && t.preview) tripPost('discard', { id: call.args.id, proposal: t.preview.proposal }).catch(() => {});
  t.state = 'cancelled';
  redraw();
}

async function undo(t, call, redraw) {
  try {
    await tripPost('undo', { id: call.args.id });
    t.undone = true;
    t.result = 'Undone: the trip is back as it was.';
  } catch (e) {
    t.result = `${t.result} (Couldn’t undo: ${String(e.message || e)})`;
  }
  redraw();
}

/**
 * Booking anything that isn't a flight: in Eden's browser (Eden fills the provider's own site up to checkout; the
 * browser's own rules hold every purchase for approval and never type payment details), or on the site in a new tab.
 * Then "Mark as booked" saves the reference the person confirms, and the stop is locked.
 */
function bookingCard(t, call, redraw) {
  const marking = call.name === 'trip_mark_booked';
  const title = marking ? 'Mark this as booked?' : 'Book this?';
  const root = el('div', { class: `toolcard ${t.state}`, role: 'group', 'aria-label': title, 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico('globe', 15), title));
  // the stop's name comes from the trip itself, not the model's words
  if (t.stopName === undefined && !LOADING.has(t)) {
    LOADING.add(t);
    tripGet(call.args.id)
      .then((r) => { const s = r.trip.days.flatMap((d) => d.stops).find((x) => x.id === call.args.stop); t.stopName = s ? s.place.name : null; t.when = s ? TT.stopDates(r.trip, s.id) : null; if (!s) { t.state = 'error'; t.error = 'That stop isn’t in the trip any more.'; } })
      .catch(() => { t.stopName = null; })
      .finally(() => { LOADING.delete(t); redraw(); });
  }
  const list = marking ? TT.markRows(call.args, t.stopName) : TT.bookRows(call.args, t.stopName, t.when);
  root.append(el('dl', 'tc-rows', ...list.flatMap(([k, v]) => [el('dt', '', k), el('dd', { 'data-no-i18n': '' }, String(v))])));
  if (t.state === 'done') { root.append(el('div', 'tc-done', ico('check', 14), t.result || 'Done.')); return root; }
  if (t.state === 'cancelled') { root.append(el('div', 'tc-done muted', 'Not booked. Nothing was changed.')); return root; }
  if (t.state === 'running') { root.append(el('div', 'tc-done muted', 'Working…')); return root; }
  root.append(el('div', 'tc-notice', marking ? 'Check the reference matches your confirmation. The stop is then locked, so Eden won’t move it.' : 'In Eden’s browser, Eden fills in the site and stops before paying: you approve and type the payment yourself. Eden never sees your card details.'));
  if (t.state === 'error') root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', t.error)));
  const acts = el('div', 'tc-acts');
  if (marking) {
    acts.append(el('button', { type: 'button', class: 'cap primary', onclick: () => markBooked(t, call, redraw) }, 'Mark as booked'));
  } else {
    acts.append(el('button', { type: 'button', class: 'cap primary', onclick: () => bookInBrowser(t, call, redraw) }, 'Book in Eden’s browser'));
    acts.append(el('button', { type: 'button', class: 'cap', onclick: () => { window.open(call.args.url, '_blank', 'noopener,noreferrer'); t.state = 'done'; t.result = 'Opened the site in a new tab. Tell Eden the booking reference when you have it.'; redraw(); } }, 'Open the site myself'));
  }
  acts.append(el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'cancelled'; redraw(); } }, 'Cancel'));
  root.append(acts);
  return root;
}

async function bookInBrowser(t, call, redraw) {
  const { sendMessage } = await import('./chat.js');
  if (sendMessage(TT.browserBookText(call.args, t.stopName)) === false) return; // a reply still running: the toast says so
  t.state = 'done';
  t.result = 'Sent to Eden’s browser. It stops before paying; you approve and pay there.';
  redraw();
}

async function markBooked(t, call, redraw) {
  t.state = 'running'; delete t.error; redraw();
  try {
    const r = await tripPost('mark-booked', { ...call.args, via: 'person', confirm: true });
    t.state = 'done';
    t.result = `Booked: ${call.args.ref} saved to “${r.trip.title}”. The stop is locked.`;
  } catch (e) {
    t.state = 'error';
    t.error = String(e.message || e);
  }
  redraw();
}

/**
 * Booking a train or bus inside Eden (Distribusion): the card checks the seats and price first (never the model's
 * number), the person types each passenger's name and an email and accepts the carrier's terms, then presses Book
 * (paid by card first when payments are on: payFirst).
 */
const CHECKING = new WeakSet();
function railCard(t, call, redraw) {
  const root = el('div', { class: `toolcard ${t.state}`, role: 'group', 'aria-label': 'Book this train?', 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico('globe', 15), 'Book this train?'));
  if (!t.check && !t.checkError && !CHECKING.has(t) && t.state !== 'done') {
    CHECKING.add(t);
    tripPost('rail-check', { offer_id: call.args.offer_id, passenger_ids: call.args.passenger_ids, title: call.args.title })
      .then((v) => { t.check = v; }).catch((e) => { t.checkError = String(e.message || e); })
      .finally(() => { CHECKING.delete(t); redraw(); });
  }
  if (t.checkError) { root.append(el('div', 'tc-error', t.checkError)); return root; }
  if (!t.check) { root.append(el('div', 'tc-notice', 'Checking seats and the price…')); return root; }
  if (!t.check.vacant) { root.append(el('div', 'tc-error', `No seats at this price now${t.check.reason ? ` (${t.check.reason})` : ''}. Ask Eden for another train.`)); return root; }
  const v = t.check;
  root.append(el('dl', 'tc-rows', ...[['Train', call.args.title], ['Passengers', String(call.args.passenger_ids.length)], ['Total now', v.total_price ? `${v.total_price.amount} ${v.total_price.currency}` : '—']].flatMap(([k, x]) => [el('dt', '', k), el('dd', { 'data-no-i18n': '' }, String(x))])),
    el('div', 'tc-src', `Checked with ${v.source} · ${String(v.checked_at).slice(0, 16).replace('T', ' ')} UTC`));
  if (t.state === 'done') { root.append(el('div', 'tc-done', ico('check', 14), t.result || 'Booked.')); return root; }
  const form = el('form', { class: 'tc-form', onsubmit: (e) => e.preventDefault() });
  const names = call.args.passenger_ids.map((_, i) => [
    el('input', { type: 'text', autocomplete: i ? 'off' : 'given-name', placeholder: `Passenger ${i + 1} first name`, 'aria-label': `Passenger ${i + 1} first name`, required: '' }),
    el('input', { type: 'text', autocomplete: i ? 'off' : 'family-name', placeholder: 'Last name', 'aria-label': `Passenger ${i + 1} last name`, required: '' })]);
  const email = el('input', { type: 'email', autocomplete: 'email', placeholder: 'Email for the tickets', 'aria-label': 'Email', required: '' });
  const terms = el('input', { type: 'checkbox', id: `terms-${call.args.offer_id.slice(-8)}`, required: '' });
  // what was typed survives an error's redraw (kept on the card's state, not the chat's text)
  if (!t.typed) t.typed = {};
  const remember = (input, k) => { if (t.typed[k] !== undefined) input.value = t.typed[k]; input.addEventListener('input', () => { t.typed[k] = input.value; }); };
  names.forEach(([g, f], i) => { remember(g, `g${i}`); remember(f, `f${i}`); }); remember(email, 'email');
  form.append(...names.map((p) => el('div', 'tc-row2', ...p)), email, el('label', { class: 'tc-check', for: terms.id }, terms, ' I accept the carrier’s terms and conditions for this ticket'));
  root.append(form);
  if (t.error) root.append(el('div', 'tc-error', t.error));
  root.append(el('div', 'tc-acts',
    el('button', { type: 'button', class: 'cap primary', onclick: async () => {
      if (!form.reportValidity()) return;
      t.state = 'running'; delete t.error; redraw();
      const args = { offer_id: call.args.offer_id, passenger_ids: call.args.passenger_ids, passengers: names.map(([g, f]) => ({ first_name: g.value, last_name: f.value })), email: email.value, terms_accepted: terms.checked, ...(call.args.id ? { id: call.args.id, stop: call.args.stop } : {}), confirm: true };
      try {
        const b = await payFirst('rail', args, () => tripPost('rail-book', args)); // the card held at Stripe first, when payments are on
        t.state = 'done';
        t.result = `Booked${b.carrier_refs && b.carrier_refs[0] ? `: reference ${b.carrier_refs[0]}` : ''}. The tickets go to ${email.value}.${call.args.stop ? ' The stop is marked booked.' : ''}`;
      } catch (e) { t.state = 'error'; t.error = String(e.message || e); }
      redraw();
    } }, 'Book'),
    el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'done'; t.result = 'Not booked.'; redraw(); } }, 'Cancel')));
  return root;
}

/**
 * Booking a hotel inside Eden (Duffel Stays): the card asks Duffel for the live price first (a quote) and shows it with
 * anything paid at the hotel and until when it cancels for free; the person types the guests' names, email and phone
 * (never the model) and presses Book. Only that button sends confirm: true.
 */
const QUOTING = new WeakSet();
function stayCard(t, call, redraw) {
  const root = el('div', { class: `toolcard ${t.state}`, role: 'group', 'aria-label': 'Book this hotel?', 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico('globe', 15), 'Book this hotel?'));
  if (!t.quote && !t.quoteError && !QUOTING.has(t) && t.state !== 'done') {
    QUOTING.add(t);
    Promise.all([tripPost('stays-quote', { rate_id: call.args.rate_id }), call.args.id ? tripGet(call.args.id).catch(() => null) : null])
      .then(([q, r]) => { t.quote = q; t.guests = (r && r.trip && r.trip.travelers) || 1; })
      .catch((e) => { t.quoteError = String(e.message || e); })
      .finally(() => { QUOTING.delete(t); redraw(); });
  }
  if (t.quoteError) { root.append(el('div', 'tc-error', t.quoteError)); return root; }
  if (!t.quote) { root.append(el('div', 'tc-notice', 'Checking the price with the hotel…')); return root; }
  const q = t.quote;
  const rows = [['Hotel', q.accommodation ? q.accommodation.name : '—'], ['Room', q.room || '—'], ['Dates', `${q.check_in} → ${q.check_out}`], ['Total now', `${q.total} ${q.currency}`]];
  if (q.due_at_accommodation && Number(q.due_at_accommodation) > 0) rows.push(['Paid at the hotel', `${q.due_at_accommodation} ${q.due_at_accommodation_currency || q.currency}`]);
  rows.push(['Free cancellation', q.cancellation && q.cancellation.free_until ? `until ${String(q.cancellation.free_until).slice(0, 16).replace('T', ' ')} UTC` : 'No: not refundable']);
  // the programme the quote earns with, as Duffel's quote names it (site travel/stayops.js); nothing when it names none
  if (q.loyalty) rows.push(['Loyalty', q.loyalty.saved.length ? `Earns with ${q.loyalty.name}: Eden sends ${q.loyalty.saved.map((x) => `${x.guest}’s ${x.number}`).join(' or ')} if they are a guest` : `Earns with ${q.loyalty.name} (no number saved: add one in Travel profile)`]);
  if (q.mode === 'test') rows.push(['Mode', 'Test: not a real hotel or charge']);
  root.append(el('dl', 'tc-rows', ...rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', { 'data-no-i18n': '' }, String(v))])), el('div', 'tc-src', `Checked with ${q.source} · ${String(q.checked_at).slice(0, 16).replace('T', ' ')} UTC`));
  if (t.state === 'done') { root.append(el('div', 'tc-done', ico('check', 14), t.result || 'Booked.')); return root; }
  const form = el('form', { class: 'tc-form', onsubmit: (e) => e.preventDefault() });
  const names = [...Array(Math.max(1, Math.min(9, t.guests || 1)))].map((_, i) => [
    el('input', { type: 'text', autocomplete: i ? 'off' : 'given-name', placeholder: `Guest ${i + 1} first name`, 'aria-label': `Guest ${i + 1} first name`, required: '' }),
    el('input', { type: 'text', autocomplete: i ? 'off' : 'family-name', placeholder: 'Last name', 'aria-label': `Guest ${i + 1} last name`, required: '' })]);
  const email = el('input', { type: 'email', autocomplete: 'email', placeholder: 'Email for the booking', 'aria-label': 'Email', required: '' });
  const phone = el('input', { type: 'tel', autocomplete: 'tel', placeholder: 'Phone, like +15555550100', 'aria-label': 'Phone', required: '' });
  if (!t.typed) t.typed = {};
  const remember = (input, k) => { if (t.typed[k] !== undefined) input.value = t.typed[k]; input.addEventListener('input', () => { t.typed[k] = input.value; }); };
  names.forEach(([g, f], i) => { remember(g, `g${i}`); remember(f, `f${i}`); }); remember(email, 'email'); // the phone isn't kept
  form.append(...names.flatMap((p) => [el('div', 'tc-row2', ...p)]), email, phone);
  root.append(form);
  // which of the person's cards earns most on this booking, at the price about to be paid (travel-perks.js)
  if (call.args && call.args.id && call.args.stop) { const slot = el('div'); root.append(slot); bookingCardNote({ id: call.args.id, stop: call.args.stop, cost: q && q.total ? { amount: Number(q.total), currency: q.currency } : null }).then((n) => { if (n) slot.replaceWith(n); }, () => {}); }
  if (t.error) root.append(el('div', 'tc-error', t.error));
  root.append(el('div', 'tc-acts',
    el('button', { type: 'button', class: 'cap primary', onclick: async () => {
      if (!form.reportValidity()) return;
      t.state = 'running'; delete t.error; redraw();
      try {
        const args = { quote_id: q.quote_id, guests: names.map(([g, f]) => ({ given_name: g.value, family_name: f.value })), email: email.value, phone_number: phone.value.replace(/[\s()-]/g, ''), ...(call.args.id ? { id: call.args.id, stop: call.args.stop } : {}), confirm: true };
        const b = await payFirst('stay', args, () => tripPost('stays-book', args)); // the card held at Stripe first, when payments are on
        t.state = 'done';
        t.result = `Booked: ${b.accommodation ? b.accommodation.name : 'the hotel'}, reference ${b.reference || b.booking_id}.${b.loyalty ? ` ${b.loyalty.name} number ${b.loyalty.number} (${b.loyalty.guest}) sent to the hotel.` : ''}${call.args.stop ? ' The stay is marked booked, and Eden watches the price until free cancellation ends.' : ''}`;
      } catch (e) { t.state = 'error'; t.error = String(e.message || e); }
      redraw();
    } }, 'Book'),
    el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'done'; t.result = 'Not booked.'; redraw(); } }, 'Cancel')));
  return root;
}

/** Saving the person's card names: what Eden has checked rates for comes from the server's match, not the model. */
function cardsCard(t, call, redraw) {
  const root = el('div', { class: `toolcard ${t.state}`, role: 'group', 'aria-label': 'Save your cards?', 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico('globe', 15), 'Save your cards?'));
  if (!t.match && t.state === 'pending' && !LOADING.has(t)) {
    LOADING.add(t);
    tripPost('cards-match', { names: call.args.names })
      .then((r) => { t.match = r.cards; })
      .catch((e) => { t.state = 'error'; t.error = String(e.message || e); })
      .finally(() => { LOADING.delete(t); redraw(); });
  }
  const list = t.match ? TT.cardRows(t.match) : call.args.names.map((n) => [n, '…']);
  root.append(el('dl', 'tc-rows', ...list.flatMap(([k, v]) => [el('dt', { 'data-no-i18n': '' }, k), el('dd', '', v)])));
  if (t.state === 'done') { root.append(el('div', 'tc-done', ico('check', 14), t.result)); return root; }
  if (t.state === 'cancelled') { root.append(el('div', 'tc-done muted', 'Not saved.')); return root; }
  if (t.state === 'running') { root.append(el('div', 'tc-done muted', 'Working…')); return root; }
  root.append(el('div', 'tc-notice', 'Names only: Eden never asks for or keeps card numbers. Earn rates come from each issuer’s own page, with the date they were checked.'));
  if (t.state === 'error') root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', t.error)));
  const acts = el('div', 'tc-acts');
  if (t.match) acts.append(el('button', { type: 'button', class: 'cap primary', onclick: async () => {
    t.state = 'running'; redraw();
    try { await tripPost('cards-save', { names: call.args.names, confirm: true }); t.state = 'done'; t.result = 'Saved. Each priced item in your trips now shows what each card earns.'; }
    catch (e) { t.state = 'error'; t.error = String(e.message || e); }
    redraw();
  } }, 'Save my cards'));
  acts.append(el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'cancelled'; redraw(); } }, 'Cancel'));
  root.append(acts);
  return root;
}

/** A booking from Eden Mail: what the card shows is the server's own read of the email; Add / Mark as booked reads it again. */
function mailCard(t, call, redraw) {
  const root = el('div', { class: `toolcard ${t.state}`, role: 'group', 'aria-label': 'Add this booking to your trip?', 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico('globe', 15), 'Add this booking to your trip?'));
  if (!t.found && t.state === 'pending' && !LOADING.has(t)) {
    LOADING.add(t);
    Promise.all([tripPost('mail-preview', { id: call.args.id, message: call.args.message, index: call.args.index }), tripGet(call.args.id)])
      .then(([p, r]) => {
        t.found = p.candidate;
        const sid = call.args.stop || (p.candidate.match.action === 'mark' ? p.candidate.match.stop : null);
        const s = sid ? r.trip.days.flatMap((d) => d.stops).find((x) => x.id === sid) : null;
        t.stopName = s ? s.place.name : null;
        if (!p.candidate.booking.ref) { t.state = 'error'; t.error = 'That email has no booking reference, so nothing can be marked booked.'; }
        else if (p.candidate.match.action === 'none' && !call.args.stop) { t.state = 'error'; t.error = p.candidate.match.why; }
      })
      .catch((e) => { t.state = 'error'; t.error = String(e.message || e); })
      .finally(() => { LOADING.delete(t); redraw(); });
  }
  if (t.found) root.append(el('dl', 'tc-rows', ...TT.mailRows(t.found, t.stopName).flatMap(([k, v]) => [el('dt', '', k), el('dd', { 'data-no-i18n': '' }, String(v))])));
  else if (t.state === 'pending') root.append(el('div', 'tc-done muted', 'Reading the email…'));
  if (t.state === 'done') { root.append(el('div', 'tc-done', ico('check', 14), t.result)); return root; }
  if (t.state === 'cancelled') { root.append(el('div', 'tc-done muted', 'Not added. Nothing was changed.')); return root; }
  if (t.state === 'running') { root.append(el('div', 'tc-done muted', 'Working…')); return root; }
  if (t.found && !t.found.booking.structured) root.append(el('div', 'tc-notice', 'This email has no booking data, only a reference: check it’s the right booking.'));
  root.append(el('div', 'tc-notice', 'Read from your Eden Mail. Nothing changes until you press the button; the booked stop is then locked.'));
  if (t.state === 'error') root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', t.error)));
  const acts = el('div', 'tc-acts');
  if (t.found && t.state !== 'error') acts.append(el('button', { type: 'button', class: 'cap primary', onclick: async () => {
    t.state = 'running'; redraw();
    try {
      const r = await tripPost('mail-import', { ...call.args, confirm: true });
      t.state = 'done';
      t.result = `Saved to “${r.trip.title}”: ${t.found.booking.ref} is booked and locked.`;
    } catch (e) { t.state = 'error'; t.error = String(e.message || e); }
    redraw();
  } }, t.found.match.action === 'add' && !call.args.stop ? 'Add to trip' : 'Mark as booked'));
  acts.append(el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'cancelled'; redraw(); } }, 'Cancel'));
  root.append(acts);
  return root;
}

/*
 * The in-flight map: the route as a great circle, the plane where it is now, time to go, altitude and speed, like a
 * seatback map. The picture is a dark Google static map the server fetches (its key never reaches the page); the plane
 * is drawn on top. FlightAware is asked at most every 5 minutes (the server caches it); in between the plane moves on
 * from its last speed and heading. It stops asking once the flight has landed, or the card leaves the screen.
 */
const LIVE = new WeakMap(); // card state → { live, map: { url, center, zoom }, timers } (never saved with the chat)
const W = 640, H = 320;
const PLANE = 'M0,-11 L2,-3 L10,1 L10,3 L2,1.5 L1.5,7 L4,9 L4,10.5 L0,9.5 L-4,10.5 L-4,9 L-1.5,7 L-2,1.5 L-10,3 L-10,1 L-2,-3 Z';
const svg = (tag, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };

function flightMapCard(c, node, t, call) {
  const root = el('div', { class: `toolcard ${t.state === 'error' ? 'error' : 'done'} trip-flightmap`, role: 'group', 'aria-label': `Flight ${call.args.ident} on a map`, 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico('globe', 15), `Flight ${call.args.ident}`));
  const st = LIVE.get(t) || { live: null, map: null, timers: [] };
  LIVE.set(t, st);
  const frame = el('div', { class: 'tf-frame', style: 'position:relative;width:100%;aspect-ratio:2/1;border-radius:14px;overflow:hidden;background:#0b1a2e;margin-top:8px' });
  const pic = el('img', { alt: '', style: 'position:absolute;inset:0;width:100%;height:100%;display:block' });
  const over = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', style: 'position:absolute;inset:0;width:100%;height:100%', 'aria-hidden': 'true' });
  frame.append(pic, over);
  const strip = el('dl', 'tc-rows');
  const note = el('div', 'tc-notice', 'Live from FlightAware, refreshed every few minutes. Times in UTC.');
  root.append(frame, strip, note);

  const draw = () => {
    const { live, map } = st;
    over.replaceChildren();
    if (!live) return;
    strip.replaceChildren(...TT.flightStrip(live).flatMap(([k, v]) => [el('dt', '', k), el('dd', { 'data-no-i18n': '' }, String(v))]));
    if (!map || !live.from || !live.to) return;
    pic.src = map.url;
    const P = (p) => TT.project(p, map.center, map.zoom, W, H);
    const line = TT.greatCircle(live.from, live.to, 80).map(P);
    const plane = TT.planeAt(live);
    const d = (pts) => pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
    over.append(svg('path', { d: d(line), fill: 'none', stroke: '#7cc4ff', 'stroke-width': 2, 'stroke-dasharray': '6 6', opacity: 0.55 }));
    if (plane) {
      // the flown part solid, up to the plane
      const at = P(plane);
      let k = 0, best = Infinity;
      line.forEach((q, i) => { const dd = (q.x - at.x) ** 2 + (q.y - at.y) ** 2; if (dd < best) { best = dd; k = i; } });
      over.append(svg('path', { d: d([...line.slice(0, k + 1), at]), fill: 'none', stroke: '#7cc4ff', 'stroke-width': 3 }));
    }
    for (const [p, code] of [[live.from, live.flight.origin && live.flight.origin.code], [live.to, live.flight.destination && live.flight.destination.code]]) {
      const q = P(p);
      over.append(svg('circle', { cx: q.x, cy: q.y, r: 5, fill: '#ffffff', stroke: '#0b1a2e', 'stroke-width': 2 }));
      const label = svg('text', { x: q.x + 9, y: q.y + 4, fill: '#ffffff', 'font-size': 13, 'font-weight': 600, 'font-family': 'system-ui, -apple-system, sans-serif' });
      label.textContent = code || '';
      over.append(label);
    }
    if (plane) {
      const q = P(plane);
      over.append(svg('path', { d: PLANE, fill: plane.how === 'live' ? '#ffd166' : '#ffffff', stroke: '#0b1a2e', 'stroke-width': 1, transform: `translate(${q.x.toFixed(1)},${q.y.toFixed(1)}) rotate(${plane.heading.toFixed(0)}) scale(1.3)` }));
    }
    note.textContent = plane && plane.how === 'estimated' ? 'No live position right now: the plane is placed by its times. Times in UTC.' : 'Live from FlightAware, refreshed every few minutes. Times in UTC.';
  };
  // off: stopped because the card left the page (travel.js makes a new one when it's shown again); landed or failed: done
  const stop = (off = false) => { for (const id of st.timers) clearInterval(id); st.timers = []; if (off) root.dataset.stopped = '1'; };
  const load = async () => {
    try {
      st.live = await tripPost('flight-live', call.args);
      liveFlight(st.live && st.live.flight); // its gate and terminal on the Travel app's Live Activity (nothing elsewhere)
      if (!st.map && st.live.from && st.live.to) {
        const q = new URLSearchParams({ a: `${st.live.from.lat},${st.live.from.lng}`, b: `${st.live.to.lat},${st.live.to.lng}` });
        const res = await fetch(apiUrl(`/api/chat/travel/map?${q}`), { headers: { 'X-Jarvis-Chat': '1' }, credentials: 'same-origin' });
        if (res.ok) {
          const [lat, lng] = String(res.headers.get('x-map-center') || '').split(',').map(Number);
          const blob = await res.blob();
          const url = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result || '')); r.onerror = bad; r.readAsDataURL(blob); });
          st.map = { url, center: { lat, lng }, zoom: Number(res.headers.get('x-map-zoom')) };
        }
      }
      if (!st.live.refresh_s) stop(); // landed or cancelled: nothing more to ask
    } catch (e) {
      stop();
      t.state = 'error';
      root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', String(e.message || e))));
    }
    draw();
  };
  if (!st.timers.length && t.state !== 'error') {
    load();
    // ask again every refresh (5 min); move the plane on every 15 s; stop once the card is off the page
    st.timers.push(setInterval(() => { if (!root.isConnected) return stop(true); load(); }, 5 * 60_000));
    st.timers.push(setInterval(() => { if (!root.isConnected) return stop(true); draw(); }, 15_000));
  } else draw();
  return root;
}
