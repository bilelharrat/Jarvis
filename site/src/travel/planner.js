// Eden Travel's planner for a new trip (owner, 2026-10-28: "draft with the best search model, then Eden's checks verify
// and fix"). The travel-plan pilot (askeden-travel eval/travel-plans/results/2026-10-28-pilot) had Ask Eden's own tool
// loop deliver a plan 1 time in 8 against 8 in 8 for GPT-6.1 Sol + web search; this puts that model first and Eden's
// Google checks after it.
//
// trip-plan { request, constraints?: { destination, start, days, travelers, budget, pace } }
//   → { trip, checks, changes, unresolved, sources, notes, model, searched, costs, took_ms, note? }   (nothing is saved:
//     `trip` goes to trip-create when the person presses Create, as Ask Eden's trip_create card)
//
// 1. Draft: GPT-6.1 Sol with OpenAI's web_search tool (Responses API), its answer held to TRIP_SCHEMA (cleanTrip's shape,
//    each place with a source_url for the hours or closure it relied on). No OpenAI key here: the service's own model
//    (service-ai.js) drafts without search, and `note` says so.
// 2. Verify: every place looked up on Google on its own (one place per search, near the destination), then checkTrip
//    (open that weekday and at that time, closed for good, travel times, pace).
// 3. Fix, Eden first: closed for good or not on Google → removed, with why; closed that day or out of hours → re-timed
//    the same day if its hours allow, else moved to another trip day where it's open (a meal only within its own meal
//    time; a stay or getting-there stop never moved); arriving late → started when you'd get there, if that still fits.
//    Then, only if problems remain, ONE repair round back to the search model with the exact failures and Google's
//    hours ("replace, re-time or move these; don't change the rest": its edits can only touch those stops), and the
//    checks again. Anything still wrong is in `unresolved` with Google's own words, never kept silently.
//
// Budget per plan: PLAN (tokens, web searches, Google dollars on its own meter, time).

import { CACHE, FRESH, checkTrip, noCache } from './checks.js';
import { MapsError, distanceKm } from './maps.js';
import { KINDS, TRIP, TripError, cleanTrip, dayDate, hhmm, minutesOf, money, weekday } from './trips.js';

export const PLAN = {
  model: 'gpt-6.1-sol', effort: 'medium', // the best measured search model (2026-10-27 hard bake-off; 2026-10-28 travel pilot)
  draftTokens: 16_000, repairTokens: 8_000, // output caps, reasoning included
  draftSearches: 10, repairSearches: 4, // web_search calls (max_tool_calls)
  draftMs: 75_000, repairMinMs: 25_000, deadlineMs: 100_000,
  googleUsd: 1.5, // this plan's Google spend (spend.js meter's per-open cap); the account's daily cap still holds
  places: 30, km: 80, request: 2000,
  daily: 20, // plans an account makes a day (ops.js; TRAVEL_PLANS_A_DAY)
  // GPT-6.1 Sol list prices: $2 / $10 per million tokens (askeden src/models.ts); web search $0.01 a call (askeden
  // src/chat/stream.ts OPENAI_SEARCH_USD)
  inUsd: 2, outUsd: 10, searchUsd: 0.01,
  fallbackModel: 'claude-sonnet-5-5',
};
const RESPONSES = 'https://api.openai.com/v1/responses';
const PACES = ['relaxed', 'normal', 'packed'];
const MODES = ['walk', 'transit', 'drive', 'taxi'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const GAP = 15; // minutes kept free between stops when Eden moves one
const DAY_FROM = 8 * 60, DAY_TO = 23 * 60;
// a meal keeps its own meal time when Eden re-times it (and never changes day)
const MEALS = [[7 * 60, 10 * 60 + 30], [11 * 60 + 30, 15 * 60], [18 * 60, 22 * 60 + 30]];
const MOVABLE = new Set(['visit', 'activity', 'rental']);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (s, cap) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const httpsUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString().slice(0, 500) : null; } catch { return null; } };
const round = (n, k = 4) => Math.round(n * 10 ** k) / 10 ** k;
const off = (env, name) => /^(off|0|false|no)$/i.test(String(env[name] ?? '').trim());

// ── what the model answers (strict JSON schema: every field present, null where it has nothing) ──

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const PLACE_SCHEMA = { type: 'object', additionalProperties: false, required: ['name', 'address', 'city'], properties: { name: { type: 'string' }, address: nullable({ type: 'string' }), city: nullable({ type: 'string' }) } };
const COST_SCHEMA = { type: 'object', additionalProperties: false, required: ['amount', 'currency'], properties: { amount: { type: 'number' }, currency: { type: 'string' } } };
export const TRIP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'destination', 'start', 'travelers', 'days', 'notes'],
  properties: {
    title: { type: 'string' }, destination: { type: 'string' }, start: { type: 'string', description: 'YYYY-MM-DD' }, travelers: { type: 'integer' },
    notes: { type: 'string', description: 'closures and changes you planned around, and anything assumed (dates, party size)' },
    days: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'stops'], properties: {
      title: { type: 'string' },
      stops: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'place', 'at', 'minutes', 'mode', 'nights', 'note', 'cost', 'source_url'], properties: {
        kind: { type: 'string', enum: KINDS }, place: PLACE_SCHEMA, at: { type: 'string', description: 'HH:MM, 24-hour' }, minutes: { type: 'integer' },
        mode: { type: 'string', enum: MODES }, nights: nullable({ type: 'integer' }), note: { type: 'string' }, cost: nullable(COST_SCHEMA),
        source_url: nullable({ type: 'string', description: 'the page you relied on for its hours or that it is open (official site first)' }),
      } } },
    } } },
  },
};
export const REPAIR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['edits'],
  properties: { edits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['stop', 'action', 'day', 'at', 'minutes', 'place', 'kind', 'note', 'source_url', 'why'], properties: {
    stop: { type: 'string' }, action: { type: 'string', enum: ['retime', 'move', 'replace', 'remove'] },
    day: nullable({ type: 'integer' }), at: nullable({ type: 'string' }), minutes: nullable({ type: 'integer' }), place: nullable(PLACE_SCHEMA),
    kind: nullable({ type: 'string', enum: KINDS }), note: nullable({ type: 'string' }), source_url: nullable({ type: 'string' }), why: { type: 'string' },
  } } } },
};

export function plannerSystem(today) {
  return [
    `You plan trips for Eden Travel. Today is ${today}. Answer only with the JSON the schema asks for.`,
    'Use web search to check, for every place you schedule, that it exists and is open on that exact weekday and at that time: opening days and hours, weekly closing days, seasonal or holiday closures, renovations, and places closed for good or moved. Prefer the place’s official site.',
    'Never schedule a place on a day or at a time it is closed. If something the person asked for is closed on their dates, plan it on another day of the trip when it is open, or leave it out, and say so in notes.',
    'source_url: for each visit, meal and activity, the page you relied on for its hours or that it is open. null only for a stop with no hours (a street, a square, a viewpoint) or a getting-there stop.',
    'Real, named places only (“Trattoria Mario”, not “a trattoria”), each with its street address and city when you know them, so the map finds the right one (similar names are common: give the full official name). Meals at normal local times in a named place that is open then.',
    'Each day: stops in time order, at = start time (HH:MM, 24-hour), minutes = time spent there, mode = how you get there from the stop before (walk, transit, drive or taxi), with realistic travel time between stops. Day 1 is the start date, day 2 the next date, and so on.',
    'Kinds: stay (the hotel, on the first day, with nights), transport (arriving, leaving, a train or ferry: named with its route), meal, activity, rental, visit. Leave cost null unless a source gave the price.',
    'Keep to what the person asked (dates, length, pace, interests). If they gave no date, choose the soonest sensible one and say so in notes.',
  ].join('\n');
}

// ── the person's words and form ──

export function cleanPlanArgs(body = {}) {
  const request = text(body.request, PLAN.request);
  const c = isObj(body.constraints) ? body.constraints : {};
  const out = {};
  if (text(c.destination, 120)) out.destination = text(c.destination, 120);
  if (c.start != null && c.start !== '') {
    if (!DATE.test(String(c.start)) || Number.isNaN(Date.parse(`${c.start}T00:00:00Z`))) throw new TripError('constraints.start must be YYYY-MM-DD.');
    out.start = String(c.start);
  }
  if (c.days != null && c.days !== '') {
    const d = Number(c.days);
    if (!Number.isInteger(d) || d < 1 || d > TRIP.days) throw new TripError(`constraints.days: 1 to ${TRIP.days}.`);
    out.days = d;
  }
  if (c.travelers != null && c.travelers !== '') {
    const n = Number(c.travelers);
    if (!Number.isInteger(n) || n < 1 || n > TRIP.travelers) throw new TripError(`constraints.travelers: 1 to ${TRIP.travelers}.`);
    out.travelers = n;
  }
  const budget = money(c.budget ?? null, 'constraints.budget');
  if (budget) out.budget = budget;
  if (c.pace != null && c.pace !== '') {
    if (!PACES.includes(String(c.pace))) throw new TripError(`constraints.pace: one of ${PACES.join(', ')}.`);
    out.pace = String(c.pace);
  }
  if (request.length < 3 && !out.destination) throw new TripError('request: what trip to plan (where, when, how long).');
  return { request, constraints: out };
}

function userText({ request, constraints: c }) {
  const lines = [`The person asked: “${request || `A trip to ${c.destination}`}”`];
  const said = [];
  if (c.destination) said.push(`destination ${c.destination}`);
  if (c.start) said.push(`first day ${c.start}`);
  if (c.days) said.push(`${c.days} day${c.days === 1 ? '' : 's'}`);
  if (c.travelers) said.push(`${c.travelers} traveller${c.travelers === 1 ? '' : 's'}`);
  if (c.budget) said.push(`budget ${c.budget.amount} ${c.budget.currency}`);
  if (c.pace) said.push(`pace: ${c.pace}${c.pace === 'relaxed' ? ' (two or three sights a day)' : c.pace === 'packed' ? ' (as much as fits)' : ''}`);
  if (said.length) lines.push(`From their form (these win): ${said.join('; ')}.`);
  if (c.start && c.days) lines.push(`The days: ${Array.from({ length: c.days }, (_, i) => { const d = dayDate({ start: c.start }, i); return `day ${i + 1} = ${DAY_NAMES[weekday(d)]} ${d}`; }).join(', ')}.`);
  return lines.join('\n');
}

// ── the models ──

export class PlanError extends TripError {}

/** One Responses API call with web search and a JSON schema answer → { json, citations, searches, usage, usd }. */
async function askSearchModel(key, { system, user, schema, name, maxTokens, maxSearches, ms, fetch: f }) {
  let res;
  try {
    res = await f(RESPONSES, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: PLAN.model, reasoning: { effort: PLAN.effort }, store: false,
        tools: [{ type: 'web_search' }], max_tool_calls: maxSearches, max_output_tokens: maxTokens,
        input: [{ role: 'developer', content: system }, { role: 'user', content: user }],
        text: { format: { type: 'json_schema', name, schema, strict: true } },
      }),
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    throw new PlanError(e && e.name === 'TimeoutError' ? 'The planner took too long. Try again, or ask for fewer days.' : 'The planner could not be reached.', 504, 'unavailable');
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlanError(`The planner answered ${res.status}${out.error && out.error.message ? `: ${String(out.error.message).slice(0, 160)}` : ''}.`, 502, 'unavailable');
  const items = Array.isArray(out.output) ? out.output : [];
  const parts = items.filter((o) => o && o.type === 'message').flatMap((o) => (Array.isArray(o.content) ? o.content : [])).filter((c) => c && c.type === 'output_text');
  const citations = parts.flatMap((p) => (Array.isArray(p.annotations) ? p.annotations : [])).filter((a) => a && a.type === 'url_citation' && httpsUrl(a.url)).map((a) => ({ url: httpsUrl(a.url), title: text(a.title, 160) }));
  const searches = items.filter((o) => o && o.type === 'web_search_call').length;
  const u = out.usage || {};
  const usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, reasoning: (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0 };
  const usd = (usage.input * PLAN.inUsd + usage.output * PLAN.outUsd) / 1e6 + searches * PLAN.searchUsd;
  if (out.status === 'incomplete') throw Object.assign(new PlanError('The planner ran out of room for this trip. Ask for fewer days.', 502, 'incomplete'), { usage, usd, searches });
  let json;
  try { json = JSON.parse(parts.map((p) => p.text).join('')); } catch { throw Object.assign(new PlanError('The planner’s answer could not be read.', 502, 'unreadable'), { usage, usd, searches }); }
  return { json, citations, searches, usage, usd };
}

/** No OpenAI key: the service's own model (service-ai.js) drafts, without web search. */
async function askServiceModel(env, { system, user, schema, maxTokens, ms, fetch: f }) {
  const [{ serviceFetch }, { priceOf }] = await Promise.all([import('../accounts/service-ai.js'), import('../accounts/proxy.js')]);
  let res;
  try {
    res = await serviceFetch(env, { model: String(env.TRAVEL_PLAN_FALLBACK_MODEL || PLAN.fallbackModel), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema } } }, { signal: AbortSignal.timeout(ms), ...(f ? { fetch: f } : {}) });
  } catch { throw new PlanError('The planner could not be reached.', 504, 'unavailable'); }
  if (!res) throw new PlanError('Eden’s planner isn’t set up here (no model key).', 503, 'not_set_up');
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlanError(`The planner answered ${res.status}.`, 502, 'unavailable');
  const usage = { input: out.usage?.input_tokens || 0, output: out.usage?.output_tokens || 0, reasoning: 0 };
  const [pin, pout] = priceOf(out.model);
  let json;
  try { json = JSON.parse((out.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new PlanError('The planner’s answer could not be read.', 502, 'unreadable'); }
  return { json, citations: [], searches: 0, usage, usd: (usage.input * pin + usage.output * pout) / 1e6, model: String(out.model || PLAN.fallbackModel) };
}

// ── the draft → a trip cleanTrip takes (the model's slips mended, never invented) ──

function draftTrip(j, { constraints: c }, newId) {
  const days = (Array.isArray(j.days) ? j.days : []).slice(0, c.days || TRIP.days);
  while (c.days && days.length < c.days) days.push({ title: `Day ${days.length + 1}`, stops: [] });
  const src = new Map(); // stop id → its source_url
  const trip = {
    title: text(j.title, TRIP.title) || (c.destination ? `${c.destination}` : 'New trip'),
    destination: c.destination || text(j.destination, 120),
    start: c.start || (DATE.test(String(j.start)) ? String(j.start) : null),
    travelers: c.travelers || (Number.isInteger(j.travelers) && j.travelers >= 1 && j.travelers <= TRIP.travelers ? j.travelers : 1),
    budget: c.budget || null,
    days: days.map((d, i) => ({
      title: text(isObj(d) && d.title, TRIP.title) || `Day ${i + 1}`,
      stops: (isObj(d) && Array.isArray(d.stops) ? d.stops : []).filter((s) => isObj(s) && isObj(s.place) && text(s.place.name, 120) && TIME.test(String(s.at))).slice(0, TRIP.stops).map((s) => {
        const id = newId();
        const url = httpsUrl(s.source_url);
        if (url) src.set(id, url);
        const kind = KINDS.includes(s.kind) ? s.kind : 'visit';
        let cost = null;
        try { cost = money(s.cost ?? null, 'cost'); } catch { cost = null; }
        return {
          id, kind, at: String(s.at), mode: MODES.includes(s.mode) ? s.mode : 'walk', cost,
          minutes: Number.isInteger(s.minutes) && s.minutes >= 0 && s.minutes <= 1440 ? s.minutes : 60,
          nights: kind === 'stay' && Number.isInteger(s.nights) && s.nights >= 1 && s.nights <= 60 ? s.nights : null,
          note: text(s.note, TRIP.note),
          place: { name: text(s.place.name, 120), address: text(s.place.address, 200) || null, city: text(s.place.city, 80) || null },
        };
      }),
    })),
  };
  if (!trip.start) throw new PlanError('The planner gave no start date. Say which day the trip starts.', 502, 'unreadable');
  if (!trip.days.length) throw new PlanError('The planner gave no days.', 502, 'unreadable');
  return { trip, src };
}

// ── Google: each place on its own ──

// words that say what a place is, not which one (a "yellow pumpkin" isn't the "red pumpkin")
const GENERIC = new Set(['the', 'and', 'von', 'van', 'dei', 'del', 'des', 'les', 'los', 'las', 'der', 'die', 'das', 'il', 'la', 'le', 'degli', 'della', 'delle', 'dello', 'dalla', 'nella', 'les', 'des', 'der', 'die', 'das', 'del', 'los', 'las', 'fontana', 'fountain', 'fuente', 'fontaine', 'brunnen', 'cattedrale', 'duomo', 'castello', 'castle', 'castillo', 'chateau', 'schloss', 'mercato', 'mercado', 'marche', 'markt', 'giardino', 'jardin', 'parco', 'parque', 'torre', 'turm', 'tour', 'museu', 'museum', 'musee', 'galerie', 'plaza', 'praca', 'place', 'museo', 'musee', 'gallery', 'galleries', 'galleria', 'cathedral', 'church', 'chiesa', 'basilica', 'restaurant', 'ristorante', 'trattoria', 'osteria', 'cafe', 'caffe', 'hotel', 'station', 'stazione', 'palace', 'palazzo', 'park', 'garden', 'gardens', 'bridge', 'ponte', 'square', 'piazza', 'platz', 'tower', 'market', 'with', 'from', 'near', 'centre', 'center', 'city', 'national', 'visit', 'tour']);
const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w)); // 3 letters count: "Red" pumpkin isn't the yellow one
/** More than half the distinctive words of the name asked for are in Google's (else the card says what it was matched
 *  as: similar names are a common slip; a translated name can show up here too, which is worth a look anyway). */
export const sameName = (asked, google) => {
  const g = [...new Set(words(google))], a = words(asked);
  const hit = (w, list) => list.some((x) => x.startsWith(w) || w.startsWith(x));
  // either way round: "Galleria degli Uffizi" is "Uffizi Galleries", "Fontana di Trevi" is "Trevi Fountain"
  return !a.length || !g.length || a.filter((w) => hit(w, g)).length * 2 > a.length || (g.length && g.every((w) => hit(w, a)));
};

/**
 * Looks up each stop that isn't a getting-there stop, one place per search, near the destination (and a stop's own
 * address or city). → Map stop id → { hit } | { none: true } | { error, held? }; stops found get Google's id and point.
 */
async function findPlaces(trip, maps, cache, center) {
  const memo = new Map();
  const found = new Map();
  const todo = [];
  for (const day of trip.days) for (const s of day.stops) {
    if (s.kind === 'transport' || s.place.id) continue;
    if (todo.length >= PLAN.places) { found.set(s.id, { error: 'Not looked up: the trip has more places than Eden checks in one plan.' }); continue; }
    // always with the city (a square or a church shares its name with many towns: "Piazza della Repubblica" in Signa
    // isn't Florence's); the address too when it says more than the name
    const city = String(s.place.city || trip.destination || '').trim();
    const addr = String(s.place.address || '').trim();
    const parts = [s.place.name, addr && addr.toLowerCase() !== s.place.name.toLowerCase() ? addr : '', city && !`${s.place.name} ${addr}`.toLowerCase().includes(city.split(',')[0].toLowerCase()) ? city : ''].filter(Boolean);
    todo.push({ s, q: parts.join(', ') });
  }
  await Promise.all(todo.map(async ({ s, q }) => {
    if (!memo.has(q)) memo.set(q, maps.search(q, center || {}).then((hits) => ({ hits }), (e) => ({ e })));
    const r = await memo.get(q);
    if (r.e) { found.set(s.id, { error: r.e instanceof MapsError ? r.e.message : 'The map lookup failed.', held: r.e && r.e.code === 'capped' }); return; }
    // of the hits near the destination: the one whose name matches, nearest first (a same-name place in the next town loses)
    const near = r.hits.filter((h) => Number.isFinite(h.lat) && (!center || distanceKm(h, center) < PLAN.km));
    const rank = (h) => (sameName(s.place.name, h.name) ? 0 : 1e6) + (center ? distanceKm(h, center) : 0);
    const hit = near.sort((x, y) => rank(x) - rank(y))[0];
    if (!hit) { found.set(s.id, { none: true, q }); return; }
    found.set(s.id, { hit, asked: s.place.name });
    s.place = { id: hit.id, name: hit.name, lat: hit.lat, lng: hit.lng };
    await seed(cache, hit);
  }));
  return found;
}

// The search answer already has the place's hours and status: kept in the checks' cache (checks.js lookups, keys ps1:/ph1:)
// so checkTrip doesn't pay Google again for the same place.
async function seed(cache, p) {
  if (!p || p.standin || !p.id || !cache || cache === noCache) return;
  const stamp = { source: p.source, checked_at: p.checked_at, standin: false };
  const pick = (keys) => Object.fromEntries(keys.filter((k) => k in p).map((k) => [k, p[k]]));
  await cache.put(`ps1:${p.id}`, { ...pick(['id', 'name', 'address', 'lat', 'lng', 'url', 'access']), ...stamp }, FRESH.stable, CACHE.keepMs);
  await cache.put(`ph1:${p.id}`, { ...pick(['status', 'hours', 'price', 'price_level', 'website', 'photo']), ...stamp }, Math.min(...FRESH.hours.map(([, a]) => a)), CACHE.keepMs);
}

// ── hours ──

/** The place's opening spans on that date, in minutes ([[open, close]]); null when Google lists no hours. */
export function spansOn(hit, date) {
  if (!hit || !Array.isArray(hit.hours)) return null;
  return hit.hours.filter((h) => h.day === weekday(date)).map((h) => { const o = minutesOf(h.open), c = minutesOf(h.close); return [o, c <= o ? 24 * 60 : c]; });
}
const fitsHours = (spans, at, minutes) => spans === null || spans.some(([o, c]) => at >= o && at + minutes <= c);
/** Google's week, in words: "Mon closed; Tue–Sun 08:15–18:30" style, one entry a day. */
export function weekText(hit) {
  if (!hit || !Array.isArray(hit.hours)) return 'no hours listed on Google Maps';
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((d) => { const h = hit.hours.filter((x) => x.day === d); return `${DAY_NAMES[d].slice(0, 3)} ${h.length ? h.map((x) => `${x.open}–${x.close}`).join(', ') : 'closed'}`; }).join('; ');
}

// ── Eden's own fixes ──

const busy = (day, except) => day.stops.filter((x) => x.id !== except).map((x) => [minutesOf(x.at), minutesOf(x.at) + x.minutes]);
/** The day's usable hours: after an arrival that opens it, before a departure that closes it. */
function bounds(day) {
  let lo = DAY_FROM, hi = DAY_TO;
  const st = [...day.stops].sort((a, b) => minutesOf(a.at) - minutesOf(b.at));
  if (st.length && st[0].kind === 'transport') lo = Math.max(lo, minutesOf(st[0].at) + st[0].minutes);
  if (st.length > 1 && st[st.length - 1].kind === 'transport') hi = Math.min(hi, minutesOf(st[st.length - 1].at));
  return [lo, hi];
}
/** The start time nearest `want` where the stop fits its hours, the day's bounds and the other stops (GAP each side). */
export function slot(day, stop, spans, want, { within = null } = {}) {
  const [lo0, hi0] = bounds(day);
  const lo = Math.max(lo0, within ? within[0] : 0), hi = Math.min(hi0, within ? within[1] : 24 * 60);
  const taken = busy(day, stop.id);
  let best = null;
  for (let t = Math.ceil(lo / 15) * 15; t + stop.minutes <= hi; t += 15) {
    if (!fitsHours(spans, t, stop.minutes)) continue;
    if (taken.some(([a, b]) => t < b + GAP && t + stop.minutes + GAP > a)) continue;
    if (best === null || Math.abs(t - want) < Math.abs(best - want)) best = t;
  }
  return best;
}
const mealTime = (at) => MEALS.find(([a, b]) => at >= a - 30 && at <= b) || null;
const where = (trip, d) => { const date = dayDate(trip, d); return `${DAY_NAMES[weekday(date)]} ${date}`; };

function findStop(trip, id) {
  for (let d = 0; d < trip.days.length; d++) {
    const i = trip.days[d].stops.findIndex((s) => s.id === id);
    if (i >= 0) return { d, i, s: trip.days[d].stops[i] };
  }
  return null;
}
const sortDay = (day) => day.stops.sort((a, b) => minutesOf(a.at) - minutesOf(b.at));

/**
 * Eden's deterministic fixes for the checks' alerts, in place on `trip` (cleanTrip's shape). `hits`: stop id → Google's
 * place (with hours). → the changes made; alerts it couldn't fix stay for the repair round.
 */
export function fixTrip(trip, checks, hits) {
  const changes = [];
  const seen = new Set();
  for (const a of checks.alerts) {
    if (seen.has(a.stop)) continue;
    seen.add(a.stop);
    const f = findStop(trip, a.stop);
    if (!f) continue;
    const { d, s } = f;
    const hit = hits.get(s.id) || null;
    const at = minutesOf(s.at);
    const evidence = (dd) => ({ text: `Google Maps hours: ${weekText(hit)}.`, source: hit ? hit.source : null, checked_at: hit ? hit.checked_at : null, on: where(trip, dd) });
    if (a.kind === 'late') {
      const c = checks.days[d] && checks.days[d].stops.find((x) => x.stop === s.id);
      if (!c) continue;
      const want = Math.ceil(minutesOf(c.arrive) / 5) * 5;
      const taken = busy(trip.days[d], s.id);
      const ok = want + s.minutes <= bounds(trip.days[d])[1] && fitsHours(spansOn(hit, dayDate(trip, d)), want, s.minutes) && !taken.some(([x, y]) => want < y && want + s.minutes > x)
        && (s.kind !== 'meal' || mealTime(want));
      if (!ok) continue;
      s.at = hhmm(want);
      changes.push({ stop: s.id, name: s.place.name, what: 'retimed', by: 'eden', from: { day: d, at: hhmm(at) }, to: { day: d, at: s.at }, why: `Google’s travel time gets you there at ${c.arrive}, so it starts then.`, evidence: { text: c.badges && c.badges.travel ? c.badges.travel.text : '', source: c.badges && c.badges.travel ? c.badges.travel.source : null, checked_at: c.badges && c.badges.travel ? c.badges.travel.checked_at : null, on: where(trip, d) } });
      sortDay(trip.days[d]);
      continue;
    }
    if (a.kind !== 'closed_that_day' && a.kind !== 'out_of_hours') continue;
    if (!hit || !Array.isArray(hit.hours)) continue;
    // the same day, at a time it's open (a meal within its own meal time)
    const meal = s.kind === 'meal' ? mealTime(at) : null;
    if (s.kind === 'meal' && !meal) continue;
    const spans = spansOn(hit, dayDate(trip, d));
    const t = spans.length ? slot(trip.days[d], s, spans, at, { within: meal }) : null;
    if (t !== null) {
      s.at = hhmm(t);
      changes.push({ stop: s.id, name: s.place.name, what: 'retimed', by: 'eden', from: { day: d, at: hhmm(at) }, to: { day: d, at: s.at }, why: `${a.text.replace(`${s.place.name}: `, '')} Now ${s.at}, when it’s open.`, evidence: evidence(d) });
      sortDay(trip.days[d]);
      continue;
    }
    if (!MOVABLE.has(s.kind)) continue;
    // another day of the trip where it's open, nearest first
    const others = trip.days.map((_, e) => e).filter((e) => e !== d).sort((x, y) => Math.abs(x - d) - Math.abs(y - d) || x - y);
    let moved = false;
    for (const e of others) {
      const sp = spansOn(hit, dayDate(trip, e));
      if (!sp.length) continue;
      const t2 = slot(trip.days[e], s, sp, at);
      if (t2 === null) continue;
      trip.days[d].stops = trip.days[d].stops.filter((x) => x.id !== s.id);
      s.at = hhmm(t2);
      trip.days[e].stops.push(s);
      sortDay(trip.days[e]);
      changes.push({ stop: s.id, name: s.place.name, what: 'moved', by: 'eden', from: { day: d, at: hhmm(at) }, to: { day: e, at: s.at }, why: `${a.text.replace(`${s.place.name}: `, '')} Moved to ${where(trip, e)} at ${s.at}, when it’s open.`, evidence: evidence(e) });
      moved = true;
      break;
    }
    if (moved) continue;
  }
  return changes;
}

// ── the repair round: the search model replaces or re-times only the failing stops ──

function repairText(trip, problems, hits) {
  const lines = trip.days.map((day, d) => `Day ${d + 1} (${where(trip, d)}) [day=${d}]:\n${day.stops.map((s) => `  [stop=${s.id}] ${s.at} ${s.minutes} min ${s.kind} ${s.place.name}`).join('\n') || '  (nothing)'}`);
  const probs = problems.map((p) => `- [stop=${p.stop}] ${p.name}, Day ${p.day + 1} (${where(trip, p.day)}) ${p.at}: ${p.text} Google Maps hours: ${weekText(hits.get(p.stop))}.`);
  return [
    `Trip “${trip.title}” in ${trip.destination}, as it stands:`, ...lines, '',
    'Google Maps found these problems:', ...probs, '',
    'For each problem stop only, give one edit: retime (same day, new at), move (day = the [day=N] number, at), replace (a different real, named place of the same kind that is open then: place, at, minutes, source_url) or remove (when nothing fits). Use web search for the replacement’s hours. Do not change any other stop: edits to other stops are ignored. Fields you don’t use are null; why is one short sentence.',
  ].join('\n');
}

function problemsOf(trip, checks) {
  const out = [];
  const seen = new Set();
  for (const a of checks.alerts) {
    if (seen.has(a.stop)) continue;
    const f = findStop(trip, a.stop);
    if (!f) continue;
    seen.add(a.stop);
    const c = checks.days[f.d] && checks.days[f.d].stops.find((x) => x.stop === a.stop);
    const badge = c && (a.kind === 'late' ? c.badges.travel : a.kind === 'access' ? c.badges.access : c.badges.hours);
    out.push({ stop: a.stop, name: f.s.place.name, kind: a.kind, stop_kind: f.s.kind, day: f.d, at: f.s.at, text: a.text.replace(`${f.s.place.name}: `, ''), source: badge ? badge.source : null, checked_at: badge ? badge.checked_at : null });
  }
  return out;
}

// ── the op ──

/**
 * trip-plan. deps: { maps, cache, now, fetch, env } (ops.js hands in the account's maps on the plan's own meter and the
 * checks' cache; `draft`: skip the search model's draft and verify this one). Nothing is stored except the cache's map
 * answers.
 */
export async function planTrip(body, { env = {}, maps, cache = noCache, now = () => Date.now(), fetch: f = globalThis.fetch, meter = null, draft: given = null } = {}) {
  const t0 = now();
  const started = Date.now();
  const left = () => PLAN.deadlineMs - (Date.now() - started);
  const args = cleanPlanArgs(body);
  const today = new Date(t0).toISOString().slice(0, 10);
  const system = plannerSystem(today);
  const key = String(env.OPENAI_API_KEY || '').trim();
  const search = Boolean(key) && !off(env, 'EDEN_OPENAI');
  const spend = { usd: 0, searches: 0, tokens: { input: 0, output: 0, reasoning: 0 }, calls: 0 };
  let model = PLAN.model;
  const count = (r) => { spend.usd += r.usd || 0; spend.searches += r.searches || 0; spend.calls++; for (const k of ['input', 'output', 'reasoning']) spend.tokens[k] += (r.usage && r.usage[k]) || 0; };
  const ask = async (o) => {
    try {
      const r = search ? await askSearchModel(key, { ...o, fetch: f }) : await askServiceModel(env, { ...o, fetch: f === globalThis.fetch ? undefined : f });
      if (r.model) model = r.model;
      count(r);
      return r;
    } catch (e) { if (e.usd) count(e); throw e; }
  };

  // 1. draft (`given`: a draft in TRIP_SCHEMA's shape from elsewhere, verified and fixed the same way: the eval, checks)
  const draft = given ? { json: given, citations: [] } : await ask({ system, user: userText(args), schema: TRIP_SCHEMA, name: 'trip', maxTokens: PLAN.draftTokens, maxSearches: PLAN.draftSearches, ms: Math.min(PLAN.draftMs, left()) });
  const newId = () => `s-${hex(4)}`;
  const { trip: raw, src } = draftTrip(draft.json, args, newId);
  const sources = new Map();
  for (const c of draft.citations) if (!sources.has(c.url)) sources.set(c.url, { url: c.url, title: c.title, stops: [] });
  const note = (id, url) => { if (!url) return; if (!sources.has(url)) sources.set(url, { url, title: '', stops: [] }); sources.get(url).stops.push(id); };
  for (const [id, url] of src) note(id, url);

  // 2. verify: each place on Google
  const changes = [];
  const unresolved = [];
  const hits = new Map(); // stop id → Google's place
  const dest = raw.destination ? (await maps.search(raw.destination).catch(() => []))[0] : null;
  const center = dest && Number.isFinite(dest.lat) ? { lat: dest.lat, lng: dest.lng } : null;
  const locate = async (trip) => {
    const found = await findPlaces(trip, maps, cache, center);
    for (const [id, r] of found) {
      const f = findStop(trip, id);
      if (!f) continue;
      if (r.hit) {
        hits.set(id, r.hit);
        if (r.hit.status === 'closed_permanently') {
          trip.days[f.d].stops.splice(f.i, 1);
          changes.push({ stop: id, name: r.hit.name, what: 'removed', by: 'eden', from: { day: f.d, at: f.s.at }, why: 'Google Maps lists it as closed for good.', evidence: { text: 'Business status: closed permanently.', source: r.hit.source, checked_at: r.hit.checked_at } });
        } else if (!sameName(r.asked, r.hit.name)) {
          changes.push({ stop: id, name: r.hit.name, asked: r.asked, what: 'matched', by: 'eden', to: { day: f.d, at: f.s.at }, why: `Google Maps found “${r.hit.name}” for “${r.asked}”: check it’s the place you mean.`, evidence: { text: r.hit.address || '', source: r.hit.source, checked_at: r.hit.checked_at } });
        }
      } else if (r.none) {
        trip.days[f.d].stops.splice(f.i, 1);
        changes.push({ stop: id, name: f.s.place.name, what: 'removed', by: 'eden', from: { day: f.d, at: f.s.at }, why: `Google Maps found no place by that name near ${trip.destination || 'the destination'}, so it isn’t in the plan.`, evidence: { text: `Searched: “${r.q}”.`, source: 'Google Maps (Places API)', checked_at: new Date(now()).toISOString() } });
      } else {
        unresolved.push({ stop: id, name: f.s.place.name, day: f.d, at: f.s.at, kind: 'not_checked', text: r.error, source: null, checked_at: null });
      }
    }
  };
  await locate(raw);
  const clean = () => { const t = cleanTrip(raw, { newId, now: t0 }); for (const d of t.days) for (const s of d.stops) delete s.owner; return t; };
  let trip = clean();
  const check = () => checkTrip(trip, maps, { cache, now });
  let checks = await check();

  // 3. Eden's own fixes, then (if still wrong) one repair round, then Eden's fixes on what the repair changed
  const fixAndCheck = async () => {
    const made = fixTrip(trip, checks, hits);
    if (made.length) { changes.push(...made); checks = await check(); }
  };
  await fixAndCheck();
  let repaired = false;
  const problems = problemsOf(trip, checks).filter((p) => !unresolved.some((u) => u.stop === p.stop));
  if (problems.length && left() >= PLAN.repairMinMs) {
    try {
      const r = await ask({ system, user: repairText(trip, problems, hits), schema: REPAIR_SCHEMA, name: 'repair', maxTokens: PLAN.repairTokens, maxSearches: PLAN.repairSearches, ms: left() - 8000 });
      repaired = true;
      for (const c of r.citations) if (!sources.has(c.url)) sources.set(c.url, { url: c.url, title: c.title, stops: [] });
      const failing = new Set(problems.map((p) => p.stop));
      const replaced = [];
      for (const e of Array.isArray(r.json.edits) ? r.json.edits : []) {
        if (!isObj(e) || !failing.has(e.stop)) continue; // only the stops that failed
        failing.delete(e.stop);
        const f = findStop(trip, e.stop);
        if (!f) continue;
        const was = { day: f.d, at: f.s.at };
        const p = problems.find((x) => x.stop === e.stop);
        const why = text(e.why, 300);
        const ev = { text: `${p.text} Google Maps hours: ${weekText(hits.get(e.stop))}.`, source: p.source, checked_at: p.checked_at };
        const day = Number.isInteger(e.day) && e.day >= 0 && e.day < trip.days.length ? e.day : f.d;
        const at = TIME.test(String(e.at)) ? String(e.at) : f.s.at;
        if (e.action === 'remove') {
          trip.days[f.d].stops.splice(f.i, 1);
          changes.push({ stop: e.stop, name: f.s.place.name, what: 'removed', by: 'search_model', from: was, why: why || 'Nothing fitting was open then.', evidence: ev });
          continue;
        }
        if (Number.isInteger(e.minutes) && e.minutes > 0 && e.minutes <= 1440) f.s.minutes = e.minutes;
        if (e.action === 'replace' && isObj(e.place) && text(e.place.name, 120)) {
          const old = f.s.place.name;
          f.s.place = { name: text(e.place.name, 120), address: text(e.place.address, 200) || null, city: text(e.place.city, 80) || null };
          if (e.kind && KINDS.includes(e.kind)) f.s.kind = e.kind;
          if (e.note != null) f.s.note = text(e.note, TRIP.note);
          hits.delete(e.stop);
          note(e.stop, httpsUrl(e.source_url));
          replaced.push(e.stop);
          changes.push({ stop: e.stop, name: f.s.place.name, what: 'replaced', by: 'search_model', was_name: old, from: was, to: { day, at }, why: why || `Replaces ${old}.`, evidence: ev });
        } else if (e.action !== 'retime' && e.action !== 'move' && e.action !== 'replace') continue;
        else changes.push({ stop: e.stop, name: f.s.place.name, what: day === f.d ? 'retimed' : 'moved', by: 'search_model', from: was, to: { day, at }, why: why || 'Re-timed to when it’s open.', evidence: ev });
        f.s.at = at;
        if (day !== f.d) { trip.days[f.d].stops.splice(f.i, 1); trip.days[day].stops.push(f.s); }
        sortDay(trip.days[day]);
      }
      if (replaced.length) {
        // the new places looked up on Google like the rest (a replacement Google can't find is removed)
        await locate(trip);
        trip = cleanTrip(trip, { newId, now: t0 });
        for (const d of trip.days) for (const s of d.stops) delete s.owner;
        for (const c of changes) if (c.what === 'replaced') { const f = findStop(trip, c.stop); if (f) c.name = f.s.place.name; } // Google's name
      }
      checks = await check();
      await fixAndCheck();
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
      // the repair failing leaves the draft as Eden fixed it: what's wrong is listed below
    }
  }

  // anything still wrong: listed with Google's reason, never kept silently
  for (const p of problemsOf(trip, checks)) if (!unresolved.some((u) => u.stop === p.stop)) unresolved.push({ stop: p.stop, name: p.name, day: p.day, at: p.at, kind: p.kind, text: p.text, source: p.source, checked_at: p.checked_at, hours: hits.has(p.stop) ? weekText(hits.get(p.stop)) : null });
  const live = new Set(trip.days.flatMap((d) => d.stops.map((s) => s.id)));
  const out = { ...trip };
  delete out.rev; delete out.created; delete out.updated;
  const google = meter ? round(meter.usd) : null;
  return {
    trip: out,
    checks,
    changes,
    unresolved: unresolved.filter((u) => live.has(u.stop)),
    sources: [...sources.values()].map((s) => ({ ...s, stops: s.stops.filter((id) => live.has(id)) })).slice(0, 60),
    notes: text(draft.json.notes, 1200),
    model,
    searched: search,
    repaired,
    costs: { model_usd: round(spend.usd), web_searches: spend.searches, tokens: spend.tokens, model_calls: spend.calls, google_usd: google, google_calls: meter ? meter.calls : null, total_usd: round(spend.usd + (google || 0)) },
    took_ms: Date.now() - started,
    ...(search ? {} : { note: `No OpenAI key here: drafted by ${model} without web search, then checked on Google Maps the same way.` }),
  };
}
