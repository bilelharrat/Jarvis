// Eden Travel, planning by hand (travel.js hands it its state and helpers through init): a plain New trip form (or Let
// Eden plan it: the server's planner drafts it with web search and checks it on Google Maps; the person presses Create), a
// stop's own edits (time, length, note, cost, how you get there; move to another day; remove), adding a stop from a
// Google place search, a leg to another city at the time the person enters, a printable itinerary (the browser's own
// Save as PDF makes the PDF) and a packing list from the checked forecast and the trip's own words. Every change is the
// person's own press, goes through the server's ops (a booked stop stays locked there; its message shows) and can be
// undone. Rules live in travel-plan-rules.js (pure, tested).

import { el, ico, toast } from './util.js';
import { cancelPlanJob, ensurePlanCss, followPlanJob, planDays, planProgress, planSection, startPlanJob, tripPlan, tripPost } from './trip-ui.js';
import * as PJ from './trip-planjob.js';
import { planView } from './trip-tools.js';
import * as R from './travel-plan-rules.js';

let C = null; // { S, paint, loadTrip, money, hm, dayLong, kicker, chip, keep, ask, tripRef }
export function init(ctx) { C = ctx; setTimeout(resumePlan, 0); }

// Let Eden plan it, as a job (trip-planjob.js): the form shows each step as it happens; the job id is kept for this tab
// (sessionStorage), so a reload opens the form again on the same plan instead of paying for a second one.
const tab = () => (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
function resumePlan() {
  const j = PJ.recallJob(tab());
  if (!j || !C || C.S.newTrip) return;
  const st = { form: true, planning: true, title: j.title || null, quick: Boolean(j.quick) };
  C.S.newTrip = st;
  followJob(st, PJ.planState(j.job, j.startedAt));
}
function followJob(st, v) {
  st.job = v; st.seen = new Set(); st.ctl = new AbortController();
  const ctl = st.ctl;
  const shown = () => C.S.newTrip === st;
  followPlanJob(v, () => { if (shown()) C.paint(); }, ctl.signal).then((end) => {
    if (ctl.signal.aborted) return;
    PJ.rememberJob(tab(), null);
    if (end.state === 'done') { st.plan = { ...end.result, checks: undefined }; st.view = end; if (st.title) st.plan.trip.title = st.title; }
    else if (end.state !== 'cancelled') st.err = end.error || 'The plan stopped.';
  }).catch((x) => { st.err = String(x.message || x); }).finally(() => {
    if (ctl.signal.aborted) return;
    st.planning = false; st.job = null;
    if (shown()) C.paint();
  });
}
/**
 * A plan from elsewhere on the page (travel.js's one-sentence card: quick), shown in the New trip panel as it's made.
 * Resolves once the job has started (or, on an older server, once the one long call has answered); throws if it can't start.
 */
export async function planWithEden(args, { quick = false, title = null } = {}) {
  if (!C) throw new Error('Eden Travel isn’t open yet.');
  const v = await startPlanJob(args);
  const st = { form: true, quick, planning: true, title };
  if (!v) { const plan = await tripPlan(args); C.S.newTrip = { plan, quick }; C.paint(); return; }
  PJ.rememberJob(tab(), { job: v.job, startedAt: v.startedAt, title, quick });
  C.S.newTrip = st;
  followJob(st, v);
  C.paint();
}
function stopPlan(st) {
  if (st.ctl) st.ctl.abort();
  if (st.job && st.job.job) cancelPlanJob(st.job.job);
  PJ.rememberJob(tab(), null);
  st.planning = false; st.job = null;
  C.paint();
  toast('Stopped. Nothing was saved.');
}

const err = (e) => toast(String((e && e.message) || e));
const RM = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: true };
const KIND_WORD = { visit: 'Sight or visit', meal: 'Meal', activity: 'Activity', stay: 'Stay', transport: 'Getting there', rental: 'Rental' };
const MODE_WORD = { walk: 'Walk', transit: 'Public transport', drive: 'Drive', taxi: 'Taxi' };
const undoFor = (id) => ({ label: 'Undo', run: () => tripPost('undo', { id }).catch(err) });
// a form's kept values (travel.js keep) go when the form is done with
function forget(prefix) { const f = C.S.form || {}; for (const k of Object.keys(f)) if (k.startsWith(prefix)) delete f[k]; }
// a panel just opened: into view (no smooth scroll under reduced motion)
function reveal(cls) { setTimeout(() => C.S.pane && C.S.pane.querySelector(cls)?.scrollIntoView({ block: 'nearest', behavior: RM.matches ? 'auto' : 'smooth' }), 0); }

/** A labelled field: the label is the input's name for screen readers; a field in error says so. */
function field(label, input, errKey, wide = false) {
  if (errKey) input.setAttribute('aria-invalid', 'true');
  return el('label', `tv-field${wide ? ' wide' : ''}`, el('span', '', label), input);
}
const input = (attrs) => el('input', { class: 'tv-input', ...attrs });
const select = (attrs, opts) => el('select', { class: 'tv-input', ...attrs }, ...opts.map(([v, t]) => el('option', { value: String(v) }, t)));
function panel(cls, label, onClose, ...body) {
  return el('section', { class: `glass-card tv-plan ${cls}`, 'aria-label': label },
    el('div', 'tv-card-head', el('span', 'tv-kicker accent', label), el('button', { type: 'button', class: 'tv-x', 'aria-label': `Close ${label.toLowerCase()}`, 'data-k': `close:${cls}`, onclick: onClose }, ico('x', 14))),
    ...body);
}
const errLine = (msg) => (msg ? el('p', { class: 'tv-note warn', role: 'alert' }, msg) : null);
function dayOptions(trip, from = 0) {
  const ch = C.S.data.checks;
  return trip.days.map((d, i) => [i, `Day ${i + 1} · ${C.dayLong((ch.days[i] && ch.days[i].date) || R.dayDate(trip.start, i))}`]).slice(from);
}
// a failed form: its message, and the focus on the field to fix
function failed(state, r, keyOf) {
  state.err = r.error; state.errField = r.field || null; C.paint();
  if (r.field) setTimeout(() => C.S.pane.querySelector(`[data-k="${CSS.escape(`f:${keyOf(r.field)}`)}"]`)?.focus(), 0);
}

/* ---------- trip-wide tools (travel.js puts them in its Trip tools menu) ---------- */

/** Travel to another city: the leg form opens (or closes) on the day shown. */
export function toggleLeg() { const S = C.S; S.leg = S.leg ? null : { day: S.day }; C.paint(); if (S.leg) reveal('.tv-legform'); }
/** The packing list opens (or closes); the forecast is asked for once. */
export function togglePack() { const S = C.S; S.packOpen = !S.packOpen; C.paint(); if (S.packOpen) { loadPackWeather(); reveal('.tv-pack'); } }
/** The printable itinerary over the page. */
export function print(trip) { openPrint(trip); }

/** The trip-wide panels that are open (under the photo header). */
export function tripPanels(trip) {
  const S = C.S;
  return [S.newTrip ? newTripPanel() : null, S.leg && !S.member ? legPanel(trip) : null, S.packOpen ? packPanel(trip) : null];
}
/** The day's own panel (adding a stop), inside the day. */
export function dayPanels(trip) {
  const S = C.S;
  return [S.adding && !S.member ? addPanel(trip) : null];
}

/* ---------- 1. a new trip, by hand ---------- */

/** A new trip by hand: the form opens (or closes) over the day view. */
export function toggleNewTrip() {
  const S = C.S;
  S.newTrip = S.newTrip ? null : {};
  if (S.newTrip && S.data) S.view = 'workspace';
  C.paint(); if (S.newTrip) reveal('.tv-newform');
}

export function newTripButton(cls = 'tv-btn') {
  const S = C.S;
  return el('button', { type: 'button', class: `${cls} tv-newtrip`, 'data-k': `plan:new:${cls.split(' ').pop()}`, 'aria-pressed': String(Boolean(S.newTrip)), title: 'Start a trip: let Eden plan it, or make it yourself', onclick: toggleNewTrip }, ico('plus', 13), el('span', 'tv-newtrip-label', 'New trip'));
}

export function newTripPanel() {
  const S = C.S, st = S.newTrip;
  const k = (f) => `new:${f}`;
  const today = new Date(); today.setDate(today.getDate() + 14);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const f = {
    title: input({ type: 'text', maxlength: '120', placeholder: 'Lisbon in spring', autocomplete: 'off' }),
    destination: input({ type: 'text', maxlength: '120', placeholder: 'Lisbon, Portugal', autocomplete: 'off' }),
    start: input({ type: 'date' }),
    days: input({ type: 'number', min: '1', max: String(R.LIMITS.days), inputmode: 'numeric', value: '3' }),
    travelers: input({ type: 'number', min: '1', max: String(R.LIMITS.travelers), inputmode: 'numeric', value: '1' }),
    budget: input({ type: 'number', min: '0', step: '1', inputmode: 'decimal', placeholder: 'Optional' }),
    currency: input({ type: 'text', maxlength: '3', value: 'EUR', class: 'tv-input tiny', autocapitalize: 'characters' }),
    wishes: el('textarea', { class: 'tv-input', rows: '3', maxlength: '1500', placeholder: 'For Let Eden plan it: what you’d like to see and do, fixed times (a train at 18:30), who’s coming' }),
    pace: select({}, [['normal', 'Normal'], ['relaxed', 'Relaxed'], ['packed', 'Packed']]),
  };
  f.start.value = iso(today);
  labelMoney(f.budget, f.currency, 'Budget');
  for (const name of Object.keys(f).reverse()) C.keep(f[name], k(name)); // the name field takes the focus (the last keep's wins)
  const make = async (e) => {
    e.preventDefault();
    const r = R.newTrip(Object.fromEntries(Object.entries(f).map(([n, x]) => [n, x.value])));
    if (r.error) return failed(st, r, k);
    st.busy = true; st.err = null; C.paint();
    try {
      const out = await tripPost('create', { trip: r.trip }); // the trip-changed event shows it
      forget('new:'); S.newTrip = null;
      toast(`“${(out.trip && out.trip.title) || r.trip.title}” made. Add stops by hand or ask Eden.`);
    } catch (x) { st.busy = false; st.err = String(x.message || x); C.paint(); }
  };
  // Let Eden plan it: the same fields as the plan's constraints, the wishes as the person's words (about a minute)
  const planIt = async () => {
    const vals = Object.fromEntries(Object.entries(f).map(([n, x]) => [n, x.value]));
    if (!String(vals.title).trim()) vals.title = String(vals.destination).trim() || 'New trip';
    const r = R.newTrip(vals);
    if (r.error) return failed(st, r, k);
    if (!r.trip.destination) return failed(st, { error: 'Say where the trip is, so Eden can plan it.', field: 'destination' }, k);
    const t = r.trip, n = t.days.length;
    const request = `${String(vals.wishes || '').trim() || `${n} day${n === 1 ? '' : 's'} in ${t.destination}`} (trip name: ${t.title})`;
    const args = { request, constraints: { destination: t.destination, start: t.start, days: n, travelers: t.travelers, ...(t.budget ? { budget: t.budget } : {}), pace: vals.pace || 'normal' } };
    st.planning = true; st.err = null; st.title = t.title; C.paint();
    let v = null;
    try { v = await startPlanJob(args); } catch (x) { st.err = String(x.message || x); st.planning = false; C.paint(); return; }
    if (v) { PJ.rememberJob(tab(), { job: v.job, startedAt: v.startedAt, title: t.title }); followJob(st, v); C.paint(); return; }
    // an older server without plan jobs: one long call, as before
    try {
      st.plan = await tripPlan(args);
      st.plan.trip.title = t.title;
    } catch (x) { st.err = String(x.message || x); }
    st.planning = false; C.paint();
  };
  if (st.plan) return planPanel(st);
  if (st.planning && st.job) {
    return panel('tv-newform', 'Planning your trip', () => stopPlan(st),
      planProgress(st.job, st.seen),
      el('div', 'tv-acts wide', el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': 'new:stop', onclick: () => stopPlan(st) }, 'Stop planning')),
      el('p', 'tv-fine', 'Eden drafts with Gemini and Google Search, then checks every place on Google Maps: open that day and at that time, not closed for good, travel times. Nothing is saved until you press Create.'));
  }
  const bad = (n) => (st.errField === n ? n : null);
  return panel('tv-newform', 'New trip', () => { S.newTrip = null; C.paint(); },
    el('form', { class: 'tv-fields', onsubmit: make, novalidate: '' },
      field('Trip name', f.title, bad('title'), true),
      field('Where (city, country)', f.destination, bad('destination'), true),
      field('First day', f.start, bad('start')),
      field('Days', f.days, bad('days')),
      field('Travellers', f.travelers, bad('travelers')),
      el('div', 'tv-field money', el('span', '', 'Budget (optional)'), el('div', 'tv-amount', f.budget, f.currency)),
      field('What you’d like (optional)', f.wishes, null, true),
      field('Pace', f.pace),
      errLine(st.err),
      el('div', 'tv-acts wide', el('button', { type: 'submit', class: 'tv-btn', 'data-k': 'new:go', disabled: st.busy || st.planning ? '' : null }, st.busy ? 'Making…' : 'Make it empty'),
        el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'new:plan', disabled: st.busy || st.planning ? '' : null, onclick: planIt }, st.planning ? 'Planning… a minute or two' : 'Let Eden plan it'),
        el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { S.newTrip = null; C.paint(); } }, 'Cancel'))),
    el('p', 'tv-fine', st.planning ? 'Eden is drafting the trip with web search, then checking every place on Google Maps: open that day and at that time, not closed for good, travel times.' : 'Let Eden plan it: a whole plan, each place checked on Google Maps, to look at before anything is saved. Or make it empty and add stops yourself.'));
}

// the planned trip, before it's made: its days (with what Google said of each place, when it came from a job), what Eden
// checked and changed, then Create. From the one-sentence card (st.quick) Back closes it; from the form, back to the form.
function planPanel(st) {
  const S = C.S, v = planView(st.plan), trip = st.plan.trip;
  ensurePlanCss();
  const make = async () => {
    st.busy = true; st.err = null; C.paint();
    try {
      const out = await tripPost('create', { trip });
      forget('new:'); S.newTrip = null;
      toast(`“${(out.trip && out.trip.title) || trip.title}” made.${out.checks && out.checks.alerts.length ? ` ${out.checks.alerts.length} thing${out.checks.alerts.length === 1 ? '' : 's'} to look at.` : ''}`);
    } catch (x) { st.busy = false; st.err = String(x.message || x); C.paint(); }
  };
  const back = () => { if (st.quick) S.newTrip = null; else st.plan = null; C.paint(); };
  const longDate = (iso) => { const t = new Date(`${iso}T12:00:00Z`); return Number.isNaN(t.getTime()) ? iso : t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
  const facts = v.rows.filter(([k]) => k !== 'Trip').map(([k, x]) => el('div', 'tvp-fact', el('span', 'tvp-k', k), el('span', { class: 'tvp-v', 'data-no-i18n': '' }, k === 'From' ? longDate(String(x)) : String(x))));
  return panel('tv-newform tv-planned', 'Eden’s plan', () => { S.newTrip = null; C.paint(); },
    el('h3', { class: 'tvp-title', 'data-no-i18n': '' }, trip.title),
    el('div', 'tvp-facts', ...facts),
    el('div', 'tp-live tvp-days', ...planDays(PJ.finalDays(st.plan, st.view || null), (st.seen ||= new Set()))),
    el('div', 'tvp-checked', ...planSection(v)),
    errLine(st.err),
    el('div', 'tv-acts wide',
      el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'new:create', disabled: st.busy ? '' : null, onclick: make }, st.busy ? 'Making…' : 'Create trip'),
      el('button', { type: 'button', class: 'tv-btn quiet', onclick: back }, st.quick ? 'Back' : 'Back to the form')),
    el('p', 'tv-fine', 'Nothing is saved until you press Create.'));
}

function labelMoney(a, cur, label) { a.setAttribute('aria-label', `${label} amount`); cur.setAttribute('aria-label', `${label} currency`); }

/* ---------- 2. a stop's own edits ---------- */

/** Under a stop's detail: Edit, Move to another day, Remove (never for someone the trip is shared with, never offline). */
export function stopTools(trip, s) {
  const S = C.S;
  if (S.member) return null;
  if (S.editStop === s.id) return stopForm(trip, s);
  const others = dayOptions(trip).filter(([i]) => i !== S.day);
  const to = others.length ? select({ class: 'tv-input small', 'aria-label': `Move ${s.place.name} to`, 'data-k': `moveto:${s.id}` }, others) : null;
  return el('div', 'tv-acts tv-stoptools',
    el('button', { type: 'button', class: 'tv-btn', 'data-k': `edit:${s.id}`, onclick: () => { S.editStop = s.id; C.paint(); } }, ico('edit', 13), 'Edit'),
    to ? el('span', 'tv-moveto', to, el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `move:${s.id}`, onclick: () => moveStop(s, Number(to.value)) }, 'Move')) : null,
    el('button', { type: 'button', class: 'tv-btn quiet danger', 'data-k': `remove:${s.id}`, onclick: () => removeStop(s) }, ico('trash', 13), 'Remove'));
}

async function edit(ops, said) {
  const id = C.S.id;
  try { await tripPost('edit', { id, ops }); toast(said, undoFor(id)); return true; } catch (e) { err(e); return false; } // a booked stop: the server says why
}
async function removeStop(s) {
  if (s.booked) return toast(`${s.place.name} is booked, so it stays. Cancel or change the booking first.`);
  if (!confirm(`Remove “${s.place.name}” from the trip?`)) return;
  if (await edit([{ op: 'remove', stop: s.id }], `Removed ${s.place.name}`)) { C.S.open = null; }
}
async function moveStop(s, day) {
  if (s.booked) return toast(`${s.place.name} is booked, so it keeps its day. Change the booking first.`);
  if (await edit([{ op: 'move', stop: s.id, day }], `${s.place.name} moved to Day ${day + 1}`)) { C.S.open = null; }
}

function stopForm(trip, s) {
  const S = C.S;
  const st = (S.stopErr && S.stopErr.id === s.id) ? S.stopErr : { id: s.id };
  const k = (n) => `stop-${s.id}:${n}`;
  const f = {
    at: input({ type: 'time', value: s.at, required: '' }),
    minutes: input({ type: 'number', min: '0', max: '1440', step: '5', inputmode: 'numeric', value: String(s.minutes) }),
    mode: select({}, Object.entries(MODE_WORD)),
    amount: input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'None', value: s.cost ? String(s.cost.amount) : '' }),
    currency: input({ type: 'text', maxlength: '3', class: 'tv-input tiny', value: s.cost ? s.cost.currency : (trip.budget && trip.budget.currency) || 'EUR' }),
    note: el('textarea', { class: 'tv-input', rows: '2', maxlength: '500', placeholder: 'Anything to remember' }),
  };
  f.mode.value = s.mode || 'walk';
  f.note.value = s.note || '';
  labelMoney(f.amount, f.currency, 'Cost');
  for (const n of Object.keys(f).reverse()) C.keep(f[n], k(n));
  const close = () => { S.editStop = null; S.stopErr = null; forget(`stop-${s.id}:`); C.paint(); };
  const save = async (e) => {
    e.preventDefault();
    const r = R.stopEditOps(s, Object.fromEntries(Object.entries(f).map(([n, x]) => [n, x.value])));
    if (r.error) { S.stopErr = { id: s.id }; return failed(S.stopErr, r, k); }
    if (!r.ops.length) return close();
    if (await edit(r.ops, `${s.place.name} saved`)) close();
  };
  const bad = (n) => (st.errField === n ? n : null);
  const first = trip.days[S.day].stops[0] === s;
  return el('form', { class: 'tv-fields tv-stopform', onsubmit: save, novalidate: '', 'aria-label': `Edit ${s.place.name}` },
    s.booked ? el('p', 'tv-note wide', 'Booked: the note can change here; the time, length and cost follow the booking.') : null,
    field('Time', f.at, bad('at')),
    field('Length (min)', f.minutes, bad('minutes')),
    field(first ? 'Getting here' : 'From the stop before', f.mode, bad('mode')),
    el('div', 'tv-field money', el('span', '', 'Cost'), el('div', 'tv-amount', f.amount, f.currency)),
    field('Note', f.note, null, true),
    errLine(st.err),
    el('div', 'tv-acts wide', el('button', { type: 'submit', class: 'tv-btn primary', 'data-k': `save:${s.id}` }, 'Save'), el('button', { type: 'button', class: 'tv-btn quiet', onclick: close }, 'Cancel')));
}

/* ---------- 3. add a stop by hand ---------- */

/** Add a stop by hand: the search panel opens (or closes) on the day shown. */
export function toggleAdd() { const S = C.S; S.adding = S.adding ? null : { day: S.day }; C.paint(); if (S.adding) reveal('.tv-addform'); }

function addPanel(trip) {
  const S = C.S, st = S.adding;
  const q = input({ type: 'search', placeholder: 'A place: Time Out Market, Belém Tower…', autocomplete: 'off', 'aria-label': 'Search for a place' });
  const close = () => { S.adding = null; forget('add:'); C.paint(); };
  const search = async (e) => {
    e.preventDefault();
    const text = q.value.trim();
    if (text.length < 2) return q.focus();
    st.busy = true; st.err = null; st.pick = null; C.paint();
    // near this day's stops (or any on the map), so a name finds the one in this city
    const day = trip.days[S.day].stops.find((x) => Number.isFinite(x.place.lat)) || trip.days.flatMap((d) => d.stops).find((x) => Number.isFinite(x.place.lat));
    try {
      const r = await tripPost('places', { text: trip.destination && !text.toLowerCase().includes(String(trip.destination).split(',')[0].toLowerCase()) && !day ? `${text}, ${trip.destination}` : text, ...(day ? { near: { lat: day.place.lat, lng: day.place.lng } } : {}) });
      st.results = r.places || []; st.maps = r.maps;
      if (!st.results.length) st.err = 'Nothing found by that name. Try the full name, or add the city.';
    } catch (x) { st.results = []; st.err = String(x.message || x); }
    st.busy = false; C.paint();
  };
  C.keep(q, 'add:q');
  const source = st.maps === 'google' ? 'Google Maps' : 'Sample data: no live maps here';
  return panel('tv-addform', 'Add a stop', close,
    el('form', { class: 'tv-form', role: 'search', onsubmit: search }, q, el('button', { type: 'submit', class: 'tv-btn primary', 'data-k': 'add:search', disabled: st.busy ? '' : null }, st.busy ? 'Looking…' : 'Search')),
    errLine(st.err),
    st.pick ? addForm(trip, st) : st.results && st.results.length ? el('ul', 'tv-xlist tv-found', ...st.results.map((p, i) => el('li', 'tv-found-row',
      el('div', '', el('b', '', p.name), el('span', 'tv-meta', p.address || ''),
        el('small', '', [p.status === 'closed_permanently' ? 'Closed for good' : p.status === 'closed_temporarily' ? 'Closed for now' : null, `${source}${p.checked_at ? ` · ${new Date(p.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`].filter(Boolean).join(' · '))),
      el('button', { type: 'button', class: 'tv-btn', 'data-k': `pick:${i}`, disabled: p.status === 'closed_permanently' ? '' : null, onclick: () => { st.pick = p; st.err = null; C.paint(); } }, 'Choose')))) : null,
    el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { close(); C.ask(`Add something to Day ${S.day + 1} of ${C.tripRef(trip)}: find a good place near my other stops, with real hours, and propose it.`); } }, ico('spark', 13), 'Ask Eden to suggest one')));
}

function addForm(trip, st) {
  const S = C.S;
  const p = st.pick;
  const k = (n) => `add:${n}`;
  const f = {
    day: select({}, dayOptions(trip)),
    at: input({ type: 'time', required: '' }),
    minutes: input({ type: 'number', min: '0', max: '1440', step: '5', inputmode: 'numeric', value: '60' }),
    kind: select({ onchange: (e) => { st.kind = e.target.value; C.paint(); } }, R.KINDS.map((x) => [x, KIND_WORD[x]])),
    nights: input({ type: 'number', min: '1', max: '60', inputmode: 'numeric', value: '1' }),
  };
  f.day.value = String(st.day ?? S.day);
  f.kind.value = st.kind || 'visit';
  for (const n of ['nights', 'kind', 'minutes', 'day', 'at']) C.keep(f[n], k(n)); // the time is focused
  const add = async (e) => {
    e.preventDefault();
    const r = R.addStopOp(p, Object.fromEntries(Object.entries(f).map(([n, x]) => [n, x.value])), trip.days.length);
    if (r.error) return failed(st, r, k);
    if (await edit([r.op], `${p.name} added to Day ${r.op.day + 1} at ${r.op.stop.at}`)) { S.day = r.op.day; S.adding = null; forget('add:'); }
  };
  const bad = (n) => (st.errField === n ? n : null);
  return el('form', { class: 'tv-fields', onsubmit: add, novalidate: '', 'aria-label': `Add ${p.name}` },
    el('p', 'wide tv-picked', el('b', '', p.name), p.address ? el('span', 'tv-meta', ` · ${p.address}`) : null,
      el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { st.pick = null; C.paint(); } }, 'Change')),
    field('Day', f.day, bad('day')),
    field('Time', f.at, bad('at')),
    field('Length (min)', f.minutes, bad('minutes')),
    field('Kind', f.kind, null),
    (st.kind || 'visit') === 'stay' ? field('Nights', f.nights, bad('nights')) : null,
    el('div', 'tv-acts wide', el('button', { type: 'submit', class: 'tv-btn primary', 'data-k': 'add:go' }, 'Add to the trip')),
    el('p', 'tv-fine wide', 'Its hours and the travel time from the stop before are checked once it’s added.'));
}

/* ---------- 4. a leg to another city ---------- */

function legPanel(trip) {
  const S = C.S, st = S.leg;
  const k = (n) => `leg:${n}`;
  const city = String(trip.destination || '').split(',')[0].trim();
  const day = Number.isInteger(st.day) ? st.day : S.day;
  const f = {
    from: input({ type: 'text', maxlength: '50', value: city, autocomplete: 'off' }),
    to: input({ type: 'text', maxlength: '50', placeholder: 'Porto', autocomplete: 'off' }),
    mode: select({}, Object.entries(R.LEG_MODES)),
    day: select({ onchange: (e) => { st.day = Number(e.target.value); C.paint(); } }, dayOptions(trip)),
    at: input({ type: 'time', required: '' }),
    minutes: input({ type: 'number', min: '1', max: '1440', step: '5', inputmode: 'numeric', placeholder: '180' }),
    until: select({}, dayOptions(trip, day)),
  };
  f.mode.value = 'train';
  f.day.value = String(day);
  f.until.value = String(trip.days.length - 1);
  for (const n of ['until', 'minutes', 'at', 'mode', 'from', 'to']) C.keep(f[n], k(n)); // "to" is focused
  if (Number(f.until.value) < day) f.until.value = String(day); // a later travel day picked: the stay starts there
  const rename = el('input', { type: 'checkbox', checked: st.rename === false ? null : '', onchange: (e) => { st.rename = e.target.checked; } });
  const close = () => { S.leg = null; forget('leg:'); C.paint(); };
  const go = async (e) => {
    e.preventDefault();
    const r = R.legOps(trip, { ...Object.fromEntries(Object.entries(f).map(([n, x]) => [n, x.value])), rename: rename.checked });
    if (r.error) return failed(st, r, k);
    const to = f.to.value.trim();
    if (await edit(r.ops, `${R.LEG_MODES[f.mode.value]} to ${to} added on Day ${Number(f.day.value) + 1}`)) { S.day = Number(f.day.value); S.leg = null; forget('leg:'); }
  };
  const bad = (n) => (st.errField === n ? n : null);
  return panel('tv-legform', 'Travel to another city', close,
    el('form', { class: 'tv-fields', onsubmit: go, novalidate: '' },
      field('From', f.from, bad('from')),
      field('To', f.to, bad('to')),
      field('By', f.mode, null),
      field('Day you travel', f.day, bad('day')),
      field('Leaves at', f.at, bad('at')),
      field('Journey (min)', f.minutes, bad('minutes')),
      field('In the new city until', f.until, bad('until')),
      el('label', 'tv-check-row wide', rename, el('span', '', 'Name those days after the new city (a day’s own title stays after it)')),
      errLine(st.err),
      el('div', 'tv-acts wide', el('button', { type: 'submit', class: 'tv-btn primary', 'data-k': 'leg:go' }, 'Add the journey'), el('button', { type: 'button', class: 'tv-btn quiet', onclick: close }, 'Cancel'))),
    el('p', 'tv-fine', 'Use the time on your ticket or the timetable: Eden doesn’t fill it in. To find and book a seat, open the journey and press Book.'));
}

/* ---------- 5. the printable itinerary ---------- */

function openPrint(trip) {
  const S = C.S;
  document.querySelector('.tv-print')?.remove();
  const ch = S.data.checks;
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const checkLine = (name, b) => (b ? el('li', `tv-pr-check ${b.status}`, `${name}: ${b.text}`, el('span', 'tv-pr-src', b.status === 'sample' ? ' · sample data, not checked' : b.source ? ` · ${b.source}${b.checked_at ? `, checked ${when(b.checked_at)}` : ''}` : ' · not checked')) : null);
  const weatherOf = (i) => {
    const w = S.weather && S.weather[i];
    if (!w) return null;
    if (w.forecast === null || w.why) return el('p', 'tv-pr-wx', /too far ahead/i.test(w.why || '') ? 'No forecast yet: too far ahead' : `No forecast: ${String(w.why || 'none').replace(/^./, (x) => x.toLowerCase())}`);
    return el('p', 'tv-pr-wx', `${w.summary || 'Weather'} · ${Math.round(w.high_c)}° / ${Math.round(w.low_c)}°${w.rain_chance_pct != null ? ` · ${w.rain_chance_pct}% rain` : ''} · ${w.source || 'Open-Meteo'}${w.checked_at ? `, checked ${when(w.checked_at)}` : ''}`);
  };
  const first = ch.days[0] && ch.days[0].date, last = ch.days.at(-1) && ch.days.at(-1).date;
  const close = () => { sheet.remove(); document.body.classList.remove('tv-printing'); removeEventListener('keydown', esc); S.pane.querySelector('[data-k="plan:print"]')?.focus(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const sheet = el('div', { class: 'tv-print', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Printable itinerary' },
    el('div', 'tv-print-bar',
      el('span', '', 'Print, or choose “Save as PDF” in the print window.'),
      el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'print-go', onclick: () => print() }, ico('doc', 13), 'Print / PDF'),
      el('button', { type: 'button', class: 'tv-btn', onclick: close }, 'Close')),
    el('article', 'tv-print-sheet',
      el('header', '',
        el('h1', '', trip.title),
        el('p', '', [trip.destination, `${C.dayLong(first)}${last && last !== first ? ` – ${C.dayLong(last)}` : ''}`, `${trip.days.length} day${trip.days.length === 1 ? '' : 's'}`, `${trip.travelers} traveller${trip.travelers === 1 ? '' : 's'}`,
          trip.budget ? `budget ${C.money(trip.budget.amount, trip.budget.currency)}` : null].filter(Boolean).join(' · '))),
      ...trip.days.map((d, i) => {
        const c = ch.days[i] || { stops: [] };
        return el('section', 'tv-pr-day',
          el('h2', '', `Day ${i + 1} · ${C.dayLong(c.date || R.dayDate(trip.start, i))}`, /^Day \d+$/.test(d.title) ? null : el('span', '', ` · ${d.title}`)),
          weatherOf(i),
          d.stops.length ? el('ol', 'tv-pr-stops', ...d.stops.map((s, k) => {
            const b = (c.stops[k] || {}).badges || {};
            return el('li', '',
              el('div', 'tv-pr-head', el('b', 'tv-pr-time', s.at), el('b', '', s.place.name),
                el('span', 'tv-pr-meta', [KIND_WORD[s.kind] && s.kind !== 'visit' ? KIND_WORD[s.kind] : null, C.hm(s.minutes), s.cost ? C.money(s.cost.amount, s.cost.currency) : null, s.nights ? `${s.nights} night${s.nights === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '))),
              s.place.address ? el('p', 'tv-pr-addr', s.place.address) : null,
              s.booked ? el('p', 'tv-pr-booked', `Booked${s.booked.ref ? ` · ref ${s.booked.ref}` : ''}${s.booked.provider ? ` · ${s.booked.provider}` : ''}`) : null,
              s.note ? el('p', 'tv-pr-note', s.note) : null,
              el('ul', 'tv-pr-checks', checkLine('Hours', b.hours), checkLine('Getting there', b.travel), checkLine('Price', b.price)));
          })) : el('p', 'tv-pr-wx', 'Nothing planned yet.'));
      }),
      el('footer', '', `Printed ${new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} from Eden Travel. Each check names its source and when it was made; “sample data” was not checked against a live source.`)));
  document.body.append(sheet);
  document.body.classList.add('tv-printing');
  addEventListener('keydown', esc);
  sheet.querySelector('[data-k="print-go"]').focus();
}

/* ---------- 6. the packing list ---------- */

async function loadPackWeather() {
  const S = C.S;
  if (S.weather || S.packWeatherFor === S.id || S.member) return; // the trip's own forecast is there, asked already, or not ours to ask
  const id = (S.packWeatherFor = S.id);
  try { const w = await tripPost('weather', { id }); if (S.id === id && !S.weather) { S.packWeather = w.days || []; C.paint(); } } catch { S.packWeather = null; }
}
const PACK = (id) => `eden:travel:pack:${id}`;
function ticks(id) { try { return new Set(JSON.parse(localStorage.getItem(PACK(id)) || '[]')); } catch { return new Set(); } }
function setTick(id, item, on) {
  try { const t = ticks(id); if (on) t.add(item); else t.delete(item); localStorage.setItem(PACK(id), JSON.stringify([...t])); } catch { /* storage blocked: ticks last this visit only */ }
}

function packPanel(trip) {
  const S = C.S;
  const weather = S.weather || (S.packWeatherFor === S.id ? S.packWeather : null) || null;
  const { items, notes } = R.packingList(trip, weather);
  const done = ticks(S.id);
  const left = items.filter((x) => !done.has(x.id)).length;
  return panel('tv-pack', 'Packing list', () => { S.packOpen = false; C.paint(); },
    el('p', 'tv-note', left ? `${left} of ${items.length} to pack` : 'All packed'),
    el('ul', 'tv-packlist', ...items.map((x) => {
      const box = el('input', { type: 'checkbox', 'data-k': `pack:${x.id}`, checked: done.has(x.id) ? '' : null, onchange: (e) => { setTick(S.id, x.id, e.target.checked); C.paint(); } });
      return el('li', done.has(x.id) ? 'done' : '', el('label', '', box, el('span', '', el('b', '', x.item), el('small', '', `Why: ${x.why}`))));
    })),
    ...notes.map((n) => el('p', 'tv-note', n)),
    el('p', 'tv-fine', 'From the trip itself: its days, nights and travellers, Open-Meteo’s forecast for each day’s first place, and words in your stops’ own names and notes. Ticks stay on this device.'));
}
