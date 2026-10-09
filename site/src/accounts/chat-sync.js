// Eden's chat history on every device, automatically (ROADMAP H1 follow-up; docs/accounts.md
// "Chat sync"). The default for every signed-in account: no passphrase. The Worker seals each
// conversation (AES-256-GCM under tokens.js's HKDF key for the account, the same sealing as the
// saved memories and the owner's API keys) before it reaches the account's Durable Object, so
// askeden.com stores them encrypted at rest. The optional end-to-end mode (eden-sync.js) is the
// alternative for people who want a key only their devices hold; the browser decides which one
// it is in (no end-to-end key set up = this).
//
// In the account's object:
//   cvm:<id>      { rev, updated, deleted, size, n, iv, ct, miv, mct }  the revision, and the sealed
//                 list entry (title, dates, pin…) in `miv`/`mct`; the body is `n` chunks
//   cvb:<id>:<i>  a slice (<= 100 KB) of the sealed body's ciphertext (DO values stay small)
//   cvrev, cvcount, cvbytes  the revision counter, live conversations, their size
// Limits: a conversation up to 1.5 MB of text (images never leave the browser: the page sends
// only a placeholder); 5000 conversations and 200 MB per account. Deleting the account deletes all
// (storage.deleteAll); a deleted chat is a tombstone (no content) so other devices drop it too.

import { call, limited } from './index.js';
import { ApiError, json, readJson } from './util.js';
import { openWith, sealWith } from './tokens.js';

export const CHAT_SYNC = { maxChars: 1_500_000, chunk: 100_000, maxConvs: 5000, maxBytes: 200_000_000, page: 200 };
const idOk = (id) => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(id);
const bad = (m) => new ApiError(400, 'bad_request', m);
const info = (account) => `account:${account}`;
const aadBody = (account, id) => `csync:${account}:${id}`;
const aadMeta = (account, id) => `csyncm:${account}:${id}`;

/** What the list needs of a conversation (the sidebar). */
export function metaOf(c) {
  const pick = (k) => (c[k] === undefined ? undefined : c[k]);
  return {
    id: c.id, title: String(c.title || 'New chat').slice(0, 200), titleSet: pick('titleSet'), created: Number(c.created) || 0, updated: Number(c.updated) || 0,
    pinned: Boolean(c.pinned), kind: c.kind || 'chat', personaId: pick('personaId') || null,
    project: c.project && typeof c.project === 'object' ? { name: String(c.project.name || '').slice(0, 120), path: c.project.path } : null,
    messages: Object.keys(c.nodes || {}).length,
  };
}

// ── the Account object's ops (account.js: `if (op.startsWith('csync-')) …`) ──

export async function chatSyncOp(account, op, request) {
  const device = await account.authenticate(request); // grantGuard refuses a delegate's or a space's device
  if (device.grant) throw new ApiError(403, 'grant_forbidden', 'Chats stay with the account’s owner.');
  const body = await request.json().catch(() => ({}));
  const st = account.storage;
  const rev = async () => (await st.get('cvrev')) || 0;
  const entry = (id) => st.get(`cvm:${id}`);
  switch (op) {
    case 'csync-status': return json({ rev: await rev(), count: (await st.get('cvcount')) || 0, bytes: (await st.get('cvbytes')) || 0, limits: CHAT_SYNC });
    case 'csync-list': {
      const since = Number(body.since) || 0;
      const rows = [...(await st.list({ prefix: 'cvm:' })).values()].filter((r) => r.rev > since).sort((a, b) => a.rev - b.rev);
      const page = rows.slice(0, CHAT_SYNC.page);
      return json({ rev: await rev(), more: rows.length > page.length, items: page.map((r) => ({ id: r.id, rev: r.rev, updated: r.updated, deleted: Boolean(r.deleted), size: r.size, meta: r.deleted ? null : { iv: r.miv, ct: r.mct } })) });
    }
    case 'csync-get': {
      if (!idOk(body.id)) throw bad('Which chat?');
      const r = await entry(body.id);
      if (!r) throw new ApiError(404, 'not_found', 'No such chat.');
      if (r.deleted) return json({ id: body.id, rev: r.rev, deleted: true, updated: r.updated });
      let ct = '';
      for (let i = 0; i < r.n; i++) ct += (await st.get(`cvb:${body.id}:${i}`)) || '';
      return json({ id: body.id, rev: r.rev, updated: r.updated, record: { iv: r.iv, ct } });
    }
    case 'csync-put': {
      if (!idOk(body.id)) throw bad('Which chat?');
      const rec = body.record;
      if (!rec || typeof rec.ct !== 'string' || typeof rec.iv !== 'string' || !body.meta || typeof body.meta.ct !== 'string') throw bad('Send the sealed chat.');
      const cur = await entry(body.id);
      const base = Number(body.base_rev) || 0;
      if (cur && cur.rev !== base) return json({ conflict: { rev: cur.rev, deleted: Boolean(cur.deleted), updated: cur.updated } });
      if (!cur && base) return json({ conflict: { rev: 0, deleted: true, updated: 0 } });
      const count = (await st.get('cvcount')) || 0;
      const bytes = (await st.get('cvbytes')) || 0;
      const had = cur && !cur.deleted;
      if (!had && count >= CHAT_SYNC.maxConvs) return json({ code: 'too_many', error: `Up to ${CHAT_SYNC.maxConvs} chats sync.` });
      if (bytes - (had ? cur.size : 0) + rec.ct.length > CHAT_SYNC.maxBytes) return json({ code: 'too_big', error: 'This account’s synced chats are full.' });
      if (rec.ct.length > CHAT_SYNC.maxChars * 1.4) return json({ code: 'too_big', error: 'That chat is too big to sync.' });
      const n = Math.ceil(rec.ct.length / CHAT_SYNC.chunk);
      for (let i = 0; i < n; i++) await st.put(`cvb:${body.id}:${i}`, rec.ct.slice(i * CHAT_SYNC.chunk, (i + 1) * CHAT_SYNC.chunk));
      if (had) for (let i = n; i < cur.n; i++) await st.delete(`cvb:${body.id}:${i}`);
      const next = (await rev()) + 1;
      await st.put(`cvm:${body.id}`, { id: body.id, rev: next, updated: Number(body.updated) || Date.now(), deleted: false, size: rec.ct.length, n, iv: rec.iv, miv: body.meta.iv, mct: body.meta.ct });
      await st.put('cvrev', next);
      await st.put('cvcount', count + (had ? 0 : 1));
      await st.put('cvbytes', bytes - (had ? cur.size : 0) + rec.ct.length);
      return json({ rev: next });
    }
    case 'csync-delete': {
      if (!idOk(body.id)) throw bad('Which chat?');
      const cur = await entry(body.id);
      if (!cur || cur.deleted) return json({ rev: cur ? cur.rev : await rev() });
      for (let i = 0; i < cur.n; i++) await st.delete(`cvb:${body.id}:${i}`);
      const next = (await rev()) + 1;
      await st.put(`cvm:${body.id}`, { id: body.id, rev: next, updated: Date.now(), deleted: true, size: 0, n: 0 });
      await st.put('cvrev', next);
      await st.put('cvcount', Math.max(0, ((await st.get('cvcount')) || 0) - 1));
      await st.put('cvbytes', Math.max(0, ((await st.get('cvbytes')) || 0) - cur.size));
      return json({ rev: next });
    }
    case 'csync-wipe': { // "Delete all chats", or switching to end-to-end: every server copy, tombstones included
      const keys = [...(await st.list({ prefix: 'cvm:' })).keys(), ...(await st.list({ prefix: 'cvb:' })).keys()];
      for (let i = 0; i < keys.length; i += 120) await st.delete(keys.slice(i, i + 120));
      const next = (await rev()) + 1;
      await st.put('cvrev', next); // devices see a revision they can't match: they start over (`wiped`)
      await st.put('cvwiped', next);
      await st.put('cvcount', 0);
      await st.put('cvbytes', 0);
      return json({ rev: next });
    }
    default: throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

// ── the Worker's side: /api/web/csync/<op> (a browser) and /api/csync/<op> (the apps) ──

const OPS = new Set(['status', 'list', 'get', 'put', 'delete', 'wipe']);

export async function chatSyncApi(request, env, who, op) {
  // Its own allowance (a first upload is hundreds of calls); API_RATE's 120 a minute is for chat turns and ran out within the first minute.
  await limited(env, env.CSYNC_RATE ? 'CSYNC_RATE' : 'API_RATE', who.account);
  if (!OPS.has(op)) throw new ApiError(404, 'not_found', 'No such thing.');
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST it.');
  const body = await readJson(request, 4_000_000);
  const go = (name, b) => call(env, who.account, `csync-${name}`, b, who.token);
  if (op === 'wipe') await limited(env, 'LINK_RATE', `csync:${who.account}`);
  if (op === 'status' || op === 'delete' || op === 'wipe') return json(await go(op, body));
  if (op === 'list') {
    const out = await go('list', body);
    const items = [];
    for (const r of out.items) {
      if (r.deleted) { items.push({ id: r.id, rev: r.rev, updated: r.updated, deleted: true }); continue; }
      const meta = await openWith(env, info(who.account), aadMeta(who.account, r.id), r.meta);
      items.push(meta ? { id: r.id, rev: r.rev, updated: r.updated, size: r.size, meta } : { id: r.id, rev: r.rev, updated: r.updated, unreadable: true });
    }
    return json({ ...out, items });
  }
  if (op === 'get') {
    const out = await go('get', body);
    if (out.deleted) return json(out);
    const conv = await openWith(env, info(who.account), aadBody(who.account, out.id), out.record);
    if (!conv) throw new ApiError(500, 'unreadable', 'That chat couldn’t be opened.');
    return json({ id: out.id, rev: out.rev, updated: out.updated, conv });
  }
  // put
  const c = body.conv;
  if (!idOk(body.id) || !c || typeof c !== 'object' || c.id !== body.id || !c.nodes || typeof c.nodes !== 'object') throw bad('Send a conversation.');
  if (c.temp) throw bad('Temporary chats don’t sync.');
  if (JSON.stringify(c).length > CHAT_SYNC.maxChars) return json({ code: 'too_big', error: 'That chat is too big to sync.' });
  const record = await sealWith(env, info(who.account), aadBody(who.account, body.id), c);
  const meta = await sealWith(env, info(who.account), aadMeta(who.account, body.id), metaOf(c));
  const out = await go('put', { id: body.id, record, meta, base_rev: body.base_rev, updated: c.updated });
  if (out.conflict && !out.conflict.deleted) {
    const cur = await go('get', { id: body.id });
    const conv = await openWith(env, info(who.account), aadBody(who.account, body.id), cur.record);
    return json({ conflict: { ...out.conflict, conv } });
  }
  return json(out);
}
