// Watching Eden Mail for bookings (src/travel/mailwatch.js): opt-in, one look every few hours at mail since the last,
// structured bookings only, matched to every trip they fall in, kept for the page as the scan's cards, one push, and
// never added to a trip by itself. A fake Gmail (format=full messages with schema.org JSON-LD) and a fake clock only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './fakes.js';
import { queued, runAlarms } from '../src/accounts/schedule.js';
import { MAILWATCH, mailWatchDue, mailWatchOp, tripsFor, watchQuery } from '../src/travel/mailwatch.js';

const T0 = Date.parse('2027-04-01T09:00:00Z');
const H = 3600_000;
const account = () => ({ storage: new Storage(), env: {}, t: T0, now() { return this.t; } });

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
function gmailMessage(id, subject, jsonLd, plain = '') {
  const html = jsonLd ? `<html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body>${subject}</body></html>` : `<p>${plain}</p>`;
  return { id, payload: { mimeType: 'text/html', headers: [{ name: 'Subject', value: subject }, { name: 'From', value: 'Hotel <stay@example.com>' }, { name: 'Date', value: 'Wed, 31 Mar 2027 10:00:00 +0000' }], body: { data: b64(html) } } };
}
const lodging = (ref, name, checkin) => ({ '@context': 'http://schema.org', '@type': 'LodgingReservation', reservationNumber: ref, reservationStatus: 'http://schema.org/ReservationConfirmed', reservationFor: { '@type': 'LodgingBusiness', name, address: 'Rua 1, Lisboa' }, checkinTime: `${checkin}T15:00:00+00:00`, checkoutTime: '2027-05-15T11:00:00+00:00' });

function fakeGmail(messages) {
  const calls = { search: [], full: [] };
  return {
    calls,
    messages,
    search: async (q, limit) => { calls.search.push({ q, limit }); return Object.keys(messages); },
    full: async (id) => { calls.full.push(id); if (!messages[id]) throw new Error('gone'); return messages[id]; },
  };
}
function trips(a) {
  a.storage.map.set('trip:t1', { title: 'Lisbon', start: '2027-05-12', travelers: 2, rev: 1, days: [
    { stops: [{ id: 's1', kind: 'stay', place: { name: 'Hotel Avenida' }, at: '15:00', minutes: 60, mode: 'taxi', booked: null }] },
    { stops: [] }, { stops: [] }, { stops: [] },
  ] });
  a.storage.map.set('trip:t2', { title: 'Porto', start: '2027-06-01', travelers: 1, rev: 1, days: [{ stops: [] }, { stops: [] }] });
}
const box = () => fakeGmail({
  m1: gmailMessage('m1', 'Your stay is confirmed', lodging('HX7731', 'Hotel Avenida', '2027-05-12')),
  m2: gmailMessage('m2', 'Booking for June', lodging('PQ1', 'Casa do Porto', '2027-06-01')),
  m3: gmailMessage('m3', 'Your booking reference is AB12345', null, 'Booking reference: AB12345'), // words only
  m4: gmailMessage('m4', 'Confirmed: Berlin', lodging('BE9', 'Hotel Berlin', '2027-09-01')), // in no trip
});

test('on needs confirm; Gmail not connected: on anyway and says so; off drops the job', async () => {
  const a = account();
  await assert.rejects(mailWatchOp(a, 'trip-mailwatch-on', {}), /confirm/);
  const s = await mailWatchOp(a, 'trip-mailwatch-on', { confirm: true }); // no Google grant in this account
  assert.equal(s.on, true);
  assert.equal(s.gmail.ok, false);
  assert.match(s.gmail.problem, /Connect Gmail/);
  assert.equal(s.since, new Date(T0 - MAILWATCH.firstDays * 86400_000).toISOString());
  assert.ok((await queued(a)).some((j) => j.kind === 'tmailw' && j.at <= T0 + 1000));
  // the look itself: no Gmail, no throw, the problem kept, next look in a few hours
  a.t += 2000;
  const next = await mailWatchDue(a, {});
  assert.equal(next, a.t + MAILWATCH.everyMs);
  assert.match((await mailWatchOp(a, 'trip-mailwatch-status', {})).gmail.problem, /Connect Gmail/);
  assert.deepEqual(await mailWatchOp(a, 'trip-mailwatch-off', {}), { on: false });
  assert.ok(!(await queued(a)).some((j) => j.kind === 'tmailw'));
  assert.equal((await mailWatchOp(a, 'trip-mailwatch-status', {})).on, false);
  assert.equal(await mailWatchDue(a, {}), undefined, 'off: the job goes');
});

test('a look: new mail since the last, structured bookings in a trip only, one push, the trip untouched', async () => {
  const a = account();
  trips(a);
  const mail = box();
  await mailWatchOp(a, 'trip-mailwatch-on', { confirm: true }, { mail });
  const before = JSON.stringify(await a.storage.get('trip:t1'));
  const pushes = [];
  const notify = async (_acct, p) => { pushes.push(p); };
  a.t += 5000;
  assert.equal(await mailWatchDue(a, { notify, mail }), a.t + MAILWATCH.everyMs);
  assert.equal(mail.calls.search[0].q, watchQuery(T0 - MAILWATCH.firstDays * 86400_000));
  assert.match(mail.calls.search[0].q, /after:\d+$/);
  assert.ok(!mail.calls.search[0].q.includes('newer_than'));
  // the Lisbon stay and the Porto one; not the words-only email, not Berlin (in no trip)
  const all = await mailWatchOp(a, 'trip-mail-found', {});
  assert.deepEqual(all.candidates.map((c) => [c.trip, c.booking.ref, c.match.action]).sort(), [['t1', 'HX7731', 'mark'], ['t2', 'PQ1', 'add']]);
  const lis = (await mailWatchOp(a, 'trip-mail-found', { id: 't1' })).candidates;
  assert.equal(lis.length, 1);
  assert.deepEqual(Object.keys(lis[0]).sort(), ['booking', 'found_at', 'from', 'index', 'match', 'message', 'received', 'source', 'subject', 'trip', 'trip_title']);
  assert.equal(lis[0].source, 'mail');
  assert.equal(lis[0].match.stop, 's1');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, '2 bookings found in your email');
  assert.match(pushes[0].body, /nothing was added/);
  assert.equal(pushes[0].data.kind, 'tmail');
  assert.equal(JSON.stringify(await a.storage.get('trip:t1')), before, 'never added to a trip by itself');
  // the next look: since this one (less a minute), the same emails not read again, no push for nothing new
  a.t += MAILWATCH.everyMs;
  const read = mail.calls.full.length;
  await mailWatchDue(a, { notify, mail });
  assert.equal(mail.calls.search[1].q, watchQuery(T0 + 5000 - 60_000));
  assert.equal(mail.calls.full.length, read);
  assert.equal(pushes.length, 1);
  // a new email: one more found, one push saying 1
  mail.messages.m5 = gmailMessage('m5', 'Dinner booked', { '@context': 'http://schema.org', '@type': 'FoodEstablishmentReservation', reservationNumber: 'TBL22', reservationFor: { '@type': 'FoodEstablishment', name: 'Taberna' }, startTime: '2027-05-13T20:00:00+01:00' });
  a.t += MAILWATCH.everyMs;
  await mailWatchDue(a, { notify, mail });
  assert.equal(pushes[1].title, '1 booking found in your email');
  assert.equal((await mailWatchOp(a, 'trip-mail-found', { id: 't1' })).candidates.length, 2);
});

test('found: gone once its reference is booked in the trip, dropped by the person, or the trip is gone', async () => {
  const a = account();
  trips(a);
  const mail = box();
  await mailWatchOp(a, 'trip-mailwatch-on', { confirm: true }, { mail });
  a.t += 5000;
  await mailWatchDue(a, { mail });
  const t1 = await a.storage.get('trip:t1');
  t1.days[0].stops[0].booked = { kind: 'stay', ref: 'HX7731', via: 'mail' };
  await a.storage.put('trip:t1', t1);
  assert.equal((await mailWatchOp(a, 'trip-mail-found', { id: 't1' })).candidates.length, 0);
  const [porto] = (await mailWatchOp(a, 'trip-mail-found', { id: 't2' })).candidates;
  assert.deepEqual(await mailWatchOp(a, 'trip-mailwatch-drop', { message: porto.message, index: porto.index }), { dropped: 1 });
  assert.equal((await mailWatchOp(a, 'trip-mail-found', {})).candidates.length, 0);
  await assert.rejects(mailWatchOp(a, 'trip-mail-found', { id: 'nope' }), (e) => e.status === 404);
  assert.equal((await mailWatchOp(a, 'trip-mailwatch-status', {})).found, 1, 'kept until dropped; the booked one just isn’t shown');
});

test('Gmail down mid-look: no throw, said in status, tried next time; one unreadable email is read again later', async () => {
  const a = account();
  trips(a);
  const mail = box();
  await mailWatchOp(a, 'trip-mailwatch-on', { confirm: true }, { mail });
  a.t += 5000;
  const down = { search: async () => { throw new Error('503'); }, full: async () => { throw new Error('503'); } };
  assert.equal(await mailWatchDue(a, { mail: down }), a.t + MAILWATCH.everyMs);
  const s = await mailWatchOp(a, 'trip-mailwatch-status', {});
  assert.match(s.gmail.problem, /didn’t answer/);
  assert.equal(s.since, new Date(T0 - MAILWATCH.firstDays * 86400_000).toISOString(), 'the window isn’t moved past mail never read');
  const flaky = { ...mail, full: async (id) => { if (id === 'm1') throw new Error('timeout'); return mail.full(id); } };
  await mailWatchDue(a, { mail: flaky });
  assert.ok(!(await a.storage.get('tmwseen')).includes('m1'));
  assert.equal((await mailWatchOp(a, 'trip-mail-found', { id: 't1' })).candidates.length, 0);
});

test('the alarm queue keeps the job at the next look (runAlarms with the returned time)', async () => {
  const a = account();
  a.storage.setAlarm = async () => {}; a.storage.getAlarm = async () => null;
  const mail = box();
  await mailWatchOp(a, 'trip-mailwatch-on', { confirm: true }, { mail });
  a.t += 2000;
  await runAlarms(a, { tmailw: () => mailWatchDue(a, { mail }) });
  assert.equal((await queued(a)).find((j) => j.kind === 'tmailw').at, a.t + MAILWATCH.everyMs);
});

test('tripsFor: every trip whose days cover the booking', () => {
  const t = (start, n) => ({ start, days: Array.from({ length: n }, () => ({ stops: [] })) });
  const list = [['a', t('2027-05-10', 5)], ['b', t('2027-05-12', 2)], ['c', t('2027-05-20', 2)]];
  assert.deepEqual(tripsFor(list, { date: '2027-05-12', kind: 'meal', title: 'x' }).map((x) => x.id), ['a', 'b']);
});
