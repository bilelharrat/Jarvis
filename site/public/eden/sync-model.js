// The rules of chat sync with no browser in them (cloud-sync.js and sync.js use them; the tests
// load this file alone): merging two copies of a conversation, what a conversation sends, which
// ones sync at all, and what a pulled list asks of this device.

const textLen = (n) => (n.role === 'user' ? (n.content || '').length : (n.parts || []).reduce((t, p) => t + (p.text ? p.text.length : 0), 0));
export function better(a, b) {
  if (a.streaming && !b.streaming) return b;
  if (b.streaming && !a.streaming) return a;
  if (b.finish && !a.finish) return b;
  return textLen(b) > textLen(a) ? b : a;
}
export const union = (a = [], b = []) => [...a, ...b.filter((x) => !a.includes(x))];

/** A chat's shared-link records (share.js) from two copies, by id; once revoked on either side, revoked. */
export function mergeShares(a = [], b = []) {
  const m = new Map();
  for (const s of [...(a || []), ...(b || [])]) {
    if (!s || !s.id) continue;
    const prev = m.get(s.id);
    m.set(s.id, prev ? { ...prev, ...s, ...(prev.revoked || s.revoked ? { revoked: true } : {}) } : s);
  }
  return [...m.values()];
}

/** A chat's shared links that still open: not revoked, not expired. */
export const liveShares = (c, now = Date.now()) => (c && Array.isArray(c.shares) ? c.shares.filter((s) => s && !s.revoked && !(s.expires && s.expires < now)) : []);

/**
 * Two copies of one conversation as one: every message of both (by node id), the newer side's
 * settings. A rename, pin, persona or folder change stamps `metaAt` without touching `updated`
 * (app.js, folders-model.js setFolder), so those go by `metaAt` when the two copies' stamps differ,
 * and by `updated` as before when they don't (copies from before the stamp existed).
 */
export function merge(mine, theirs) {
  const out = { ...mine, nodes: { ...mine.nodes }, root: { ...mine.root, children: union(mine.root.children, theirs.root && theirs.root.children) } };
  const newer = (theirs.updated || 0) > (mine.updated || 0) ? theirs : mine;
  const meta = (theirs.metaAt || 0) > (mine.metaAt || 0) ? theirs : mine; // a folder move doesn't touch `updated`
  const named = (theirs.metaAt || 0) !== (mine.metaAt || 0) ? meta : newer;
  if (meta.folder) out.folder = meta.folder; else delete out.folder;
  out.metaAt = Math.max(mine.metaAt || 0, theirs.metaAt || 0) || undefined;
  if (mine.shares || theirs.shares) out.shares = mergeShares(mine.shares, theirs.shares); // Q3: shared links made on either device; revoked stays revoked
  for (const k of ['title', 'titleSet', 'pinned', 'personaId']) if (k in named) out[k] = named[k];
  for (const k of ['project', 'mode', 'kind', 'lastRoute', 'allowTools', 'todos', 'privacy', 'deckVersions']) if (k in newer) out[k] = newer[k];
  out.updated = Math.max(mine.updated || 0, theirs.updated || 0);
  for (const [id, n] of Object.entries(theirs.nodes || {})) {
    const m = out.nodes[id];
    if (!m) { out.nodes[id] = n; continue; }
    const pick = better(m, n);
    out.nodes[id] = { ...pick, children: union(m.children, n.children), sel: m.sel };
  }
  return out;
}

/** A conversation as it travels and is stored: image data never included (only a placeholder). */
export function wire(c, { slim = false } = {}) {
  const out = { ...c, queue: undefined, status: 'idle', nodes: {} };
  delete out.queue;
  delete out.remote;
  delete out.loading;
  delete out.deckImages; // Q14: a deck's pictures stay on the device they were added on (deck.js); the slides say so elsewhere
  delete out.images; // the chat's pictures (image-tool.js) stay on the device that made them; its card says so elsewhere
  for (const [id, n] of Object.entries(c.nodes || {})) {
    const m = { ...n };
    if (m.attachments) {
      m.attachments = m.attachments.map((a) => (a.kind === 'image' ? { kind: 'image', name: a.name, mime: a.mime, size: a.size } : slim && a.kind === 'text' ? { kind: 'text', name: a.name, text: '', dropped: true } : a));
    }
    if (m.streaming) { m.streaming = false; m.finish = m.finish || 'aborted'; }
    out.nodes[id] = m;
  }
  return out;
}

export const MAX_JSON = 450_000; // end-to-end items
export const MAX_ACCOUNT_JSON = 1_400_000; // sealed by askeden.com

/** { value, text } to send, or null when it's too big even without text attachments' contents. */
export function payload(c, max = MAX_JSON) {
  let w = wire(c);
  let text = JSON.stringify(w);
  if (text.length > max) { w = wire(c, { slim: true }); text = JSON.stringify(w); }
  return text.length > max ? null : { conv: w, text };
}

/** Whether a conversation syncs: never a temporary chat, one still being filled in, or an empty one. */
export const syncable = (c, streaming = false) => Boolean(c && !c.temp && !c.remote && !streaming && c.nodes && Object.keys(c.nodes).length && /^[A-Za-z0-9._:-]{1,120}$/.test(c.id || ''));

/**
 * A chat title as a rename leaves it (folders-model.js cleanTitle, AS13): one line, no control characters, no bidi
 * overrides or isolates, at most `max`. Used on titles that come from another device (bug sweep AS2-9). (Kept here
 * as well because this file is loaded alone, with no imports.)
 */
export const cleanTitle = (raw, max = 120) => String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/** A sidebar entry for a conversation not downloaded here yet. */
export function stub(meta) {
  return {
    id: meta.id, title: cleanTitle(meta.title) || 'New chat', titleSet: meta.titleSet, created: meta.created || 0, updated: meta.updated || 0, pinned: Boolean(meta.pinned), folder: meta.folder || undefined, metaAt: meta.metaAt || undefined,
    temp: false, kind: meta.kind || 'chat', project: meta.project || null, sessionId: null, personaId: meta.personaId || null, mode: meta.kind === 'code' ? 'default' : 'chat',
    nodes: {}, root: { children: [], sel: 0 }, lastRoute: null, allowTools: [], todos: [], queue: [], status: 'idle', remote: true,
  };
}

/**
 * What a pulled list asks of this device. `items` from the server ({ id, rev, deleted, meta }),
 * `known` { id: rev } this device has already merged, `have` Map id → conversation.
 * → { remove: [ids], stubs: [meta], fetch: [ids] } (fetch: newest first).
 */
export function planList(items, known, have, busy = new Set()) {
  const remove = [], stubs = [], fetch = [];
  for (const it of items) {
    const mine = have.get(it.id);
    if (it.deleted) { if (mine && !busy.has(it.id)) remove.push(it.id); continue; }
    if (!it.meta || busy.has(it.id)) continue;
    if (!mine) { stubs.push(it.meta); fetch.push(it); continue; }
    if (known[it.id] !== it.rev && !mine.remote) fetch.push(it);
  }
  fetch.sort((a, b) => (b.meta.updated || 0) - (a.meta.updated || 0));
  return { remove, stubs, fetch: fetch.map((x) => x.id) };
}

/** A put that lost the race for a conversation: what to do. `conflict` from the server. */
export function onConflict(mine, conflict) {
  if (conflict.deleted) return mine.updated > (conflict.updated || 0) ? { action: 'resurrect', rev: conflict.rev } : { action: 'drop' };
  return { action: 'merge', rev: conflict.rev };
}

/** What "this copy changed" is measured by: a new message (`updated`) or a rename, pin or move (`metaAt`). */
export const stampOf = (c) => Math.max((c && c.updated) || 0, (c && c.metaAt) || 0);

/** True when `merged` holds something the server's copy `remote` doesn't (so it's worth pushing back). */
export function differs(remote, merged) {
  if ((merged.updated || 0) > (remote.updated || 0) || (merged.metaAt || 0) > (remote.metaAt || 0) || merged.title !== remote.title || Boolean(merged.pinned) !== Boolean(remote.pinned) || (merged.folder || '') !== (remote.folder || '')) return true;
  const rn = remote.nodes || {};
  const ids = Object.keys(merged.nodes || {});
  if (ids.length !== Object.keys(rn).length) return true;
  return ids.some((id) => !rn[id] || (merged.nodes[id].children || []).length !== (rn[id].children || []).length);
}

/**
 * Two tabs of one browser keep one saved sync state in localStorage (bug sweep AS2-2). Before a pass and before it
 * saves, a tab takes in what another tab saved meanwhile: deletes still to send (less those this tab already had
 * answered: `sent`), and the revision another tab reached for a chat this tab holds exactly as that tab sent it
 * (`stampHere(id)` equals the stamp it saved), so the same edit isn't uploaded twice; a chat this tab holds only as a
 * stub (`stampHere` null) takes it too (so one tab's save doesn't drop what another knows). A chat this tab changed since
 * keeps its own revision (its put then conflicts and merges, as before). Only between states of the same
 * generation (`gen`: a wipe or a restart makes a new one). `keyOf(id)`: the revs key of a chat (sync.js
 * 'eden/conv.<id>'). → the ids whose revision was taken.
 */
export function takeIn(local, stored, { sent = new Set(), keyOf = (id) => id, stampHere = () => undefined } = {}) {
  const took = [];
  if (!local || !stored || typeof stored !== 'object' || stored.gen !== local.gen) return took;
  const theirs = Array.isArray(stored.deleted) ? stored.deleted.filter((id) => typeof id === 'string' && !sent.has(id)) : [];
  if (theirs.length) local.deleted = union(local.deleted || [], theirs);
  const revs = stored.revs || {};
  for (const [id, at] of Object.entries(stored.seen || {})) {
    const key = keyOf(id);
    const rev = revs[key];
    if (!rev || rev <= ((local.revs || {})[key] || 0) || at === undefined) continue;
    // a chat this tab holds: only as that tab sent it; one it holds only as a stub (`null`): unless this tab knows one
    // already; one it doesn't hold (`undefined`: deleted or dropped here, or never seen): never
    const here = stampHere(id);
    if (here === undefined || (here === null ? (local.revs || {})[key] !== undefined : here !== at)) continue;
    (local.revs ||= {})[key] = rev;
    (local.seen ||= {})[id] = at;
    if (stored.hashes && stored.hashes[key]) (local.hashes ||= {})[key] = stored.hashes[key];
    took.push(id);
  }
  return took;
}
