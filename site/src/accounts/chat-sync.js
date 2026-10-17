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
//   cvwiped       the revision of the last wipe (every server copy removed); devices behind it start over
//   cvpruned      the newest tombstone revision cleaned up (after TOMBSTONE_DAYS); devices behind it list again
//   cvr:<rev>     the revision index: the id of the row at that revision (12 digits, so keys sort by revision)
//   cvt:<rev>     { id, updated } for each tombstone, oldest first, for the clean-up
//   cvidx         1 once the index is whole (built once for an account that synced before it existed)
// Limits: a conversation up to 1.5 MB of text (images never leave the browser: the page sends
// only a placeholder); 5000 conversations and 200 MB per account. Deleting the account deletes all
// (storage.deleteAll); a deleted chat is a tombstone (no content) so other devices drop it too.

import { call, limited } from './index.js';
import { ApiError, accountCode, json, readJson } from './util.js';
import { openWith, sealWith } from './tokens.js';

// batch: chats a csync/batch request may send (their JSON up to batchChars together); batchDeletes: deletes in it
export const CHAT_SYNC = { maxChars: 1_500_000, chunk: 100_000, maxConvs: 5000, maxBytes: 200_000_000, page: 200, batch: 25, batchDeletes: 100, batchChars: 3_500_000 };
export const TOMBSTONE_DAYS = 180; // a deleted chat's tombstone is kept this long, then cleaned up
const PRUNE_STEP = 120; // tombstones cleaned up per list call at most (one storage.delete takes up to 128 keys)
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
    pinned: Boolean(c.pinned), folder: typeof c.folder === 'string' && c.folder.trim() ? c.folder.trim().slice(0, 40) : undefined, metaAt: Number(c.metaAt) || undefined, kind: c.kind || 'chat', personaId: pick('personaId') || null,
    project: c.project && typeof c.project === 'object' ? { name: String(c.project.name || '').slice(0, 120), path: c.project.path } : null,
    messages: Object.keys(c.nodes || {}).length,
  };
}

// ── the Account object's ops (account.js: `if (op.startsWith('csync-')) …`) ──

// The revision index (cvr:<rev> → id; cvt:<rev> → { id, updated } for tombstones), so a list reads only the rows
// after the device's cursor and the clean-up only the oldest tombstones, not every row. Kept with each write; built
// once (cvidx) for an account that synced before it existed. Revisions are zero-padded so keys sort by revision.
const REV_MAX = 1e12 - 1;
const padRev = (rev) => String(Math.min(Math.max(0, Math.floor(Number(rev) || 0)), REV_MAX)).padStart(12, '0');
const revKey = (rev) => `cvr:${padRev(rev)}`;
const tombKey = (rev) => `cvt:${padRev(rev)}`;
const revOf = (key) => Number(key.slice(4));

/** Keys after `after` under `prefix`, in order, at most `limit` (a storage that ignores startAfter/limit gives the same). */
async function listAfter(st, prefix, after, limit) {
  const got = await st.list(after ? { prefix, startAfter: after, limit } : { prefix, limit });
  return [...got].filter(([k]) => !after || k > after).slice(0, limit);
}

/** storage.get for many keys (128 a call). */
async function getMany(st, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 128) for (const [k, v] of await st.get(keys.slice(i, i + 128))) out.set(k, v);
  return out;
}

async function deleteMany(st, keys) {
  for (let i = 0; i < keys.length; i += 128) await st.delete(keys.slice(i, i + 128));
}

async function ensureIndex(st, built) {
  if (built) return;
  const writes = [];
  for (const r of (await st.list({ prefix: 'cvm:' })).values()) {
    writes.push([revKey(r.rev), r.id]);
    if (r.deleted) writes.push([tombKey(r.rev), { id: r.id, updated: r.updated || 0 }]);
  }
  for (let i = 0; i < writes.length; i += 128) await st.put(Object.fromEntries(writes.slice(i, i + 128)));
  await st.put('cvidx', 1);
}

/** The counters a write changes, read together. */
async function counters(st) {
  const got = await st.get(['cvrev', 'cvcount', 'cvbytes']);
  return { rev: got.get('cvrev') || 0, count: got.get('cvcount') || 0, bytes: got.get('cvbytes') || 0 };
}

/** One sealed chat in (csync-put, and each of csync-batch's): its row, chunks, index entry and the counters, in one put. */
async function putChat(st, c, body, { withRecord = false } = {}) {
  if (!body || typeof body !== 'object' || !idOk(body.id)) return { error: bad('Which chat?') };
  const rec = body.record;
  if (!rec || typeof rec.ct !== 'string' || typeof rec.iv !== 'string' || !body.meta || typeof body.meta.ct !== 'string') return { error: bad('Send the sealed chat.') };
  const cur = await st.get(`cvm:${body.id}`);
  const base = Number(body.base_rev) || 0;
  if (cur && cur.rev !== base) {
    const conflict = { rev: cur.rev, deleted: Boolean(cur.deleted), updated: cur.updated };
    if (withRecord && !cur.deleted) conflict.record = { iv: cur.iv, ct: await chunks(st, body.id, cur.n) };
    return { out: { conflict } };
  }
  if (!cur && base) return { out: { conflict: { rev: 0, deleted: true, updated: 0 } } };
  const had = cur && !cur.deleted;
  if (!had && c.count >= CHAT_SYNC.maxConvs) return { out: { code: 'too_many', error: `Up to ${CHAT_SYNC.maxConvs} chats sync.` } };
  if (c.bytes - (had ? cur.size : 0) + rec.ct.length > CHAT_SYNC.maxBytes) return { out: { code: 'too_big', error: 'This account’s synced chats are full.' } };
  if (rec.ct.length > CHAT_SYNC.maxChars * 1.4) return { out: { code: 'too_big', error: 'That chat is too big to sync.' } };
  const n = Math.ceil(rec.ct.length / CHAT_SYNC.chunk);
  const next = c.rev + 1;
  const count = c.count + (had ? 0 : 1);
  const bytes = c.bytes - (had ? cur.size : 0) + rec.ct.length;
  const puts = {};
  for (let i = 0; i < n; i++) puts[`cvb:${body.id}:${i}`] = rec.ct.slice(i * CHAT_SYNC.chunk, (i + 1) * CHAT_SYNC.chunk);
  Object.assign(puts, {
    [`cvm:${body.id}`]: { id: body.id, rev: next, updated: Number(body.updated) || Date.now(), deleted: false, size: rec.ct.length, n, iv: rec.iv, miv: body.meta.iv, mct: body.meta.ct },
    [revKey(next)]: body.id, cvrev: next, cvcount: count, cvbytes: bytes,
  });
  const drop = [];
  if (cur) drop.push(revKey(cur.rev), ...(cur.deleted ? [tombKey(cur.rev)] : []));
  if (had) for (let i = n; i < cur.n; i++) drop.push(`cvb:${body.id}:${i}`);
  await st.put(puts);
  await deleteMany(st, drop);
  Object.assign(c, { rev: next, count, bytes });
  return { out: { rev: next } };
}

/** One chat deleted (csync-delete, and csync-batch's): a tombstone, indexed for the clean-up. */
async function deleteChat(st, c, id) {
  const cur = await st.get(`cvm:${id}`);
  if (!cur || cur.deleted) return { rev: cur ? cur.rev : c.rev };
  const next = c.rev + 1;
  const now = Date.now();
  const count = Math.max(0, c.count - 1);
  const bytes = Math.max(0, c.bytes - cur.size);
  await st.put({ [`cvm:${id}`]: { id, rev: next, updated: now, deleted: true, size: 0, n: 0 }, [revKey(next)]: id, [tombKey(next)]: { id, updated: now }, cvrev: next, cvcount: count, cvbytes: bytes });
  await deleteMany(st, [revKey(cur.rev), ...Array.from({ length: cur.n }, (_, i) => `cvb:${id}:${i}`)]);
  Object.assign(c, { rev: next, count, bytes });
  return { rev: next };
}

async function chunks(st, id, n) {
  const keys = Array.from({ length: n }, (_, i) => `cvb:${id}:${i}`);
  const got = await getMany(st, keys);
  return keys.map((k) => got.get(k) || '').join('');
}

/** Rows with a revision after `since`, in revision order, through the index: up to `want` of them (live only: `live`). */
async function rowsAfter(st, since, want, { live = false } = {}) {
  const rows = [];
  let after = revKey(since);
  let last = null;
  let more = false;
  for (;;) {
    const keys = await listAfter(st, 'cvr:', after, want + 1 - rows.length);
    if (!keys.length) break;
    const got = await getMany(st, keys.map(([, id]) => `cvm:${id}`));
    const stale = [];
    for (const [k, id] of keys) {
      const r = got.get(`cvm:${id}`);
      if (!r || r.rev !== revOf(k)) { stale.push(k); continue; } // an entry left behind: not a row any more
      if (live && r.deleted) continue;
      if (rows.length === want) { more = true; break; }
      rows.push(r);
      last = k;
    }
    await deleteMany(st, stale);
    if (more) break;
    after = keys[keys.length - 1][0];
  }
  return { rows, more, last };
}

// csync-wipe a page at a time. A storage.list hands back every value with its key, and the chunks are each chat's
// whole text (up to CHAT_SYNC.maxBytes together, more than an object's memory), so they are never listed in bulk:
// each row says how many chunks it has (`n`), and they go by key.
const WIPE_STEP = 200;

/** Every chat's row and chunks, then the index: no chat's text is read. */
async function wipeAll(st) {
  for (;;) {
    const rows = await st.list({ prefix: 'cvm:', limit: WIPE_STEP });
    if (!rows.size) break;
    const keys = [];
    for (const [k, r] of rows) keys.push(k, ...Array.from({ length: Number(r && r.n) || 0 }, (_, i) => `cvb:${k.slice(4)}:${i}`));
    await deleteMany(st, keys);
  }
  // then what no row names (a chunk left by a write cut short, before a chat's row and chunks went in one put: a few
  // at a time, as their values come too) and the index (small values)
  for (const [prefix, step] of [['cvb:', 8], ['cvr:', 500], ['cvt:', 500]]) {
    for (;;) {
      const keys = [...(await st.list({ prefix, limit: step })).keys()];
      if (!keys.length) break;
      await deleteMany(st, keys);
    }
  }
  await st.delete('cvidx'); // the next list makes the index again, from no rows
}

// End-to-end mode set up (eden-sync.js's key, `ek:meta`): this account keeps no copies sealed by askeden.com, so no
// chat goes in. A device that hasn't noticed the switch yet (a page open from before it, which never asks again)
// otherwise uploaded its chats again after the wipe. Deletes and wipes still go through.
export const END_TO_END = 'This account syncs end to end, so askeden.com doesn’t keep copies of its chats.';
async function noCopiesIfEndToEnd(st) {
  if (await st.get('ek:meta')) throw new ApiError(409, 'end_to_end', END_TO_END);
}

export async function chatSyncOp(account, op, request) {
  const device = await account.authenticate(request); // grantGuard refuses a delegate's or a space's device
  if (device.grant) throw new ApiError(403, 'grant_forbidden', 'Chats stay with the account’s owner.');
  const body = await request.json().catch(() => ({}));
  const st = account.storage;
  switch (op) {
    case 'csync-status': {
      const c = await counters(st);
      return json({ rev: c.rev, count: c.count, bytes: c.bytes, limits: CHAT_SYNC });
    }
    case 'csync-list': {
      const since = Math.max(0, Number(body.since) || 0);
      const head = await st.get(['cvrev', 'cvidx', 'cvwiped', 'cvpruned']);
      await ensureIndex(st, head.get('cvidx'));
      // Tombstones older than TOMBSTONE_DAYS go, a bounded number a call (the oldest first); `pruned` (the newest
      // revision cleaned up) tells a device that last synced before it to list everything again (cloud-sync.js).
      const old = Date.now() - TOMBSTONE_DAYS * 864e5;
      let pruned = head.get('cvpruned') || 0;
      // (the oldest one is read first: when it isn't due, none are, and an idle list reads one tombstone)
      const oldest = await listAfter(st, 'cvt:', null, 1);
      const due = oldest.length && (oldest[0][1].updated || 0) < old ? (await listAfter(st, 'cvt:', null, PRUNE_STEP)).filter(([, t]) => (t.updated || 0) < old) : [];
      if (due.length) {
        const got = await getMany(st, due.map(([, t]) => `cvm:${t.id}`));
        const drop = [];
        const gone = [];
        for (const [k, t] of due) {
          drop.push(k);
          const r = got.get(`cvm:${t.id}`);
          if (r && r.deleted && r.rev === revOf(k) && (r.updated || 0) < old) { gone.push(r.rev); drop.push(`cvm:${t.id}`, revKey(r.rev)); }
        }
        await deleteMany(st, drop);
        if (gone.length) {
          pruned = Math.max(pruned, ...gone);
          await st.put('cvpruned', pruned);
        }
      }
      const { rows, more, last } = await rowsAfter(st, since, CHAT_SYNC.page);
      // The cursor is the last row sent while there are more (the account's revision would skip the rest),
      // as eden-sync.js's pull does. `wiped`: the revision of the last "remove every server copy".
      return json({ rev: more ? revOf(last) : head.get('cvrev') || 0, more, wiped: head.get('cvwiped') || 0, pruned, items: rows.map((r) => ({ id: r.id, rev: r.rev, updated: r.updated, deleted: Boolean(r.deleted), size: r.size, meta: r.deleted ? null : { iv: r.miv, ct: r.mct } })) });
    }
    case 'csync-get': {
      if (!idOk(body.id)) throw bad('Which chat?');
      const r = await st.get(`cvm:${body.id}`);
      if (!r) throw new ApiError(404, 'not_found', 'No such chat.');
      if (r.deleted) return json({ id: body.id, rev: r.rev, deleted: true, updated: r.updated });
      return json({ id: body.id, rev: r.rev, updated: r.updated, record: { iv: r.iv, ct: await chunks(st, body.id, r.n) } });
    }
    case 'csync-getmany': { // several chats' bodies in one call: in the order asked, as many as fit (at least one)
      const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, CHAT_SYNC.batch);
      const rows = await getMany(st, ids.filter(idOk).map((id) => `cvm:${id}`));
      const items = [];
      let chars = 0;
      for (const id of ids) {
        if (!idOk(id)) { items.push({ id: null, missing: true }); continue; }
        const r = rows.get(`cvm:${id}`);
        if (!r) { items.push({ id, missing: true }); continue; }
        if (r.deleted) { items.push({ id, rev: r.rev, deleted: true, updated: r.updated }); continue; }
        if (items.some((x) => x.record) && chars + (r.size || 0) > CHAT_SYNC.batchChars) break; // the rest: the next request
        chars += r.size || 0;
        items.push({ id, rev: r.rev, updated: r.updated, record: { iv: r.iv, ct: await chunks(st, id, r.n) } });
      }
      return json({ items });
    }
    case 'csync-put': {
      await noCopiesIfEndToEnd(st);
      const { error, out } = await putChat(st, await counters(st), body);
      if (error) throw error;
      return json(out);
    }
    case 'csync-delete': {
      if (!idOk(body.id)) throw bad('Which chat?');
      return json(await deleteChat(st, await counters(st), body.id));
    }
    case 'csync-batch': { // several deletes and puts in one call (the Worker checked the sizes); each answered on its own
      const deletes = Array.isArray(body.deletes) ? body.deletes.slice(0, CHAT_SYNC.batchDeletes) : [];
      const puts = Array.isArray(body.puts) ? body.puts.slice(0, CHAT_SYNC.batch) : [];
      if (puts.length) await noCopiesIfEndToEnd(st);
      const c = await counters(st);
      const gone = [];
      for (const id of deletes) gone.push(idOk(id) ? { id, ...(await deleteChat(st, c, id)) } : { id, code: 'bad_request', error: 'Which chat?' });
      const done = [];
      for (const p of puts) {
        const { error, out } = await putChat(st, c, p, { withRecord: true });
        done.push(error ? { id: p && typeof p === 'object' ? p.id : null, code: 'bad_request', error: error.message } : { id: p.id, ...out });
      }
      return json({ deletes: gone, puts: done });
    }
    case 'csync-wipe': { // "Delete all chats", or switching to end-to-end: every server copy, tombstones and the index included
      await wipeAll(st);
      const next = (await counters(st)).rev + 1;
      await st.put({ cvrev: next, cvwiped: next, cvcount: 0, cvbytes: 0 }); // devices see a revision they can't match: they start over (`wiped`)
      return json({ rev: next });
    }
    default: throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

// ── the Worker's side: /api/web/csync/<op> (a browser) and /api/csync/<op> (the apps) ──

const OPS = new Set(['status', 'list', 'get', 'getmany', 'put', 'delete', 'wipe', 'batch']);

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
  if (op === 'getmany') {
    // A new device's first downloads (cloud-sync.js): up to CHAT_SYNC.batch chats a request, one call to the account.
    if (!Array.isArray(body.ids) || body.ids.length > CHAT_SYNC.batch) throw bad(`Ask for up to ${CHAT_SYNC.batch} chats at once.`);
    const out = await go('getmany', { ids: body.ids });
    const items = [];
    for (const r of out.items) {
      if (!r.record) { items.push(r); continue; }
      const conv = await openWith(env, info(who.account), aadBody(who.account, r.id), r.record);
      items.push(conv ? { id: r.id, rev: r.rev, updated: r.updated, conv } : { id: r.id, error: 'unreadable' });
    }
    return json({ items });
  }
  if (op === 'batch') return json(await batchApi(env, who, body, go));
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

/**
 * csync/batch: { deletes: [id], puts: [{ id, conv, base_rev }] } in one request (a first upload of thousands of
 * chats was one request each): up to CHAT_SYNC.batch chats, their JSON up to batchChars together, and up to
 * batchDeletes deletes. Each is answered as its own delete or put would be, in order: { deletes: [{ id, rev }],
 * puts: [{ id, rev } | { id, conflict } | { id, code, error }] }. One call to the account for all of them.
 */
async function batchApi(env, who, body, go) {
  const deletes = body.deletes === undefined ? [] : body.deletes;
  const puts = body.puts === undefined ? [] : body.puts;
  if (!Array.isArray(deletes) || !Array.isArray(puts)) throw bad('Send deletes and puts as lists.');
  if (deletes.length > CHAT_SYNC.batchDeletes) throw bad(`At most ${CHAT_SYNC.batchDeletes} deletes at once.`);
  if (puts.length > CHAT_SYNC.batch) throw bad(`At most ${CHAT_SYNC.batch} chats at once.`);
  const results = [];
  const sealed = [];
  let chars = 0;
  for (const p of puts) {
    const c = p && p.conv;
    if (!p || !idOk(p.id) || !c || typeof c !== 'object' || c.id !== p.id || !c.nodes || typeof c.nodes !== 'object') { results.push({ id: p && idOk(p.id) ? p.id : null, code: 'bad_request', error: 'Send a conversation.' }); continue; }
    if (c.temp) { results.push({ id: p.id, code: 'bad_request', error: 'Temporary chats don’t sync.' }); continue; }
    const size = JSON.stringify(c).length;
    if (size > CHAT_SYNC.maxChars) { results.push({ id: p.id, code: 'too_big', error: 'That chat is too big to sync.' }); continue; }
    chars += size;
    if (chars > CHAT_SYNC.batchChars) throw new ApiError(413, 'too_big', 'Send fewer chats at once.');
    const record = await sealWith(env, info(who.account), aadBody(who.account, p.id), c);
    const meta = await sealWith(env, info(who.account), aadMeta(who.account, p.id), metaOf(c));
    results.push(null); // the account's answer goes here
    sealed.push({ id: p.id, record, meta, base_rev: p.base_rev, updated: c.updated });
  }
  const out = deletes.length || sealed.length ? await go('batch', { deletes, puts: sealed }) : { deletes: [], puts: [] };
  let k = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i]) continue;
    const r = out.puts[k++];
    if (r.conflict && r.conflict.record) {
      const { record, ...conflict } = r.conflict;
      const conv = await openWith(env, info(who.account), aadBody(who.account, r.id), record);
      results[i] = { id: r.id, conflict: { ...conflict, conv } };
    } else results[i] = r;
  }
  return { deletes: out.deletes, puts: results };
}

// ── bringing another sign-in's chats into this account ──
//
// Apple, Google and a passkey are separate Eden accounts until linked, so chats made under one
// aren't under another. When "Add Google" (or Apple) finds that identity already opens another
// account, the person has just proved they control it; session.js then mints a merge token for
// (this account, that account). With it the browser asks for the chats to be copied across, a few
// at a time: each is opened with the other account's key and sealed again under this one's.
// Nothing is deleted or moved: the other account keeps its copy, and only chats are copied.

export const MERGE_SECONDS = 900;
const MERGE_STEP = 25;
const mergeInfo = 'merge-token';
const aadMerge = (a) => `merge:${a}`;

/** A sealed grant for account `a` to read the chats of account `b` for a quarter of an hour. */
export async function mintMergeToken(env, a, b) {
  return sealWith(env, mergeInfo, aadMerge(a), { a, b, exp: Date.now() + MERGE_SECONDS * 1000 });
}
async function readMergeToken(env, a, token) {
  const grant = await openWith(env, mergeInfo, aadMerge(a), token);
  if (!grant || grant.a !== a || typeof grant.b !== 'string' || !(grant.exp > Date.now())) throw new ApiError(403, 'merge_expired', 'That took too long. Add the sign-in again to restart.');
  return grant;
}

/** The other account's side (Account object, `cmerge-*`): refuses unless the grant is for it. */
export async function chatMergeOp(account, op, request) {
  const body = await request.json().catch(() => ({}));
  const me = (await account.storage.get('account'))?.id;
  const grant = await readMergeToken(account.env, String(body.a || ''), body.token);
  if (!me || grant.b !== me) throw new ApiError(403, 'forbidden', 'Not this account’s to read.');
  const st = account.storage;
  switch (op) {
    case 'cmerge-status': return json({ count: (await st.get('cvcount')) || 0 });
    case 'cmerge-list': {
      const since = Math.max(0, Number(body.since) || 0);
      await ensureIndex(st, await st.get('cvidx'));
      const { rows, more } = await rowsAfter(st, since, MERGE_STEP, { live: true });
      return json({ more, items: rows.map((r) => ({ id: r.id, rev: r.rev })) });
    }
    case 'cmerge-get': {
      if (!idOk(body.id)) throw bad('Which chat?');
      const r = await st.get(`cvm:${body.id}`);
      if (!r || r.deleted) return json({ gone: true });
      return json({ record: { iv: r.iv, ct: await chunks(st, body.id, r.n) } });
    }
    default: throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

/** The Worker's side: POST /api/web/merge/preview and /step, for the signed-in browser. */
export async function chatMergeApi(request, env, who, op) {
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST it.');
  if (op !== 'preview' && op !== 'step') throw new ApiError(404, 'not_found', 'No such thing.');
  await limited(env, env.CSYNC_RATE ? 'CSYNC_RATE' : 'API_RATE', `merge:${who.account}`);
  const body = await readJson(request, 20_000);
  const a = who.account;
  const grant = await readMergeToken(env, a, body.token);
  if (grant.b === a) throw bad('That is this account.');
  const from = (name, extra = {}) => call(env, grant.b, name, { a, token: body.token, ...extra });
  // With the other account's short code (util.js accountCode), so the page can say which account that sign-in opens.
  if (op === 'preview') return json({ count: (await from('cmerge-status')).count, account_code: await accountCode(grant.b) });
  const list = await from('cmerge-list', { since: body.since });
  let copied = 0, skipped = 0, failed = 0, since = Number(body.since) || 0, firstError = '';
  for (const it of list.items) {
    since = it.rev;
    try {
      const got = await from('cmerge-get', { id: it.id });
      if (got.gone) continue;
      const conv = await openWith(env, info(grant.b), aadBody(grant.b, it.id), got.record);
      if (!conv || conv.id !== it.id || !conv.nodes || conv.temp) { failed++; continue; }
      const record = await sealWith(env, info(a), aadBody(a, it.id), conv);
      const meta = await sealWith(env, info(a), aadMeta(a, it.id), metaOf(conv));
      const out = await call(env, a, 'csync-put', { id: it.id, record, meta, base_rev: 0, updated: conv.updated }, who.token);
      if (out.conflict) skipped++; // this account already has that chat
      else if (out.code) { failed++; firstError ||= out.error || ''; if (out.code === 'too_many' || out.code === 'too_big') { return json({ copied, skipped, failed, since, done: true, error: out.error }); } }
      else copied++;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      failed++;
      if (error.code === 'end_to_end') return json({ copied, skipped, failed, since, done: true, error: error.message }); // none would go in
    }
  }
  return json({ copied, skipped, failed, since, done: !list.more, ...(firstError ? { error: firstError } : {}) });
}
