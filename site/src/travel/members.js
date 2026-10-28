// Planning a trip together: the organiser invites the people on the trip, each with their own Eden account. A member
// sees the whole trip in their own Eden Travel (as it is now: every day, stop, check and booking) and can suggest
// changes, made by Ask Eden in their session; a suggestion lands as a proposal in the organiser's Eden noticed, with
// who suggested it, and only the organiser applies it. Members can't change the trip, see the organiser's cards, or
// book on the organiser's account.
//
// Where it lives: the invite `tinv:<code>` and each member `tmem:<trip>:<account>` in the organiser's account object
// (the code's account found through the index objects `trk:<code>`, as trip links); in the member's account, a pointer
// `tjoin:<organiser>:<trip>` { title, by } so their Eden Travel lists the trip.
//
//   organiser (trip ops, signed in): trip-invite-create { id } → { code, url, expires } · trip-members { id } → { members, invites }
//                                    trip-member-remove { id, member } · trip-invite-revoke { code }
//   member (Worker, signed in):      POST /api/chat/travel { action: 'join', args: { code } }
//                                    shared-list · shared-get { owner, trip } · shared-propose { owner, trip, title, reason, ops }
//                                    shared-leave { owner, trip }
//   organiser's object, from the Worker (no device: the Worker vouches for the member's account):
//                                    tmember-join { code, member, name } · tmember-get { trip, member }
//                                    tmember-propose { trip, member, title, reason, ops } · tmember-leave { trip, member }

import { ApiError } from '../accounts/util.js';
import { CODE, ask, index, newCode } from './track.js';

export const MEMBERS_MAX = 12;
const INVITE_MS = 14 * 86400_000;
const ACCOUNT = /^[0-9a-f-]{36}$/;
const TRIP_ID = /^[0-9a-f]{16}$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/* ---------- the organiser's side (signed in, their own account object) ---------- */

export async function inviteCreate(account, body) {
  const id = String(body.id || '');
  const trip = await account.storage.get(`trip:${id}`);
  if (!trip) throw new ApiError(404, 'not_found', 'There is no such trip.');
  const members = await account.storage.list({ prefix: `tmem:${id}:` });
  if (members.size >= MEMBERS_MAX) throw new ApiError(409, 'too_many', `A trip has at most ${MEMBERS_MAX} people planning it.`);
  const acct = ((await account.storage.get('account')) || {}).id;
  let code;
  for (let i = 0; i < 4 && !code; i++) {
    const c = newCode();
    const claimed = await index(account.env, c, 'tshare-index-claim', { account: acct }).catch(() => null);
    if (claimed && claimed.ok) code = c;
  }
  if (!code) throw new ApiError(503, 'unavailable', 'Couldn’t make an invite just now. Try again.');
  const now = account.now();
  await account.storage.put(`tinv:${code}`, { code, trip: id, created: now, expires: now + INVITE_MS });
  return { code, url: `/join/${code}`, expires: now + INVITE_MS };
}

export async function membersOf(account, body) {
  const id = String(body.id || '');
  const now = account.now();
  const members = [...(await account.storage.list({ prefix: `tmem:${id}:` })).values()].map((m) => ({ member: m.member, name: m.name, joined: m.joined }));
  const invites = [...(await account.storage.list({ prefix: 'tinv:' })).values()].filter((x) => x.trip === id && x.expires > now && !x.revoked).map((x) => ({ code: x.code, url: `/join/${x.code}`, expires: x.expires }));
  return { members, invites };
}

export async function memberRemove(account, body) {
  const key = `tmem:${String(body.id || '')}:${String(body.member || '')}`;
  if (!(await account.storage.get(key))) throw new ApiError(404, 'not_found', 'No such person on this trip.');
  await account.storage.delete(key);
  // and stays off: the trip's invites (14 days) would let them join again, so those are refused to them; a new invite
  // (the organiser asking them back) isn't
  const id = String(body.id || '');
  const invites = [...(await account.storage.list({ prefix: 'tinv:' })).values()].filter((x) => x.trip === id).map((x) => x.code);
  await account.storage.put(`tban:${id}:${String(body.member || '')}`, { at: account.now(), invites });
  return { removed: true };
}

export async function inviteRevoke(account, body) {
  const key = `tinv:${String(body.code || '')}`;
  const x = await account.storage.get(key);
  if (!x) throw new ApiError(404, 'not_found', 'No such invite.');
  x.revoked = true;
  await account.storage.put(key, x);
  await index(account.env, x.code, 'tshare-index-drop', {}).catch(() => {});
  return { revoked: true };
}

/* ---------- the organiser's object, asked by the Worker for a member ---------- */

async function membership(account, trip, member) {
  if (!TRIP_ID.test(String(trip || '')) || !ACCOUNT.test(String(member || ''))) throw new ApiError(404, 'not_found', 'No such shared trip.');
  const m = await account.storage.get(`tmem:${trip}:${member}`);
  if (!m) throw new ApiError(404, 'not_found', 'You’re not on this trip any more.');
  return m;
}

export async function memberOp(account, op, body, { tripOp }) {
  const member = String(body.member || '');
  switch (op) {
    case 'tmember-join': {
      const code = String(body.code || '');
      const x = CODE.test(code) ? await account.storage.get(`tinv:${code}`) : null;
      if (!x || x.revoked || x.expires <= account.now()) throw new ApiError(404, 'not_found', 'This invite has ended. Ask for a new one.');
      if (!ACCOUNT.test(member)) throw new ApiError(400, 'bad_request', 'member');
      const own = ((await account.storage.get('account')) || {}).id;
      if (member === own) throw new ApiError(409, 'own_trip', 'This is your own trip.');
      // someone taken off may come back only through an invite made after that (the organiser asking them again)
      const ban = await account.storage.get(`tban:${x.trip}:${member}`);
      if (ban && (Array.isArray(ban.invites) ? ban.invites.includes(code) : x.created <= ban.at)) throw new ApiError(403, 'removed', 'The organiser took you off this trip. Ask them for a new invite.');
      if (ban) await account.storage.delete(`tban:${x.trip}:${member}`);
      const trip = await account.storage.get(`trip:${x.trip}`);
      if (!trip) throw new ApiError(404, 'not_found', 'This trip was deleted.');
      const count = (await account.storage.list({ prefix: `tmem:${x.trip}:` })).size;
      if (count >= MEMBERS_MAX && !(await account.storage.get(`tmem:${x.trip}:${member}`))) throw new ApiError(409, 'too_many', 'This trip has as many people planning it as it can.');
      await account.storage.put(`tmem:${x.trip}:${member}`, { member, name: clean(body.name, 40) || 'Someone on the trip', joined: account.now() });
      return { owner: own, trip: x.trip, title: trip.title };
    }
    case 'tmember-get': {
      await membership(account, body.trip, member);
      const got = await tripOp(account, 'trip-get', { id: body.trip });
      // the trip and its checks, and a proposal waiting; never the organiser's cards or rewards
      return { trip: got.trip, checks: got.checks, proposal: got.proposal ? { id: got.proposal.id, title: got.proposal.title, by: got.proposal.by, by_name: got.proposal.by_name || null } : null, owner: ((await account.storage.get('account')) || {}).id };
    }
    case 'tmember-propose': {
      const m = await membership(account, body.trip, member);
      const out = await tripOp(account, 'trip-propose', { id: body.trip, title: body.title, reason: body.reason, ops: body.ops, by: 'member', by_name: m.name });
      return { proposal: out.proposal, preview: out.preview };
    }
    case 'tmember-leave': {
      await account.storage.delete(`tmem:${String(body.trip || '')}:${member}`);
      return { left: true };
    }
    default:
      throw new ApiError(404, 'not_found', 'Not found');
  }
}

/* ---------- the Worker's side, for the signed-in member ---------- */

const ownerOf = async (env, code) => (await index(env, code, 'tshare-index-get')).account;

/** The member's actions (travel/api.js): `call` reaches the member's own object, `ask` the organiser's. */
export async function memberApi(env, who, action, args, { call }) {
  switch (action) {
    case 'join': {
      const code = String(args.code || '');
      if (!CODE.test(code)) throw new ApiError(400, 'bad_request', 'That isn’t an invite code.');
      const owner = await ownerOf(env, code).catch(() => { throw new ApiError(404, 'not_found', 'This invite has ended. Ask for a new one.'); });
      const out = await ask(env, owner, 'tmember-join', { code, member: who.account, name: args.name });
      await call(env, who.account, 'trip-joined', { owner: out.owner, trip: out.trip, title: out.title }, who.token);
      return out;
    }
    case 'shared-list':
      return call(env, who.account, 'trip-joined-list', {}, who.token);
    case 'shared-get':
      return ask(env, String(args.owner || ''), 'tmember-get', { trip: args.trip, member: who.account });
    case 'shared-propose':
      return ask(env, String(args.owner || ''), 'tmember-propose', { trip: args.trip, member: who.account, title: args.title, reason: args.reason, ops: args.ops });
    case 'shared-leave':
      await ask(env, String(args.owner || ''), 'tmember-leave', { trip: args.trip, member: who.account }).catch(() => {});
      return call(env, who.account, 'trip-joined-drop', { owner: args.owner, trip: args.trip }, who.token);
    default:
      throw new ApiError(400, 'bad_request', 'Unknown shared-trip action.');
  }
}

/** The member's own pointers (their account object, signed in). */
export async function joinedOp(account, op, body) {
  const key = (o, t) => `tjoin:${o}:${t}`;
  if (op === 'trip-joined') {
    if (!ACCOUNT.test(String(body.owner || '')) || !TRIP_ID.test(String(body.trip || ''))) throw new ApiError(400, 'bad_request', 'owner and trip');
    await account.storage.put(key(body.owner, body.trip), { owner: body.owner, trip: body.trip, title: clean(body.title, 120), joined: account.now() });
    return { joined: true };
  }
  if (op === 'trip-joined-list') return { shared: [...(await account.storage.list({ prefix: 'tjoin:' })).values()] };
  if (op === 'trip-joined-drop') { await account.storage.delete(key(body.owner, body.trip)); return { left: true }; }
  throw new ApiError(404, 'not_found', 'Not found');
}
