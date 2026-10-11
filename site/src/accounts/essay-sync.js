// Eden's essays on every device (askeden ROADMAP T11; the essay writer, web/chat/essay.js). Built as
// chat sync is (chat-sync.js): the Worker seals each essay (AES-256-GCM under tokens.js's HKDF key for
// the account) before it reaches the account's Durable Object, so askeden.com keeps essays encrypted at
// rest, and the browser only turns this on when chat sync is on (not in end-to-end mode, whose promise
// is a key only the devices hold). Revisions make a stale write a conflict, answered with the current
// copy, so the page can keep both versions instead of losing one; a deleted essay is a tombstone.
//
// In the account's object:
//   esm:<id>      { rev, updated, deleted, size, n, iv, miv, mct }  the sealed list entry (title, style,
//                 dates) in `miv`/`mct`; the body is `n` chunks
//   esb:<id>:<i>  a slice (<= 100 KB) of the sealed essay's ciphertext
//   esrev, escount, esbytes  the revision counter, live essays, their size
// Deleting the account deletes all (storage.deleteAll).

import { call, limited } from './index.js';
import { ApiError, json, readJson } from './util.js';
import { openWith, sealWith } from './tokens.js';

export const ESSAY_SYNC = { maxChars: 1_500_000, chunk: 100_000, maxEssays: 2000, maxBytes: 150_000_000, page: 200 };
const idOk = (id) => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(id);
const bad = (m) => new ApiError(400, 'bad_request', m);
const info = (account) => `account:${account}`;
const aadBody = (account, id) => `essay:${account}:${id}`;
const aadMeta = (account, id) => `essaym:${account}:${id}`;

/** What the Essays list needs of an essay without opening it. */
export function essayMetaOf(e) {
  const d = (e && e.details) || {};
  return { id: e.id, title: String(d.title || '').slice(0, 300), style: String(e.style || 'mla').slice(0, 20), created: Number(e.created) || 0, updated: Number(e.updated) || 0 };
}

// ── the Account object's ops (account.js: `if (op.startsWith('essay-')) …`) ──

export async function essaySyncOp(account, op, request) {
  const device = await account.authenticate(request);
  if (device.grant) throw new ApiError(403, 'grant_forbidden', 'Essays stay with the account’s owner.');
  const body = await request.json().catch(() => ({}));
  const st = account.storage;
  const rev = async () => (await st.get('esrev')) || 0;
  const entry = (id) => st.get(`esm:${id}`);
  switch (op) {
    case 'essay-status': return json({ rev: await rev(), count: (await st.get('escount')) || 0, bytes: (await st.get('esbytes')) || 0, limits: ESSAY_SYNC });
    case 'essay-list': {
      const since = Number(body.since) || 0;
      const rows = [...(await st.list({ prefix: 'esm:' })).values()].filter((r) => r.rev > since).sort((a, b) => a.rev - b.rev);
      const page = rows.slice(0, ESSAY_SYNC.page);
      return json({ rev: await rev(), more: rows.length > page.length, items: page.map((r) => ({ id: r.id, rev: r.rev, updated: r.updated, deleted: Boolean(r.deleted), meta: r.deleted ? null : { iv: r.miv, ct: r.mct } })) });
    }
    case 'essay-get': {
      if (!idOk(body.id)) throw bad('Which essay?');
      const r = await entry(body.id);
      if (!r) throw new ApiError(404, 'not_found', 'No such essay.');
      if (r.deleted) return json({ id: body.id, rev: r.rev, deleted: true, updated: r.updated });
      let ct = '';
      for (let i = 0; i < r.n; i++) ct += (await st.get(`esb:${body.id}:${i}`)) || '';
      return json({ id: body.id, rev: r.rev, updated: r.updated, record: { iv: r.iv, ct } });
    }
    case 'essay-put': {
      if (!idOk(body.id)) throw bad('Which essay?');
      const rec = body.record;
      if (!rec || typeof rec.ct !== 'string' || typeof rec.iv !== 'string' || !body.meta || typeof body.meta.ct !== 'string') throw bad('Send the sealed essay.');
      const cur = await entry(body.id);
      const base = Number(body.base_rev) || 0;
      if (cur && cur.rev !== base) return json({ conflict: { rev: cur.rev, deleted: Boolean(cur.deleted), updated: cur.updated } });
      if (!cur && base) return json({ conflict: { rev: 0, deleted: true, updated: 0 } });
      const count = (await st.get('escount')) || 0;
      const bytes = (await st.get('esbytes')) || 0;
      const had = cur && !cur.deleted;
      if (!had && count >= ESSAY_SYNC.maxEssays) return json({ code: 'too_many', error: `Up to ${ESSAY_SYNC.maxEssays} essays sync.` });
      if (bytes - (had ? cur.size : 0) + rec.ct.length > ESSAY_SYNC.maxBytes) return json({ code: 'too_big', error: 'This account’s synced essays are full.' });
      const n = Math.ceil(rec.ct.length / ESSAY_SYNC.chunk);
      for (let i = 0; i < n; i++) await st.put(`esb:${body.id}:${i}`, rec.ct.slice(i * ESSAY_SYNC.chunk, (i + 1) * ESSAY_SYNC.chunk));
      if (cur) for (let i = n; i < (cur.n || 0); i++) await st.delete(`esb:${body.id}:${i}`);
      const next = (await rev()) + 1;
      await st.put(`esm:${body.id}`, { id: body.id, rev: next, updated: Number(body.updated) || Date.now(), deleted: false, size: rec.ct.length, n, iv: rec.iv, miv: body.meta.iv, mct: body.meta.ct });
      await st.put('esrev', next);
      await st.put('escount', count + (had ? 0 : 1));
      await st.put('esbytes', bytes - (had ? cur.size : 0) + rec.ct.length);
      return json({ rev: next });
    }
    case 'essay-delete': {
      if (!idOk(body.id)) throw bad('Which essay?');
      const cur = await entry(body.id);
      if (!cur || cur.deleted) return json({ rev: cur ? cur.rev : await rev() });
      for (let i = 0; i < cur.n; i++) await st.delete(`esb:${body.id}:${i}`);
      const next = (await rev()) + 1;
      await st.put(`esm:${body.id}`, { id: body.id, rev: next, updated: Date.now(), deleted: true, size: 0, n: 0 });
      await st.put('esrev', next);
      await st.put('escount', Math.max(0, ((await st.get('escount')) || 0) - 1));
      await st.put('esbytes', Math.max(0, ((await st.get('esbytes')) || 0) - cur.size));
      return json({ rev: next });
    }
    default: throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

// ── the Worker's side: /api/web/essays/<op> (a browser) and /api/essays/<op> (the apps) ──

const OPS = new Set(['status', 'list', 'get', 'put', 'delete']);

export async function essaySyncApi(request, env, who, op) {
  await limited(env, env.CSYNC_RATE ? 'CSYNC_RATE' : 'API_RATE', who.account);
  if (!OPS.has(op)) throw new ApiError(404, 'not_found', 'No such thing.');
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST it.');
  const body = await readJson(request, 3_000_000);
  const go = (name, b) => call(env, who.account, `essay-${name}`, b, who.token);
  if (op === 'status' || op === 'delete') return json(await go(op, body));
  if (op === 'list') {
    const out = await go('list', body);
    const items = [];
    for (const r of out.items) {
      if (r.deleted) { items.push({ id: r.id, rev: r.rev, updated: r.updated, deleted: true }); continue; }
      const meta = await openWith(env, info(who.account), aadMeta(who.account, r.id), r.meta);
      items.push(meta ? { id: r.id, rev: r.rev, updated: r.updated, meta } : { id: r.id, rev: r.rev, updated: r.updated, unreadable: true });
    }
    return json({ ...out, items });
  }
  if (op === 'get') {
    const out = await go('get', body);
    if (out.deleted) return json(out);
    const essay = await openWith(env, info(who.account), aadBody(who.account, out.id), out.record);
    if (!essay) throw new ApiError(500, 'unreadable', 'That essay couldn’t be opened.');
    return json({ id: out.id, rev: out.rev, updated: out.updated, essay });
  }
  // put
  const e = body.essay;
  if (!idOk(body.id) || !e || typeof e !== 'object' || e.id !== body.id || !e.doc || typeof e.doc !== 'object') throw bad('Send an essay.');
  if (JSON.stringify(e).length > ESSAY_SYNC.maxChars) return json({ code: 'too_big', error: 'That essay is too big to sync.' });
  const record = await sealWith(env, info(who.account), aadBody(who.account, body.id), e);
  const meta = await sealWith(env, info(who.account), aadMeta(who.account, body.id), essayMetaOf(e));
  const out = await go('put', { id: body.id, record, meta, base_rev: body.base_rev, updated: e.updated });
  if (out.conflict && !out.conflict.deleted) {
    const cur = await go('get', { id: body.id });
    const essay = await openWith(env, info(who.account), aadBody(who.account, body.id), cur.record);
    return json({ conflict: { ...out.conflict, essay } });
  }
  return json(out);
}
