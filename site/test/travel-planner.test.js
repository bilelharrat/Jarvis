// Eden Travel's planner (travel/planner.js): the search model's draft, Google's checks and Eden's fixes. A fake OpenAI
// (Responses API) and a fake Google only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tripOp } from '../src/travel/ops.js';
import { PLAN, TRIP_SCHEMA, fixTrip, planTrip, sameName, slot, spansOn, weekText } from '../src/travel/planner.js';
import { checkTrip } from '../src/travel/checks.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const all = (open, close) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open, close }));
const except = (closedDay, open, close) => all(open, close).filter((h) => h.day !== closedDay);

// Google, faked: places by name, all near Florence's centre; every leg 10 minutes
const FLORENCE = { lat: 43.7696, lng: 11.2558 };
const PLACES = {
  florence: { id: 'gp-florence-0001', name: 'Florence', hours: null, status: 'open' },
  'hotel calimala': { id: 'gp-calimala-0001', name: 'Hotel Calimala', hours: all('00:00', '23:59'), status: 'open' },
  'uffizi gallery': { id: 'gp-uffizi-00001', name: 'Uffizi Gallery', hours: except(1, '08:15', '18:30'), status: 'open' }, // closed Mondays
  'trattoria mario': { id: 'gp-mario-000001', name: 'Trattoria Mario', hours: except(0, '12:00', '15:30'), status: 'open' },
  'duomo di firenze': { id: 'gp-duomo-000001', name: 'Cattedrale di Santa Maria del Fiore (Duomo di Firenze)', hours: all('10:15', '16:30'), status: 'open' },
  'old caffe': { id: 'gp-oldcaffe-001', name: 'Old Caffe', hours: all('08:00', '22:00'), status: 'closed_permanently' },
  'galleria dell accademia': { id: 'gp-accademia-01', name: 'Galleria dell’Accademia', hours: except(1, '08:15', '18:50'), status: 'open' },
  'palazzo pitti': { id: 'gp-pitti-000001', name: 'Palazzo Pitti', hours: except(1, '08:15', '18:30'), status: 'open' },
  'osteria chiusa': { id: 'gp-chiusa-00001', name: 'Osteria Chiusa', hours: except(2, '12:00', '15:00'), status: 'open' }, // closed Tuesdays
  'cantina buona': { id: 'gp-cantina-0001', name: 'Cantina Buona', hours: all('12:00', '23:00'), status: 'open' },
  'museo bardini': { id: 'gp-bardini-0001', name: 'Museo Bardini', hours: [5, 6, 0].map((day) => ({ day, open: '11:00', close: '17:00' })), status: 'open' }, // Fri–Sun only
};
function fakeMaps() {
  const calls = { search: [], place: 0, travel: 0 };
  const view = (p) => ({ ...p, address: `${p.name}, Florence`, lat: FLORENCE.lat + 0.001, lng: FLORENCE.lng + 0.001, price: null, standin: false, source: 'Google Maps (Places API)', checked_at: new Date(T0).toISOString() });
  return {
    calls,
    mode: 'google',
    async search(q) {
      calls.search.push(q);
      const name = String(q).split(',')[0].toLowerCase().replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim();
      return PLACES[name] ? [view(PLACES[name])] : [];
    },
    async place(id) { calls.place++; const p = Object.values(PLACES).find((x) => x.id === id); return view(p); },
    async travel(a, b, mode) { calls.travel++; return { minutes: 10, meters: 800, mode, standin: false, source: 'Google Maps (Routes API)', checked_at: new Date(T0).toISOString() }; },
  };
}

// OpenAI, faked: the Responses API's shape (a web_search_call, then the message with its JSON and citations)
const stop = (kind, name, at, minutes, extra = {}) => ({ kind, place: { name, address: null, city: 'Florence' }, at, minutes, mode: 'walk', nights: null, note: '', cost: null, source_url: kind === 'transport' ? null : `https://example.org/${encodeURIComponent(name)}`, ...extra });
const FLORENCE_DRAFT = {
  title: 'Two days in Florence', destination: 'Florence, Italy', start: '2026-11-02', travelers: 2, notes: 'Planned from official sites.',
  days: [
    { title: 'Monday', stops: [
      stop('stay', 'Hotel Calimala', '09:00', 30, { nights: 1 }),
      stop('visit', 'Uffizi Gallery', '10:00', 120), // closed Mondays → moved to Tuesday
      stop('meal', 'Trattoria Mario', '13:00', 60),
      stop('visit', 'Duomo di Firenze', '15:00', 60),
      stop('activity', 'Ghost Bar', '17:00', 60), // not on Google → removed
      stop('meal', 'Old Caffe', '20:00', 60), // closed for good → removed
    ] },
    { title: 'Tuesday', stops: [
      stop('visit', 'Palazzo Pitti', '08:00', 60), // opens 08:15 → re-timed
      stop('visit', 'Galleria dell Accademia', '10:00', 90),
      stop('meal', 'Osteria Chiusa', '13:00', 60), // closed Tuesdays, a meal: Eden can't move it → the repair round
    ] },
  ],
};
function fakeOpenAI(answers) {
  const seen = [];
  const fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    seen.push({ body, auth: init.headers.authorization });
    const a0 = answers[seen.length - 1];
    const a = typeof a0 === 'function' ? a0(body) : a0;
    if (!a) throw new Error('no more answers');
    if (a.status) return jsonRes({ error: { message: 'nope' } }, a.status);
    return jsonRes({
      status: 'completed',
      output: [
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(a), annotations: [{ type: 'url_citation', url: 'https://www.uffizi.it/en/pages/opening-times', title: 'Uffizi opening times' }] }] },
      ],
      usage: { input_tokens: 10_000, output_tokens: 3000, output_tokens_details: { reasoning_tokens: 1000 } },
    });
  };
  return { fetch, seen };
}
function account(env = {}) {
  const m = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
  };
  m.set('account', { id: OWNER });
  return { m, storage, env, now: () => T0 };
}
const stopsOf = (trip) => trip.days.flatMap((d, i) => d.stops.map((s) => ({ ...s, day: i })));
const named = (trip, name) => stopsOf(trip).find((s) => s.place.name === name);

test('Florence on a Monday: drafted with web search, checked on Google, fixed by Eden, one repair round', async () => {
  // the repair answer names the failing stop by the id Eden gave it in the request
  const ai = fakeOpenAI([FLORENCE_DRAFT, (body) => {
    const id = /\[stop=(s-[0-9a-f]{8})\] Osteria Chiusa/.exec(body.input[1].content)[1];
    return { edits: [
      { stop: id, action: 'replace', day: null, at: '13:00', minutes: 60, place: { name: 'Cantina Buona', address: null, city: 'Florence' }, kind: 'meal', note: null, source_url: 'https://example.org/cantina', why: 'Osteria Chiusa is closed on Tuesdays.' },
      { stop: 's-00000000', action: 'remove', day: null, at: null, minutes: null, place: null, kind: null, note: null, source_url: null, why: 'not a failing stop: ignored' },
    ] };
  }]);
  const fetch = ai.fetch;
  const acct = account({ OPENAI_API_KEY: 'sk-test-key' });
  const maps = fakeMaps();
  const r = await tripOp(acct, 'trip-plan', { request: 'Two days in Florence from Monday 2 November 2026, the Uffizi and good food', constraints: { start: '2026-11-02', days: 2, travelers: 2 } }, { fetch, maps });

  // the draft call: GPT-6.1 Sol, web search on, the trip schema, the key only in the header
  const first = ai.seen[0];
  assert.equal(first.body.model, 'gpt-6.1-sol');
  assert.deepEqual(first.body.tools, [{ type: 'web_search' }]);
  assert.equal(first.body.text.format.type, 'json_schema');
  assert.deepEqual(first.body.text.format.schema, TRIP_SCHEMA);
  assert.equal(first.auth, 'Bearer sk-test-key');
  assert.ok(!JSON.stringify(first.body).includes('sk-test-key'));
  assert.match(first.body.input[1].content, /day 1 = Monday 2026-11-02, day 2 = Tuesday 2026-11-03/);

  // one place per search, never packed
  assert.ok(maps.calls.search.every((q) => !q.includes(';')));
  assert.ok(maps.calls.search.includes('Uffizi Gallery, Florence'));
  // the search's hours were kept: no second Google call per place for the checks
  assert.equal(maps.calls.place, 0);

  const uffizi = named(r.trip, 'Uffizi Gallery');
  assert.equal(uffizi.day, 1, 'closed Monday → moved to Tuesday');
  const moved = r.changes.find((c) => c.name === 'Uffizi Gallery');
  assert.equal(moved.what, 'moved');
  assert.equal(moved.by, 'eden');
  assert.deepEqual(moved.from, { day: 0, at: '10:00' });
  assert.match(moved.why, /closed on Mondays/);
  assert.match(moved.evidence.text, /Mon closed; Tue 08:15–18:30/);
  assert.equal(moved.evidence.source, 'Google Maps (Places API)');

  const pitti = named(r.trip, 'Palazzo Pitti');
  assert.equal(pitti.at, '08:15', 'out of hours → re-timed when it opens');
  assert.equal(r.changes.find((c) => c.name === 'Palazzo Pitti').what, 'retimed');

  assert.equal(named(r.trip, 'Ghost Bar'), undefined);
  assert.match(r.changes.find((c) => c.name === 'Ghost Bar').why, /found no place/);
  assert.equal(named(r.trip, 'Old Caffe'), undefined);
  assert.match(r.changes.find((c) => c.name === 'Old Caffe').why, /closed for good/);

  // the repair round: only the failing meal, replaced and checked again
  assert.equal(ai.seen.length, 2);
  assert.equal(ai.seen[1].body.text.format.name, 'repair');
  assert.match(ai.seen[1].body.input[1].content, /Osteria Chiusa.*closed on Tuesdays.*Tue closed/s);
  assert.equal(r.repaired, true);
  const cantina = named(r.trip, 'Cantina Buona');
  assert.ok(cantina && cantina.day === 1 && cantina.at === '13:00' && cantina.place.id === 'gp-cantina-0001');
  assert.equal(r.changes.find((c) => c.what === 'replaced').was_name, 'Osteria Chiusa');
  assert.equal(stopsOf(r.trip).length, 9 - 2, 'two removed; nothing else dropped by the ignored edit');

  // nothing wrong left, and the trip is ready for trip-create (Duomo matched under Google's longer name: said so)
  assert.deepEqual(r.unresolved, []);
  assert.equal(r.checks.alerts.length, 0);
  assert.ok(!r.changes.some((c) => c.what === 'matched'), 'Duomo di Firenze is in Google’s longer name: no match note');
  assert.equal(r.model, 'gpt-6.1-sol');
  assert.equal(r.searched, true);
  assert.ok(r.sources.some((s) => s.url === 'https://www.uffizi.it/en/pages/opening-times'));
  assert.equal(r.costs.web_searches, 2);
  assert.equal(r.costs.model_usd, 0.12); // 2 calls × (10k in × $2/M + 3k out × $10/M + 1 search × $0.01)
  assert.ok(!('rev' in r.trip));
  const made = await tripOp(acct, 'trip-create', { trip: r.trip }, { fetch, maps });
  assert.equal(made.trip.days[1].stops.length, 4);
  assert.equal(made.checks.alerts.length, 0);
  assert.equal(maps.calls.place, 0, 'creating it reused the plan’s Google answers');
});

test('what Eden can’t fix (closed on the only day, the repair has nothing) is listed with Google’s reason', async () => {
  const draft = { title: 'A Monday in Florence', destination: 'Florence', start: '2026-11-02', travelers: 1, notes: '', days: [{ title: 'Monday', stops: [stop('visit', 'Museo Bardini', '11:00', 90), stop('meal', 'Trattoria Mario', '13:00', 60)] }] };
  const ai = fakeOpenAI([draft, { edits: [] }]);
  const r = await planTrip({ request: 'One Monday in Florence with the Bardini' }, { env: { OPENAI_API_KEY: 'k' }, maps: fakeMaps(), fetch: ai.fetch, now: () => T0 });
  assert.equal(ai.seen.length, 2, 'one repair round, no more');
  assert.equal(r.unresolved.length, 1);
  const u = r.unresolved[0];
  assert.equal(u.name, 'Museo Bardini');
  assert.equal(u.kind, 'closed_that_day');
  assert.match(u.text, /closed on Mondays/);
  assert.match(u.hours, /Fri 11:00–17:00/);
  assert.equal(u.source, 'Google Maps (Places API)');
  assert.ok(named(r.trip, 'Museo Bardini'), 'kept, but listed: the card shows it');
});

test('a failed repair call leaves Eden’s fixes and lists the rest; a draft error is the person’s message', async () => {
  const draft = { title: 'x', destination: 'Florence', start: '2026-11-02', travelers: 1, notes: '', days: [{ title: 'Mon', stops: [stop('visit', 'Museo Bardini', '11:00', 90)] }] };
  const ai = fakeOpenAI([draft, { status: 500 }]);
  const r = await planTrip({ request: 'Florence' }, { env: { OPENAI_API_KEY: 'k' }, maps: fakeMaps(), fetch: ai.fetch, now: () => T0 });
  assert.equal(r.repaired, false);
  assert.equal(r.unresolved[0].name, 'Museo Bardini');
  const bad = fakeOpenAI([{ status: 401 }]);
  await assert.rejects(planTrip({ request: 'Florence' }, { env: { OPENAI_API_KEY: 'k' }, maps: fakeMaps(), fetch: bad.fetch, now: () => T0 }), (e) => e.code === 'unavailable' && /401/.test(e.message));
});

test('no OpenAI key: the service model drafts without search, and the result says so', async () => {
  const draft = { title: 'Florence', destination: 'Florence', start: '2026-11-03', travelers: 1, notes: '', days: [{ title: 'Tue', stops: [stop('visit', 'Uffizi Gallery', '10:00', 120)] }] };
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(url);
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body);
    assert.equal(body.output_config.format.type, 'json_schema');
    return jsonRes({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify(draft) }], usage: { input_tokens: 1000, output_tokens: 500 } });
  };
  const r = await planTrip({ request: 'A Tuesday in Florence' }, { env: { ANTHROPIC_API_KEY: 'a' }, maps: fakeMaps(), fetch, now: () => T0 });
  assert.equal(r.searched, false);
  assert.match(r.note, /No OpenAI key here: drafted by claude-sonnet-5-5 without web search/);
  assert.equal(r.unresolved.length, 0);
  assert.equal(seen.length, 1);
});

test('the op: Plus-free checks of its words, and a daily allowance', async () => {
  const acct = account({ OPENAI_API_KEY: 'k', TRAVEL_PLANS_A_DAY: '1' });
  await assert.rejects(tripOp(acct, 'trip-plan', { request: 'x' }, { maps: fakeMaps() }), /request/);
  await assert.rejects(tripOp(acct, 'trip-plan', { request: 'Florence', constraints: { pace: 'frantic' } }, { maps: fakeMaps() }), /pace/);
  const draft = { title: 'x', destination: 'Florence', start: '2026-11-03', travelers: 1, notes: '', days: [{ title: 'Tue', stops: [stop('visit', 'Uffizi Gallery', '10:00', 120)] }] };
  await tripOp(acct, 'trip-plan', { request: 'Florence on Tuesday' }, { maps: fakeMaps(), fetch: fakeOpenAI([draft]).fetch });
  await assert.rejects(tripOp(acct, 'trip-plan', { request: 'Florence on Tuesday' }, { maps: fakeMaps(), fetch: fakeOpenAI([draft]).fetch }), (e) => e.code === 'rate_limited');
  assert.equal(PLAN.model, 'gpt-6.1-sol');
});

test('the fixer’s pieces: hours on a date, free slots, Google’s week in words, names', () => {
  const hit = { hours: except(1, '08:15', '18:30') };
  assert.deepEqual(spansOn(hit, '2026-11-02'), []);
  assert.deepEqual(spansOn(hit, '2026-11-03'), [[495, 1110]]);
  assert.equal(spansOn({ hours: null }, '2026-11-03'), null);
  const day = { stops: [{ id: 'a', kind: 'visit', at: '10:00', minutes: 60 }, { id: 'b', kind: 'meal', at: '13:00', minutes: 60 }] };
  assert.equal(slot(day, { id: 'x', minutes: 90 }, [[495, 1110]], 600), 11 * 60 + 15); // 11:15–12:45, a quarter-hour either side
  assert.equal(slot(day, { id: 'x', minutes: 600 }, [[495, 1110]], 600), null);
  // an arrival opens the day: nothing before it
  const arrive = { stops: [{ id: 't', kind: 'transport', at: '12:00', minutes: 30 }] };
  assert.equal(slot(arrive, { id: 'x', minutes: 60 }, null, 9 * 60), 12 * 60 + 45);
  assert.match(weekText(hit), /^Mon closed; Tue 08:15–18:30/);
  assert.equal(sameName('Duomo di Firenze', 'Cattedrale di Santa Maria del Fiore (Duomo di Firenze)'), true);
  assert.equal(sameName('Natural History Museum Vienna', 'Kunsthistorisches Museum Wien'), false);
  assert.equal(sameName('Yellow Pumpkin', 'Red Pumpkin by Yayoi Kusama'), false);
  assert.equal(sameName('Uffizi Gallery', 'Uffizi Galleries'), true);
  assert.equal(sameName('Museo dell’Opera del Duomo', 'Opera del Duomo Museum'), true);
  assert.equal(sameName('Antico Caffè Greco', 'Babington’s Tea Room'), false);
});

test('a late arrival is started when you get there, if that still fits', async () => {
  const trip = { title: 't', destination: 'Florence', start: '2026-11-03', travelers: 1, budget: null, access: null, days: [{ title: 'd', stops: [
    { id: 's-a', kind: 'visit', place: { id: 'gp-uffizi-00001', name: 'Uffizi Gallery', lat: 43.77, lng: 11.25 }, at: '10:00', minutes: 60, mode: 'walk', cost: null, nights: null, link: null, booked: null, note: '' },
    { id: 's-b', kind: 'visit', place: { id: 'gp-pitti-000001', name: 'Palazzo Pitti', lat: 43.77, lng: 11.25 }, at: '11:00', minutes: 60, mode: 'walk', cost: null, nights: null, link: null, booked: null, note: '' },
  ] }] };
  const maps = fakeMaps();
  const checks = await checkTrip(trip, maps, { now: () => T0 });
  assert.equal(checks.alerts[0].kind, 'late');
  const hits = new Map([['s-b', { ...PLACES['palazzo pitti'], source: 'Google Maps (Places API)', checked_at: 'x' }]]);
  const changes = fixTrip(trip, checks, hits);
  assert.equal(trip.days[0].stops[1].at, '11:10');
  assert.equal(changes[0].what, 'retimed');
  assert.match(changes[0].why, /there at 11:10/);
});
