// "Plus covers your companions": what a person on a Plus member's trip (members.js) gets on that trip because the
// organiser has Plus, said plainly, and the one piece that was missing: flight changes on the member's own phone.
//
// What's covered was read from the code (2026-10-28), not assumed: every member action goes to the organiser's object
// (account.js `tmember-*`, refused when the organiser's Plus has ended), so it runs on the organiser's Plus. A copy of
// the trip is made in the member's own account, so it needs their own Plus; the stop pictures and the destination photo
// (api.js /photo, /hero-image) check the member's own Plus today, a gap listed in COVERS.
//
// Flight alerts for members: off unless the member turns them on for that trip. The organiser's flight watch (watch.js)
// hands each change to memberFlightNews, which asks only the members who turned them on; the member's own object then
// checks its own pointer (they're still on the trip, alerts on) and pushes to their own phone. What goes is only what the
// trip already shows them: the flight number, the change (delay, gate, terminal, cancelled, diverted), the trip's title.
// Never the organiser's bookings, references, cards or other trips.
//
//   member (Worker, signed in):  shared-plus-covers { owner, trip } → { covers, alerts, memories_shared }
//                                shared-alerts { owner, trip, on } → { alerts }
//   organiser (trip op):         trip-plus-covers { id } → { covers, members: [{ name, alerts }], memories_shared }
//   organiser's object, from the Worker: tmember-covers { trip, member } · tmember-alerts { trip, member, on }
//                                tmember-read { trip, member } → { trip, money } (no checks: for the year in review)
//   member's object, from the organiser's object: tjoin-flight-news { owner, trip, title, body, data }
//   member's own object, signed in: trip-joined-alerts { owner, trip, on } (their consent, on their pointer)

import { ApiError } from '../accounts/util.js';
import { ask as askDefault } from './track.js';

export const ALERTS = { perDay: 40, title: 120, body: 400 };
const TRIP_ID = /^[0-9a-f]{16}$/;
const ACCOUNT = /^[0-9a-f-]{36}$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Each feature on a shared trip: covered 'yes' (the organiser's Plus), 'shared' (yes, while the organiser shares it),
 * 'opt_in' (yes, when the member turns it on), 'own' (the member's own Plus), 'no' (not for members).
 */
export const COVERS = [
  { key: 'trip', name: 'The whole trip', covered: 'yes', how: 'Every day, stop, check and booking status, as the organiser sees it (never their cards or booking references).', via: 'shared-get' },
  { key: 'suggest', name: 'Suggest changes', covered: 'yes', how: 'Ask Eden makes the change as a suggestion; the organiser decides.', via: 'shared-propose' },
  { key: 'chat', name: 'Trip chat and decisions', covered: 'yes', how: 'The group’s chat, and what was agreed, each line quoting its message.', via: 'shared-chat' },
  { key: 'money', name: 'Money and settle-up', covered: 'yes', how: 'Add what you paid, see your share and who owes whom, at the European Central Bank’s rates.', via: 'shared-money' },
  { key: 'discover', name: 'Discover and Near me', covered: 'yes', how: 'Ideas for the trip; adding one sends it to the organiser as a suggestion.', via: 'shared-discover' },
  { key: 'presence', name: 'Who’s looking now', covered: 'yes', how: 'Who else has the trip open, and on which day.', via: 'shared-presence-beat' },
  { key: 'memories', name: 'Memories and photos', covered: 'shared', how: 'The recap and the group’s photos, while the organiser shares them. Your photos count against the organiser’s space.', via: 'shared-memories' },
  { key: 'alerts', name: 'Flight changes on your phone', covered: 'opt_in', how: 'Delays, gate and terminal changes, cancellations on this trip’s flights, pushed to your own phone when you turn it on.', via: 'shared-alerts' },
  { key: 'copy', name: 'Copy the trip as your own', covered: 'own', how: 'The copy is your own trip, in your account, so it needs your own Plus.', via: 'shared-copy' },
  { key: 'pictures', name: 'Stop pictures and the destination photo', covered: 'own', how: 'Not covered yet: these pictures check your own Plus.', via: null, gap: true },
  { key: 'book', name: 'Booking and the organiser’s cards', covered: 'no', how: 'Only the organiser books on their account and sees their cards.', via: null },
];

const covers = ({ memoriesShared, alerts }) => COVERS.map((c) => ({
  ...c,
  on: c.covered === 'yes' ? true : c.covered === 'shared' ? Boolean(memoriesShared) : c.covered === 'opt_in' ? Boolean(alerts) : false,
}));

async function membership(account, trip, member) {
  if (!TRIP_ID.test(String(trip || '')) || !ACCOUNT.test(String(member || ''))) throw new ApiError(404, 'not_found', 'No such shared trip.');
  const m = await account.storage.get(`tmem:${trip}:${member}`);
  if (!m) throw new ApiError(404, 'not_found', 'You’re not on this trip any more.');
  return m;
}
const memoriesShared = async (storage, trip) => Boolean(((await storage.get(`tmemo:${trip}`)) || {}).share);

/* ---------- the organiser's side ---------- */

/** trip-plus-covers { id } (signed in, the organiser's own object). */
export async function coversOp(account, op, body) {
  if (op !== 'trip-plus-covers') throw new ApiError(404, 'not_found', 'Not found');
  const id = String(body.id || '');
  if (!TRIP_ID.test(id) || !(await account.storage.get(`trip:${id}`))) throw new ApiError(404, 'not_found', 'There is no such trip.');
  const members = [...(await account.storage.list({ prefix: `tmem:${id}:` })).values()].map((m) => ({ name: m.name, alerts: Boolean(m.alerts) }));
  const shared = await memoriesShared(account.storage, id);
  return { covers: covers({ memoriesShared: shared, alerts: false }).map(({ on: _o, ...c }) => c), members, memories_shared: shared };
}

/** The organiser's object, asked by the Worker for a member (account.js routes tmember-covers, -alerts, -read here). */
export async function coversMemberOp(account, op, body, { tripOp } = {}) {
  const member = String(body.member || '');
  const m = await membership(account, body.trip, member);
  const key = `tmem:${body.trip}:${member}`;
  if (op === 'tmember-covers') {
    const shared = await memoriesShared(account.storage, body.trip);
    return { covers: covers({ memoriesShared: shared, alerts: m.alerts }), alerts: Boolean(m.alerts), memories_shared: shared };
  }
  if (op === 'tmember-alerts') {
    await account.storage.put(key, { ...m, alerts: body.on === true });
    return { alerts: body.on === true };
  }
  if (op === 'tmember-read') {
    // the trip alone (no checks: each can be a paid lookup) and the money as this member sees it
    const trip = await account.storage.get(`trip:${body.trip}`);
    if (!trip) throw new ApiError(404, 'not_found', 'This trip was deleted.');
    const money = tripOp ? await tripOp(account, 'trip-money', { id: body.trip }, { by: member }).catch(() => null) : null;
    return { trip: { id: body.trip, ...trip }, money, you: member };
  }
  throw new ApiError(404, 'not_found', 'Not found');
}

/**
 * A flight change on the organiser's trip, handed on to the members who turned alerts on (watch.js, after the
 * organiser's own push). `f`: { trip, stop, ident, title } as watch.js flightStops gives it; `news`: [{ title, body }].
 * Only while the organiser has Plus (`plus`). Returns how many members were asked.
 */
export async function memberFlightNews(account, f, news, { plus = true, ask = askDefault } = {}) {
  if (!plus || !news || !news.length) return 0;
  const owner = ((await account.storage.get('account')) || {}).id;
  if (!owner) return 0;
  const on = [...(await account.storage.list({ prefix: `tmem:${f.trip}:` })).values()].filter((m) => m.alerts && ACCOUNT.test(String(m.member)));
  let asked = 0;
  for (const m of on) {
    for (const n of news) {
      await ask(account.env, m.member, 'tjoin-flight-news', { owner, trip: f.trip, title: clean(n.title, ALERTS.title), body: clean(n.body, ALERTS.body), data: { kind: 'flight', ident: f.ident, shared: { owner, trip: f.trip } } })
        .catch((e) => console.error('member flight alert', e && e.message));
    }
    asked += 1;
  }
  return asked;
}

/* ---------- the member's own object ---------- */

/** trip-joined-alerts (signed in, the member) and tjoin-flight-news (from the organiser's object, no device). */
export async function joinedAlertsOp(account, op, body, { notify } = {}) {
  const key = `tjoin:${String(body.owner || '')}:${String(body.trip || '')}`;
  if (!ACCOUNT.test(String(body.owner || '')) || !TRIP_ID.test(String(body.trip || ''))) throw new ApiError(400, 'bad_request', 'owner and trip');
  const p = await account.storage.get(key);
  if (op === 'trip-joined-alerts') {
    if (!p) throw new ApiError(404, 'not_found', 'You’re not on this trip.');
    await account.storage.put(key, { ...p, alerts: body.on === true });
    return { alerts: body.on === true };
  }
  if (op === 'tjoin-flight-news') {
    // the member's own consent, kept on their own side: no pointer (they left) or alerts off → nothing is pushed
    if (!p || !p.alerts) return { sent: 0, reason: 'off' };
    const day = new Date(account.now()).toISOString().slice(0, 10);
    const count = p.alerts_day === day ? p.alerts_sent || 0 : 0;
    if (count >= ALERTS.perDay) return { sent: 0, reason: 'cap' };
    await account.storage.put(key, { ...p, alerts_day: day, alerts_sent: count + 1 });
    const title = clean(body.title, ALERTS.title);
    if (!title || !notify) return { sent: 0 };
    const data = { kind: 'flight', ident: clean(body.data && body.data.ident, 12), shared: { owner: body.owner, trip: body.trip } };
    const sent = await notify(account, { title, body: `${p.title ? `${p.title}: ` : ''}${clean(body.body, ALERTS.body)}`, data });
    return { sent: sent || 0 };
  }
  throw new ApiError(404, 'not_found', 'Not found');
}

/* ---------- the Worker's side, for the signed-in member ---------- */

/** shared-plus-covers and shared-alerts (travel/api.js): `call` reaches the member's own object, `ask` the organiser's. */
export async function companionsApi(env, who, action, args, { call, ask = askDefault }) {
  const owner = String(args.owner || '');
  if (action === 'shared-plus-covers') return ask(env, owner, 'tmember-covers', { trip: args.trip, member: who.account });
  if (action === 'shared-alerts') {
    const on = args.on === true;
    // the member's consent first, on their own pointer; then the organiser's object learns whom to ask
    await call(env, who.account, 'trip-joined-alerts', { owner, trip: args.trip, on }, who.token);
    try { return await ask(env, owner, 'tmember-alerts', { trip: args.trip, member: who.account, on }); }
    catch (e) { if (on) await call(env, who.account, 'trip-joined-alerts', { owner, trip: args.trip, on: false }, who.token).catch(() => {}); throw e; }
  }
  throw new ApiError(400, 'bad_request', 'Unknown shared-trip action.');
}
