// "Best time to go" on the Travel page (travel.js hands it its state through init; the lead opens it from Trip tools and
// the first-run screen): turn the days off a person has (PTO) into the longest breaks, around weekends and the public
// holidays of their country (site travel/pto.js: OpenHolidays API, Nager.Date only when sponsored; each holiday with its
// source and when it was checked). The optimizer (optimize) is pure and runs here; nothing is saved, nothing is booked.
// "Plan a trip for these dates" hands the dates to Eden's planner (trip-ui.js tripPlan), whose plan shows in the New trip
// panel as any other (travel-plan.js): nothing is created until the person presses Create.
//
// A day counts as off only when it's a weekend day the person chose, a full-day public holiday from the source, a company
// day off the person entered, or a PTO day: never a guess. A half-day holiday needs a PTO day and says so.

import { el, ico, toast } from './util.js';
import { tripPost, tripPlan } from './trip-ui.js';

let C = null; // { S, paint }
export function init(ctx) { C = ctx; }

/* ---------- the optimizer (pure) ---------- */

const DAY = 86400_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const t0 = (d) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d, n) => new Date(t0(d) + n * DAY).toISOString().slice(0, 10);
export const weekday = (d) => new Date(t0(d)).getUTCDay(); // 0 Sunday … 6 Saturday
export const WEEKENDS = { 'sat-sun': [6, 0], 'fri-sat': [5, 6], sun: [0], fri: [5] };
export const LIMITS = { pto: 60, minLen: 1, maxLen: 30, rangeDays: 460, singles: 5 }; // maxLen: the planner's 30 days
export const METHOD = 'Eden looks at every way to take your days off in the dates you chose: each break runs from a working day you keep to the next one, so it always includes the weekends and public holidays next to it. Of all the sets of breaks that fit your days, it picks the one with the most days off; when two tie, the one with longer breaks, then the one that uses fewer of your days. A day counts as off only when it’s a weekend, a public holiday from the source shown, a company day off you entered, or one of your days.';

/** 'YYYY-MM-DD' list for a from–to (inclusive; to optional), at most a year. */
export function expandRange(from, to) {
  if (!YMD.test(String(from || ''))) return [];
  const end = YMD.test(String(to || '')) && to >= from ? to : from;
  const out = [];
  for (let d = from; d <= end && out.length < 366; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The best breaks for `pto` days off between `from` and `to`:
 *   holidays: [{ date, name, source, checked_at, half? }] (half days never count as off), weekend: weekdays off,
 *   company: dates off the person entered, blackout: dates they can't be away (never in a break), minLen/maxLen: a
 *   break's length in days, spillTo: a date after `to` a break may run on to over days already off (no PTO there).
 * → { breaks, singles, days_off, pto_used, pto_left } with each break { start, end, days, pto, pto_dates, holidays,
 *   half_days, company, weekend_days, cal: [{ date, kind: 'pto'|'holiday'|'weekend'|'company' }] }.
 */
export function optimize({ holidays = [], weekend = WEEKENDS['sat-sun'], pto = 0, from, to, spillTo = null, company = [], blackout = [], minLen = 3, maxLen = 16 } = {}) {
  if (!YMD.test(String(from || '')) || !YMD.test(String(to || '')) || to < from) throw new Error('Choose the dates to look in.');
  const budget = Math.max(0, Math.min(LIMITS.pto, Math.floor(Number(pto) || 0)));
  const lo = Math.max(LIMITS.minLen, Math.floor(Number(minLen) || 1));
  const hi = Math.min(LIMITS.maxLen, Math.max(lo, Math.floor(Number(maxLen) || LIMITS.maxLen)));
  const last = YMD.test(String(spillTo || '')) && spillTo > to ? spillTo : to;
  const days = [];
  for (let d = from; d <= last && days.length < LIMITS.rangeDays; d = addDays(d, 1)) days.push(d);
  const wk = new Set((Array.isArray(weekend) ? weekend : []).map(Number));
  const hol = new Map(), half = new Map();
  for (const h of Array.isArray(holidays) ? holidays : []) {
    if (!h || !YMD.test(String(h.date || ''))) continue;
    (h.half ? half : hol).has(h.date) || (h.half ? half : hol).set(h.date, h);
  }
  const comp = new Set(company), block = new Set(blackout);
  // each day: 'off' (and why), 'work' (a PTO day if in a break) or 'block' (a blackout, or a working day past `to`)
  const kind = days.map((d) => {
    if (block.has(d)) return { k: 'block' };
    if (hol.has(d)) return { k: 'off', why: 'holiday' };
    if (comp.has(d)) return { k: 'off', why: 'company' };
    if (wk.has(weekday(d))) return { k: 'off', why: 'weekend' };
    return d > to ? { k: 'block' } : { k: 'work' };
  });
  const n = days.length;
  const edge = (i) => i < 0 || i >= n || kind[i].k !== 'off'; // a break stops at a working day, a blackout or the end
  // every possible break: [a, b] with nothing blocked, at least one PTO day, within the budget and the lengths
  const cands = [];
  for (let a = 0; a < n; a++) {
    if (!edge(a - 1) || kind[a].k === 'block') continue;
    let cost = 0;
    for (let b = a; b < n && b - a < hi; b++) {
      if (kind[b].k === 'block') break;
      if (kind[b].k === 'work') cost++;
      if (cost > budget) break;
      if (cost >= 1 && b - a + 1 >= lo && edge(b + 1)) cands.push({ a, b, cost, len: b - a + 1 });
    }
  }
  // the best set: days off first, then longer breaks (sum of squared lengths), then fewer PTO days; best[i][k] = the
  // best with days before i decided and k PTO days used. A break [a, b] leaves day b + 1 out (a working day kept).
  const byStart = Array.from({ length: n }, () => []);
  for (const c of cands) byStart[c.a].push(c);
  const W = budget + 1;
  const best = Array.from({ length: n + 2 }, () => new Array(W).fill(-1));
  const back = Array.from({ length: n + 2 }, () => new Array(W).fill(null));
  best[0][0] = 0;
  const score = (c) => c.len * 1e6 + c.len * c.len;
  for (let i = 0; i <= n; i++) {
    for (let k = 0; k < W; k++) {
      const v = best[i][k];
      if (v < 0) continue;
      if (i + 1 <= n + 1 && v > best[i + 1][k]) { best[i + 1][k] = v; back[i + 1][k] = { from: i, k, c: null }; }
      if (i >= n) continue;
      for (const c of byStart[i]) {
        const j = Math.min(c.b + 2, n + 1), kk = k + c.cost, nv = v + score(c);
        if (kk < W && nv > best[j][kk]) { best[j][kk] = nv; back[j][kk] = { from: i, k, c }; }
      }
    }
  }
  let end = null;
  for (const i of [n, n + 1]) for (let k = 0; k < W; k++) {
    const v = best[i][k];
    if (v >= 0 && (!end || v > end.v || (v === end.v && k < end.k))) end = { i, k, v };
  }
  const chosen = [];
  for (let at = end; at && back[at.i][at.k];) {
    const p = back[at.i][at.k];
    if (p.c) chosen.unshift(p.c);
    at = { i: p.from, k: p.k };
  }
  const shape = (c) => {
    const span = days.slice(c.a, c.b + 1);
    const cal = span.map((d, x) => ({ date: d, kind: kind[c.a + x].k === 'work' ? 'pto' : kind[c.a + x].why }));
    return {
      start: span[0], end: span.at(-1), days: c.len, pto: c.cost,
      pto_dates: cal.filter((x) => x.kind === 'pto').map((x) => x.date),
      holidays: span.filter((d) => hol.has(d)).map((d) => ({ date: d, name: hol.get(d).name, source: hol.get(d).source || null, checked_at: hol.get(d).checked_at || null })),
      half_days: cal.filter((x) => x.kind === 'pto' && half.has(x.date)).map((x) => x.date).map((d) => ({ date: d, name: half.get(d).name, source: half.get(d).source || null, checked_at: half.get(d).checked_at || null })),
      company: cal.filter((x) => x.kind === 'company').map((x) => x.date),
      weekend_days: cal.filter((x) => x.kind === 'weekend').length,
      cal,
    };
  };
  const breaks = chosen.map(shape);
  // one long break instead: the longest the days allow, then the fewest PTO days, then the earliest; none overlapping
  const singles = [];
  for (const c of [...cands].sort((x, y) => y.len - x.len || x.cost - y.cost || x.a - y.a)) {
    if (singles.length >= LIMITS.singles) break;
    if (singles.some((s) => !(c.b < s.a || c.a > s.b))) continue;
    singles.push(c);
  }
  const used = breaks.reduce((s, b) => s + b.pto, 0);
  return { breaks, singles: singles.map(shape), days_off: breaks.reduce((s, b) => s + b.days, 0), pto_used: used, pto_left: budget - used };
}

/** "10 PTO days → 25 days off" (and where and when, for sharing). */
export function summaryLine(r, { place = '', when = '' } = {}) {
  const head = `${r.pto_used} PTO day${r.pto_used === 1 ? '' : 's'} → ${r.days_off} days off`;
  return [head, place, when].filter(Boolean).join(' · ');
}

/** "Fri 2 Apr" for a 'YYYY-MM-DD' (en-GB, like travel.js; i18n-fr-travel.js translates it). */
export function dayLabel(d, { weekday: wd = true } = {}) {
  return new Date(t0(d)).toLocaleDateString('en-GB', { ...(wd ? { weekday: 'short' } : {}), day: 'numeric', month: 'short', timeZone: 'UTC' });
}
/** Dates as runs: "Tue 6 Apr – Fri 9 Apr, Mon 12 Apr". */
export function runsLabel(dates) {
  const out = [];
  for (let i = 0; i < dates.length;) {
    let j = i;
    while (j + 1 < dates.length && dates[j + 1] === addDays(dates[j], 1)) j++;
    out.push(i === j ? dayLabel(dates[i]) : `${dayLabel(dates[i])} – ${dayLabel(dates[j])}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** The dates for a choice of year: the rest of this year from today, or all of next year; a break may run on into the
 *  first two weeks after it over days already off. */
export function rangeFor(choice, today) {
  const y = Number(today.slice(0, 4));
  if (choice === 'next') return { from: `${y + 1}-01-01`, to: `${y + 1}-12-31`, spillTo: `${y + 2}-01-14`, years: [y + 1, y + 2] };
  return { from: today, to: `${y}-12-31`, spillTo: `${y + 1}-01-14`, years: [y, y + 1] };
}

/* ---------- the panel ---------- */

const err = (e) => String((e && e.message) || e);
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const checkedOn = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const KIND_LABEL = { pto: 'Day off you take', holiday: 'Public holiday', weekend: 'Weekend', company: 'Company day off' };
const CSS = 'travel-pto.css';

function state() {
  const S = C.S;
  if (!S.pto) {
    // the person's own country from the browser's language region as the starting choice (they change it)
    let cc = '';
    try { cc = (new Intl.Locale(navigator.language).maximize().region || '').toUpperCase(); } catch { /* none */ }
    S.pto = { country: cc, region: '', year: 'rest', pto: 10, weekend: 'sat-sun', minLen: 4, maxLen: 16, company: [], blackout: [], countries: null, answers: {}, result: null, busy: false, err: null, planFor: null, dest: '' };
    loadCountries();
  }
  if (!document.querySelector(`link[href$="${CSS}"]`)) document.head.append(el('link', { rel: 'stylesheet', href: CSS }));
  return S.pto;
}

async function loadCountries() {
  const P = C.S.pto;
  try {
    P.countries = (await tripPost('pto-holidays', {})).countries || [];
    if (P.country && P.countries.some((c) => c.code === P.country)) loadHolidays(P.country, rangeFor(P.year, todayYmd()).years[0]).then(() => C.paint());
  } catch (e) { P.countries = []; P.err = err(e); }
  C.paint();
}

// one country, region and year from the server (site travel/pto.js), kept for the panel's life
async function loadHolidays(cc, year, region = '') {
  const P = C.S.pto;
  const key = `${cc}:${region}:${year}`;
  if (!P.answers[key]) P.answers[key] = tripPost('pto-holidays', { country: cc, year, ...(region ? { region } : {}) }).catch((e) => ({ failed: err(e) }));
  return P.answers[key];
}

async function run() {
  const P = C.S.pto;
  P.busy = true; P.err = null; P.planFor = null; C.paint();
  try {
    const range = rangeFor(P.year, todayYmd());
    let holidays = [], answer = null;
    if (P.country) {
      const [a, b] = await Promise.all(range.years.map((y) => loadHolidays(P.country, y, P.region)));
      if (a.failed) throw new Error(a.failed);
      answer = a;
      holidays = [...(a.holidays || []), ...((b && b.holidays) || [])];
    }
    const r = optimize({ holidays, weekend: WEEKENDS[P.weekend], pto: P.pto, ...range, company: P.company, blackout: P.blackout, minLen: P.minLen, maxLen: P.maxLen });
    P.result = { ...r, answer, range };
  } catch (e) { P.err = err(e); P.result = null; }
  P.busy = false; C.paint();
}

const regionName = (P, a) => (P.region && a && a.regions ? ((a.regions.find((x) => x.code === P.region) || {}).name || P.region) : '');
const yearLabel = (P) => { const y = Number(todayYmd().slice(0, 4)); return P.year === 'next' ? String(y + 1) : `Rest of ${y}`; };

/** The panel's body (travel.js wraps it in its sheet: "Best time to go"). */
export function ptoPanel() {
  const P = state();
  const y = Number(todayYmd().slice(0, 4));
  const num = (k, label, min, max) => {
    const id = `tv-pto-${k}`;
    const i = el('input', { type: 'number', inputmode: 'numeric', class: 'tv-input small', id, min: String(min), max: String(max), step: '1', 'data-k': `pto:${k}` });
    i.value = String(P[k]);
    i.addEventListener('change', () => { const v = Math.round(Number(i.value)); P[k] = Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : P[k]; i.value = String(P[k]); });
    return el('label', { class: 'tv-pto-field', for: id }, el('span', '', label), i);
  };
  const country = el('select', { class: 'tv-input', id: 'tv-pto-country', 'data-k': 'pto:country', disabled: P.countries ? null : '' },
    el('option', { value: '' }, P.countries ? 'Another country (no holiday source)' : 'Loading the countries…'),
    ...(P.countries || []).map((c) => el('option', { value: c.code, selected: c.code === P.country ? '' : null }, c.name)));
  country.value = P.countries && P.countries.some((c) => c.code === P.country) ? P.country : '';
  country.addEventListener('change', async () => {
    P.country = country.value; P.region = ''; P.result = null;
    if (P.country) await loadHolidays(P.country, rangeFor(P.year, todayYmd()).years[0]);
    C.paint();
  });
  const first = P.country ? P.answers[`${P.country}::${rangeFor(P.year, todayYmd()).years[0]}`] : null;
  const known = first && typeof first.then !== 'function' ? first : null;
  if (first && !known) first.then((a) => { P.answers[`${P.country}::${rangeFor(P.year, todayYmd()).years[0]}`] = a; C.paint(); });
  const regions = (known && known.regions) || [];
  const region = regions.length ? el('select', { class: 'tv-input', id: 'tv-pto-region', 'data-k': 'pto:region' },
    el('option', { value: '' }, 'All of the country'),
    ...regions.map((r) => el('option', { value: r.code, selected: r.code === P.region ? '' : null }, r.name))) : null;
  if (region) { region.value = P.region; region.addEventListener('change', () => { P.region = region.value; P.result = null; }); }
  const seg = (k, label) => el('button', { type: 'button', class: 'tv-seg', 'aria-pressed': String(P.year === k), 'data-k': `pto:y:${k}`, onclick: () => { P.year = k; P.result = null; C.paint(); } }, label);
  const weekends = el('select', { class: 'tv-input small', id: 'tv-pto-weekend', 'data-k': 'pto:weekend' },
    ...[['sat-sun', 'Saturday and Sunday'], ['fri-sat', 'Friday and Saturday'], ['sun', 'Sunday only'], ['fri', 'Friday only']].map(([v, t]) => el('option', { value: v }, t)));
  weekends.value = P.weekend;
  weekends.addEventListener('change', () => { P.weekend = weekends.value; P.result = null; });
  return el('div', { class: 'tv-pto', 'aria-busy': P.busy ? 'true' : null },
    el('p', 'tv-note', 'Turn your days off into the longest breaks: Eden lines them up with weekends and public holidays, each holiday from its source.'),
    el('form', { class: 'tv-pto-form', novalidate: '', onsubmit: (e) => { e.preventDefault(); run(); } },
      el('div', 'tv-pto-row',
        el('label', { class: 'tv-pto-field grow', for: 'tv-pto-country' }, el('span', '', 'Country'), country),
        region ? el('label', { class: 'tv-pto-field grow', for: 'tv-pto-region' }, el('span', '', 'Region (optional)'), region) : null),
      known && known.covered === false ? el('p', { class: 'tv-note warn', role: 'status' }, known.why) : null,
      !P.country && P.countries ? el('p', 'tv-fine', 'With no holiday source, only weekends and the company days you add count as off: add your public holidays as company days off.') : null,
      el('div', { class: 'tv-segs', role: 'group', 'aria-label': 'Year' }, seg('rest', `Rest of ${y}`), seg('next', String(y + 1))),
      el('div', 'tv-pto-row',
        num('pto', 'Days off to use', 0, LIMITS.pto),
        el('label', { class: 'tv-pto-field', for: 'tv-pto-weekend' }, el('span', '', 'Weekends'), weekends),
        num('minLen', 'Shortest break (days)', 1, LIMITS.maxLen),
        num('maxLen', 'Longest break (days)', 1, LIMITS.maxLen)),
      datesBox('company', 'Company days off', 'Days your company closes that aren’t public holidays.'),
      datesBox('blackout', 'Dates you can’t be away', 'No break includes these.'),
      el('div', 'tv-acts', el('button', { type: 'submit', class: 'tv-btn primary', 'data-k': 'pto:go', disabled: P.busy || !P.countries ? '' : null }, ico('cal', 14), P.busy ? 'Finding…' : 'Find the best breaks'))),
    P.err ? el('p', { class: 'tv-note warn', role: 'alert' }, P.err) : null,
    P.result ? results(P) : null);
}

// company days or blackouts: a from (and an optional to) and Add; each range a chip with its remove button
function datesBox(k, title, hint) {
  const P = C.S.pto;
  const a = el('input', { type: 'date', class: 'tv-input small', id: `tv-pto-${k}-a`, 'data-k': `pto:${k}:a` });
  const b = el('input', { type: 'date', class: 'tv-input small', id: `tv-pto-${k}-b`, 'data-k': `pto:${k}:b` });
  const add = () => {
    const days = expandRange(a.value, b.value);
    if (!days.length) { toast('Choose a date first'); a.focus(); return; }
    P[k] = [...new Set([...P[k], ...days])].sort();
    P.result = null; C.paint();
  };
  const runs = [];
  for (let i = 0; i < P[k].length;) {
    let j = i;
    while (j + 1 < P[k].length && P[k][j + 1] === addDays(P[k][j], 1)) j++;
    runs.push(P[k].slice(i, j + 1));
    i = j + 1;
  }
  return el('fieldset', 'tv-pto-dates',
    el('legend', '', title),
    el('p', 'tv-fine', hint),
    el('div', 'tv-pto-row',
      el('label', { class: 'tv-pto-field', for: a.id }, el('span', '', 'From'), a),
      el('label', { class: 'tv-pto-field', for: b.id }, el('span', '', 'To (optional)'), b),
      el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `pto:${k}:add`, onclick: add }, 'Add')),
    runs.length ? el('ul', { class: 'tv-pto-chips', 'aria-label': title }, ...runs.map((r) => {
      const label = r.length > 1 ? `${dayLabel(r[0])} – ${dayLabel(r.at(-1))}` : dayLabel(r[0]);
      return el('li', 'tv-chip', el('span', '', label),
        el('button', { type: 'button', class: 'tv-x', 'aria-label': `Remove ${label}`, onclick: () => { const drop = new Set(r); P[k] = P[k].filter((d) => !drop.has(d)); P.result = null; C.paint(); } }, ico('x', 11)));
    })) : null);
}

function results(P) {
  const r = P.result;
  const a = r.answer;
  const place = a ? [a.country_name, regionName(P, a)].filter(Boolean).join(', ') : '';
  const line = summaryLine(r, { place, when: yearLabel(P) });
  const said = globalThis.edenI18n ? globalThis.edenI18n.t(line) : line; // shared in the page's language
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ text: said });
      else { await navigator.clipboard.writeText(said); toast('Copied'); }
    } catch { /* closed */ }
  };
  const src = a && a.covered && a.checked_at
    ? el('p', 'tv-fine', 'Public holidays: ', el('a', { href: a.source_url, target: '_blank', rel: 'noopener noreferrer' }, a.source), ` (${a.licence}) · checked ${checkedOn(a.checked_at)}`)
    : a && a.unavailable ? el('p', 'tv-note warn', a.unavailable) : null;
  return el('section', { class: 'tv-pto-results', 'aria-label': 'The best breaks', 'aria-live': 'polite' },
    el('div', 'tv-pto-sum',
      el('h3', '', `${r.pto_used} PTO day${r.pto_used === 1 ? '' : 's'} → ${r.days_off} days off`),
      el('button', { type: 'button', class: 'tv-pill', 'data-k': 'pto:share', onclick: share }, ico('ext', 12), 'Share')),
    el('p', 'tv-note', [place, yearLabel(P), r.breaks.length ? `${r.breaks.length} break${r.breaks.length === 1 ? '' : 's'}` : '', r.pto_left > 0 ? `${r.pto_left} day${r.pto_left === 1 ? '' : 's'} left over` : ''].filter(Boolean).join(' · ')),
    r.breaks.length ? el('ol', 'tv-pto-list', ...r.breaks.map((b) => breakCard(P, b))) : el('p', 'tv-note', 'No break fits: try more days, a shorter shortest break, or fewer dates you can’t be away.'),
    r.singles.length ? el('details', 'tv-pto-singles',
      el('summary', '', 'If you take one long break instead'),
      el('ol', 'tv-pto-list', ...r.singles.map((b) => breakCard(P, b, { compact: true })))) : null,
    legend(),
    el('details', 'tv-pto-how', el('summary', '', 'How Eden counts'), el('p', 'tv-note', METHOD)),
    src);
}

function legend() {
  return el('ul', { class: 'tv-pto-legend', 'aria-hidden': 'true' }, ...Object.entries(KIND_LABEL).map(([k, t]) => el('li', '', el('i', `tv-pto-d ${k}`), t)));
}

function breakCard(P, b, { compact = false } = {}) {
  const id = `${b.start}:${b.end}`;
  const planning = P.planFor === id;
  return el('li', 'tv-pto-break',
    el('div', 'tv-pto-head',
      el('b', '', `${dayLabel(b.start)} – ${dayLabel(b.end)}`),
      el('span', 'tv-meta', `${b.days} days off for ${b.pto} PTO day${b.pto === 1 ? '' : 's'}`)),
    // the strip is a picture of the lines under it (which carry the same facts for a screen reader)
    el('div', { class: 'tv-pto-strip', 'aria-hidden': 'true' }, ...b.cal.map((d) => el('span', { class: `tv-pto-d ${d.kind}`, title: `${dayLabel(d.date)} · ${KIND_LABEL[d.kind]}` },
      el('small', '', dayLabel(d.date).slice(0, 2)), el('b', '', String(Number(d.date.slice(8))))))),
    el('p', 'tv-note', `Take off: ${runsLabel(b.pto_dates)}`),
    b.holidays.length ? el('p', 'tv-note', `Bridges ${b.holidays.map((h) => `${h.name} (${dayLabel(h.date)})`).join(', ')}`,
      el('small', 'tv-pto-src', ` · ${[...new Set(b.holidays.map((h) => h.source).filter(Boolean))].join(', ')}${b.holidays[0].checked_at ? `, checked ${checkedOn(b.holidays[0].checked_at)}` : ''}`)) : null,
    b.company.length ? el('p', 'tv-note', `Company days off: ${runsLabel(b.company)}`) : null,
    ...b.half_days.map((h) => el('p', 'tv-fine', `${h.name} (${dayLabel(h.date)}) is a half-day holiday, so it takes one of your days.`)),
    compact ? null : planBox(P, b, id, planning));
}

// "Plan a trip for these dates": where to, then Eden's planner (trip-ui.js tripPlan) with the dates; its plan opens in
// the New trip panel (travel-plan.js) like any other, nothing created before Create
function planBox(P, b, id, open) {
  if (!open) return el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `pto:plan:${id}`, onclick: () => { P.planFor = id; C.paint(); setTimeout(() => C.S.pane?.querySelector('[data-k="pto:dest"]')?.focus(), 0); } }, ico('spark', 13), 'Plan a trip for these dates'));
  const input = el('input', { type: 'text', class: 'tv-input', maxlength: '120', autocomplete: 'off', placeholder: 'Lisbon', 'aria-label': 'Where to?', 'data-k': 'pto:dest' });
  input.value = P.dest;
  input.addEventListener('input', () => { P.dest = input.value; });
  const go = async (e) => {
    e.preventDefault();
    const dest = String(P.dest || '').trim();
    if (dest.length < 2) { toast('Say where to'); input.focus(); return; }
    P.planning = true; C.paint();
    try {
      const days = Math.min(LIMITS.maxLen, b.days);
      const plan = await tripPlan({ request: `${days} days in ${dest}, ${b.start} to ${b.end}`, constraints: { destination: dest, start: b.start, days } });
      const S = C.S;
      S.ptoOpen = false; P.planning = false; P.planFor = null;
      S.newTrip = { plan, quick: true }; // travel-plan.js shows it: what Eden checked and changed, then Create
      if (S.data) S.view = 'workspace';
      S.focusNext = '.tv-newform';
    } catch (x) { P.planning = false; toast(err(x)); }
    C.paint();
  };
  return el('form', { class: 'tv-pto-plan', novalidate: '', onsubmit: go },
    el('label', { class: 'tv-pto-field grow' }, el('span', '', 'Where to?'), input),
    el('button', { type: 'submit', class: 'tv-btn primary', 'data-k': 'pto:plan:go', disabled: P.planning ? '' : null }, ico('spark', 14), P.planning ? 'Planning…' : 'Plan it'),
    P.planning ? el('p', { class: 'tv-fine', role: 'status' }, 'A minute or two: Eden drafts the days, then checks each place on Google Maps.') : null);
}
