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

/** Two copies of one conversation as one: every message of both (by node id), the newer side's title and pins. */
export function merge(mine, theirs) {
  const out = { ...mine, nodes: { ...mine.nodes }, root: { ...mine.root, children: union(mine.root.children, theirs.root && theirs.root.children) } };
  const newer = (theirs.updated || 0) > (mine.updated || 0) ? theirs : mine;
  for (const k of ['title', 'titleSet', 'pinned', 'personaId', 'project', 'mode', 'kind', 'lastRoute', 'allowTools', 'todos', 'privacy']) if (k in newer) out[k] = newer[k];
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

/** A sidebar entry for a conversation not downloaded here yet. */
export function stub(meta) {
  return {
    id: meta.id, title: meta.title || 'New chat', titleSet: meta.titleSet, created: meta.created || 0, updated: meta.updated || 0, pinned: Boolean(meta.pinned),
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

/** True when `merged` holds something the server's copy `remote` doesn't (so it's worth pushing back). */
export function differs(remote, merged) {
  if ((merged.updated || 0) > (remote.updated || 0) || merged.title !== remote.title || Boolean(merged.pinned) !== Boolean(remote.pinned)) return true;
  const rn = remote.nodes || {};
  const ids = Object.keys(merged.nodes || {});
  if (ids.length !== Object.keys(rn).length) return true;
  return ids.some((id) => !rn[id] || (merged.nodes[id].children || []).length !== (rn[id].children || []).length);
}
