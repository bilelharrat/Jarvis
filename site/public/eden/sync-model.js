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

/**
 * Two copies of one conversation as one: every message of both (by node id), the newer side's
 * settings. A rename, pin, persona or folder change stamps `metaAt` without touching `updated`
 * (app.js, folders-model.js setFolder), so those go by `metaAt` when the two copies' stamps differ,
 * and by `updated` as before when they don't (copies from before the stamp existed). Both stamps equal
 * and the values not: the same copy wins on both devices, by its values (a rename or pin from before
 * `metaAt` kept each device's own, and the two sent theirs to each other on every pass, for ever).
 */
const tie = (mine, theirs, valueOf) => (valueOf(theirs) > valueOf(mine) ? theirs : mine);
const nameOf = (c) => JSON.stringify([String(c.title ?? ''), Boolean(c.titleSet), Boolean(c.pinned), String(c.personaId ?? '')]);
export function merge(mine, theirs) {
  const out = { ...mine, nodes: { ...mine.nodes }, root: { ...mine.root, children: union(mine.root.children, theirs.root && theirs.root.children) } };
  const newer = (theirs.updated || 0) > (mine.updated || 0) ? theirs : mine;
  const sameAt = (theirs.metaAt || 0) === (mine.metaAt || 0);
  const meta = (theirs.metaAt || 0) > (mine.metaAt || 0) ? theirs : sameAt ? tie(mine, theirs, (c) => String(c.folder || '')) : mine; // a folder move doesn't touch `updated`
  const tied = sameAt && (theirs.updated || 0) === (mine.updated || 0);
  const named = !sameAt ? meta : !tied ? newer : tie(mine, theirs, nameOf);
  if (meta.folder) out.folder = meta.folder; else delete out.folder;
  out.metaAt = Math.max(mine.metaAt || 0, theirs.metaAt || 0) || undefined;
  if (mine.shares || theirs.shares) out.shares = mergeShares(mine.shares, theirs.shares); // Q3: shared links made on either device; revoked stays revoked
  for (const k of ['title', 'titleSet', 'pinned', 'personaId']) if (k in named) out[k] = named[k]; else if (tied) delete out[k]; // (a tie: all of the winner's, so both devices agree)
  for (const k of ['project', 'mode', 'kind', 'lastRoute', 'allowTools', 'todos', 'privacy']) if (k in newer) out[k] = newer[k];
  // Q14: a deck's versions only ever get added, so both copies' are kept (two tabs editing at once lost one tab's
  // edit when the newer copy's list replaced the other's), and both copies' pictures (they never travel: wire)
  if (mine.deckVersions || theirs.deckVersions) out.deckVersions = newer === theirs ? mergeVersions(mine.deckVersions, theirs.deckVersions) : mergeVersions(theirs.deckVersions, mine.deckVersions);
  if (mine.deckImages || theirs.deckImages) out.deckImages = { ...(theirs.deckImages || {}), ...(mine.deckImages || {}) };
  if (out.deckVersions) out.deckVersions = foldComments(out.deckVersions, [mine.deckVersions, theirs.deckVersions]); // a deck's comments from both copies (each may have written them into the same version), on its newest version (deck-comments.js)
  out.updated = Math.max(mine.updated || 0, theirs.updated || 0);
  for (const [id, n] of Object.entries(theirs.nodes || {})) {
    const m = out.nodes[id];
    if (!m) { out.nodes[id] = n; continue; }
    const pick = better(m, n);
    out.nodes[id] = { ...pick, children: union(m.children, n.children), sel: m.sel };
    if (pick.attachments) out.nodes[id].attachments = withTexts(pick.attachments, (pick === m ? n : m).attachments);
  }
  return out;
}

const MAX_DECK_VERSIONS = 40; // deck-model.js MAX_VERSIONS
// A version's identity: its id (deck-model.js addVersion), else when it was made, how, from which reply. Its deck can
// change in place (pictures filled in after it was made: deck.js), so the content is not part of it.
const versionKey = (v) => v.id || `${v.at || 0}:${v.kind || ''}:${v.nodeId || ''}`;
/** Both lists of deck versions as one, in time order, each version once (`newer`'s copy of it), the newest 40. */
export function mergeVersions(older, newer) {
  const m = new Map();
  for (const v of [...(Array.isArray(older) ? older : []), ...(Array.isArray(newer) ? newer : [])]) if (v && typeof v === 'object') m.set(versionKey(v), v);
  const all = [...m.values()].sort((x, y) => (x.at || 0) - (y.at || 0));
  let drop = all.length - MAX_DECK_VERSIONS; // the oldest go, but named (pinned) versions stay (deck-model.js capVersions)
  return drop > 0 ? all.filter((v, k) => !(drop > 0 && !v.pinned && k < all.length - 1 && drop--)) : all;
}

/**
 * A text attachment one copy dropped to fit (wire `slim`: `dropped`, no text) and the other copy still holds: the
 * full one is kept (a big chat merged with another device's slimmed copy lost its attachments' contents here).
 */
function withTexts(picked, other) {
  if (!Array.isArray(picked) || !Array.isArray(other)) return picked;
  return picked.map((a, i) => {
    const o = other[i];
    return a && a.dropped && o && !o.dropped && o.kind === a.kind && o.name === a.name && typeof o.text === 'string' ? o : a;
  });
}

/** A conversation as it travels and is stored: image data never included (only a placeholder). */
export function wire(c, { slim = false } = {}) {
  const out = { ...c, queue: undefined, status: 'idle', nodes: {} };
  delete out.queue;
  delete out.remote;
  delete out.loading;
  delete out.loadError;
  delete out.account; // whose chat it is on this device (state.js): the account it's synced to knows
  delete out.syncRev; // the revision the copy stored here is based on (cloud-sync.js)
  delete out.deckImages; // Q14: a deck's pictures stay on the device they were added on (deck.js); the slides say so elsewhere
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

/**
 * Whether a conversation syncs: never a temporary chat, one still being filled in, an empty one, or a private one
 * (privacy.js: "Private: this chat stays on this iPhone" / "on your Mac", so it never goes to askeden.com).
 */
export const syncable = (c, streaming = false) => Boolean(c && !c.temp && !c.remote && c.privacy !== true && !streaming && c.nodes && Object.keys(c.nodes).length && /^[A-Za-z0-9._:-]{1,120}$/.test(c.id || ''));

/**
 * A chat title from another device, cleaned (bug sweep AS2-9: an older page or an import could send any characters):
 * one line, no control characters, no bidi overrides or isolates, at most `max`. (Here because this file is loaded
 * alone, with no imports.)
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

/** True when a stub's sidebar entry (its title, pin, folder, place) is behind the list's `meta` for it. */
function stubBehind(s, meta) {
  const next = stub(meta);
  return ['title', 'titleSet', 'updated', 'pinned', 'folder', 'metaAt', 'personaId'].some((k) => (next[k] ?? null) !== (s[k] ?? null));
}

/**
 * What a pulled list asks of this device. `items` from the server ({ id, rev, deleted, meta }),
 * `known` { id: rev } this device has already merged, `have` Map id → conversation, `busy` ids
 * left alone (a reply streaming, a private chat).
 * → { remove: [ids], stubs: [meta], restub: [meta], fetch: [ids] } (fetch: newest first). `restub`: chats
 * listed here but not downloaded yet whose entry changed elsewhere (a rename, pin, move or new message):
 * the entry takes it now (it kept its old title and place until it was opened).
 */
export function planList(items, known, have, busy = new Set()) {
  const remove = [], stubs = [], fetch = [], restub = [];
  for (const it of items) {
    const mine = have.get(it.id);
    if (it.deleted) { if (mine && !busy.has(it.id)) remove.push(it.id); continue; }
    if (!it.meta || busy.has(it.id)) continue;
    if (!mine) { stubs.push(it.meta); fetch.push(it); continue; }
    if (known[it.id] === it.rev) continue;
    if (mine.remote && !Object.keys(mine.nodes || {}).length && stubBehind(mine, it.meta)) restub.push(it.meta);
    fetch.push(it);
  }
  fetch.sort((a, b) => (b.meta.updated || 0) - (a.meta.updated || 0));
  return { remove, stubs, restub, fetch: fetch.map((x) => x.id) };
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

/*
 * A deck's comments (deck.comments, deck-comments-model.js) from two copies as one: every thread and reply of both, by
 * id; a thread's own fields (text, resolved, task, deleted) from the copy changed last (`edited`, then the larger copy
 * so both sides agree); replies the same, one by one. A deleted thread stays as a tombstone so it never comes back.
 */
const stampC = (x) => Number(x && (x.edited || x.at)) || 0;
const later = (a, b) => (stampC(b) > stampC(a) ? b : stampC(b) < stampC(a) ? a : JSON.stringify(b) > JSON.stringify(a) ? b : a);
const byTime = (x, y) => (stampC({ at: x.at }) - stampC({ at: y.at })) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
export const MAX_COMMENTS = 300; // deck-comments-model.js LIMITS.threads + room for tombstones
export function mergeComments(a = [], b = []) {
  const m = new Map();
  for (const t of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string') continue;
    const prev = m.get(t.id);
    if (!prev) { m.set(t.id, t); continue; }
    const win = later(prev, t);
    if (win.deleted) { m.set(t.id, win); continue; }
    const rs = new Map();
    for (const r of [...(prev.replies || []), ...(t.replies || [])]) if (r && typeof r.id === 'string') rs.set(r.id, rs.has(r.id) ? later(rs.get(r.id), r) : r);
    const replies = [...rs.values()].sort(byTime);
    m.set(t.id, { ...win, ...(replies.length ? { replies } : {}) });
  }
  const all = [...m.values()].sort(byTime);
  if (all.length <= MAX_COMMENTS) return all;
  const dead = all.filter((t) => t.deleted).slice(0, all.length - MAX_COMMENTS); // the oldest tombstones go first
  return all.filter((t) => !dead.includes(t)).slice(-MAX_COMMENTS);
}

/** Every version's comments (and those of the version lists in `also`) merged onto the newest version (a copy; the list is returned as is when none has any). */
export function foldComments(versions, also = []) {
  if (!Array.isArray(versions) || !versions.length) return versions;
  let all = null;
  for (const v of [...versions, ...also.flatMap((x) => (Array.isArray(x) ? x : []))]) if (v && v.deck && Array.isArray(v.deck.comments) && v.deck.comments.length) all = mergeComments(all || [], v.deck.comments);
  if (!all) return versions;
  const last = versions.at(-1);
  if (!last || !last.deck || JSON.stringify(last.deck.comments || []) === JSON.stringify(all)) return versions;
  return [...versions.slice(0, -1), { ...last, deck: { ...last.deck, comments: all } }];
}

/** What a conversation's deck comments are, to compare two copies (state.js writes a merge back when they differ). */
export const commentsKey = (c) => { const v = c && Array.isArray(c.deckVersions) ? c.deckVersions.at(-1) : null; return JSON.stringify((v && v.deck && v.deck.comments) || []); };
