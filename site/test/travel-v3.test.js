// Eden Travel v3, the server side: bookings in (pasted and forwarded emails), documents on stops, Discover and Near me,
// the group's money and chat with grounded decisions, the day measured from the hotel, step-free checks, the shorter
// order for a day and booking windows read from the venue's own site. Fake fetches only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCS, headerText, inboxOp, parseEmail, travelEmail } from '../src/travel/inbox.js';
import { listingsIn, plainWiki, wikivoyage } from '../src/travel/discover.js';
import { grounded, moneyOp, settle } from '../src/travel/money.js';
import { freeRuns, pageText } from '../src/travel/plan.js';
import { tripOp } from '../src/travel/ops.js';
import { memberOp } from '../src/travel/members.js';
import { checkTrip, stayFor } from '../src/travel/checks.js';
import { mapsFor, standinMaps } from '../src/travel/maps.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const TID = 'a1b2c3d4e5f60718';
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function account({ env = {}, trip } = {}) {
  const m = new Map();
  const clock = { t: T0 };
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix, start }) => new Map([...m].filter(([k]) => k.startsWith(prefix) && (!start || k >= start)).sort(([a], [b]) => (a < b ? -1 : 1))),
    setAlarm: async () => {},
  };
  m.set('account', { id: OWNER });
  if (trip !== null) m.set(`trip:${TID}`, trip || lisbon());
  return { m, storage, env, now: () => clock.t, clock };
}
function lisbon() {
  return {
    title: 'Lisbon', destination: 'Lisbon', start: '2026-11-28', travelers: 2, budget: { amount: 900, currency: 'EUR' }, rev: 1, created: T0, updated: T0, access: null,
    days: [
      { title: 'Day 1', stops: [
        { id: 's-air', kind: 'transport', place: { id: 'standin:lis-airport', name: 'Lisbon airport', lat: 38.7742, lng: -9.1342 }, at: '09:00', minutes: 30, mode: 'taxi', cost: null, nights: null, link: null, booked: null, note: '' },
        { id: 's-hotel', kind: 'stay', place: { id: 'standin:baixa-hotel', name: 'A hotel in Baixa', lat: 38.7118, lng: -9.1384 }, at: '11:00', minutes: 30, mode: 'taxi', cost: { amount: 300, currency: 'EUR' }, nights: 2, link: null, booked: { kind: 'stay', ref: 'H1', provider: 'Hotel', via: 'person', at: T0 }, note: '' },
      ] },
      { title: 'Day 2', stops: [
        // a zigzag: Belém, the castle, Belém again, the castle again
        { id: 's-jer', kind: 'visit', place: { id: 'standin:jeronimos', name: 'Jerónimos Monastery', lat: 38.6979, lng: -9.2068 }, at: '10:00', minutes: 60, mode: 'transit', cost: null, nights: null, link: null, booked: null, note: '' },
        { id: 's-cas', kind: 'visit', place: { id: 'standin:castle', name: 'São Jorge Castle', lat: 38.7139, lng: -9.1335 }, at: '11:30', minutes: 60, mode: 'transit', cost: null, nights: null, link: null, booked: null, note: '' },
        { id: 's-maat', kind: 'visit', place: { id: 'standin:maat', name: 'MAAT', lat: 38.6957, lng: -9.1946 }, at: '13:00', minutes: 60, mode: 'transit', cost: null, nights: null, link: null, booked: null, note: '' },
        { id: 's-carmo', kind: 'visit', place: { id: 'standin:carmo', name: 'Carmo Convent ruins', lat: 38.7120, lng: -9.1405 }, at: '14:30', minutes: 60, mode: 'transit', cost: null, nights: null, link: null, booked: null, note: '' },
        { id: 's-din', kind: 'meal', place: { id: 'standin:chiado', name: 'A restaurant in Chiado', lat: 38.7107, lng: -9.1422 }, at: '20:00', minutes: 90, mode: 'walk', cost: null, nights: null, link: null, booked: null, note: '' },
      ] },
      { title: 'Day 3', stops: [] },
    ],
  };
}

// ── bookings in ──

const LD = '<script type="application/ld+json">{"@context":"http://schema.org","@type":"FoodEstablishmentReservation","reservationNumber":"TBL-4411","reservationFor":{"@type":"FoodEstablishment","name":"Cervejaria Ramiro"},"startTime":"2026-11-29T20:30:00+00:00","partySize":2}</script>';
const EML = [
  'From: =?utf-8?Q?Cervejaria_Ram=C3=ADro?= <no-reply@ramiro.example>',
  'Subject: =?utf-8?B?WW91ciB0YWJsZSBpcyBib29rZWQg4pyU?=',
  'Date: Tue, 27 Oct 2026 10:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Your table is booked. Reservation number TBL-4411.',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  `<html><body>${LD.replace(/=/g, '=3D')}<p>See you soon=\r\n!</p></body></html>`,
  '--b1--',
  '',
].join('\r\n');

test('an email as it came: encoded headers, multipart, quoted-printable HTML', () => {
  assert.equal(headerText('=?utf-8?B?WW91ciB0YWJsZSBpcyBib29rZWQg4pyU?='), 'Your table is booked ✔');
  const e = parseEmail(EML);
  assert.equal(e.subject, 'Your table is booked ✔');
  assert.match(e.from, /^Cervejaria Ramíro </);
  assert.equal(e.date, '2026-10-27T10:00:00.000Z');
  assert.match(e.html, /"reservationNumber":"TBL-4411"/);
  assert.match(e.html, /See you soon!/);
  assert.match(e.text, /TBL-4411/);
});

test('a pasted .eml: kept, read like Eden Mail, and imported only on confirm, as "paste"', async () => {
  const a = account();
  const { paste } = await inboxOp(a, 'trip-paste', { text: EML });
  const scan = await tripOp(a, 'trip-mail-scan', { id: TID, source: 'paste', message: paste }, { maps: standinMaps(a.now) });
  assert.equal(scan.candidates.length, 1);
  const c = scan.candidates[0];
  assert.equal(c.source, 'paste');
  assert.equal(c.booking.ref, 'TBL-4411');
  assert.deepEqual(c.match, { action: 'mark', stop: 's-din', day: 1 }, 'the dinner that day, by its kind');
  await assert.rejects(tripOp(a, 'trip-mail-import', { id: TID, source: 'paste', message: paste, index: 0 }, { maps: standinMaps(a.now) }), /confirm/);
  const out = await tripOp(a, 'trip-mail-import', { id: TID, source: 'paste', message: paste, index: 0, confirm: true }, { maps: standinMaps(a.now) });
  const stop = out.trip.days[1].stops.find((s) => s.id === out.stop);
  assert.equal(out.stop, 's-din');
  assert.equal(stop.booked.via, 'paste');
  assert.equal(stop.booked.ref, 'TBL-4411');
  // a booking for a day with no such stop is added, with where it came from
  const add = await tripOp(a, 'trip-mail-import', { id: TID, source: 'paste', message: (await inboxOp(a, 'trip-paste', { text: EML.replace('2026-11-29', '2026-11-30') })).paste, index: 0, confirm: true }, { maps: standinMaps(a.now) });
  const added = add.trip.days[2].stops.find((s) => s.id === add.stop);
  assert.equal(added.at, '20:30');
  assert.match(added.note, /^From your pasted confirmation/);
  // plain text pasted (no headers): kept as the person's text
  const p2 = await inboxOp(a, 'trip-paste', { text: 'Booking reference: ABC123' });
  assert.equal(a.m.get(`tpaste:${p2.paste}`).from, 'You');
  await assert.rejects(inboxOp(a, 'trip-paste', { text: '  ' }), /Paste/);
});

test('an imported flight puts its number and route in the stop, so it is tracked live', async () => {
  const a = account();
  const ld = '<script type="application/ld+json">{"@type":"FlightReservation","reservationNumber":"XKQ7PL","reservationFor":{"@type":"Flight","flightNumber":"1351","airline":{"@type":"Airline","name":"TAP Air Portugal","iataCode":"TP"},"departureAirport":{"@type":"Airport","iataCode":"LHR"},"arrivalAirport":{"@type":"Airport","iataCode":"LIS"},"departureTime":"2026-11-28T07:00:00+00:00"}}</script>';
  const { paste } = await inboxOp(a, 'trip-paste', { text: 'x', html: ld });
  const out = await tripOp(a, 'trip-mail-import', { id: TID, source: 'paste', message: paste, index: 0, confirm: true }, { maps: standinMaps(a.now) });
  const s = out.trip.days[0].stops.find((x) => x.id === 's-air');
  assert.equal(out.stop, 's-air');
  assert.match(s.note, /^TP1351 LHR → LIS/);
  assert.equal(s.booked.ref, 'XKQ7PL');
});

test('the forwarding address: one per account, the index claimed, a new one on reset', async () => {
  const claims = [];
  const env = { TRAVEL_INBOX_DOMAIN: 'askedentravel.com', ACCOUNTS: { idFromName: (n) => n, get: (n) => ({ fetch: async (u, i) => { claims.push([n, u.split('/').pop(), JSON.parse(i.body)]); return jsonRes({ ok: true }); } }) } };
  const a = account({ env });
  const one = await inboxOp(a, 'trip-inbox-address', {});
  assert.match(one.address, /^trips\+[a-z0-9]{12}@askedentravel\.com$/);
  assert.equal(one.on, true);
  assert.deepEqual((await inboxOp(a, 'trip-inbox-address', {})).address, one.address, 'the same address again');
  assert.equal(claims.length, 1);
  assert.match(claims[0][0], /^tin:/);
  const two = await inboxOp(a, 'trip-inbox-reset', { confirm: true });
  assert.notEqual(two.address, one.address);
  assert.ok(claims.some(([, op]) => op === 'tshare-index-drop'), 'the old code dropped');
});

test('a forwarded email: the right code only; kept, pruned to 30, and pushed', async () => {
  const pushed = [];
  const a = account();
  a.m.set('tinaddr', { code: 'abcdefghij12' });
  await assert.rejects(inboxOp(a, 'tinbox-add', { code: 'zzzzzzzzzz12', email: parseEmail(EML) }), /No such/);
  await inboxOp(a, 'tinbox-add', { code: 'abcdefghij12', email: parseEmail(EML) }, { notify: async (_a, n) => pushed.push(n) });
  assert.equal(pushed[0].title, 'Booking email received');
  for (let i = 0; i < 32; i++) { a.clock.t += 3 * 3600_000; await inboxOp(a, 'tinbox-add', { code: 'abcdefghij12', email: { subject: `n${i}` } }); } // 8 a day: under the daily cap
  assert.equal([...a.m.keys()].filter((k) => k.startsWith('tinbox:')).length, 30);
  const scan = await tripOp(a, 'trip-mail-scan', { id: TID, source: 'inbox' }, { maps: standinMaps(a.now) });
  assert.ok(Array.isArray(scan.candidates));
});

test('a forwarded email (security review L3): 20 a day per address; the push never carries the subject; the sender checked, not blocked', async () => {
  const pushed = [];
  const a = account();
  a.m.set('tinaddr', { code: 'abcdefghij12' });
  a.m.set('identities', [{ provider: 'google', email: 'me@example.com' }]);
  const add = (email, extra = {}) => inboxOp(a, 'tinbox-add', { code: 'abcdefghij12', email, ...extra }, { notify: async (_a, n) => pushed.push(n) });
  await add({ subject: 'Your booking ✈ PNR X1 — click http://evil.example', from: 'Stranger <who@evil.example>' }, { auth: { dkim: 'fail', spf: 'none', dmarc: 'fail <script>' } });
  assert.doesNotMatch(pushed[0].body, /PNR|evil|click/);
  assert.match(pushed[0].body, /isn’t on your Eden account/);
  const kept = [...a.m].find(([k]) => k.startsWith('tinbox:'))[1];
  assert.deepEqual(kept.sender, { known: false, auth: { dkim: 'fail', spf: 'none', dmarc: null } });
  await add({ subject: 'Hotel', from: 'Me <ME@example.com>' });
  assert.match(pushed[1].body, /An email you forwarded/);
  for (let i = 2; i < 20; i++) await add({ subject: `n${i}` });
  await assert.rejects(add({ subject: 'one too many' }), (e) => e.status === 429);
  assert.equal(pushed.length, 20);
  a.clock.t += 86400_000;
  await add({ subject: 'next day' });
  assert.equal(pushed.length, 21);
});

test('authOf and addressOf read Authentication-Results and From lines', async () => {
  const { authOf, addressOf } = await import('../src/travel/inbox.js');
  assert.deepEqual(authOf('mx.cloudflare.net; dkim=pass header.d=ba.com; spf=softfail; dmarc=pass'), { dkim: 'pass', spf: 'softfail', dmarc: 'pass' });
  assert.deepEqual(authOf(null), { dkim: null, spf: null, dmarc: null });
  assert.equal(addressOf('BA <Bookings@BA.com>'), 'bookings@ba.com');
});

test('the email handler: unknown or malformed addresses refused; a known one handed to its account', async () => {
  const rejects = [];
  const asked = [];
  const env = { ACCOUNTS: { idFromName: (n) => n, get: (n) => ({ fetch: async (u, i) => {
    const op = u.split('/').pop();
    asked.push([n, op]);
    if (op === 'tshare-index-get') return n === 'tin:abcdefghij12' ? jsonRes({ account: OWNER }) : jsonRes({ error: 'no' }, 404);
    return jsonRes({ kept: true });
  } }) } };
  const msg = (to) => ({ to, from: 'x@y.example', rawSize: EML.length, raw: new Response(EML).body, setReject: (r) => rejects.push(r) });
  await travelEmail(msg('someone@askedentravel.com'), env);
  await travelEmail(msg('trips+nope@askedentravel.com'), env);
  await travelEmail(msg('trips+zzzzzzzzzz12@askedentravel.com'), env);
  assert.equal(rejects.length, 3);
  await travelEmail(msg('trips+abcdefghij12@askedentravel.com'), env);
  assert.equal(rejects.length, 3);
  assert.deepEqual(asked.at(-1), [OWNER, 'tinbox-add']);
});

// ── documents ──

const pdf = (n) => { const b = new Uint8Array(n); b.set([0x25, 0x50, 0x44, 0x46, 0x2d]); for (let i = 5; i < n; i++) b[i] = i % 251; return b; };
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); };

test('documents: checked by their bytes, chunked, read back whole, gone with the trip', async () => {
  const a = account();
  const big = pdf(Math.round(DOCS.chunk * 2.5));
  const { doc } = await inboxOp(a, 'trip-doc-add', { id: TID, stop: 's-hotel', name: 'Booking.pdf', type: 'application/pdf', data: b64(big) });
  assert.equal(doc.chunks, 3);
  assert.equal(doc.stop, 's-hotel');
  const got = await inboxOp(a, 'trip-doc-get', { id: TID, doc: doc.id });
  assert.equal(got.data, b64(big));
  await assert.rejects(inboxOp(a, 'trip-doc-add', { id: TID, name: 'x', type: 'application/pdf', data: btoa('<html>not a pdf') }), /isn’t the kind/);
  await assert.rejects(inboxOp(a, 'trip-doc-add', { id: TID, name: 'x', type: 'text/html', data: btoa('<html>') }), /PDF/);
  await assert.rejects(inboxOp(a, 'trip-doc-add', { id: TID, stop: 's-nope', name: 'x', type: 'application/pdf', data: b64(pdf(10)) }), /no such stop/);
  assert.equal((await inboxOp(a, 'trip-docs', { id: TID })).docs.length, 1);
  await tripOp(a, 'trip-delete', { id: TID }, { maps: standinMaps(a.now) });
  assert.equal([...a.m.keys()].filter((k) => k.startsWith('tdoc')).length, 0);
});

// ── Discover ──

const WIKI_MAIN = `Lisbon is the capital. Districts: [[Lisbon/Belém|Belém]] and [[Lisbon/Alfama]].
==See==
* {{see
| name=[[Castelo de São Jorge|São Jorge Castle]] | alt=Castelo | url=http://castelodesaojorge.pt | lat=38.7139 | long=-9.1335
| hours=Daily 09:00-21:00 | price=€15 | lastedit=2025-04-02
| content=The castle on the hill, with views over {{station|Baixa|M}} and the river. ''Go early.''
}}
* {{listing | type=eat | name=Cervejaria Ramiro | lat=38.72 | long=-9.135 | content=Seafood.}}`;
const WIKI_BELEM = `==See==\n* {{see | name=Jerónimos Monastery | lat=38.6979 | long=-9.2068 | content=Manueline.}}\n* {{see | name=São Jorge Castle | content=dup}}`;

test('Wikivoyage listings: the kind asked for, plain words, coordinates and when it was edited', () => {
  const see = listingsIn(WIKI_MAIN, 'see');
  assert.equal(see.length, 1);
  assert.deepEqual({ ...see[0], about: undefined }, { name: 'São Jorge Castle', alt: 'Castelo', lat: 38.7139, lng: -9.1335, url: 'https://castelodesaojorge.pt', about: undefined, address: null, hours_note: 'Daily 09:00-21:00', price_note: '€15', edited: '2025-04-02' });
  assert.equal(see[0].about, 'The castle on the hill, with views over Baixa and the river. Go early.');
  assert.equal(listingsIn(WIKI_MAIN, 'eat')[0].name, 'Cervejaria Ramiro');
  assert.equal(plainWiki('[[a|b]] {{m2|140000}}'), 'b 140000 m²');
});

test('Wikivoyage for a destination: its article and districts, no duplicates, with the licence', async () => {
  const pages = { Lisbon: WIKI_MAIN, 'Lisbon/Belém': WIKI_BELEM, 'Lisbon/Alfama': '' };
  const seen = [];
  const fetch = async (u, init) => {
    const page = new URL(u).searchParams.get('page');
    seen.push([page, init.headers['User-Agent']]);
    return page in pages ? jsonRes({ parse: { title: page, wikitext: pages[page] } }) : jsonRes({ error: { code: 'missingtitle' } });
  };
  const w = await wikivoyage('Lisbon, Portugal', 'see', { fetch, now: T0 });
  assert.deepEqual(w.places.map((p) => [p.name, p.page]), [['São Jorge Castle', 'Lisbon'], ['Jerónimos Monastery', 'Lisbon/Belém']]);
  assert.equal(w.licence.name, 'CC BY-SA 4.0');
  assert.match(w.places[1].page_url, /^https:\/\/en\.wikivoyage\.org\/wiki\/Lisbon\/Bel%C3%A9m$/);
  assert.match(seen[0][1], /^EdenTravel\//);
  assert.equal(await wikivoyage('Nowhere', 'see', { fetch, now: T0 }), null);
});

test('Near me: Google places open now within the walk, nearest first; closed and too far left out', async () => {
  const calls = [];
  const place = (id, name, lat, open) => ({ id, displayName: { text: name }, location: { latitude: lat, longitude: -9.14 }, businessStatus: 'OPERATIONAL', rating: 4.5, userRatingCount: 900, currentOpeningHours: { openNow: open } });
  const fetch = async (u, init) => {
    const body = JSON.parse(init.body);
    calls.push([u, init.headers['X-Goog-FieldMask'], body]);
    if (u === 'https://places.googleapis.com/v1/places:searchNearby') return jsonRes({ places: [place('PLACEaaaaaaaa1', 'Near open', 38.711, true), place('PLACEaaaaaaaa2', 'Closed', 38.7112, false), place('PLACEaaaaaaaa3', 'Far', 38.72, true)] });
    return jsonRes([{ originIndex: 0, destinationIndex: 0, duration: '300s', distanceMeters: 400, condition: 'ROUTE_EXISTS' }, { originIndex: 0, destinationIndex: 1, duration: '360s', condition: 'ROUTE_EXISTS' }, { originIndex: 0, destinationIndex: 2, duration: '1500s', condition: 'ROUTE_EXISTS' }]);
  };
  const a = account({ env: { GOOGLE_MAPS_SERVER_KEY: 'k' } });
  const out = await tripOp(a, 'trip-nearby', { lat: 38.71, lng: -9.14, kind: 'eat', minutes: 15 }, { fetch });
  assert.deepEqual(out.places.map((p) => [p.name, p.walk_minutes, p.open_now]), [['Near open', 5, true]]);
  assert.equal(out.source, 'Google Maps (Places and Routes APIs)');
  assert.deepEqual(calls[0][2].includedTypes, ['restaurant']);
  assert.match(calls[0][1], /places\.currentOpeningHours\.openNow/);
  assert.equal(calls[1][2].travelMode, 'WALK');
  await tripOp(a, 'trip-nearby', { lat: 38.71, lng: -9.14, kind: 'eat', minutes: 15 }, { fetch });
  assert.equal(calls.length, 2, 'the same spot a minute later: from the cache');
  await assert.rejects(tripOp(a, 'trip-nearby', { lat: 'x', lng: 1, kind: 'eat' }, { fetch }), /Where are you/);
  await assert.rejects(tripOp(a, 'trip-nearby', { lat: 1, lng: 1, kind: 'shop' }, { fetch }), /kind/);
});

// ── money ──

test('settle: the fewest payments, exact to the cent', () => {
  assert.deepEqual(settle([{ id: 'a', cents: 9000 }, { id: 'b', cents: -3000 }, { id: 'c', cents: -6000 }]), [{ from: 'c', to: 'a', cents: 6000 }, { from: 'b', to: 'a', cents: 3000 }]);
  assert.deepEqual(settle([{ id: 'a', cents: 0 }]), []);
});

test('money: bookings count as the organiser’s, other currencies at the ECB rate, shares add up, members only delete their own', async () => {
  const a = account();
  a.m.set(`tmem:${TID}:${MEMBER}`, { member: MEMBER, name: 'Sam', joined: T0 });
  const fx = [];
  const fetch = async (u) => { fx.push(u); return jsonRes({ base: 'EUR', date: '2026-10-28', rates: { GBP: 0.8, USD: 1.25 } }); };
  const deps = { maps: standinMaps(a.now), fetch };
  await tripOp(a, 'trip-people', { id: TID, owner_name: 'Bilel', add_guest: 'Alex' }, deps);
  const people = (await tripOp(a, 'trip-money', { id: TID }, deps)).people;
  assert.deepEqual(people.map((p) => [p.name, p.kind]), [['Bilel', 'organiser'], ['Sam', 'member'], ['Alex', 'guest']]);
  const alex = people[2].id;
  await tripOp(a, 'trip-expense-add', { id: TID, what: 'Dinner', amount: 80, currency: 'GBP', paid_by: MEMBER }, deps); // 100 EUR
  await tripOp(a, 'trip-expense-add', { id: TID, what: 'Taxi', amount: 10, currency: 'EUR', paid_by: alex, split: [alex, MEMBER] }, deps);
  await assert.rejects(tripOp(a, 'trip-expense-add', { id: TID, what: 'x', amount: 5, paid_by: 'g-nobody00' }, deps), /paid_by/);
  const m = await tripOp(a, 'trip-money', { id: TID }, deps);
  assert.equal(m.currency, 'EUR');
  assert.equal(m.total, 410, 'the 300 EUR hotel booking + 100 + 10');
  assert.equal(m.expenses[0].booking, true);
  assert.equal(m.expenses.find((x) => x.what === 'Dinner').in_trip_currency, 100);
  assert.equal(Math.round(m.shares.reduce((n, s) => n + s.amount * 100, 0)), 41000);
  assert.equal(Math.abs(Math.round(m.balances.reduce((n, b) => n + b.amount * 100, 0))), 0);
  assert.equal(m.rates.date, '2026-10-28');
  assert.match(m.rates.source, /European Central Bank/);
  assert.match(fx[0], /base=EUR$/);
  // the member: adds as themselves, can't delete the organiser's
  const theirs = await tripOp(a, 'trip-expense-add', { id: TID, what: 'Coffee', amount: 4 }, { ...deps, by: MEMBER });
  assert.equal(theirs.expense.paid_by, MEMBER);
  const own = m.expenses.find((x) => x.what === 'Taxi').id;
  await assert.rejects(tripOp(a, 'trip-expense-delete', { id: TID, expense: own }, { ...deps, by: MEMBER }), /Only whoever added it/);
  assert.deepEqual(await tripOp(a, 'trip-expense-delete', { id: TID, expense: theirs.expense.id }, { ...deps, by: MEMBER }), { deleted: true });
  await assert.rejects(tripOp(a, 'trip-people', { id: TID, add_guest: 'Eve' }, { ...deps, by: MEMBER }), /organiser/);
  await assert.rejects(tripOp(a, 'trip-people', { id: TID, remove_guest: alex }, deps), /in an expense/);
});

test('money: no rates → other currencies left out and said so', async () => {
  const a = account();
  const deps = { maps: standinMaps(a.now), fetch: async () => jsonRes({}, 500) };
  await tripOp(a, 'trip-expense-add', { id: TID, what: 'Gift', amount: 20, currency: 'USD' }, deps);
  const m = await tripOp(a, 'trip-money', { id: TID }, deps);
  assert.equal(m.total, 300);
  assert.equal(m.expenses[1].unconverted, true);
  assert.match(m.rates_missing, /didn’t load/);
});

test('the chat, and members through the organiser’s object: as themselves, only while on the trip', async () => {
  const a = account();
  a.m.set(`tmem:${TID}:${MEMBER}`, { member: MEMBER, name: 'Sam', joined: T0 });
  const op = (o, b, d = {}) => tripOp(a, o, b, { maps: standinMaps(a.now), ...d });
  await op('trip-chat-post', { id: TID, text: 'Shall we do Sintra on Sunday?' });
  a.clock.t += 1000;
  const posted = await memberOp(a, 'tmember-chat-post', { trip: TID, member: MEMBER, text: 'Yes, Sintra on Sunday works for me', by: OWNER }, { tripOp: (x, o, b, d) => tripOp(x, o, b, { maps: standinMaps(a.now), ...d }) });
  assert.equal(posted.message.by, MEMBER, 'a forged `by` is ignored');
  assert.equal(posted.message.name, 'Sam');
  const chat = await op('trip-chat', { id: TID });
  assert.deepEqual(chat.messages.map((x) => x.name), ['Organiser', 'Sam']);
  const after = await op('trip-chat', { id: TID, after: chat.messages[0].id });
  assert.deepEqual(after.messages.map((x) => x.name), ['Sam']);
  await assert.rejects(memberOp(a, 'tmember-chat', { trip: TID, member: '33333333-3333-4333-8333-333333333333' }, { tripOp }), /not on this trip/);
});

test('decisions: only lines whose quote is in the message they cite; kept until a new message', async () => {
  const msgs = new Map([['m1', { id: 'm1', text: 'Let’s book Ramiro for Saturday night.' }], ['m2', { id: 'm2', text: 'Not sure about Sintra.' }]]);
  assert.deepEqual(grounded([
    { text: 'Ramiro on Saturday', message: 'm1', quote: "let's book Ramiro" },
    { text: 'Made up', message: 'm1', quote: 'book the Ritz' },
    { text: 'No such message', message: 'm9', quote: 'Sintra' },
  ], msgs).map((l) => l.text), ['Ramiro on Saturday']);

  const a = account({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
  let asked = 0;
  const fetch = async (u, init) => {
    asked++;
    const user = JSON.parse(init.body).messages[0].content;
    const id = /\n(\w+) · Sam · /.exec(user)[1];
    return jsonRes({ model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: JSON.stringify({ decisions: [{ text: 'Sintra on Sunday', message: id, quote: 'Sintra on Sunday works' }, { text: 'Invented', message: id, quote: 'the Ritz' }], open: [] }) }] });
  };
  const deps = { maps: standinMaps(a.now), fetch };
  a.m.set(`tmem:${TID}:${MEMBER}`, { member: MEMBER, name: 'Sam', joined: T0 });
  await tripOp(a, 'trip-chat-post', { id: TID, text: 'Yes, Sintra on Sunday works for me' }, { ...deps, by: MEMBER });
  const d = await tripOp(a, 'trip-decisions', { id: TID }, deps);
  assert.deepEqual(d.decisions.map((x) => x.text), ['Sintra on Sunday']);
  assert.equal(d.dropped, 1);
  await tripOp(a, 'trip-decisions', { id: TID }, deps);
  assert.equal(asked, 1, 'no new message: the kept answer');
});

// ── the day from the hotel, step-free ──

test('the day measured from the hotel: out in the morning, back at night; arrival day back only', async () => {
  const trip = lisbon();
  assert.equal(stayFor(trip, 1).id, 's-hotel');
  assert.equal(stayFor(trip, 1).arrival, false);
  assert.equal(stayFor(trip, 0).arrival, true);
  const c = await checkTrip(trip, standinMaps(() => T0));
  const a1 = c.days[1].anchor;
  assert.equal(a1.stay, 'A hotel in Baixa');
  assert.equal(a1.to, 's-jer');
  assert.equal(a1.from, 's-din');
  assert.equal(a1.out.status, 'sample');
  assert.ok(a1.out.minutes > 0 && a1.back.minutes > 0);
  // a trip with no stay: no anchor
  const bare = lisbon();
  bare.days[0].stops.splice(1, 1);
  assert.equal((await checkTrip(bare, standinMaps(() => T0))).days[1].anchor, null);
});

test('step-free: entrances as Google lists them (yes, no, not said) and less-walking transit', async () => {
  const bodies = [];
  const ACCESS = { PLACEbbbbbbbb1: { wheelchairAccessibleEntrance: true }, PLACEbbbbbbbb2: { wheelchairAccessibleEntrance: false }, PLACEbbbbbbbb3: undefined };
  const fetch = async (u, init) => {
    if (u.includes('/places/')) { const id = u.split('/').pop(); return jsonRes({ id, displayName: { text: id }, businessStatus: 'OPERATIONAL', accessibilityOptions: ACCESS[id] }); }
    bodies.push(JSON.parse(init.body));
    return jsonRes({ routes: [{ duration: '600s', distanceMeters: 900 }] });
  };
  const maps = mapsFor({ GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch, now: () => T0 });
  const stop = (id, at) => ({ id: `s-${id.slice(-1)}`, kind: 'visit', place: { id, name: id, lat: 38.71, lng: -9.14 }, at, minutes: 60, mode: 'transit', cost: null, booked: null });
  const trip = { start: '2026-11-28', travelers: 1, access: { step_free: true }, days: [{ stops: [stop('PLACEbbbbbbbb1', '10:00'), stop('PLACEbbbbbbbb2', '12:00'), stop('PLACEbbbbbbbb3', '14:00')] }] };
  const c = await checkTrip(trip, maps);
  assert.deepEqual(c.days[0].stops.map((s) => s.badges.access.status), ['ok', 'warn', 'look']);
  assert.ok(c.alerts.some((x) => x.kind === 'access'));
  assert.deepEqual(bodies[0].transitPreferences, { routingPreference: 'LESS_WALKING' });
  trip.access = null;
  const plain = await checkTrip(trip, maps);
  assert.equal(plain.days[0].stops[0].badges.access, undefined);
});

test('trip-update keeps the step-free setting', async () => {
  const a = account();
  const out = await tripOp(a, 'trip-update', { id: TID, access: { step_free: true } }, { maps: standinMaps(a.now) });
  assert.deepEqual(out.trip.access, { step_free: true });
  assert.ok(out.checks.days[1].stops[0].badges.access);
});

// ── a shorter order, booking windows ──

test('free runs: sights and activities that aren’t booked, between the fixed stops', () => {
  const runs = freeRuns(lisbon().days[1].stops);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].run.map((s) => s.id), ['s-jer', 's-cas', 's-maat', 's-carmo']);
  assert.equal(runs[0].after.id, 's-din');
});

test('optimize: the zigzag day becomes a proposal that saves time and fits the hours; nothing changes until applied', async () => {
  const a = account();
  const deps = { maps: standinMaps(a.now) };
  const out = await tripOp(a, 'trip-optimize', { id: TID, day: 1 }, deps);
  assert.ok(out.saved_minutes >= 5, `saved ${out.saved_minutes}`);
  assert.equal(out.proposal.by, 'eden');
  assert.match(out.proposal.title, /^Reorder day 2 to save \d+ min$/);
  const order = out.preview.trip.days[1].stops.map((s) => s.id);
  assert.ok(Math.abs(order.indexOf('s-jer') - order.indexOf('s-maat')) === 1, `Belém together: ${order}`);
  assert.equal(order.at(-1), 's-din', 'dinner stays put');
  assert.equal(a.m.get(`trip:${TID}`).days[1].stops[1].id, 's-cas', 'the trip itself unchanged');
  const again = await tripOp(a, 'trip-optimize', { id: TID, day: 0 }, deps);
  assert.equal(again.saved_minutes, 0);
  assert.match(again.why, /Nothing to reorder/);
});

test('booking windows: only a rule the venue’s own page states, quoted; else "not found"', async () => {
  const site = '<html><body><nav><a href="/en/tickets">Tickets</a><a href="https://other.example/book">x</a></nav><p>Welcome</p></body></html>';
  const tickets = '<html><body><script>var x=1</script><h1>Tickets</h1><p>Online booking opens 60 days in advance, at 10:00 Lisbon time.</p></body></html>';
  const answers = [];
  const fetch = async (u, init) => {
    if (u.includes('/places/')) return jsonRes({ id: 'PLACEccccccccc1', displayName: { text: 'Belcanto' }, businessStatus: 'OPERATIONAL', websiteUri: 'http://belcanto.example/' });
    if (u.startsWith('https://belcanto.example/en/tickets')) return new Response(tickets, { headers: { 'content-type': 'text/html' } });
    if (u.startsWith('https://belcanto.example/')) return new Response(site, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (u.includes('anthropic')) {
      const v = answers.shift();
      return jsonRes({ model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify(v) }] });
    }
    throw new Error(`unexpected ${u}`);
  };
  const a = account({ env: { ANTHROPIC_API_KEY: 'sk', GOOGLE_MAPS_SERVER_KEY: 'k' } });
  a.m.get(`trip:${TID}`).days[1].stops[4].place.id = 'PLACEccccccccc1';
  answers.push({ found: true, page: 1, quote: 'Online booking opens 60 days in advance, at 10:00 Lisbon time.', rule: '60 days ahead at 10:00', days_ahead: 60, opens_at: '10:00' });
  const w = await tripOp(a, 'trip-windows', { id: TID, stop: 's-din' }, { fetch });
  assert.equal(w.found, true);
  assert.equal(w.opens_on, '2026-09-30', '60 days before 29 November');
  assert.equal(w.opens_at, '10:00');
  assert.equal(w.url, 'https://belcanto.example/en/tickets');
  assert.equal((await tripOp(a, 'trip-windows', { id: TID, stop: 's-din' }, { fetch })).found, true, 'kept a week');
  // a quote that isn't on the page: not shown
  a.m.delete(`twin:${TID}:s-din`);
  answers.push({ found: true, page: 1, quote: 'Bookings open 90 days ahead.', rule: '90 days', days_ahead: 90, opens_at: null });
  const no = await tripOp(a, 'trip-windows', { id: TID, stop: 's-din' }, { fetch });
  assert.equal(no.found, false);
  assert.match(no.why, /doesn’t say plainly/);
  // stand-in places: no website
  assert.equal((await tripOp(a, 'trip-windows', { id: TID, stop: 's-jer' }, { fetch })).found, false);
  assert.equal(pageText('<p>a&nbsp;b</p><script>x</script>'), 'a b');
});
