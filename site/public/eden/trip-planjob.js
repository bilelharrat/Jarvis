// A new trip's plan as a job (the Worker's travel/planjob.js): the pure part behind the planning card (trip-ui.js) and the
// New trip form (travel-plan.js). The server keeps each step as it happens; the page polls and shows them: a first sketch
// (marked not checked), the draft's days, each place as Google Maps answered it, each change, then the create card.
// No DOM, no imports, so the tests load it as is.

export const POLL_MS = 1500;
const KEY = 'eden.tripPlanJob'; // sessionStorage: the New trip form's job, so a reload keeps following it

/** A fresh view of a job. */
export function planState(job = null, startedAt = Date.now()) {
  return { job, state: 'running', after: 0, startedAt, stage: null, stageKey: null, sketch: null, draft: null, changes: [], checked: 0, problems: 0, result: null, error: null, code: null };
}

const findStop = (draft, id) => {
  if (!draft) return null;
  for (let d = 0; d < draft.days.length; d++) {
    const i = draft.days[d].stops.findIndex((s) => s.id === id);
    if (i >= 0) return { d, i, s: draft.days[d].stops[i] };
  }
  return null;
};
const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/** The status answer's events (and state) folded into the view, in order. Returns the same object. */
export function applyStatus(v, r) {
  for (const e of (r && Array.isArray(r.events) ? r.events : [])) {
    if (!(e.n > v.after)) continue;
    v.after = e.n;
    if (e.type === 'stage') { v.stage = e.text; v.stageKey = e.stage; }
    else if (e.type === 'sketch' && !v.draft) v.sketch = { label: e.label, title: e.title, days: e.days };
    else if (e.type === 'draft') {
      v.sketch = null; // the draft replaces it
      v.draft = { label: e.label, title: e.title, days: e.days.map((d) => ({ title: d.title, date: d.date, stops: d.stops.map((s) => ({ ...s, check: null, change: null })) })) };
    } else if (e.type === 'place') {
      const f = findStop(v.draft, e.stop);
      if (!f) continue;
      if (!f.s.check) v.checked++;
      if (e.ok === false && !(f.s.check && f.s.check.ok === false)) v.problems++;
      f.s.check = { ok: e.ok, text: e.text, source: e.source, checked_at: e.checked_at };
      if (e.name) f.s.name = e.name; // Google's name
    } else if (e.type === 'change') {
      v.changes.push(e);
      const f = findStop(v.draft, e.stop);
      if (!f) continue;
      f.s.change = { what: e.what, why: e.why, by: e.by };
      if (e.what === 'removed') f.s.gone = true;
      if (e.what === 'replaced') { f.s.name = e.name; f.s.check = null; }
      if ((e.what === 'moved' || e.what === 'retimed' || e.what === 'replaced') && e.to) {
        f.s.at = e.to.at || f.s.at;
        if (Number.isInteger(e.to.day) && e.to.day !== f.d && v.draft.days[e.to.day]) {
          v.draft.days[f.d].stops.splice(f.i, 1);
          v.draft.days[e.to.day].stops.push(f.s);
        }
        v.draft.days[Number.isInteger(e.to.day) && v.draft.days[e.to.day] ? e.to.day : f.d].stops.sort(byTime);
      }
    }
  }
  if (r && r.state) v.state = r.state;
  if (r && r.result) v.result = r.result;
  if (r && r.error) { v.error = r.error; v.code = r.code || null; }
  return v;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Day 2 · Tue 3 Nov" for a day of the draft or sketch. */
export function dayHead(d, i) {
  if (!d.date) return `Day ${i + 1}`;
  const t = new Date(`${d.date}T12:00:00Z`);
  return `Day ${i + 1} · ${DAY[t.getUTCDay()]} ${t.getUTCDate()} ${t.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

/** Where Google's answer came from, short: "Google Maps". */
const short = (src) => (src ? String(src).replace(/\s*\(.*\)\s*$/, '') : '');

/** One stop's line: mark (ok | bad | info | wait | gone), its words, and the change Eden made. */
export function stopLine(s) {
  const c = s.check;
  const mark = s.gone ? 'gone' : !c ? (s.done ? 'plain' : 'wait') : c.ok === true ? 'ok' : c.ok === false ? (s.change ? 'fixed' : 'bad') : 'info';
  const said = c ? `${c.text}${c.source ? ` · ${short(c.source)}` : ''}` : s.kind === 'transport' ? 'getting there: travel time checked with the day' : s.done ? '' : 'checking on Google Maps…';
  const change = s.change ? changeWord(s.change.what) : '';
  return { mark, said, change, why: s.change ? s.change.why : '' };
}
const changeWord = (w) => ({ moved: 'Moved', retimed: 'Re-timed', removed: 'Left out', replaced: 'Swapped in', matched: 'Matched' }[w] || '');

/** A change as one line: "Moved Uffizi Gallery: Day 1 10:00 → Day 2 10:00. Closed Mondays…". */
export function changeLine(c) {
  const when = (x) => (x ? `Day ${x.day + 1} ${x.at}` : '');
  const head = c.what === 'moved' ? `Moved ${c.name}: ${when(c.from)} → ${when(c.to)}.`
    : c.what === 'retimed' ? `Re-timed ${c.name}: ${c.from ? c.from.at : ''} → ${c.to ? c.to.at : ''}.`
      : c.what === 'removed' ? `Left out ${c.name}.`
        : c.what === 'replaced' ? `Swapped ${c.was_name || 'a stop'} for ${c.name}.`
          : `Matched “${c.asked || c.name}” to ${c.name}.`;
  return `${head} ${c.why || ''}`.trim();
}

/**
 * The finished plan's days in the live view's shape (dayHead, stopLine): each kept stop with what Google said of it during
 * the job (by stop id), when there was a job; else just the stops.
 */
export function finalDays(plan, v = null) {
  const seen = new Map();
  if (v && v.draft) for (const d of v.draft.days) for (const s of d.stops) seen.set(s.id, s);
  const start = plan.trip.start;
  return plan.trip.days.map((d, i) => ({
    title: d.title,
    date: start ? new Date(Date.parse(`${start}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10) : null,
    stops: d.stops.map((s) => {
      const was = seen.get(s.id);
      return { id: s.id, at: s.at, kind: s.kind, name: s.place ? s.place.name : '', check: was ? was.check : null, change: was ? was.change : null, done: true };
    }),
  }));
}

/** The live summary for screen readers and the head: "Checked 5 of 12 places · 0:42". */
export function summary(v, now = Date.now()) {
  const s = Math.max(0, Math.round((now - v.startedAt) / 1000));
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const total = v.draft ? v.draft.days.reduce((n, d) => n + d.stops.filter((x) => x.kind !== 'transport').length, 0) : 0;
  const what = v.state === 'done' ? 'Done' : v.state === 'cancelled' ? 'Stopped' : v.state === 'failed' ? 'Stopped on an error'
    : v.draft && v.stageKey !== 'drafting' ? `Checked ${Math.min(v.checked, total)} of ${total} place${total === 1 ? '' : 's'}` : (v.stage || 'Starting');
  return { clock, text: what };
}

/**
 * Follows a job until it ends: post(action, args) is the page's POST to /api/chat/travel; onUpdate(view) after each
 * answer. Network slips are tried again (a few in a row); Cancel through `signal`. → the final view.
 */
export async function followPlan(v, { post, onUpdate, signal, sleep = (ms) => new Promise((res) => setTimeout(res, ms)), tries = 6 }) {
  let slips = 0;
  for (;;) {
    if (signal && signal.aborted) return v;
    let r;
    try { r = await post('plan-status', { job: v.job, after: v.after }); slips = 0; } catch (e) {
      if (e && (e.code === 'not_found' || /no such plan/i.test(String(e.message)))) { v.state = 'failed'; v.error = String(e.message || e); v.code = 'not_found'; onUpdate(v); return v; }
      if (++slips >= tries) throw e;
      await sleep(Math.min(8000, POLL_MS * 2 ** slips));
      continue;
    }
    if (signal && signal.aborted) return v;
    applyStatus(v, r);
    onUpdate(v);
    if (v.state !== 'running') return v;
    await sleep(Number(r.poll_ms) > 0 ? Number(r.poll_ms) : POLL_MS);
  }
}

/** The New trip form's job, kept for this tab (a reload follows it again). */
export function rememberJob(store, job) {
  try { if (job) store.setItem(KEY, JSON.stringify(job)); else store.removeItem(KEY); } catch { /* private mode: no resume */ }
}
export function recallJob(store, now = Date.now()) {
  try {
    const j = JSON.parse(store.getItem(KEY) || 'null');
    // a job is kept a day on the server; after an hour it's surely over and its result read
    return j && /^[0-9a-f]{16}$/.test(String(j.job)) && now - Number(j.startedAt || 0) < 3_600_000 ? j : null;
  } catch { return null; }
}
