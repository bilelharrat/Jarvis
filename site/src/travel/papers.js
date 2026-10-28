// Travellers' papers and what each trip needs of them. The person saves, per traveller, a name, the passport's
// nationality (a country code) and expiry date (the issue date if they like), and any travel authorisation they hold
// (ESTA, Canada eTA, UK ETA, Australia ETA or eVisitor, NZeTA) with its expiry. Never a passport or approval number.
// For a trip, Eden checks each traveller against each country it goes to, using only entry-rules.js (rules read on the
// official sites, each with its source and the day it was verified). Anything those rules don't cover is "check the
// official page" with the link (entry.js), never a guess. What still needs doing shows in Decisions left and is pushed.
//
//   trip-papers         {}                                                           → { travellers, kinds, rules_verified }
//   trip-papers-save    { id?, name, nationality, passport_expires, passport_issued?, auths?: [{ kind, expires }], confirm: true }
//                                                                                    → the same  (same id, or same name: replaced)
//   trip-papers-delete  { id }                                                       → the same
//   trip-entry-check    { id, countries?: [{ code, from?, to?, by_air? }], travellers?: [paper ids] }
//                       → { id, countries, countries_derived, travellers, items, open, rules_verified, checked_at }
//                       countries/travellers, when given, are kept for the trip (an empty list goes back to the default:
//                       the countries named in the trip's destination, every saved traveller).
//
// tpapers → [{ id, name, nationality, passport_expires, passport_issued | null, auths: [{ kind, expires }], added }]
// tentry:<trip> → { countries: [{ code, from, to, by_air }] | null, travellers: [ids] | null }
// tpaprem:<trip>:<item key> → { first_seen, sent: [stage] }: reminders already pushed for one open item.
// One job in the account's alarm queue (kind 'tpap'); armed again when a trip, a traveller's papers or the countries change.
//
// Reminders, at 09:00 in the trip's time zone (tz:<trip>, UTC without one): the morning after Eden first finds the item,
// then 6 weeks, 2 weeks, 1 week and 3 days before it is due (its apply-by day, else the day you arrive), and on the
// apply-by day itself. Each once; one whose morning passed long ago is not sent late. Fixed items stop on their own,
// because each run checks the papers again.

import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';
import { TripError, dayDate } from './trips.js';
import { localInstant } from './reminders.js';
import { entryAdvice } from './entry.js';
import { AUTH_KINDS, ETIAS, PASSPORT_RULES, RULES_VERIFIED, authRuleFor } from './entry-rules.js';

export const PAPERS = { max: 12, auths: 6, countries: 12, hour: 9, stages: [42, 14, 7, 3], lateMs: 18 * 3600_000 };
const JOB = 'tpap';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^p-[0-9a-f]{10}$/;
const DAY = 86400_000;
const NUMBER_FIELDS = ['passport_number', 'number', 'document_number', 'esta_number', 'application_number'];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const bad = (m) => new TripError(m);
const newId = () => `p-${[...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const nameKey = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s'’.-]+/g, '');

/* ---------- dates (all 'YYYY-MM-DD', UTC) ---------- */

const realDate = (d) => DATE.test(String(d || '')) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** Calendar months later; a day the month doesn't have becomes its last day (30 Nov + 3 months → 28 Feb). */
export function addMonths(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}
/** n working days (Monday to Friday) before d; public holidays aren't known, so they count as working days. */
export function workingDaysBefore(d, n) {
  let t = d;
  for (let left = n; left > 0;) { t = addDays(t, -1); const w = new Date(`${t}T00:00:00Z`).getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return t;
}
export const fmtDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const today = (account) => new Date(account.now()).toISOString().slice(0, 10);

/* ---------- countries ---------- */

let regions;
export function countryName(cc) {
  try { regions ||= new Intl.DisplayNames(['en'], { type: 'region' }); const n = regions.of(cc); return n && n !== cc && !/unknown/i.test(n) ? n : null; } catch { return null; }
}
let byName;
const ALIASES = { uk: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB', usa: 'US', 'united states of america': 'US', holland: 'NL', 'czech republic': 'CZ' };
/** The countries a trip's destination names, by their English names (whole words): "Lisbon, Portugal" → ['PT']. */
export function countriesNamed(text) {
  if (!byName) {
    byName = new Map(Object.entries(ALIASES));
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) { const cc = String.fromCharCode(a, b), n = countryName(cc); if (n && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), cc); }
  }
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-zÀ-ɏ]+/g, ' ')} `;
  const out = [];
  // longest names first, so "Northern Ireland" isn't also read as "Ireland"
  let rest = t;
  for (const [n, cc] of [...byName].sort((x, y) => y[0].length - x[0].length)) {
    const w = ` ${n.replace(/[^a-zÀ-ɏ]+/g, ' ').trim()} `;
    if (w.trim().length < 2 || !rest.includes(w)) continue;
    out.push([rest.indexOf(w), cc]);
    rest = rest.split(w).join(' '.repeat(w.length)); // same length: later matches keep their place
  }
  return [...new Set(out.sort((x, y) => x[0] - y[0]).map(([, cc]) => cc))]; // in the order the text names them
}

/* ---------- the saved papers ---------- */

const view = (p) => ({ id: p.id, name: p.name, nationality: p.nationality, nationality_name: countryName(p.nationality), passport_expires: p.passport_expires, passport_issued: p.passport_issued, auths: p.auths.map((a) => ({ ...a, name: AUTH_KINDS[a.kind].name })) });
const kinds = () => Object.entries(AUTH_KINDS).map(([kind, k]) => ({ kind, name: k.name, country: k.country }));

export function cleanPapers(b) {
  if (!isObj(b)) throw bad('Send the traveller as an object.');
  for (const f of NUMBER_FIELDS) if (b[f] != null && b[f] !== '') throw bad('Eden doesn’t keep passport or application numbers. Leave the number out.');
  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw bad('Give the traveller’s name.');
  const nationality = String(b.nationality || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(nationality) || !countryName(nationality)) throw bad('The nationality is the passport’s country, as a two-letter code (like GB, US or PT).');
  if (!realDate(b.passport_expires)) throw bad('The passport’s expiry date is needed, as YYYY-MM-DD.');
  const passport_issued = b.passport_issued == null || b.passport_issued === '' ? null : String(b.passport_issued);
  if (passport_issued !== null && (!realDate(passport_issued) || passport_issued >= b.passport_expires)) throw bad('The issue date must be a real date (YYYY-MM-DD) before the expiry date.');
  const auths = [];
  for (const a of Array.isArray(b.auths) ? b.auths : []) {
    if (!isObj(a)) throw bad('Each approval is { kind, expires }.');
    for (const f of NUMBER_FIELDS) if (a[f] != null && a[f] !== '') throw bad('Eden doesn’t keep passport or application numbers. Leave the number out.');
    if (!Object.hasOwn(AUTH_KINDS, a.kind)) throw bad(`An approval's kind is one of ${Object.keys(AUTH_KINDS).join(', ')}.`);
    if (!realDate(a.expires)) throw bad(`Give the ${AUTH_KINDS[a.kind].name}’s expiry date, as YYYY-MM-DD (it’s on the approval).`);
    if (auths.some((x) => x.kind === a.kind)) throw bad(`Only one ${AUTH_KINDS[a.kind].name} per traveller.`);
    auths.push({ kind: a.kind, expires: a.expires });
  }
  if (auths.length > PAPERS.auths) throw bad(`At most ${PAPERS.auths} approvals per traveller.`);
  return { name, nationality, passport_expires: b.passport_expires, passport_issued, auths };
}

/* ---------- the checks ---------- */

function cleanCountries(list, trip) {
  if (!Array.isArray(list)) throw bad('countries is a list of { code, from?, to?, by_air? }.');
  if (list.length > PAPERS.countries) throw bad(`At most ${PAPERS.countries} countries a trip.`);
  const start = trip.start, end = dayDate(trip, Math.max(0, trip.days.length - 1));
  return list.map((c) => {
    const o = typeof c === 'string' ? { code: c } : c;
    if (!isObj(o)) throw bad('Each country is { code, from?, to?, by_air? }.');
    const code = String(o.code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || !countryName(code)) throw bad('A country is its two-letter code (like PT).');
    const from = o.from == null || o.from === '' ? start : String(o.from), to = o.to == null || o.to === '' ? end : String(o.to);
    if (!realDate(from) || !realDate(to) || to < from) throw bad('A country’s from and to are dates (YYYY-MM-DD), from first.');
    return { code, from, to, by_air: o.by_air == null ? null : o.by_air === true };
  });
}

const src = (s) => ({ by: s.by, url: s.url, verified: s.verified, quote: s.quote || null });
function officialLinks(cc, nat) {
  const own = entryAdvice({ country_code: cc, passport: nat === 'US' || nat === 'GB' ? nat : '' }) || entryAdvice({ country_code: cc }) || [];
  return own.map((a) => ({ title: a.title, url: a.url, by: a.by, verified: a.verified_on }));
}

/**
 * Everything one trip needs of each traveller: items { key, traveller, country, kind, status, text, by, by_text,
 * apply_url, caveat, source, links }. status: 'problem' (fix it: a passport too short, an approval expired), 'todo'
 * (apply for something), 'check' (no rule in Eden: read the official page), 'ok', 'info'. Pure: no storage, no clock
 * but `now` (a date).
 */
export function entryChecks(trip, travellers, countries, now) {
  const items = [];
  const named = (cs) => cs.map((c) => countryName(c.code)).join(', ');
  for (const t of travellers) {
    const nat = t.nationality, natName = countryName(nat);
    const who = { id: t.id, name: t.name };
    const abroad = countries.filter((c) => c.code !== nat);
    const ruled = new Set();
    // passport validity, per rule (a whole area once: the Schengen area counts from first entry to last exit)
    for (const r of PASSPORT_RULES) {
      const here = abroad.filter((c) => r.countries.includes(c.code));
      if (!here.length || !r.for(nat)) continue;
      for (const c of here) ruled.add(c.code);
      const enter = here.reduce((m, c) => (c.from < m ? c.from : m), here[0].from);
      const leave = here.reduce((m, c) => (c.to > m ? c.to : m), here[0].to);
      const need = r.until === 'leave+3m' ? addMonths(leave, 3) : leave;
      const where = `${named(here)}${here.length > 1 || r.area !== countryName(here[0].code) ? ` (${r.area})` : ''}`;
      const base = { traveller: who, country: here[0].code, countries: here.map((c) => c.code), source: src(r.source), apply_url: null, caveat: null, links: [] };
      if (t.passport_expires < need) {
        items.push({ ...base, key: `${t.id}:${r.id}`, kind: 'passport', status: 'problem', by: enter, by_text: `before you leave on ${fmtDate(enter)}`,
          text: `${t.name}’s passport must be valid until ${fmtDate(need)} for ${where}; it expires ${fmtDate(t.passport_expires)}.` });
      } else {
        items.push({ ...base, key: `${t.id}:${r.id}`, kind: 'passport', status: 'ok', by: null, by_text: null,
          text: `${t.name}’s passport is valid long enough for ${where} (needed until ${fmtDate(need)}).` });
      }
      if (r.issued_years) {
        const after = addMonths(enter, -12 * r.issued_years);
        const k = { ...base, key: `${t.id}:${r.id}:issued`, kind: 'passport', by: null, by_text: null };
        if (t.passport_issued == null) items.push({ ...k, status: 'check', text: `Check ${t.name}’s passport was issued after ${fmtDate(after)}: ${r.area} needs it issued within the last ${r.issued_years} years.` });
        else if (t.passport_issued < after) items.push({ ...k, status: 'problem', by: enter, by_text: `before you leave on ${fmtDate(enter)}`, text: `${t.name}’s passport was issued on ${fmtDate(t.passport_issued)}; ${r.area} needs one issued after ${fmtDate(after)}.` });
      }
    }
    for (const c of abroad) {
      const cname = countryName(c.code);
      const links = officialLinks(c.code, nat);
      // a passport that runs out before the trip leaves the country: plain arithmetic, no rule needed
      if (!ruled.has(c.code) && t.passport_expires < c.to) {
        items.push({ key: `${t.id}:${c.code}:expires`, traveller: who, country: c.code, kind: 'passport', status: 'problem', by: c.from, by_text: `before you leave on ${fmtDate(c.from)}`,
          text: `${t.name}’s passport expires ${fmtDate(t.passport_expires)}, before you leave ${cname} on ${fmtDate(c.to)}.`, source: null, apply_url: null, caveat: null, links });
      }
      const r = authRuleFor(c.code);
      const base = { traveller: who, country: c.code, kind: 'auth', source: r ? src(r.source) : null, apply_url: r ? r.apply_url : null, caveat: r ? r.caveat : null, links };
      if (r && r.needed_by.includes(nat) && !r.exempt.includes(nat)) {
        const has = t.auths.find((a) => a.kind === r.kind);
        const by = r.apply.working_days ? workingDaysBefore(c.from, r.apply.working_days) : r.apply.before_arrival ? c.from : (now < c.from ? now : c.from);
        const byText = r.apply.working_days ? `apply by ${fmtDate(by)} (${r.apply.working_days} working days before you arrive)` : r.apply.before_arrival ? `before you arrive on ${fmtDate(c.from)}` : 'apply now';
        const air = r.air_only && c.by_air === false;
        if (air) items.push({ ...base, key: `${t.id}:${r.id}`, status: 'check', by: null, by_text: null, text: `${t.name} isn’t flying into ${cname}: ${r.caveat}` });
        else if (!has) items.push({ ...base, key: `${t.id}:${r.id}`, status: 'todo', by, due: r.apply.working_days ? by : c.from, by_text: byText, text: `${r.name} needed for ${cname} (${t.name}, ${natName} passport). ${r.apply.text}` });
        else if (has.expires < c.from) items.push({ ...base, key: `${t.id}:${r.id}`, status: 'problem', by, due: r.apply.working_days ? by : c.from, by_text: byText, text: `${t.name}’s ${r.name} ends ${fmtDate(has.expires)}, before you arrive in ${cname} on ${fmtDate(c.from)}. Apply for a new one.` });
        else if (r.valid_on === 'arrival' || has.expires >= c.to) items.push({ ...base, key: `${t.id}:${r.id}`, status: 'ok', by: null, by_text: null, text: `${t.name}’s ${r.name} is valid${r.valid_on === 'arrival' ? ' when you arrive' : ' for the whole stay'} (until ${fmtDate(has.expires)}).` });
        else items.push({ ...base, key: `${t.id}:${r.id}`, status: 'check', by: null, by_text: null, text: `${t.name}’s ${r.name} ends ${fmtDate(has.expires)}, during the stay in ${cname}. Check the official page whether that matters.` });
      } else if (!(r && r.exempt.includes(nat))) {
        // no rule in Eden for this nationality here (it may need a visa, or nothing): the official page decides
        items.push({ ...base, key: `${t.id}:${c.code}:check`, status: 'check', by: null, by_text: null, source: null,
          text: `Visas and entry rules for ${cname} with a ${natName} passport: Eden has no checked rule, so check the official page.` });
      }
    }
    // ETIAS: not started (official site); said once, so nobody pays a look-alike site for it
    if (!ETIAS.started && abroad.some((c) => ETIAS.countries.includes(c.code)) && PASSPORT_RULES[0].for(nat)) {
      items.push({ key: `${t.id}:etias`, traveller: who, country: abroad.find((c) => ETIAS.countries.includes(c.code)).code, kind: 'auth', status: 'info', by: null, by_text: null, text: ETIAS.text, source: src(ETIAS.source), apply_url: null, caveat: null, links: [] });
    }
  }
  return items;
}

const OPEN = new Set(['problem', 'todo']);
/** The open items, soonest first, as Decisions left and the pushes word them. */
export const openItems = (items) => items.filter((i) => OPEN.has(i.status)).sort((a, b) => String(a.by || '9').localeCompare(String(b.by || '9')));

async function tripEntry(storage, id) { return (await storage.get(`tentry:${id}`)) || { countries: null, travellers: null }; }

/** What one trip needs: the check, with the countries and travellers it used. */
export async function checkTrip(account, id, trip = null) {
  const storage = account.storage;
  trip ||= await storage.get(`trip:${id}`);
  if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
  const all = (await storage.get('tpapers')) || [];
  const kept = await tripEntry(storage, id);
  const end = dayDate(trip, Math.max(0, trip.days.length - 1));
  const derived = !kept.countries;
  const countries = kept.countries || countriesNamed(trip.destination || trip.title).map((code) => ({ code, from: trip.start, to: end, by_air: null }));
  const travellers = kept.travellers ? all.filter((p) => kept.travellers.includes(p.id)) : all;
  const items = entryChecks(trip, travellers, countries, today(account));
  return {
    id, countries: countries.map((c) => ({ ...c, name: countryName(c.code) })), countries_derived: derived,
    travellers: travellers.map((p) => ({ id: p.id, name: p.name })), items, open: openItems(items).map((i) => i.key),
    rules_verified: RULES_VERIFIED, checked_at: new Date(account.now()).toISOString(),
  };
}

export async function papersOp(account, op, body = {}) {
  const storage = account.storage;
  let list = (await storage.get('tpapers')) || [];
  const out = () => ({ travellers: list.map(view), kinds: kinds(), rules_verified: RULES_VERIFIED });
  if (op === 'trip-papers') return out();
  if (op === 'trip-papers-delete') {
    const id = String(body.id || '');
    if (!ID.test(id) || !list.some((p) => p.id === id)) throw new TripError('There is no such traveller.', 404, 'not_found');
    list = list.filter((p) => p.id !== id);
    await storage.put('tpapers', list);
    return out();
  }
  if (op === 'trip-papers-save') {
    if (body.confirm !== true) throw bad('papers-save needs confirm: true (the person pressed Save).');
    const p = cleanPapers(body);
    const id = body.id != null && body.id !== '' ? String(body.id) : null;
    if (id && (!ID.test(id) || !list.some((x) => x.id === id))) throw new TripError('There is no such traveller.', 404, 'not_found');
    const old = id ? list.find((x) => x.id === id) : list.find((x) => nameKey(x.name) === nameKey(p.name));
    const left = list.filter((x) => x !== old);
    if (left.length >= PAPERS.max) throw new TripError(`Eden keeps papers for at most ${PAPERS.max} travellers. Remove one first.`, 409, 'too_many');
    list = [...left, { id: old ? old.id : newId(), ...p, added: old ? old.added : account.now() }];
    await storage.put('tpapers', list);
    return out();
  }
  if (op === 'trip-entry-check') {
    const id = String(body.id || '');
    const trip = await storage.get(`trip:${id}`);
    if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
    if (body.countries != null || body.travellers != null) {
      const kept = await tripEntry(storage, id);
      if (body.countries != null) kept.countries = body.countries.length ? cleanCountries(body.countries, trip) : null;
      if (body.travellers != null) {
        if (!Array.isArray(body.travellers) || body.travellers.some((t) => !list.some((p) => p.id === t))) throw bad('travellers is a list of saved travellers’ ids.');
        kept.travellers = body.travellers.length ? [...new Set(body.travellers)] : null;
      }
      await storage.put(`tentry:${id}`, kept);
    }
    return checkTrip(account, id, trip);
  }
  throw new TripError('Unknown trip op.', 404, 'not_found');
}

/* ---------- reminders ---------- */

const zoneOf = async (storage, id) => { const z = await storage.get(`tz:${id}`); return z && typeof z === 'object' ? z.zone : typeof z === 'string' ? z : null; };

/**
 * When to push for one open item: [{ stage, at }], soonest first. `firstSeen` is when Eden first found it (ms). The
 * item is due on its `due` day (an apply-by day, or the arrival day when the advice is "apply now"), else `by`, else
 * `arrive`.
 */
export function stageTimes(item, firstSeen, zone = null, arrive = null) {
  const due = item.due || item.by || arrive;
  if (!due) return [];
  const at = (d) => localInstant(d, PAPERS.hour * 60, zone);
  const out = PAPERS.stages.map((n) => ({ stage: `d${n}`, at: at(addDays(due, -n)) }));
  out.push({ stage: 'by', at: at(due) });
  const seenDay = new Date(firstSeen).toISOString().slice(0, 10);
  let found = at(addDays(seenDay, 1));
  if (at(seenDay) > firstSeen) found = at(seenDay);
  // the first push: the next 09:00 after Eden found it, unless a stage comes within 3 days anyway
  const later = out.filter((s) => s.at > firstSeen);
  if (!later.some((s) => s.at - found < 3 * DAY && s.at >= found)) out.push({ stage: 'found', at: found });
  return out.filter((s) => s.at > firstSeen && s.at <= at(due) + DAY).sort((a, b) => a.at - b.at);
}

async function openForTrips(account) {
  const storage = account.storage;
  if (!((await storage.get('tpapers')) || []).length) return [];
  const now = today(account), out = [];
  for (const [k, trip] of await storage.list({ prefix: 'trip:' })) {
    if (!trip || !Array.isArray(trip.days) || !trip.start) continue;
    const id = k.slice(5);
    if (dayDate(trip, Math.max(0, trip.days.length - 1)) < now) continue; // trip over
    const r = await checkTrip(account, id, trip);
    const zone = await zoneOf(storage, id);
    for (const i of openItems(r.items)) {
      const c = r.countries.find((x) => x.code === i.country);
      out.push({ key: `tpaprem:${id}:${i.key}`, id, trip, item: i, zone, arrive: c ? c.from : trip.start });
    }
  }
  return out;
}

/** The push for one item. */
export function papersPush(trip, id, item) {
  return {
    title: `Before ${trip.title || 'your trip'}: ${item.kind === 'passport' ? 'passport' : 'entry papers'}`.slice(0, 120),
    body: `${item.text}${item.by_text ? ` (${item.by_text})` : ''}`.slice(0, 400),
    data: { kind: 'papers', trip: id, item: item.key, ...(item.apply_url ? { url: item.apply_url } : {}) },
  };
}

/** Set the one job to the soonest push still to come, or drop it. Records of items now fixed are forgotten. */
export async function armPapersReminders(account) {
  const storage = account.storage, now = account.now();
  const list = await openForTrips(account);
  const live = new Set(list.map((p) => p.key));
  for (const [k] of await storage.list({ prefix: 'tpaprem:' })) if (!live.has(k)) await storage.delete(k);
  let next = Infinity;
  for (const p of list) {
    let rec = await storage.get(p.key);
    if (!rec) { rec = { first_seen: now, sent: [] }; await storage.put(p.key, rec); }
    for (const s of stageTimes(p.item, rec.first_seen, p.zone, p.arrive)) {
      if (rec.sent.includes(s.stage) || now > s.at + PAPERS.lateMs) continue;
      next = Math.min(next, Math.max(now + 1000, s.at));
    }
  }
  if (Number.isFinite(next)) await scheduleJob(account, JOB, JOB, next);
  else await unscheduleJob(account, JOB);
  return Number.isFinite(next) ? next : null;
}

/** The job: for each open item, the latest stage now due is pushed once; earlier ones it covers are marked sent. */
export async function papersRemindersDue(account, { notify }) {
  const storage = account.storage, now = account.now();
  for (const p of await openForTrips(account)) {
    const rec = (await storage.get(p.key)) || { first_seen: now, sent: [] };
    const due = stageTimes(p.item, rec.first_seen, p.zone, p.arrive).filter((s) => s.at <= now && !rec.sent.includes(s.stage));
    if (!due.length) { await storage.put(p.key, rec); continue; }
    const last = due[due.length - 1];
    if (now <= last.at + PAPERS.lateMs) await notify(account, papersPush(p.trip, p.id, p.item));
    rec.sent.push(...due.map((s) => s.stage));
    await storage.put(p.key, rec);
  }
  await armPapersReminders(account);
}
