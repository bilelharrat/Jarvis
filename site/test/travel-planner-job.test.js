// A new trip's plan as a job (travel/planjob.js, planner.js progress): start answers at once, the steps are kept as they
// happen, status gives the new ones and the result, Cancel stops it, a restart of the object starts it again once.
// A fake Gemini (sketch and draft) and a fake Google only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tripOp } from '../src/travel/ops.js';
import { JOB, forgetJobs, jobWork, slimResult } from '../src/travel/planjob.js';
import { PLAN, destinationPoint, isEvent, placeNote, planTrip, trustLegs } from '../src/travel/planner.js';
import { MapsError } from '../src/travel/maps.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const all = (open, close) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open, close }));
const except = (closedDay, open, close) => all(open, close).filter((h) => h.day !== closedDay);
const FLORENCE = { lat: 43.7696, lng: 11.2558 };
const PLACES = {
  florence: { id: 'ChIJgp-florence-0001', name: 'Florence', hours: null, status: 'open' },
  'hotel calimala': { id: 'ChIJgp-calimala-0001', name: 'Hotel Calimala', hours: all('00:00', '23:59'), status: 'open' },
  'uffizi gallery': { id: 'ChIJgp-uffizi-00001', name: 'Uffizi Gallery', hours: except(1, '08:15', '18:30'), status: 'open' }, // closed Mondays
  'trattoria mario': { id: 'ChIJgp-mario-000001', name: 'Trattoria Mario', hours: except(0, '12:00', '15:30'), status: 'open' },
  'old caffe': { id: 'ChIJgp-oldcaffe-001', name: 'Old Caffe', hours: all('08:00', '22:00'), status: 'closed_permanently' },
  'palazzo pitti': { id: 'ChIJgp-pitti-000001', name: 'Palazzo Pitti', hours: except(1, '08:15', '18:30'), status: 'open' },
};
function fakeMaps() {
  const view = (p) => ({ ...p, address: `${p.name}, Florence`, lat: FLORENCE.lat + 0.001, lng: FLORENCE.lng + 0.001, price: null, standin: false, source: 'Google Maps (Places API)', checked_at: new Date(T0).toISOString() });
  return {
    mode: 'google',
    async search(q) { const n = String(q).split(',')[0].toLowerCase().trim(); return PLACES[n] ? [view(PLACES[n])] : []; },
    async place(id) { return view(Object.values(PLACES).find((x) => x.id === id)); },
    async travel(a, b, mode) { return { minutes: 10, meters: 800, mode, standin: false, source: 'Google Maps (Routes API)', checked_at: new Date(T0).toISOString() }; },
  };
}
const stop = (kind, name, at, minutes, extra = {}) => ({ kind, place: { name, address: null, city: 'Florence' }, at, minutes, mode: 'walk', nights: null, note: '', cost: null, source_url: `https://example.org/${encodeURIComponent(name)}`, ...extra });
const DRAFT = {
  title: 'Two days in Florence', destination: 'Florence, Italy', start: '2026-11-02', travelers: 2, notes: 'From official sites.',
  days: [
    { title: 'Monday', stops: [stop('stay', 'Hotel Calimala', '09:00', 30, { nights: 1 }), stop('visit', 'Uffizi Gallery', '10:00', 120), stop('meal', 'Trattoria Mario', '13:00', 60), stop('meal', 'Old Caffe', '20:00', 60)] },
    { title: 'Tuesday', stops: [stop('visit', 'Palazzo Pitti', '09:00', 60)] },
  ],
};
const SKETCH = { title: 'Florence', start: '2026-11-02', days: [{ title: 'Day 1', stops: [{ at: '09:00', name: 'Duomo', kind: 'visit', minutes: 60 }] }, { title: 'Day 2', stops: [{ at: '10:00', name: 'Uffizi Gallery', kind: 'visit', minutes: 120 }] }] };
const gem = (json, { queries = 0 } = {}) => new Response(JSON.stringify({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(json) }] }, groundingMetadata: { webSearchQueries: Array.from({ length: queries }, (_, i) => `q${i}`), groundingChunks: [{ web: { uri: 'https://www.uffizi.it/en', title: 'Uffizi' } }] } }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 100 },
}), { status: 200, headers: { 'content-type': 'application/json' } });
const wait = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });

/** Gemini, faked: the sketch (Flash, no search) at once; the draft (Argon, with search) after `draftMs`, or `draft` = a function. */
function fakeGemini({ draftMs = 30, draft = null } = {}) {
  const seen = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const model = /models\/([^:]+):/.exec(url)[1];
    seen.push({ model, body, signal: init.signal });
    if (!body.tools) { assert.equal(model, 'gemini-3.8-flash'); assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low'); return gem(SKETCH); }
    if (draft) return draft(init);
    await wait(draftMs, init.signal);
    return gem(DRAFT, { queries: 4 });
  };
  return { fetch, seen };
}
function account(env = {}) {
  const m = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : structuredClone(m.get(k))),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
  };
  m.set('account', { id: '11111111-1111-4111-8111-111111111111' });
  return { m, storage, env: { GEMINI_API_KEY: 'g-test', ...env }, now: () => T0 };
}
const ASK = { request: 'Two days in Florence from Monday 2 November 2026, the Uffizi and good food', constraints: { start: '2026-11-02', days: 2, travelers: 2 } };

test('a plan as a job: start answers at once; sketch, draft, each place, each change, then the result', async () => {
  const acct = account();
  const g = fakeGemini();
  const deps = { fetch: g.fetch, maps: fakeMaps() };
  const s = await tripOp(acct, 'trip-plan-start', ASK, deps);
  assert.match(s.job, /^[0-9a-f]{16}$/);
  assert.equal(s.state, 'running');
  assert.equal(s.poll_ms, JOB.pollMs);
  assert.equal(acct.m.get('tplan:count').n, 1); // counted once, at the start
  const early = await tripOp(acct, 'trip-plan-status', { job: s.job, after: 0 }, deps);
  assert.equal(early.state, 'running');
  assert.ok(!early.result);

  await jobWork(acct, s.job);
  const r = await tripOp(acct, 'trip-plan-status', { job: s.job, after: 0 }, deps);
  assert.equal(r.state, 'done');
  const types = r.events.map((e) => e.type);
  assert.deepEqual(r.events.map((e) => e.n), r.events.map((_, i) => i + 1)); // numbered in order
  assert.equal(r.next, r.events.length);
  // the drafting step says which model and search
  assert.equal(r.events[0].type, 'stage');
  assert.equal(r.events[0].text, 'Drafting with Gemini 4 Argon + Google Search');
  // the sketch came first (the draft takes longer), then the draft replaced it
  assert.ok(types.indexOf('sketch') > 0 && types.indexOf('sketch') < types.indexOf('draft'));
  const sk = r.events.find((e) => e.type === 'sketch');
  assert.equal(sk.label, 'Gemini 3.8 Flash');
  assert.equal(sk.days[1].date, '2026-11-03');
  const dr = r.events.find((e) => e.type === 'draft');
  assert.equal(dr.label, 'Gemini 4 Argon');
  assert.deepEqual(dr.days.map((d) => d.stops.map((x) => x.name)), [['Hotel Calimala', 'Uffizi Gallery', 'Trattoria Mario', 'Old Caffe'], ['Palazzo Pitti']]);
  // each place as Google answered it, against the drafted day and time
  const place = (name) => r.events.find((e) => e.type === 'place' && e.name === name);
  assert.deepEqual([place('Uffizi Gallery').ok, place('Uffizi Gallery').text], [false, 'closed Mon on Google Maps']);
  assert.deepEqual([place('Trattoria Mario').ok, place('Trattoria Mario').text], [true, 'open Mon 12:00–15:30']);
  assert.equal(place('Trattoria Mario').source, 'Google Maps (Places API)');
  assert.equal(place('Trattoria Mario').checked_at, new Date(T0).toISOString());
  assert.deepEqual([place('Old Caffe').ok, place('Old Caffe').text], [false, 'closed for good on Google Maps']);
  // then what Eden changed: Old Caffe out, the Uffizi moved to Tuesday
  const change = (name) => r.events.find((e) => e.type === 'change' && e.name === name);
  assert.equal(change('Old Caffe').what, 'removed');
  assert.equal(change('Uffizi Gallery').what, 'moved');
  assert.equal(change('Uffizi Gallery').to.day, 1);
  assert.ok(types.indexOf('change') > types.lastIndexOf('place') || change('Old Caffe').n > place('Old Caffe').n);
  assert.deepEqual(r.events.at(-1), { n: r.events.length, type: 'stage', stage: 'done', text: 'Done', t: r.result.took_ms });
  // the result: trip-plan's, without the checks
  assert.equal(r.result.checks, undefined);
  assert.equal(typeof r.result.alerts, 'number');
  assert.equal(r.result.model, 'gemini-4-argon');
  assert.ok(r.result.trip.days[1].stops.some((x) => x.place.name === 'Uffizi Gallery'));
  assert.ok(r.result.costs.sketch_usd > 0 && r.result.costs.sketch_usd < r.result.costs.model_usd);
  assert.equal(r.result.costs.model_calls, 2); // the sketch and the draft
  // only new events after `after`; kept in storage for a day
  const again = await tripOp(acct, 'trip-plan-status', { job: s.job, after: r.next }, deps);
  assert.deepEqual(again.events, []);
  assert.equal(acct.m.get(`tpjob:${s.job}`).state, 'done');
});

test('a sketch that comes after the draft is not shown; the sync trip-plan has no sketch', async () => {
  const acct = account();
  const seen = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.tools ? 'draft' : 'sketch');
    if (!body.tools) { await wait(80, init.signal); return gem(SKETCH); }
    return gem(DRAFT, { queries: 2 });
  };
  const s = await tripOp(acct, 'trip-plan-start', ASK, { fetch, maps: fakeMaps() });
  await jobWork(acct, s.job);
  const r = await tripOp(acct, 'trip-plan-status', { job: s.job }, { fetch, maps: fakeMaps() });
  assert.equal(r.state, 'done');
  assert.ok(!r.events.some((e) => e.type === 'sketch'));
  const sync = await tripOp(account(), 'trip-plan', ASK, { fetch: fakeGemini().fetch, maps: fakeMaps() });
  assert.ok(sync.checks && Array.isArray(sync.checks.alerts)); // unchanged: the eval's and Ask Eden's path
  assert.equal(sync.costs.sketch_usd, undefined);
});

test('Cancel stops the draft call and keeps nothing', async () => {
  const acct = account();
  const g = fakeGemini({ draftMs: 10_000 });
  const deps = { fetch: g.fetch, maps: fakeMaps() };
  const s = await tripOp(acct, 'trip-plan-start', ASK, deps);
  await wait(20);
  const c = await tripOp(acct, 'trip-plan-cancel', { job: s.job }, deps);
  assert.equal(c.state, 'cancelled');
  await jobWork(acct, s.job);
  const draftCall = g.seen.find((x) => x.body.tools);
  assert.ok(draftCall.signal.aborted);
  const r = await tripOp(acct, 'trip-plan-status', { job: s.job, after: 0 }, deps);
  assert.equal(r.state, 'cancelled');
  assert.equal(r.result, undefined);
  assert.equal(r.events.at(-1).text, 'Stopped. Nothing was saved.');
  assert.ok(!r.events.some((e) => e.type === 'draft'));
  assert.equal((await tripOp(acct, 'trip-plan-cancel', { job: s.job }, deps)).state, 'cancelled'); // twice: the same
});

test('a failed draft ends the job with the planner’s own words', async () => {
  const acct = account();
  const fetch = async (url, init) => (JSON.parse(init.body).tools ? new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 }) : gem(SKETCH));
  const s = await tripOp(acct, 'trip-plan-start', ASK, { fetch, maps: fakeMaps() });
  await jobWork(acct, s.job);
  const r = await tripOp(acct, 'trip-plan-status', { job: s.job }, { fetch, maps: fakeMaps() });
  assert.equal(r.state, 'failed');
  assert.match(r.error, /The planner answered 429: quota/);
  // Argon, then Flash: the second drafting step says why
  const drafting = r.events.filter((e) => e.stage === 'drafting').map((e) => e.text);
  assert.deepEqual(drafting, ['Drafting with Gemini 4 Argon + Google Search', 'Gemini 4 Argon didn’t answer (unavailable). Drafting with Gemini 3.8 Flash + Google Search']);
});

test('the object restarted mid-plan: the next status plans again once, then says it was cut off', async () => {
  const acct = account();
  let hang = true;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!body.tools) return gem(SKETCH);
    if (hang) { await wait(60, init.signal).catch(() => {}); throw new Error('gone'); } // the old run, cut off
    return gem(DRAFT, { queries: 1 });
  };
  const deps = { fetch, maps: fakeMaps() };
  const s = await tripOp(acct, 'trip-plan-start', ASK, deps);
  await wait(10);
  const old = jobWork(acct, s.job);
  forgetJobs(acct); // as a restart of the Durable Object would
  hang = false;
  const r1 = await tripOp(acct, 'trip-plan-status', { job: s.job, after: 0 }, deps);
  assert.equal(r1.state, 'running');
  assert.ok(r1.events.some((e) => e.stage === 'restarted'));
  await old; // the cut-off run ends: it never writes over the new one
  await jobWork(acct, s.job);
  const r2 = await tripOp(acct, 'trip-plan-status', { job: s.job, after: 0 }, deps);
  assert.equal(r2.state, 'done');
  assert.equal(acct.m.get('tplan:count').n, 1); // not counted twice
  // cut off again: not a third run
  const s2 = await tripOp(acct, 'trip-plan-start', ASK, { fetch: async (u, i) => { await wait(10_000, i.signal); }, maps: fakeMaps() });
  forgetJobs(acct);
  const j = acct.m.get(`tpjob:${s2.job}`);
  acct.m.set(`tpjob:${s2.job}`, { ...j, restarts: 1 });
  const r3 = await tripOp(acct, 'trip-plan-status', { job: s2.job }, deps);
  assert.equal(r3.state, 'failed');
  assert.equal(r3.code, 'interrupted');
});

test('bad ids, unknown jobs, two at once, the daily cap', async () => {
  const acct = account({ TRAVEL_PLANS_A_DAY: '3' });
  const slow = { fetch: async (u, i) => { await wait(10_000, i.signal); }, maps: fakeMaps() };
  await assert.rejects(tripOp(acct, 'trip-plan-status', { job: 'nope' }, slow), /job must be/);
  await assert.rejects(tripOp(acct, 'trip-plan-status', { job: '0123456789abcdef' }, slow), (e) => e.status === 404 || e.code === 'not_found');
  await assert.rejects(tripOp(acct, 'trip-plan-start', { request: 'x' }, slow), /request/); // checked before it's counted
  const a = await tripOp(acct, 'trip-plan-start', ASK, slow);
  const b = await tripOp(acct, 'trip-plan-start', ASK, slow);
  await assert.rejects(tripOp(acct, 'trip-plan-start', ASK, slow), (e) => e.code === 'busy');
  for (const j of [a, b]) { await tripOp(acct, 'trip-plan-cancel', { job: j.job }, slow); await jobWork(acct, j.job); }
  assert.equal(acct.m.get('tplan:count').n, 2); // the busy one wasn't counted
  const c = await tripOp(acct, 'trip-plan-start', ASK, slow);
  await tripOp(acct, 'trip-plan-cancel', { job: c.job }, slow);
  await jobWork(acct, c.job);
  await assert.rejects(tripOp(acct, 'trip-plan-start', ASK, slow), (e) => e.code === 'rate_limited');
});

test('placeNote: open, closed that day, out of hours, no hours, not found', () => {
  const trip = { start: '2026-11-02', destination: 'Florence' }; // Monday
  const hit = (hours, status = 'open', name = 'Uffizi Gallery') => ({ hit: { name, hours, status }, asked: 'Uffizi Gallery' });
  assert.deepEqual(placeNote(trip, 1, { at: '10:00', minutes: 60 }, hit(except(1, '08:15', '18:30'))), { ok: true, text: 'open Tue 08:15–18:30' });
  assert.deepEqual(placeNote(trip, 0, { at: '10:00', minutes: 60 }, hit(except(1, '08:15', '18:30'))), { ok: false, text: 'closed Mon on Google Maps' });
  assert.deepEqual(placeNote(trip, 1, { at: '18:00', minutes: 60 }, hit(except(1, '08:15', '18:30'))), { ok: false, text: 'open Tue 08:15–18:30, not 18:00–19:00' });
  assert.deepEqual(placeNote(trip, 1, { at: '10:00', minutes: 60 }, hit(null)), { ok: null, text: 'found on Google Maps, no hours listed' });
  assert.deepEqual(placeNote(trip, 0, { at: '10:00', minutes: 60 }, { none: true }), { ok: false, text: 'not found on Google Maps near Florence' });
  assert.match(placeNote(trip, 1, { at: '10:00', minutes: 60 }, hit(all('09:00', '17:00'), 'open', 'Galleria Borghese')).text, /found “Galleria Borghese” for “Uffizi Gallery”/);
});

test('slimResult drops the checks and keeps how many alerts they left', () => {
  const out = slimResult({ trip: { days: [] }, checks: { alerts: [1, 2], days: [] }, changes: [], sources: [] });
  assert.equal(out.checks, undefined);
  assert.equal(out.alerts, 2);
});

test('map checks used up mid-plan: legs say not checked, never late, and Eden moves nothing on them', async () => {
  // Google answers the places, then the cap holds every travel time back (checks.js puts a straight-line estimate there)
  const capped = { ...fakeMaps(), async travel() { throw Object.assign(new MapsError('capped', 'Today’s map checks for your account are used up.'), { reason: 'account' }); } };
  const r = await tripOp(account(), 'trip-plan', ASK, { fetch: fakeGemini().fetch, maps: capped });
  const legs = r.checks.days.flatMap((d) => d.stops.map((x) => x.badges.travel).filter(Boolean));
  assert.ok(legs.length > 0);
  for (const t of legs) { assert.equal(t.status, 'unknown'); assert.match(t.text, /Not checked: today’s map checks for your account are used up/); assert.equal(t.source, null); }
  assert.ok(!r.checks.alerts.some((a) => a.kind === 'late'));
  assert.ok(!r.changes.some((c) => c.what === 'retimed' && /travel time/.test(c.why)));
  assert.match(r.note, /used up/);
  // an absurd Google answer (77,955 min between two stops of one day): not checked either, nothing re-timed by it
  const absurd = { ...fakeMaps(), async travel(a, b, mode) { return { minutes: 77_955, meters: 9e6, mode, standin: false, source: 'Google Maps (Routes API)', checked_at: new Date(T0).toISOString() }; } };
  const r2 = await tripOp(account(), 'trip-plan', ASK, { fetch: fakeGemini().fetch, maps: absurd });
  assert.ok(!r2.checks.alerts.some((a) => a.kind === 'late'));
  assert.ok(!r2.changes.some((c) => c.what === 'retimed' && /travel time/.test(c.why)));
  assert.ok(r2.checks.days.flatMap((d) => d.stops).some((x) => x.badges.travel && /can’t be right/.test(x.badges.travel.text)));
});

test('trustLegs keeps a real Google leg, even a held one from the cache', () => {
  const ck = { alerts: [{ kind: 'late', stop: 'a' }, { kind: 'late', stop: 'b' }], days: [{ stops: [
    { stop: 'a', alerts: ['late'], badges: { travel: { status: 'warn', minutes: 40, source: 'Google Maps (Routes API)', held: 'account' } } }, // the last real answer
    { stop: 'b', alerts: ['late'], badges: { travel: { status: 'sample', minutes: 900, source: 'A straight-line estimate: not checked', held: 'account' } } },
  ] }] };
  trustLegs(ck);
  assert.deepEqual(ck.alerts, [{ kind: 'late', stop: 'a' }]);
  assert.equal(ck.days[0].stops[0].badges.travel.minutes, 40);
  assert.equal(ck.days[0].stops[1].badges.travel.status, 'unknown');
});

// Barcelona, as the accuracy run met it: the destination's search answered a restaurant called Barcelona in Palo Alto
const BCN = { lat: 41.3874, lng: 2.1686 };
function barcelonaMaps({ found = null } = {}) {
  const at = (dLat, dLng) => ({ lat: BCN.lat + dLat, lng: BCN.lng + dLng });
  const P = {
    barcelona: { id: 'ChIJgp-bcn-paloalto', name: 'Barcelona', hours: all('17:00', '22:00'), status: 'open', lat: 37.4419, lng: -122.143 }, // a restaurant, Palo Alto
    'sagrada familia': { id: 'ChIJgp-sagrada-0001', name: 'Basílica de la Sagrada Família', hours: all('09:00', '18:00'), status: 'open', ...at(0.016, 0.006) },
    'park guell': { id: 'ChIJgp-guell-000001', name: 'Park Güell', hours: all('09:30', '19:30'), status: 'open', ...at(0.027, -0.016) },
    'casa batllo': { id: 'ChIJgp-batllo-00001', name: 'Casa Batlló', hours: all('09:00', '20:00'), status: 'open', ...at(0.004, -0.004) },
    'la boqueria': { id: 'ChIJgp-boqueria-001', name: 'Mercat de la Boqueria', hours: except(0, '08:00', '20:30'), status: 'open', ...at(-0.005, -0.0) },
    'cal pep': { id: 'ChIJgp-calpep-00001', name: 'Cal Pep', hours: except(0, '13:00', '23:00'), status: 'open', ...at(-0.003, 0.012) },
  };
  const view = (p) => ({ ...p, address: `${p.name}`, price: null, standin: false, source: 'Google Maps (Places API)', checked_at: new Date(T0).toISOString() });
  return {
    mode: 'google',
    async search(q) { const n = String(q).split(',')[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); if (found && n !== 'barcelona' && !found.includes(n)) return []; return P[n] ? [view(P[n])] : []; },
    async place(id) { return view(Object.values(P).find((x) => x.id === id)); },
    async travel(a, b, mode) { return { minutes: 15, meters: 1200, mode, standin: false, source: 'Google Maps (Routes API)', checked_at: new Date(T0).toISOString() }; },
  };
}
const bstop = (kind, name, at, minutes) => ({ kind, place: { name, address: null, city: 'Barcelona' }, at, minutes, mode: 'walk', nights: null, note: '', cost: null, source_url: null });
const BCN_DRAFT = { title: 'Barcelona', destination: 'Barcelona', start: '2026-11-03', travelers: 2, notes: '', days: [
  { title: 'Gaudí', stops: [bstop('visit', 'Sagrada Familia', '10:00', 90), bstop('visit', 'Casa Batllo', '12:30', 60), bstop('meal', 'Cal Pep', '14:00', 60), bstop('visit', 'Park Guell', '16:30', 90)] },
  { title: 'Old town', stops: [bstop('visit', 'La Boqueria', '10:00', 60), bstop('meal', 'Cal Pep', '13:30', 60), bstop('visit', 'Sagrada Familia', '16:00', 60)] },
] };
const BCN_ASK = { request: 'Two days in Barcelona', constraints: { destination: 'Barcelona', start: '2026-11-03', days: 2, travelers: 2 } };

test('Barcelona located as a Palo Alto restaurant: the stops’ own hits set where the trip is, none removed', async () => {
  assert.equal(destinationPoint('Barcelona', [{ name: 'Barcelona', hours: all('17:00', '22:00'), lat: 37.44, lng: -122.14 }]), null, 'a business is not a city');
  assert.deepEqual(destinationPoint('Florence, Italy', [{ name: 'Florence', hours: null, lat: 43.77, lng: 11.25 }]), { lat: 43.77, lng: 11.25 });
  const r = await planTrip(BCN_ASK, { maps: barcelonaMaps(), draft: BCN_DRAFT, now: () => T0 });
  const names = r.trip.days.map((d) => d.stops.map((x) => x.place.name));
  assert.deepEqual(names, [['Basílica de la Sagrada Família', 'Casa Batlló', 'Cal Pep', 'Park Güell'], ['Mercat de la Boqueria', 'Cal Pep', 'Basílica de la Sagrada Família']]);
  assert.ok(!r.changes.some((c) => c.what === 'removed'));
  assert.ok(r.trip.days.every((d) => d.stops.every((x) => x.place.id)));
});

test('most places not found: kept unchecked and said, never an empty plan', async () => {
  const r = await planTrip(BCN_ASK, { maps: barcelonaMaps({ found: ['cal pep'] }), draft: BCN_DRAFT, now: () => T0 });
  assert.equal(r.trip.days.reduce((n, d) => n + d.stops.length, 0), 7);
  assert.ok(!r.changes.some((c) => c.what === 'removed'));
  const nf = r.unresolved.filter((u) => u.kind === 'not_found');
  assert.equal(nf.length, 5);
  assert.match(nf[0].text, /Most of this plan’s places weren’t found, so Eden kept them, unchecked/);
  assert.match(r.note, /didn’t find 5 of this plan’s places near Barcelona/);
  // one place not found among many found: removed, as before
  const one = await planTrip(BCN_ASK, { maps: barcelonaMaps({ found: ['sagrada familia', 'casa batllo', 'cal pep', 'la boqueria'] }), draft: BCN_DRAFT, now: () => T0 });
  assert.deepEqual(one.changes.filter((c) => c.what === 'removed').map((c) => c.name), ['Park Guell']);
});

test('a show isn’t re-timed to its theatre’s box-office hours (Cirque du Soleil “O” at 21:00)', async () => {
  const LV = { lat: 36.1126, lng: -115.1767 };
  const P = {
    'las vegas': { id: 'ChIJgp-lv', name: 'Las Vegas', hours: null, status: 'open', ...LV },
    'o by cirque du soleil': { id: 'ChIJgp-o-theatre', name: 'O Theatre', hours: all('10:00', '18:00'), status: 'open', lat: LV.lat + 0.002, lng: LV.lng },
    'bellagio conservatory': { id: 'ChIJgp-conserv', name: 'Bellagio Conservatory & Botanical Garden', hours: all('00:00', '23:59'), status: 'open', lat: LV.lat + 0.001, lng: LV.lng },
  };
  const view = (p) => ({ ...p, address: p.name, price: null, standin: false, source: 'Google Maps (Places API)', checked_at: new Date(T0).toISOString() });
  const maps = { mode: 'google', async search(q) { const n = String(q).split(',')[0].toLowerCase().replace(/[“”"]/g, '').trim(); return P[n] ? [view(P[n])] : []; }, async place(id) { return view(Object.values(P).find((x) => x.id === id)); }, async travel(a, b, mode) { return { minutes: 10, meters: 500, mode, standin: false, source: 'Google Maps (Routes API)', checked_at: new Date(T0).toISOString() }; } };
  const draft = { title: 'Vegas', destination: 'Las Vegas', start: '2026-11-03', travelers: 2, notes: '', days: [{ title: 'Strip', stops: [
    { kind: 'visit', place: { name: 'Bellagio Conservatory', address: null, city: 'Las Vegas' }, at: '17:00', minutes: 60, mode: 'walk', nights: null, note: '', cost: null, source_url: null },
    { kind: 'activity', place: { name: 'O by Cirque du Soleil', address: null, city: 'Las Vegas' }, at: '21:00', minutes: 90, mode: 'walk', nights: null, note: 'The 21:00 show.', cost: null, source_url: 'https://www.cirquedusoleil.com/o' },
  ] }] };
  const events = [];
  const r = await planTrip({ request: 'An evening in Las Vegas', constraints: { destination: 'Las Vegas', start: '2026-11-03', days: 1 } }, { maps, draft, now: () => T0, progress: (e) => events.push(e) });
  const o = r.trip.days[0].stops.find((x) => x.place.name === 'O Theatre');
  assert.equal(o.at, '21:00');
  assert.ok(!r.changes.some((c) => c.what === 'retimed' || c.what === 'moved' || c.what === 'removed'));
  assert.ok(!r.unresolved.length);
  assert.ok(!r.checks.alerts.some((a) => a.kind === 'out_of_hours'));
  const badge = r.checks.days[0].stops.find((x) => x.stop === o.id).badges.hours;
  assert.equal(badge.text, 'Event time from the draft’s source; Google’s hours (10:00–18:00) are the venue’s, not the event’s.');
  assert.equal(events.find((e) => e.type === 'place' && e.name === 'O Theatre').ok, null);
  // a visit to a theatre is an event; a museum named for an opera isn't
  assert.ok(isEvent({ kind: 'visit', place: { name: 'Teatro alla Scala' } }));
  assert.ok(!isEvent({ kind: 'visit', place: { name: 'Museo dell’Opera del Duomo' } }));
  assert.ok(!isEvent({ kind: 'meal', place: { name: 'Theatre Café' } }));
});

test('a draft that didn’t search Google goes to the next model, told to search; a timeout falls back instead of failing', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); const model = /models\/([^:]+):/.exec(url)[1];
    calls.push({ model, user: body.contents[0].parts[0].text });
    if (!body.tools) return gem(SKETCH);
    return gem(DRAFT, { queries: model === 'gemini-4-argon' ? 0 : 3 });
  };
  const r = await tripOp(account(), 'trip-plan', ASK, { fetch, maps: fakeMaps() });
  assert.equal(r.model, 'gemini-3.8-flash');
  assert.ok(r.searched);
  assert.deepEqual(r.tried, ['gemini-4-argon: no_search', 'gemini-3.8-flash']);
  assert.match(calls[1].user, /Search Google for every place’s opening days and hours/);
  // nobody searched: Argon's draft is kept, and the plan says so
  const none = await tripOp(account(), 'trip-plan', ASK, { fetch: async (url, init) => gem(DRAFT, { queries: 0 }), maps: fakeMaps() });
  assert.equal(none.model, 'gemini-4-argon');
  assert.equal(none.searched, false);
  assert.match(none.note, /No model searched the web for this draft/);
  // Argon times out: Flash drafts in what's left
  const keep = { ...PLAN };
  Object.assign(PLAN, { draftMs: 60, fallbackMinMs: 10, reserveMs: 0 });
  try {
    const slow = async (url, init) => { const m = /models\/([^:]+):/.exec(url)[1]; if (m === 'gemini-4-argon') { await wait(5000, init.signal); } return gem(DRAFT, { queries: 2 }); };
    const t = await tripOp(account(), 'trip-plan', ASK, { fetch: slow, maps: fakeMaps() });
    assert.equal(t.model, 'gemini-3.8-flash');
    assert.equal(t.tried[0], 'gemini-4-argon: unavailable');
  } finally { Object.assign(PLAN, keep); }
});

test('a Places 503 is asked once more before the place is left unchecked', async () => {
  const maps = fakeMaps();
  const search = maps.search;
  let failed = 0;
  maps.search = async (q, c) => { if (/^Uffizi/.test(q) && failed++ === 0) throw new MapsError('unavailable', 'Google Maps answered 503.'); return search(q, c); };
  const keep = PLAN.retryMs; PLAN.retryMs = 5;
  try {
    const r = await tripOp(account(), 'trip-plan', ASK, { fetch: fakeGemini().fetch, maps });
    assert.equal(failed, 2);
    assert.ok(r.trip.days.some((d) => d.stops.some((x) => x.place.name === 'Uffizi Gallery')));
    assert.ok(!r.unresolved.some((u) => u.kind === 'not_checked'));
  } finally { PLAN.retryMs = keep; }
});

test('a replaced stop takes the repair’s note, or none: never the old place’s', async () => {
  // Trattoria Mario closed on Sunday 1 Nov: Eden can't move a meal, the repair swaps it without a note
  const draft = { ...DRAFT, start: '2026-11-01', days: [{ title: 'Sunday', stops: [{ ...stop('meal', 'Trattoria Mario', '13:00', 60), note: 'Book the bistecca at Mario’s.' }] }] };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!body.tools) return gem(SKETCH);
    const user = body.contents[0].parts[0].text;
    if (!/Google Maps found these problems/.test(user)) return gem(draft, { queries: 2 });
    const id = /\[stop=(s-[0-9a-f]{8})\] Trattoria Mario/.exec(user)[1];
    return gem({ edits: [{ stop: id, action: 'replace', day: null, at: '13:00', minutes: 60, place: { name: 'Hotel Calimala', address: null, city: 'Florence' }, kind: 'meal', note: null, source_url: null, why: 'Mario is closed on Sundays.' }] }, { queries: 1 });
  };
  const r = await tripOp(account(), 'trip-plan', { ...ASK, constraints: { start: '2026-11-01', days: 1, travelers: 2 } }, { fetch, maps: fakeMaps() });
  const swapped = r.trip.days[0].stops.find((x) => x.place.name === 'Hotel Calimala');
  assert.ok(swapped, 'replaced');
  assert.equal(swapped.note, '');
});
