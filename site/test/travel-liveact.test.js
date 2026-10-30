// The travel day's Live Activity by push (src/travel/liveact.js): the content-state in TravelDayAttributes.ContentState's
// shape, the tokens, the job's updates at leave-by and when the next stop changes, the end, push-to-start, a flight's
// gate from watch.js, and the real sendPush path (a key made here, a fake Apple). Nothing here reaches Apple or Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './fakes.js';
import { queued } from '../src/accounts/schedule.js';
import { LIVE, androidPlan, armLive, contentState, dayPlan, leaveAlert, liveDue, liveFlightNews, liveOp, livePayload, nextIndex, todayIn } from '../src/travel/liveact.js';
import { sampleTrip, tripOp as realTripOp } from '../src/travel/ops.js';
import { standinMaps } from '../src/travel/maps.js';
import { forgetProviderToken } from '../src/accounts/apns.js';

const REF_S = 978307200;
const TRIP = 'a1b2c3d4e5f60718';
const TOKEN = 'ab'.repeat(32);
const START_TOKEN = 'cd'.repeat(40);
const DATE = '2027-05-12';
const at = (hhmm, zone = 'Z') => Date.parse(`${DATE}T${hhmm}:00${zone}`);

function account(t, { pushes = [], answer = () => ({ status: 200 }) } = {}) {
  return { storage: new Storage(), env: {}, t, now() { return this.t; }, sendPush: async (p) => { pushes.push({ ...p, aps: JSON.parse(p.body).aps }); return answer(p); } };
}
// Lisbon (UTC+1 in May): three stops and a flight; the second has a checked travel time
function lisbon(a, { zone = 'Europe/Lisbon' } = {}) {
  a.storage.map.set(`trip:${TRIP}`, { title: 'Lisbon in May', start: DATE, travelers: 2, days: [
    { stops: [
      { id: 's1', kind: 'visit', at: '09:00', minutes: 60, place: { name: 'Belém Tower' }, mode: 'walk' },
      { id: 's2', kind: 'meal', at: '11:00', minutes: 90, place: { name: 'Time Out Market' }, mode: 'transit' },
      { id: 's3', kind: 'transport', at: '15:00', minutes: 150, place: { name: 'TP1351 to London' }, note: 'LIS → LHR' },
    ] },
  ] });
  if (zone) a.storage.map.set(`tz:${TRIP}`, { zone });
}
const checks = { days: [{ date: DATE, stops: [{ badges: {} }, { badges: { travel: { minutes: 25, mode: 'transit', source: 'Google Maps', status: 'ok' } } }, { badges: {} }] }] };
const tripOp = async (_a, op) => { assert.equal(op, 'trip-get'); return { checks }; };
const jobAt = async (a) => (await queued(a)).find((j) => j.kind === 'tlive')?.at ?? null;

test('content-state: TravelDayAttributes.ContentState exactly (dates since 2001, empty fields left out)', () => {
  const a = account(0);
  lisbon(a);
  const trip = a.storage.map.get(`trip:${TRIP}`);
  const plan = dayPlan(trip, 0, { checks, zone: 'Europe/Lisbon', snap: { gate: '14', terminal: '1' } });
  assert.equal(plan.stops[0].start, at('08:00'), '09:00 in Lisbon is 08:00 UTC in May');
  const s = contentState(plan, 1);
  assert.deepEqual(Object.keys(s), ['stop', 'startsAt', 'leaveBy', 'mode', 'minutes', 'source', 'flight', 'gate', 'terminal', 'stopsAfter', 'dayEndsAt']);
  assert.equal(s.stop, 'Time Out Market');
  assert.equal(s.startsAt, at('10:00') / 1000 - REF_S);
  assert.equal(s.leaveBy, at('09:35') / 1000 - REF_S, 'its time less the checked 25 minutes');
  assert.deepEqual([s.mode, s.minutes, s.source, s.flight, s.gate, s.terminal, s.stopsAfter], ['transit', 25, 'Google Maps', 'TP1351', '14', '1', 1]);
  assert.equal(s.dayEndsAt, at('16:30') / 1000 - REF_S, 'the last stop’s end');
  const first = contentState(plan, 0);
  assert.equal('leaveBy' in first || 'minutes' in first || 'source' in first, false, 'no checked travel time: no leave-by, never a guess');
  assert.equal(first.mode, 'walk', 'the stop’s own mode, as the page shows it');
  // no flight snapshot yet: the flight's number alone
  const bare = contentState(dayPlan(trip, 0, { zone: 'Europe/Lisbon' }), 2);
  assert.equal(bare.flight, 'TP1351');
  assert.equal('gate' in bare, false);
  // a stop earlier than the one before is after midnight (as the page counts it)
  const late = { title: 'x', start: DATE, days: [{ stops: [{ id: 'a', at: '22:00', place: { name: 'A' } }, { id: 'b', at: '01:00', place: { name: 'B' } }] }] };
  assert.equal(dayPlan(late, 0).stops[1].start, Date.parse('2027-05-13T01:00:00Z'));
  assert.equal(todayIn('Pacific/Auckland', at('13:00')), '2027-05-13');
});

test('payloads: update with stale-date, end with dismissal-date, start with attributes and an alert', () => {
  const a = account(0);
  lisbon(a);
  const plan = { ...dayPlan(a.storage.map.get(`trip:${TRIP}`), 0, { checks, zone: 'Europe/Lisbon' }), id: TRIP };
  const now = at('09:10');
  const u = livePayload('update', plan, 1, now).aps;
  assert.deepEqual(Object.keys(u), ['timestamp', 'event', 'content-state', 'stale-date']);
  assert.equal(u.timestamp, Math.floor(now / 1000));
  assert.equal(u['stale-date'], at('10:00') / 1000, 'aps dates are Unix seconds; stale once the stop starts (as the app does)');
  const e = livePayload('end', plan, 2, now).aps;
  assert.equal(e['dismissal-date'], Math.floor((now + LIVE.endDismissMs) / 1000));
  const s = livePayload('start', plan, 0, now, { alert: { title: 't', body: 'b' } }).aps;
  assert.equal(s['attributes-type'], 'TravelDayAttributes');
  assert.deepEqual(s.attributes, { trip: 'Lisbon in May', day: 'Day 1', date: DATE, tripId: TRIP });
  assert.deepEqual(s.alert, { title: 't', body: 'b' });
  assert.deepEqual(leaveAlert(plan.stops[1]), { title: 'Leave now for Time Out Market', body: '25 min public transport · Google Maps' });
});

test('trip-live-token: checked, kept, and the job set to the next change', async () => {
  const pushes = [];
  const a = account(at('07:30'), { pushes });
  lisbon(a);
  await assert.rejects(liveOp(a, 'trip-live-token', { trip: TRIP, day: DATE }), /push token/);
  await assert.rejects(liveOp(a, 'trip-live-token', { token: 'nothex', trip: TRIP, day: DATE }), /isn't a push token/);
  await assert.rejects(liveOp(a, 'trip-live-token', { token: TOKEN }), /trip and day/);
  await assert.rejects(liveOp(a, 'trip-live-token', { token: TOKEN, trip: TRIP, day: '2027-06-01' }), /isn’t on this trip/);
  await assert.rejects(liveOp(a, 'trip-live-token', { token: TOKEN, trip: 'f'.repeat(16), day: DATE }), /no such trip/);
  const r = await liveOp(a, 'trip-live-token', { token: TOKEN.toUpperCase(), trip: TRIP, day: DATE, env: 'sandbox' }, { tripOp });
  assert.equal(r.ok, true);
  const rec = a.storage.map.get(`tlive:${TRIP}:${DATE}`);
  assert.equal(rec.token, TOKEN);
  assert.equal(rec.env, 'sandbox');
  assert.equal(r.next, at('08:01'), 'a minute after Belém Tower’s 09:00 (08:00 UTC), the next stop changes');
  assert.equal(await jobAt(a), at('08:01'));
  assert.equal(pushes.length, 0, 'nothing pushed at registration (the app shows what the page sent)');
});

test('the job: next stop at each stop, an alert at leave-by, an end after the last stop', async () => {
  const pushes = [];
  const a = account(at('07:30'), { pushes });
  lisbon(a);
  await liveOp(a, 'trip-live-token', { token: TOKEN, trip: TRIP, day: DATE, env: 'sandbox' }, { tripOp });
  a.t = at('08:01');
  await liveDue(a, { tripOp });
  assert.equal(pushes.length, 1);
  let p = pushes.at(-1);
  assert.deepEqual([p.push_type, p.apns_topic, p.apns_env, p.apns_token, p.priority], ['liveactivity', 'com.askeden.travel', 'sandbox', TOKEN, 5]);
  assert.equal(p.aps.event, 'update');
  assert.equal(p.aps['content-state'].stop, 'Time Out Market');
  assert.equal(p.aps.alert, undefined);
  assert.equal(await jobAt(a), at('09:35'), 'next: leave-by for the market');
  a.t = at('09:35');
  await liveDue(a, { tripOp });
  p = pushes.at(-1);
  assert.equal(pushes.length, 2);
  assert.deepEqual(p.aps.alert, { title: 'Leave now for Time Out Market', body: '25 min public transport · Google Maps' });
  assert.equal(p.priority, 10);
  // the job again at the same minute: nothing new
  await liveDue(a, { tripOp });
  assert.equal(pushes.length, 2, 'told once');
  assert.equal(await jobAt(a), at('10:01'));
  a.t = at('10:01');
  await liveDue(a, { tripOp });
  assert.equal(pushes.at(-1).aps['content-state'].stop, 'TP1351 to London');
  assert.equal(pushes.at(-1).aps['content-state'].stopsAfter, 0);
  assert.equal(await jobAt(a), at('14:01'));
  a.t = at('14:01');
  await liveDue(a, { tripOp });
  p = pushes.at(-1);
  assert.equal(p.aps.event, 'end');
  assert.equal(p.aps['content-state'].stop, 'TP1351 to London');
  assert.equal(a.storage.map.get(`tlive:${TRIP}:${DATE}`).done, true);
  assert.equal(await jobAt(a), null, 'nothing more to do');
});

test('a leave-by the job missed by more than 10 minutes is not alerted late; Apple’s “gone” drops the token', async () => {
  const pushes = [];
  let answer = { status: 200 };
  const a = account(at('08:01'), { pushes, answer: () => answer });
  lisbon(a);
  await liveOp(a, 'trip-live-token', { token: TOKEN, trip: TRIP, day: DATE }, { tripOp });
  a.t = at('09:50');
  await liveDue(a, { tripOp });
  assert.equal(pushes.at(-1).aps.alert, undefined);
  answer = { status: 400, reason: 'BadDeviceToken' };
  a.t = at('10:01');
  await liveDue(a, { tripOp });
  const rec = a.storage.map.get(`tlive:${TRIP}:${DATE}`);
  assert.equal(rec.token, null);
  assert.equal(await jobAt(a), null);
  // Apple down: tried again in a minute, not every second
  const b = account(at('08:01'), { answer: () => ({ status: 503, reason: 'ServiceUnavailable' }) });
  lisbon(b);
  await liveOp(b, 'trip-live-token', { token: TOKEN, trip: TRIP, day: DATE }, { tripOp });
  await liveDue(b, { tripOp });
  assert.equal(await jobAt(b), at('08:01') + LIVE.retryMs);
  assert.equal(b.storage.map.get(`tlive:${TRIP}:${DATE}`).sent, null, 'not marked sent');
});

test('trip-live-end: off for that day; push-to-start skips it; never forgets the start token', async () => {
  const pushes = [];
  const a = account(at('06:00'), { pushes });
  lisbon(a);
  await liveOp(a, 'trip-live-token', { push_to_start: START_TOKEN, env: 'production' }, { tripOp });
  assert.equal(a.storage.map.get('tlivestart').token, START_TOKEN);
  assert.equal(await jobAt(a), at('08:00') - LIVE.startLeadMs, '90 minutes before the first stop');
  a.t = at('06:30');
  await liveDue(a, { tripOp });
  const p = pushes.at(-1);
  assert.equal(p.apns_token, START_TOKEN);
  assert.equal(p.aps.event, 'start');
  assert.equal(p.aps.attributes.tripId, TRIP);
  assert.equal(p.aps['content-state'].stop, 'Belém Tower');
  assert.deepEqual(p.aps.alert, { title: 'Lisbon in May: Day 1', body: 'Next: Belém Tower at 09:00' }, 'the time in the trip’s zone');
  await liveDue(a, { tripOp });
  assert.equal(pushes.length, 1, 'started once');
  // the started activity's own token arrives: what it shows is kept, so the next run sends nothing new
  await liveOp(a, 'trip-live-token', { token: TOKEN, trip: TRIP, day: DATE }, { tripOp });
  await liveDue(a, { tripOp });
  assert.equal(pushes.length, 1);
  // the person ends it: nothing more that day
  await liveOp(a, 'trip-live-end', { trip: TRIP, day: DATE }, { tripOp });
  a.t = at('08:01');
  await liveDue(a, { tripOp });
  assert.equal(pushes.length, 1);
  // an ended day isn't started again by push
  const b = account(at('06:30'), { pushes: [] });
  lisbon(b);
  await liveOp(b, 'trip-live-token', { push_to_start: START_TOKEN }, { tripOp });
  await liveOp(b, 'trip-live-end', { trip: TRIP, day: DATE }, { tripOp });
  await liveDue(b, { tripOp });
  assert.equal(b.storage.map.get(`tlive:${TRIP}:${DATE}`).started_at, undefined);
  await liveOp(b, 'trip-live-end', { never: true }, { tripOp });
  assert.equal(b.storage.map.has('tlivestart'), false);
  assert.equal(await jobAt(b), null);
});

test('watch.js hook: a new gate goes on the activity with its news as the alert', async () => {
  const pushes = [];
  const a = account(at('12:00'), { pushes });
  lisbon(a);
  await liveOp(a, 'trip-live-token', { token: TOKEN, trip: TRIP, day: DATE }, { tripOp });
  assert.equal(await liveFlightNews(a, { trip: TRIP, date: DATE, news: [] }, { tripOp }), false);
  a.storage.map.set(`fwsnap:TP1351:${DATE}`, { gate: '22', terminal: '1', state: 'scheduled' }); // watch.js keeps it first
  const sent = await liveFlightNews(a, { trip: TRIP, date: DATE, news: [{ title: 'TP1351 leaves from gate 22', body: 'Terminal 1.' }] }, { tripOp });
  assert.equal(sent, true);
  const p = pushes.at(-1);
  assert.equal(p.priority, 10);
  assert.deepEqual(p.aps.alert, { title: 'TP1351 leaves from gate 22', body: 'Terminal 1.' });
  assert.deepEqual([p.aps['content-state'].flight, p.aps['content-state'].gate, p.aps['content-state'].terminal], ['TP1351', '22', '1']);
  assert.equal(await liveFlightNews(a, { trip: TRIP, date: '2027-05-13', news: [{ title: 'x' }] }, { tripOp }), false, 'no activity that day');
});

test('with the real trip-get: checks.js’s travel badge gives the leave-by', async () => {
  const T0 = Date.parse('2027-01-01T09:00:00Z');
  const a = account(T0);
  const trip = sampleTrip(T0);
  a.storage.map.set(`trip:${TRIP}`, trip);
  const maps = standinMaps(() => T0);
  const real = (acc, op, body) => realTripOp(acc, op, body, { maps });
  const { checks: c } = await real(a, 'trip-get', { id: TRIP });
  const plan = dayPlan(trip, 0, { checks: c });
  const k = plan.stops.findIndex((s, i) => i > 0 && s.minutes !== null);
  assert.ok(k > 0, 'a stop with a checked travel time');
  const s = contentState(plan, k);
  assert.equal(s.leaveBy, s.startsAt - plan.stops[k].minutes * 60);
  assert.equal(nextIndex(plan, plan.stops[0].start + 59_000), 0);
  assert.equal(nextIndex(plan, plan.stops[0].start + 60_000), 1);
});

test('the real sendPush: Apple’s sandbox host, the travel app’s liveactivity topic, a signed provider token', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  forgetProviderToken();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('', { status: 200, headers: { 'apns-id': 'x' } }); };
  try {
    const a = { storage: new Storage(), env: { APNS_KEY: pem, APNS_KEY_ID: 'KEY1234567' }, t: at('08:01'), now() { return this.t; } };
    lisbon(a);
    await liveOp(a, 'trip-live-token', { token: TOKEN, trip: TRIP, day: DATE, env: 'sandbox' }, { tripOp });
    await liveDue(a, { tripOp });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, `https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
    assert.equal(init.headers['apns-topic'], 'com.askeden.travel.push-type.liveactivity');
    assert.equal(init.headers['apns-push-type'], 'liveactivity');
    assert.equal(init.headers['apns-priority'], '5');
    const jwt = init.headers.authorization.replace(/^bearer /, '').split('.');
    assert.equal(JSON.parse(atob(jwt[0].replace(/-/g, '+').replace(/_/g, '/'))).kid, 'KEY1234567');
    assert.equal(JSON.parse(init.body).aps.event, 'update');
  } finally {
    globalThis.fetch = realFetch;
    forgetProviderToken();
  }
});

// ── Ask Eden Travel for Android: the day as FCM data messages ──

const FCM = 'fcm1:APA91b' + 'z'.repeat(140);
// the account with one Android Travel install (a web device with the app's Firebase token) and a fake FCM
function androidAccount(t, { fcm = [], pushes = [], answer = () => ({ status: 200 }) } = {}) {
  const a = account(t, { pushes });
  const devices = [{ id: 'dA', kind: 'web', fcm_token: FCM, fcm_app: 'com.askeden.travel' }, { id: 'dB', kind: 'web', fcm_token: 'other'.repeat(8), fcm_app: null }];
  Object.assign(a, {
    devices: async () => devices,
    pushCheck: async () => ({ ok: true }),
    pushGone: async ({ fcm_token }) => { for (const d of devices) if (d.fcm_token === fcm_token) d.fcm_token = null; return {}; },
    sendFcm: async (m) => { fcm.push({ ...m, plan: JSON.parse(m.data.plan) }); return answer(m); },
  });
  return a;
}

test('Android: a trip day taken up 90 minutes before its first stop, sent as { type: travel.live, plan } in livePlan’s shape, ended after the last stop', async () => {
  const fcm = [], pushes = [];
  const a = androidAccount(at('06:00'), { fcm, pushes });
  lisbon(a);
  assert.equal(await armLive(a, { tripOp }), at('08:00') - LIVE.startLeadMs, 'set for 90 minutes before Belém Tower');
  a.t = at('06:30');
  await liveDue(a, { tripOp });
  assert.equal(fcm.length, 1);
  assert.equal(pushes.length, 0, 'no iPhone: nothing to Apple');
  const m = fcm[0];
  assert.deepEqual([m.token, m.data.type, m.collapse, m.priority], [FCM, 'travel.live', 'travel.live', 'high']);
  assert.deepEqual(m.plan, {
    trip: 'Lisbon in May', id: TRIP, day: 1, date: DATE,
    next: { name: 'Belém Tower', start: at('08:00'), leave: null, mode: 'walk', minutes: null, source: null },
    stopsAfter: 2, dayEnds: at('16:30'), flight: { ident: 'TP1351', gate: null, terminal: null },
  });
  assert.equal(a.storage.map.get(`tlive:${TRIP}:${DATE}`).android, true);
  await liveDue(a, { tripOp });
  assert.equal(fcm.length, 1, 'taken up once, nothing new');
  a.t = at('08:01');
  await liveDue(a, { tripOp });
  assert.deepEqual(fcm.at(-1).plan.next, { name: 'Time Out Market', start: at('10:00'), leave: at('09:35'), mode: 'transit', minutes: 25, source: 'Google Maps' });
  assert.equal(fcm.at(-1).plan.stopsAfter, 1);
  a.t = at('14:01');
  await liveDue(a, { tripOp });
  assert.equal(fcm.at(-1).plan.next, null, 'the day is over: no next stop, the app takes the notification away');
  assert.equal(a.storage.map.get(`tlive:${TRIP}:${DATE}`).done, true);
  assert.equal(await jobAt(a), null);
  assert.equal(pushes.length, 0);
});

test('Android: ended there (trip-live-end) is off for that day; FCM’s UNREGISTERED drops the token; a gate goes out too', async () => {
  const fcm = [];
  const a = androidAccount(at('06:30'), { fcm });
  lisbon(a);
  await liveOp(a, 'trip-live-end', { trip: TRIP, day: DATE }, { tripOp });
  await liveDue(a, { tripOp });
  assert.equal(fcm.length, 0, 'the person ended it that day');
  const b = androidAccount(at('12:00'), { fcm });
  lisbon(b);
  await liveDue(b, { tripOp });
  b.storage.map.set(`fwsnap:TP1351:${DATE}`, { gate: '22', terminal: '1' });
  assert.equal(await liveFlightNews(b, { trip: TRIP, date: DATE, news: [{ title: 'TP1351 leaves from gate 22', body: 'Terminal 1.' }] }, { tripOp }), true);
  assert.deepEqual(fcm.at(-1).plan.flight, { ident: 'TP1351', gate: '22', terminal: '1' });
  const gone = [];
  const c = androidAccount(at('06:30'), { fcm: gone, answer: () => ({ status: 404, reason: 'UNREGISTERED' }) });
  lisbon(c);
  await liveDue(c, { tripOp });
  assert.equal(gone.length, 1);
  assert.equal((await c.devices())[0].fcm_token, null, 'the token FCM called gone is dropped');
  const rec = c.storage.map.get(`tlive:${TRIP}:${DATE}`);
  assert.deepEqual([rec.android, rec.done], [false, true], 'nowhere left to send that day');
  // FCM down: tried again in a minute
  const d = androidAccount(at('06:30'), { answer: () => ({ status: 503, reason: 'UNAVAILABLE' }) });
  lisbon(d);
  await liveDue(d, { tripOp });
  assert.equal(await jobAt(d), at('06:30') + LIVE.retryMs);
});

test('Android and an iPhone on one account: both hear each change; push-to-start still starts the iPhone’s and keeps Android’s', async () => {
  const fcm = [], pushes = [];
  const a = androidAccount(at('06:30'), { fcm, pushes });
  lisbon(a);
  await liveOp(a, 'trip-live-token', { push_to_start: START_TOKEN }, { tripOp });
  await liveDue(a, { tripOp });
  assert.equal(fcm.length, 1);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].aps.event, 'start');
  const rec = a.storage.map.get(`tlive:${TRIP}:${DATE}`);
  assert.equal(rec.android, true, 'the iPhone’s start kept Android’s');
  assert.ok(rec.started_at);
  await liveOp(a, 'trip-live-token', { token: TOKEN, trip: TRIP, day: DATE }, { tripOp });
  a.t = at('08:01');
  await liveDue(a, { tripOp });
  assert.equal(pushes.at(-1).aps['content-state'].stop, 'Time Out Market');
  assert.equal(fcm.at(-1).plan.next.name, 'Time Out Market');
  assert.deepEqual([pushes.length, fcm.length], [2, 2]);
  // androidPlan for a day that's over: next null
  const plan = dayPlan(a.storage.map.get(`trip:${TRIP}`), 0, { zone: 'Europe/Lisbon' });
  assert.equal(androidPlan(plan, -1).next, null);
});

test('no push key on the Worker: nothing is armed', async () => {
  const a = { storage: new Storage(), env: {}, t: at('07:00'), now() { return this.t; } };
  lisbon(a);
  const r = await liveOp(a, 'trip-live-token', { token: TOKEN, trip: TRIP, day: DATE }, { tripOp });
  assert.equal(r.next, null);
  assert.equal(await armLive(a, { tripOp }), null);
});
