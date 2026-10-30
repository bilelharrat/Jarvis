// How often Eden Travel's checks turned out wrong (owner's mission: honest error rates). Three counts, per check kind
// (hours, travel time, price, step-free access, booking window) and per source, per month:
//   shown    a check Eden showed with a live source (each check of a stop counted once a month, however often it's opened)
//   wrong    the person said "This was wrong" on it, with what was actually true
//   changed  a later look found it changed from ok to a problem for the same place, day and plan (hours changed, say):
//            not necessarily wrong when Eden checked, so counted apart
// Only checks against a live source count: never stand-in (sample) data, never the person's own figures (their booking,
// their estimate), never a check whose source didn't answer.
//
// In the account object:
//   tacr:<report> → { id, trip, trip_title, stop, place: { id, name }, day, date, check, shown: { status, text, source,
//                     checked_at }, note, actual, at }   (at most ACCURACY.reports, oldest dropped)
//   tacsnap:<trip> → { snap }  the trip's checks as last seen (checkSnapshot), to find ones that changed
//   tacseen:<trip> → { month, keys }  the checks already counted as shown this month
//   taccq → { counts, due }  increments not yet sent to the global index · taccsent → when they last went (at most hourly)
//   trip-check-report { id, stop, check, note?, actual? } → { report }
//   trip-check-reports { id? } → { reports, global }        trip-check-unreport { report } → { removed }
//
// The global index: the account namespace's object `tacc:global` (as track.js's `trk:` index), counts only:
//   tacc:<YYYY-MM> → { [kind]: { [source]: { shown, wrong, changed } } }. No place names, no trip, no account id
//   reach it; each account sends its own increments in one batch at most hourly (alarm job 'taccflush').
//   tacc-add { counts } → { ok }   tacc-read {} → { months }

import { ApiError } from '../accounts/util.js';
import { scheduleJob } from '../accounts/schedule.js';
import { ask } from './track.js';
import { TripError, dayDate } from './trips.js';

export const ACCURACY = { reports: 200, note: 300, actual: 200, flushMs: 3600_000, batchMs: 5 * 60_000, months: 12, keepMonths: 24, minShown: 30, seen: 2000, addMax: 100_000 };
export const CHECK_KINDS = ['hours', 'travel', 'price', 'access', 'window'];
export const GLOBAL = 'tacc:global';
// a check's source as checks.js and plan.js write it → the short key the index keeps (anything else isn't Eden's check)
const SOURCES = { 'Google Maps (Places API)': 'google_places', 'Google Maps (Routes API)': 'google_routes', 'The venue’s own website': 'venue_site' };
export const SOURCE_NAMES = { google_places: 'Google Maps (Places)', google_routes: 'Google Maps (Routes)', venue_site: 'the venue’s own website' };
const KIND_WORDS = { hours: 'opening-hours', travel: 'travel-time', price: 'price', access: 'step-free access', window: 'booking-window' };
const COUNTED = new Set(['ok', 'look', 'warn']);
const TRIP_ID = /^[0-9a-f]{16}$/;
const REPORT_ID = /^[0-9a-f]{12}$/;
const MONTH = /^\d{4}-\d{2}$/;
const hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const text = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
export const sourceKey = (source) => SOURCES[source] || null;

/** Whether a badge is a check Eden made against a live source (one that counts, and can be reported wrong). */
export const countable = (b) => Boolean(b && COUNTED.has(b.status) && sourceKey(b.source));

/* ---------- pure: what was shown, what changed ---------- */

// FNV-1a: a short key for a check, so a long trip's snapshot fits in one storage value
const hash = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const STATUS = { ok: 'o', look: 'l', warn: 'w' };
const SOURCE_KEYS = Object.keys(SOURCE_NAMES);

/**
 * A trip's checks keyed by what they were about (hashed): date, stop, place id, time, length, mode, the place before
 * and the check kind → `<status letter><kind index><source index>`. The plan is in the key, so a check the person
 * changed themselves (a later time, another stop before it) is a different check, never "changed after checking".
 * Stand-in maps: nothing.
 */
export function checkSnapshot(trip, checks) {
  const out = {};
  if (!trip || !checks || checks.maps === 'standin' || !Array.isArray(checks.days)) return out;
  for (const d of checks.days) {
    const stops = (trip.days[d.day] && trip.days[d.day].stops) || [];
    for (const v of d.stops || []) {
      const k = stops.findIndex((x) => x.id === v.stop);
      if (k < 0) continue;
      const s = stops[k], before = k > 0 ? stops[k - 1].place.id || '' : '';
      const plan = [d.date, s.id, s.place.id || '', s.at, s.minutes, s.mode, before].join('|');
      CHECK_KINDS.forEach((kind, i) => {
        const b = v.badges && v.badges[kind];
        if (countable(b)) out[hash(`${plan}|${kind}`)] = `${STATUS[b.status]}${i}${SOURCE_KEYS.indexOf(sourceKey(b.source))}`;
      });
    }
  }
  return out;
}
/** A snapshot value read back: { status, kind, source }. */
export const snapValue = (v) => ({ status: { o: 'ok', l: 'look', w: 'warn' }[v[0]], kind: CHECK_KINDS[Number(v[1])], source: SOURCE_KEYS[Number(v[2])] });

/** The checks that went from ok to a problem between two snapshots of the same plan: [{ kind, source }]. */
export function changedAfterChecking(before, after) {
  const out = [];
  for (const [key, v] of Object.entries(after || {})) {
    const b = before && before[key];
    if (b && b[0] === 'o' && v[0] === 'w') { const a = snapValue(v); out.push({ kind: a.kind, source: a.source }); }
  }
  return out;
}

/** Adds to a batch of counts { [month]: { [kind:source]: [shown, wrong, changed] } }. */
export function addCount(counts, month, kind, source, field, n = 1) {
  const i = { shown: 0, wrong: 1, changed: 2 }[field];
  const m = counts[month] || (counts[month] = {});
  const row = m[`${kind}:${source}`] || (m[`${kind}:${source}`] = [0, 0, 0]);
  row[i] += n;
  return counts;
}

/* ---------- in the account object: counting, then sending ---------- */

async function queue(account, fn) {
  const q = (await account.storage.get('taccq')) || { counts: {}, due: null };
  fn(q.counts);
  const now = account.now();
  if (!q.due || q.due < now) {
    const sent = (await account.storage.get('taccsent')) || 0;
    q.due = Math.max(now + ACCURACY.batchMs, sent + ACCURACY.flushMs);
    await scheduleJob(account, 'taccflush', 'taccflush', q.due);
  }
  await account.storage.put('taccq', q);
}

/**
 * A trip's checks, as a look found them: those not yet counted this month count as shown (`shown`: false for the
 * re-check, which the person doesn't see), and any that changed from ok to a problem since the last look count as
 * changed. Called from ops.js (trip-get and trip writes) and recheck.js. Returns { shown, changed } (counts).
 */
export async function noteChecks(account, id, trip, checks, { shown = true } = {}) {
  if (!trip || !checks || checks.maps === 'standin') return { shown: 0, changed: 0 };
  const storage = account.storage;
  const month = monthOf(account.now());
  const snap = checkSnapshot(trip, checks);
  const prev = await storage.get(`tacsnap:${id}`);
  const changed = prev ? changedAfterChecking(prev.snap, snap) : [];
  let fresh = [];
  if (shown) {
    const seen = await storage.get(`tacseen:${id}`);
    const keys = new Set(seen && seen.month === month ? seen.keys : []);
    fresh = Object.keys(snap).filter((k) => !keys.has(k));
    for (const k of fresh) keys.add(k);
    if (fresh.length) await storage.put(`tacseen:${id}`, { month, keys: [...keys].slice(-ACCURACY.seen) });
  }
  await storage.put(`tacsnap:${id}`, { snap });
  if (fresh.length || changed.length) {
    await queue(account, (c) => {
      for (const k of fresh) { const v = snapValue(snap[k]); addCount(c, month, v.kind, v.source, 'shown'); }
      for (const x of changed) addCount(c, month, x.kind, x.source, 'changed');
    });
  }
  return { shown: fresh.length, changed: changed.length };
}

/** A booking window shown (plan.js trip-windows, found on the venue's own page): counted once a month per stop. */
export async function noteWindow(account, id, w) {
  if (!w || !w.found || !TRIP_ID.test(String(id))) return false;
  const month = monthOf(account.now());
  const seen = await account.storage.get(`tacseen:${id}`);
  const keys = new Set(seen && seen.month === month ? seen.keys : []);
  const key = hash(`window|${w.stop}|${w.opens_on}`);
  if (keys.has(key)) return false;
  keys.add(key);
  await account.storage.put(`tacseen:${id}`, { month, keys: [...keys].slice(-ACCURACY.seen) });
  await queue(account, (c) => addCount(c, month, 'window', 'venue_site', 'shown'));
  return true;
}

/** The job 'taccflush': the account's increments to the global index, in one batch. Throws to be tried again later. */
export async function accuracyFlush(account, { send = (counts) => ask(account.env, GLOBAL, 'tacc-add', { counts }) } = {}) {
  const q = await account.storage.get('taccq');
  if (!q || !Object.keys(q.counts || {}).length) { await account.storage.delete('taccq'); return; }
  const now = account.now();
  const sent = (await account.storage.get('taccsent')) || 0;
  if (now - sent < ACCURACY.flushMs) return sent + ACCURACY.flushMs; // at most hourly: run again then
  await send(q.counts);
  // counts added while it was sending stay for the next batch
  const after = (await account.storage.get('taccq')) || { counts: {} };
  for (const [m, rows] of Object.entries(q.counts)) for (const [k, v] of Object.entries(rows)) {
    const row = after.counts[m] && after.counts[m][k];
    if (!row) continue;
    for (let i = 0; i < 3; i++) row[i] -= v[i];
    if (row.every((n) => n === 0)) delete after.counts[m][k];
    if (!Object.keys(after.counts[m]).length) delete after.counts[m];
  }
  await account.storage.put('taccsent', now);
  if (Object.keys(after.counts).length) {
    after.due = now + ACCURACY.flushMs;
    await account.storage.put('taccq', after);
    return after.due;
  }
  await account.storage.delete('taccq');
}

/** A trip deleted: what was kept to count its checks goes (the person's reports stay theirs). */
export async function dropTripAccuracy(account, id) {
  await account.storage.delete(`tacsnap:${id}`);
  await account.storage.delete(`tacseen:${id}`);
}

/* ---------- the person's reports ---------- */

/** What the person was shown for one check of a stop: the badge (from the trip's checks) or the booking window. */
async function shownCheck(account, id, trip, d, s, kind, check) {
  if (kind === 'window') {
    const w = await account.storage.get(`twin:${id}:${s.id}`);
    if (!w || !w.found) throw new ApiError(404, 'not_found', 'Eden hasn’t found when bookings open here, so there’s nothing to report.');
    return { status: 'ok', text: `Bookings open ${w.days_ahead} days ahead (${w.opens_on}${w.opens_at ? ` at ${w.opens_at}` : ''}): “${text(w.quote, 200)}”`, source: w.source, checked_at: w.checked_at, url: w.url || null };
  }
  const checks = await check(trip);
  const day = checks.days.find((x) => x.day === d);
  const b = day && (day.stops.find((x) => x.stop === s.id) || {}).badges;
  const badge = b && b[kind];
  if (!badge) throw new ApiError(404, 'not_found', 'Eden didn’t check that for this stop.');
  if (badge.status === 'sample') throw new ApiError(409, 'sample', 'That’s sample data, not a check Eden made.');
  if (badge.source === 'Your booking' || badge.source === 'Trip estimate') throw new ApiError(409, 'yours', 'That’s your own figure, not a check Eden made. Change it on the stop.');
  if (!countable(badge)) throw new ApiError(409, 'unchecked', 'Eden couldn’t check this one, so there’s nothing to report.');
  return { status: badge.status, text: badge.text, source: badge.source, checked_at: badge.checked_at };
}

/** trip-check-* ops. `deps.check(trip)` → the trip's checks (ops.js's own, through its cache). */
export async function accuracyOp(account, op, body, { check }) {
  const storage = account.storage;
  const now = account.now();
  if (op === 'trip-check-report') {
    const id = String(body.id || '');
    if (!TRIP_ID.test(id)) throw new TripError('id must be a trip id.');
    const kind = String(body.check || '');
    if (!CHECK_KINDS.includes(kind)) throw new TripError(`check must be one of ${CHECK_KINDS.join(', ')}.`);
    const trip = await storage.get(`trip:${id}`);
    if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
    const d = trip.days.findIndex((x) => x.stops.some((s) => s.id === String(body.stop || '')));
    if (d < 0) throw new TripError('There is no such stop in this trip.', 404, 'not_found');
    const s = trip.days[d].stops.find((x) => x.id === String(body.stop));
    const shown = await shownCheck(account, id, trip, d, s, kind, check);
    const note = text(body.note, ACCURACY.note), actual = text(body.actual, ACCURACY.actual);
    const all = [...(await storage.list({ prefix: 'tacr:' })).values()];
    // the same check reported again: the words are updated, it isn't counted twice
    const same = all.find((r) => r.trip === id && r.stop === s.id && r.check === kind && r.shown.checked_at === shown.checked_at && r.shown.text === shown.text);
    if (same) {
      Object.assign(same, { note: note || same.note, actual: actual || same.actual });
      await storage.put(`tacr:${same.id}`, same);
      return { report: same, again: true };
    }
    const report = { id: hex(6), trip: id, trip_title: text(trip.title, 120), stop: s.id, place: { id: s.place.id || null, name: s.place.name }, day: d, date: dayDate(trip, d), check: kind, shown, note, actual, at: now };
    await storage.put(`tacr:${report.id}`, report);
    for (const old of all.sort((a, b) => a.at - b.at).slice(0, Math.max(0, all.length + 1 - ACCURACY.reports))) await storage.delete(`tacr:${old.id}`);
    await queue(account, (c) => addCount(c, monthOf(now), kind, sourceKey(shown.source), 'wrong'));
    return { report: report };
  }
  if (op === 'trip-check-unreport') {
    const rid = String(body.report || '');
    const r = REPORT_ID.test(rid) ? await storage.get(`tacr:${rid}`) : null;
    if (!r) throw new ApiError(404, 'not_found', 'No such report.');
    await storage.delete(`tacr:${rid}`);
    await queue(account, (c) => addCount(c, monthOf(r.at), r.check, sourceKey(r.shown.source), 'wrong', -1));
    return { removed: true };
  }
  if (op === 'trip-check-reports') {
    const id = body.id ? String(body.id) : null;
    if (id && !TRIP_ID.test(id)) throw new TripError('id must be a trip id.');
    const reports = [...(await storage.list({ prefix: 'tacr:' })).values()].filter((r) => !id || r.trip === id).sort((a, b) => b.at - a.at);
    const global = await ask(account.env, GLOBAL, 'tacc-read', {}).catch(() => null);
    return { reports, global: global ? { months: global.months, rows: accuracyRows(global.months, monthOf(now)) } : null };
  }
  throw new ApiError(404, 'not_found', 'Not found');
}

/* ---------- the global index (no device; the Worker's and accounts' own calls only) ---------- */

export async function accuracyIndexOp(account, op, body) {
  // never in a person's own object: only the one named GLOBAL (which has no account record)
  if (await account.storage.get('account')) throw new ApiError(404, 'not_found', 'Not found');
  if (op === 'tacc-read') {
    const months = [...(await account.storage.list({ prefix: 'tacc:' }))].map(([k, v]) => ({ month: k.slice(5), kinds: v })).sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, ACCURACY.months);
    return { months };
  }
  if (op !== 'tacc-add') throw new ApiError(404, 'not_found', 'Not found');
  const counts = isObj(body.counts) ? body.counts : null;
  if (!counts || Object.keys(counts).length > ACCURACY.months + 1) throw new ApiError(400, 'bad_request', 'counts: { month: { kind:source: [shown, wrong, changed] } }.');
  const n = (x) => Number.isInteger(x) && Math.abs(x) <= ACCURACY.addMax;
  for (const [month, rows] of Object.entries(counts)) {
    if (!MONTH.test(month) || !isObj(rows)) throw new ApiError(400, 'bad_request', 'counts: bad month.');
    for (const [k, v] of Object.entries(rows)) {
      const [kind, source] = k.split(':');
      if (!CHECK_KINDS.includes(kind) || !SOURCE_NAMES[source] || !Array.isArray(v) || v.length !== 3 || !v.every(n)) throw new ApiError(400, 'bad_request', `counts: bad row ${k.slice(0, 40)}.`);
    }
  }
  for (const [month, rows] of Object.entries(counts)) {
    const rec = (await account.storage.get(`tacc:${month}`)) || {};
    for (const [k, v] of Object.entries(rows)) {
      const [kind, source] = k.split(':');
      const cell = ((rec[kind] || (rec[kind] = {}))[source] ||= { shown: 0, wrong: 0, changed: 0 });
      cell.shown = Math.max(0, cell.shown + v[0]);
      cell.wrong = Math.max(0, cell.wrong + v[1]);
      cell.changed = Math.max(0, cell.changed + v[2]);
    }
    await account.storage.put(`tacc:${month}`, rec);
  }
  const keys = [...(await account.storage.list({ prefix: 'tacc:' })).keys()].sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - ACCURACY.keepMonths))) await account.storage.delete(k);
  return { ok: true };
}

/* ---------- the plain sentences the page shows ---------- */

const nf = (x) => x.toLocaleString('en-US');
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** One check kind's month in words: "2 of 1,240 opening-hours checks reported wrong in October 2026." */
export function rateText({ kind, month, shown, wrong, changed }) {
  const what = `${KIND_WORDS[kind] || kind} check${shown === 1 ? '' : 's'}`;
  const when = monthName(month);
  if (shown < ACCURACY.minShown) {
    return `${nf(shown)} ${what} in ${when} so far: too few to give a rate. ${nf(wrong)} reported wrong.`;
  }
  const head = wrong === 0 ? `None of ${nf(shown)} ${what} reported wrong in ${when}.` : `${nf(wrong)} of ${nf(shown)} ${what} reported wrong in ${when} (${pct(wrong, shown)}).`;
  const tail = changed ? ` ${nf(changed)} changed after Eden checked (for example new hours): not necessarily wrong when checked.` : '';
  return head + tail;
}
const pct = (a, b) => { const p = (100 * a) / b; return `${p < 0.1 ? '<0.1' : p < 10 ? p.toFixed(1) : Math.round(p)}%`; };

/**
 * The page's rows: for this month and the one before, each check kind with any checks, all sources together, then each
 * source on its own when there's more than one. [{ month, kind, source, shown, wrong, changed, text }]
 */
export function accuracyRows(months, current) {
  const out = [];
  const [y, m] = current.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  for (const month of [current, prev]) {
    const rec = (months || []).find((x) => x.month === month);
    if (!rec) continue;
    for (const kind of CHECK_KINDS) {
      const by = rec.kinds[kind];
      if (!by) continue;
      const cells = Object.entries(by).filter(([, c]) => c.shown > 0);
      if (!cells.length) continue;
      const sum = cells.reduce((t, [, c]) => ({ shown: t.shown + c.shown, wrong: t.wrong + c.wrong, changed: t.changed + c.changed }), { shown: 0, wrong: 0, changed: 0 });
      out.push({ month, kind, source: null, ...sum, text: rateText({ kind, month, ...sum }) });
      if (cells.length > 1) for (const [source, c] of cells) out.push({ month, kind, source: SOURCE_NAMES[source], ...c, text: `${SOURCE_NAMES[source]}: ${rateText({ kind, month, ...c })}` });
    }
  }
  return out;
}
