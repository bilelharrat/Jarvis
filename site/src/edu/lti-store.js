// The LTI 1.3 registry (askeden ROADMAP Q12): one object of the Course class, named `lti:registry`
// (binding COURSES, no new migration), reached only from the Worker's own code (edu/lti.js), never
// by a route of its own. It keeps:
//
//   reg:<id>                 a school's platform registration, added by the owner (/api/admin/lti)
//   st:<sha256(state)>       an OIDC login's state → { reg, nonce, expires }: taken once, 10 minutes
//   tk:<sha256(ticket)>      a validated launch waiting for the Eden sign-in → { …, expires }: 15 minutes
//   ctx:<reg>|<dep>|<ctx>    an LMS course (context) → { course, by, at }: linked by the Eden course's owner
//   usr:<reg>|<sub>          an LMS user → { account, at }: one Eden account per LMS user
//   rst:<reg>|<dep>|<ctx>    the last Names and Roles sync's counts (no names kept)
//
// States and tickets are kept under their SHA-256, so the stored data is no bearer value itself.

import { ApiError } from '../accounts/util.js';

export const LTI_STORE = { states: 5000, tickets: 5000, regs: 200 };
const KEY = /^[A-Za-z0-9_|:.\-~/@]{1,600}$/;
const HASH = /^[0-9a-f]{64}$/;
const bad = (m) => new ApiError(400, 'bad_request', m);

async function sweep(storage, prefix, now, max) {
  const all = await storage.list({ prefix });
  const gone = [...all].filter(([, v]) => !v || v.expires <= now).map(([k]) => k).slice(0, 128);
  if (gone.length) await storage.delete(gone);
  if (all.size - gone.length >= max) throw new ApiError(429, 'busy', 'Too many sign-ins in progress. Try again in a few minutes.');
}

/** One op on the registry object (course.js dispatches `lti-*` here). `self`: the Durable Object. */
export async function ltiStoreOp(self, op, body) {
  const s = self.storage;
  const now = self.now();
  switch (op) {
    case 'lti-reg-list': return { regs: [...(await s.list({ prefix: 'reg:' })).values()] };
    case 'lti-reg-get': return { reg: (await s.get(`reg:${String(body.id)}`)) || null };
    case 'lti-reg-put': {
      const r = body.reg;
      if (!r || !/^[A-Za-z0-9_-]{8,40}$/.test(String(r.id))) throw bad('A registration needs an id.');
      const regs = await s.list({ prefix: 'reg:' });
      if (!regs.has(`reg:${r.id}`) && regs.size >= LTI_STORE.regs) throw new ApiError(409, 'too_many', 'Too many registrations.');
      for (const other of regs.values()) if (other.id !== r.id && other.issuer === r.issuer && other.client_id === r.client_id) throw new ApiError(409, 'taken', 'That issuer and client id are registered already.');
      await s.put(`reg:${r.id}`, r);
      return { reg: r };
    }
    case 'lti-reg-delete': await s.delete(`reg:${String(body.id)}`); return { ok: true };
    case 'lti-state-put': {
      if (!HASH.test(String(body.hash))) throw bad('state');
      await sweep(s, 'st:', now, LTI_STORE.states);
      await s.put(`st:${body.hash}`, { ...body.data, expires: now + 10 * 60e3 });
      return { ok: true };
    }
    case 'lti-state-take': { // one use: a replayed state finds nothing
      if (!HASH.test(String(body.hash))) return { data: null };
      const v = await s.get(`st:${body.hash}`);
      if (v) await s.delete(`st:${body.hash}`);
      return { data: v && v.expires > now ? v : null };
    }
    case 'lti-ticket-put': {
      if (!HASH.test(String(body.hash))) throw bad('ticket');
      await sweep(s, 'tk:', now, LTI_STORE.tickets);
      await s.put(`tk:${body.hash}`, { ...body.data, expires: now + 15 * 60e3 });
      return { ok: true };
    }
    case 'lti-ticket-get': {
      if (!HASH.test(String(body.hash))) return { data: null };
      const v = await s.get(`tk:${body.hash}`);
      return { data: v && v.expires > now ? v : null };
    }
    case 'lti-ticket-delete': if (HASH.test(String(body.hash))) await s.delete(`tk:${body.hash}`); return { ok: true };
    case 'lti-ctx-get': return { link: KEY.test(String(body.key)) ? (await s.get(`ctx:${body.key}`)) || null : null };
    case 'lti-ctx-put': {
      if (!KEY.test(String(body.key))) throw bad('context');
      await s.put(`ctx:${body.key}`, { course: body.course, by: body.by, at: now });
      return { ok: true };
    }
    case 'lti-ctx-delete': if (KEY.test(String(body.key))) await s.delete(`ctx:${body.key}`); return { ok: true };
    case 'lti-user-get': return { user: KEY.test(String(body.key)) ? (await s.get(`usr:${body.key}`)) || null : null };
    case 'lti-user-put': { // first link wins: an LMS user can't be moved to another Eden account here
      if (!KEY.test(String(body.key))) throw bad('user');
      const had = await s.get(`usr:${body.key}`);
      if (had && had.account !== body.account) throw new ApiError(409, 'linked_elsewhere', 'This school account is already connected to a different Eden account. Sign in to Eden with that account instead.');
      if (!had) await s.put(`usr:${body.key}`, { account: body.account, at: now });
      return { ok: true };
    }
    case 'lti-users-get': { // many LMS users at once (Names and Roles sync): the linked ones' accounts
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter((k) => KEY.test(String(k))).slice(0, 128).map((k) => `usr:${k}`);
      const got = keys.length ? await s.get(keys) : new Map();
      return { users: Object.fromEntries([...got].map(([k, v]) => [k.slice(4), v.account])) };
    }
    case 'lti-roster-put': if (KEY.test(String(body.key))) await s.put(`rst:${body.key}`, { ...body.counts, at: now }); return { ok: true };
    case 'lti-roster-get': return { roster: KEY.test(String(body.key)) ? (await s.get(`rst:${body.key}`)) || null : null };
    default: throw new ApiError(404, 'not_found', 'No such thing.');
  }
}
