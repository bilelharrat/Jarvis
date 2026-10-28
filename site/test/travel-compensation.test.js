// Delay compensation (src/travel/compensation.js): EU261/UK261 scope and amounts, the 3 hours at arrival, cancellation
// notice, Canada and the US, the letter, the push after landing and the ops. Fake FlightAware summaries only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './fakes.js';
import { assessFlight, band, claimAfterLanding, claimLetter, claimsOp, outcome } from '../src/travel/compensation.js';

const AP = {
  LIS: { code: 'LIS', lat: 38.7742, lng: -9.1342, country: 'PT' },
  OPO: { code: 'OPO', lat: 41.2481, lng: -8.6814, country: 'PT' },
  LHR: { code: 'LHR', lat: 51.4706, lng: -0.4619, country: 'GB' },
  MAN: { code: 'MAN', lat: 53.3537, lng: -2.275, country: 'GB' },
  JFK: { code: 'JFK', lat: 40.6413, lng: -73.7781, country: 'US' },
  LAX: { code: 'LAX', lat: 33.9416, lng: -118.4085, country: 'US' },
  HEL: { code: 'HEL', lat: 60.3172, lng: 24.9633, country: 'FI' },
  TFS: { code: 'TFS', lat: 28.0445, lng: -16.5725, country: 'ES' },
  YYZ: { code: 'YYZ', lat: 43.6777, lng: -79.6248, country: 'CA' },
  DXB: { code: 'DXB', lat: 25.2532, lng: 55.3657, country: 'AE' },
};
function flight({ ident = 'TP1351', operator = 'TP', from = 'LIS', to = 'LHR', late = 0, state = 'landed', date = '2026-10-20' } = {}) {
  const sch = Date.parse(`${date}T12:00:00Z`);
  return {
    ident, operator, state, origin: { code: from }, destination: { code: to },
    departure: { scheduled: new Date(sch - 3 * 3600_000).toISOString() },
    arrival: { scheduled: new Date(sch).toISOString(), actual: state === 'landed' ? new Date(sch + late * 60_000).toISOString() : null },
    delay_minutes: { departure: late, arrival: state === 'landed' ? late : null }, source: 'FlightAware AeroAPI', checked_at: '2026-10-20T16:00:00Z',
  };
}
const snap = (o) => ({ flight: flight(o), from: AP[o.from || 'LIS'], to: AP[o.to || 'LHR'] });
const law = (a, name) => a.laws.find((l) => l.law === name);

test('distance bands: 1500 and 3500 km, intra-EU over 1500 is the middle band', () => {
  assert.equal(band(1500), 'short');
  assert.equal(band(1501), 'mid');
  assert.equal(band(3500), 'mid');
  assert.equal(band(3501), 'long');
  assert.equal(band(4000, { intraEU: true }), 'mid');
  assert.equal(band(null), null);
  // Lisbon–Helsinki (~3360 km) €400; Helsinki–Tenerife (~4680 km, both EU) still €400; London–New York £520
  assert.equal(law(assessFlight(snap({ operator: 'AY', ident: 'AY1', from: 'HEL', to: 'TFS', late: 200 })), 'EU261').amount.value, 400);
  assert.equal(law(assessFlight(snap({ operator: 'TP', from: 'LIS', to: 'OPO', late: 200 })), 'EU261').amount.value, 250);
  const ny = assessFlight(snap({ ident: 'BA117', operator: 'BA', from: 'LHR', to: 'JFK', late: 240 }));
  assert.equal(law(ny, 'UK261').amount.value, 520);
  assert.equal(law(ny, 'UK261').amount.half, 260);
  assert.ok(ny.distance_km > 5500 && ny.distance_km < 5600, String(ny.distance_km));
});

test('3 hours at arrival: 3h00 likely, 2h59 a question (door time), 2h30 not', () => {
  const at = (late) => assessFlight(snap({ late }));
  assert.equal(at(180).verdict, 'likely');
  assert.match(at(180).headline, /^Likely eligible for €400 under EU261/); // LIS–LHR ~1570 km: middle band
  assert.equal(outcome(flight({ late: 179 })).what, 'delay');
  assert.equal(at(179).verdict, 'check');
  assert.match(law(at(179), 'EU261').ask, /doors open/);
  assert.equal(at(150).verdict, 'unlikely');
  assert.equal(at(150).laws.length, 0);
  assert.equal(assessFlight(snap({ state: 'in_air' })).verdict, 'too_early');
  // never "owed"
  assert.doesNotMatch(JSON.stringify(at(240)), /you are owed/i);
  assert.ok(law(at(240), 'EU261').not_if.some((x) => /extraordinary/.test(x) && /airline to prove/.test(x)));
});

test('cancellations: the notice rules of Art. 5(1)(c)', () => {
  const c = (facts) => law(assessFlight(snap({ state: 'cancelled' }), null, facts), 'EU261');
  assert.equal(c({}).verdict, 'check'); // when were you told?
  assert.match(c({}).ask, /When did the airline tell you/);
  assert.equal(c({ notice_days: 14 }).verdict, 'unlikely');
  assert.equal(c({ notice_days: 3 }).verdict, 'likely');
  assert.equal(c({ notice_days: 10, reroute: { depart_earlier_min: 90, arrive_later_min: 200 } }).verdict, 'unlikely'); // within 2h/4h
  assert.equal(c({ notice_days: 10, reroute: { depart_earlier_min: 90, arrive_later_min: 250 } }).verdict, 'likely');
  assert.equal(c({ notice_days: 3, reroute: { depart_earlier_min: 30, arrive_later_min: 100 } }).verdict, 'unlikely'); // within 1h/2h
  assert.equal(c({ notice_days: 3, reroute: { depart_earlier_min: 30, arrive_later_min: 150 } }).verdict, 'likely');
});

test('denied boarding is compensated at once (Art. 4(3))', () => {
  const a = assessFlight(snap({ late: 0 }), null, { denied_boarding: true });
  assert.equal(a.what, 'denied');
  assert.equal(law(a, 'EU261').verdict, 'likely');
});

test('scope: EU vs UK, and a non-EU airline from outside the EU is not covered', () => {
  // London → Lisbon on TAP: UK rules (leaves the UK) and EU rules (EU airline into the EU); claim one only
  const a = assessFlight(snap({ from: 'LHR', to: 'LIS', late: 200 }));
  assert.deepEqual(a.laws.filter((l) => l.kind === 'compensation').map((l) => l.law).sort(), ['EU261', 'UK261']);
  assert.ok(a.notes.some((n) => /claim under one only/.test(n)));
  assert.equal(law(a, 'UK261').amount.currency, 'GBP');
  // Lisbon → London on BA: EU (leaves the EU, any airline) and UK (UK airline into the UK)
  const b = assessFlight(snap({ ident: 'BA501', operator: 'BA', from: 'LIS', to: 'LHR', late: 200 }));
  assert.equal(law(b, 'EU261').verdict, 'likely');
  assert.equal(law(b, 'UK261').verdict, 'likely');
  // Dubai → London on Emirates: not a UK or EU airline arriving in the UK; nothing covers it
  const c = assessFlight(snap({ ident: 'EK1', operator: 'EK', from: 'DXB', to: 'LHR', late: 300 }));
  assert.equal(c.verdict, 'not_covered');
  assert.equal(c.laws.length, 0);
  // Dubai → Lisbon on Emirates: not covered; on TAP: an EU airline (licence not checked line by line), so "check"
  assert.equal(assessFlight(snap({ ident: 'EK191', operator: 'EK', from: 'DXB', to: 'LIS', late: 300 })).verdict, 'not_covered');
  assert.equal(law(assessFlight(snap({ ident: 'TP1', operator: 'TP', from: 'DXB', to: 'LIS', late: 300 })), 'EU261').covered, 'maybe');
  // New York → London on BA: a UK airline into the UK (CAA list): UK rules yes, EU no
  const d = assessFlight(snap({ ident: 'BA112', operator: 'BA', from: 'JFK', to: 'LHR', late: 300 }));
  assert.equal(law(d, 'UK261').verdict, 'likely');
  assert.equal(law(d, 'EU261'), undefined);
  // Manchester → London: domestic UK, UK rules only
  assert.deepEqual(assessFlight(snap({ ident: 'BA1', operator: 'BA', from: 'MAN', to: 'LHR', late: 200 })).laws.map((l) => l.law), ['UK261']);
});

test('Canada and the US: ranges and refunds, never a certain amount', () => {
  const ca = assessFlight(snap({ ident: 'AC1', operator: 'AC', from: 'LAX', to: 'YYZ', late: 400 }));
  const appr = law(ca, 'APPR');
  assert.equal(appr.verdict, 'check');
  assert.deepEqual(appr.amount.range, [250, 700]); // 6–9 h late: small CA$250, large CA$700
  const us = law(ca, 'US-DOT');
  assert.equal(us.kind, 'refund');
  assert.equal(us.verdict, 'check'); // international: 6 hours or more
  const dom = assessFlight(snap({ ident: 'AA1', operator: 'AA', from: 'JFK', to: 'LAX', late: 200 }));
  assert.equal(law(dom, 'US-DOT').verdict, 'check'); // domestic: 3 hours
  assert.match(dom.headline, /refund/);
});

test('the letter: the person sends it; the airline form when known', () => {
  const a = assessFlight(snap({ ident: 'FR8341', operator: 'FR', from: 'LIS', to: 'OPO', late: 210 }));
  const l = claimLetter(a, { passengers: ['Ana Silva', { name: 'Rui Silva' }], booking_ref: 'ABC123' });
  assert.equal(l.law, 'EU261');
  assert.match(l.letter, /Ana Silva, Rui Silva/);
  assert.match(l.letter, /€250 per passenger/);
  assert.match(l.letter, /extraordinary circumstances/);
  assert.match(l.to.form_url, /^https:\/\/eu261compensationclaims\.ryanair\.com/);
  assert.match(l.sends, /yourself/);
  const none = claimLetter(assessFlight(snap({ ident: 'AY1', operator: 'AY', from: 'HEL', to: 'LIS', late: 200 })), { passengers: ['A B'] });
  assert.equal(none.to.form_url, null);
  assert.match(none.to.form_source, /airline’s website/);
  assert.throws(() => claimLetter(a, { passengers: [] }), /passenger/);
});

// ── the push after landing and the ops ──

const TRIP = '0123456789abcdef';
function account(t) {
  const storage = new Storage();
  return { storage, env: {}, t, now() { return this.t; } };
}
async function withTrip(a) {
  await a.storage.put(`trip:${TRIP}`, { title: 'Porto', start: '2026-10-20', days: [{ stops: [{ id: 's-1', kind: 'transport', place: { name: 'TP1351 LIS → LHR' }, note: '' }] }] });
}
const fakeTripOp = (f) => async (_a, op) => {
  assert.equal(op, 'trip-flight-live');
  return { flight: f, from: AP.LIS, to: AP.LHR, position: null };
};

test('claimAfterLanding pushes once when likely, and saves what FlightAware said', async () => {
  const a = account(Date.parse('2026-10-20T16:00:00Z'));
  const pushed = [];
  const notify = async (_a, n) => pushed.push(n);
  const f = { trip: TRIP, stop: 's-1', ident: 'TP1351', date: '2026-10-20' };
  const fl = flight({ late: 220 });
  await claimAfterLanding(a, f, fl, { state: 'in_air' }, { tripOp: fakeTripOp(fl), notify });
  await claimAfterLanding(a, f, fl, { state: 'in_air' }, { tripOp: fakeTripOp(fl), notify });
  assert.equal(pushed.length, 1);
  assert.match(pushed[0].body, /Likely eligible for €400/);
  assert.doesNotMatch(pushed[0].body, /owed/);
  assert.equal(pushed[0].data.kind, 'claim');
  // on time: saved, no push
  const b = account(Date.parse('2026-10-20T16:00:00Z'));
  const ok = flight({ late: 20 });
  const rec = await claimAfterLanding(b, f, ok, null, { tripOp: fakeTripOp(ok), notify });
  assert.equal(rec.verdict, 'unlikely');
  assert.equal(pushed.length, 1);
});

test('a cancellation seen running the day before: notice under 7 days', async () => {
  const a = account(Date.parse('2026-10-20T10:00:00Z'));
  const pushed = [];
  const fl = flight({ state: 'cancelled' });
  const rec = await claimAfterLanding(a, { trip: TRIP, stop: 's-1', ident: 'TP1351', date: '2026-10-20' }, fl, { state: 'scheduled', checked_at: Date.parse('2026-10-19T12:00:00Z') }, { tripOp: fakeTripOp(fl), notify: async (_a, n) => pushed.push(n) });
  assert.equal(rec.facts.notice_days, 0);
  assert.equal(rec.verdict, 'likely');
  assert.match(pushed[0].body, /was cancelled/);
});

test('trip-claims and trip-claim-letter', async () => {
  const a = account(Date.parse('2026-10-21T09:00:00Z'));
  await withTrip(a);
  const fl = flight({ late: 200 });
  let looks = 0;
  const tripOp = async (...args) => { looks++; return fakeTripOp(fl)(...args); };
  const r = await claimsOp(a, 'trip-claims', { id: TRIP }, { tripOp });
  assert.equal(r.claims.length, 1);
  assert.equal(r.claims[0].assessment.verdict, 'likely');
  assert.match(r.claims[0].form.url, /flytap\.com/);
  await claimsOp(a, 'trip-claims', { id: TRIP }, { tripOp });
  assert.equal(looks, 1); // saved after the first look
  // what the person says changes it
  const d = await claimsOp(a, 'trip-claims', { id: TRIP, facts: { 's-1': { denied_boarding: true } } }, { tripOp });
  assert.equal(d.claims[0].assessment.what, 'denied');
  const l = await claimsOp(a, 'trip-claim-letter', { id: TRIP, stop: 's-1', passengers: ['Ana Silva'] }, { tripOp });
  assert.match(l.letter, /TP1351/);
  assert.match(l.subject, /Compensation claim: TP1351 on 2026-10-20/);
  await assert.rejects(claimsOp(a, 'trip-claim-letter', { id: TRIP, stop: 's-x', passengers: ['A'] }, { tripOp }), /isn’t a flight/);
  await assert.rejects(claimsOp(a, 'trip-claims', { id: 'nope' }, { tripOp }), /trip id/);
  // a flight not flown yet is not listed
  const early = account(Date.parse('2026-10-18T09:00:00Z'));
  await withTrip(early);
  assert.equal((await claimsOp(early, 'trip-claims', { id: TRIP }, { tripOp })).claims.length, 0);
});
