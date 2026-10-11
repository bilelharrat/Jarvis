// App state: settings, conversations (a tree of messages, for branches and drafts),
// personas, and their persistence in localStorage. Image data is never persisted.

import { store, uid } from './util.js';
import * as Convs from './convstore.js';

export const DEFAULT_SETTINGS = {
  level: 3, efficiency: 50, performance: 50, linked: true,
  providers: {}, // id -> false when switched off (missing = on)
  classifier: 'always', subscriptionClaude: true,
  override: null, // { model, effort }
  theme: 'system',
};

export const state = {
  meta: null,
  metaError: null,
  settings: { ...DEFAULT_SETTINGS, ...store.get('jchat:settings', {}) },
  convs: [],
  current: null,
  personas: store.get('jchat:personas', []),
  projects: [],
  jarvis: { available: false, reason: 'Checking…' },
  streams: new Map(), // conv id -> { abort(), node, kind }
  selectedNode: null, // for the inspector's Route tab
  preview: null, // the router's live pick for the composer text (and, in Compare mode, the compare estimate)
  turnOverride: null, // { model, effort }: a pick from the estimate line, for the next message only (compare.js)
  draftContext: [], // context blocks for the next send: { title, text, kind }
  draftPersona: undefined, // persona chosen in the composer before a conversation exists
};

/** Hooks the modules fill in (keeps imports one-way). */
export const ui = {
  render: () => {}, renderSidebar: () => {}, renderTitle: () => {}, renderComposer: () => {},
  updateMessage: () => {}, renderInspector: () => {}, renderPlan: () => {}, loadChanges: () => {},
};

export function saveSettings() { store.set('jchat:settings', state.settings); }
export function savePersonas() { store.set('jchat:personas', state.personas); }

// in-memory attachment data (images, by message id): never written to storage
export const attachmentData = new Map();

/* ---------- conversations ---------- */

export function newConversation({ kind = 'chat', project = null, temp = false, personaId = null } = {}) {
  const now = Date.now();
  return {
    id: uid('c'), title: kind === 'code' ? `${project ? project.name : 'Code'} session` : 'New chat', titleSet: false,
    created: now, updated: now, pinned: false, temp, kind, project, sessionId: null, personaId,
    mode: kind === 'code' ? 'default' : 'chat',
    nodes: {}, root: { children: [], sel: 0 },
    lastRoute: null, allowTools: [], todos: [], queue: [], status: 'idle',
  };
}

/**
 * The sidebar's list records (convstore.js loadList), for a first paint before the bodies load (app.js): stand-ins
 * the sidebar alone draws, never put in state.convs or saved. Null when there are none (a first visit, no IndexedDB).
 */
export async function loadListRecords() {
  try { return await Convs.loadList(); } catch { return null; }
}
// After a full load, when the page is idle: the list records made to match what was loaded (only chats still here).
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 5000 }) : Promise.resolve().then(fn));
let reconciled = null;
/** Resolves once the list records match the last load (the tests wait for it). */
export const listReconciled = () => reconciled || Promise.resolve(0);

export async function loadConversations() {
  const out = [];
  for (const c of await Convs.loadAll()) {
    c.queue = [];
    c.status = c.status === 'running' ? 'idle' : (c.status || 'idle');
    // a turn that was streaming when the page closed
    for (const n of Object.values(c.nodes || {})) if (n.streaming) { n.streaming = false; n.finish = n.finish || 'aborted'; }
    out.push(c);
  }
  state.convs = out;
  store.set('jchat:index', out.filter((x) => !x.temp).map((x) => x.id));
  reconciled = new Promise((resolve) => idle(() => {
    Convs.reconcileList(out.filter((c) => !c.temp && state.convs.includes(c))).then(resolve, () => resolve(0));
  }));
}

function stripForStorage(c) {
  const copy = { ...c, queue: undefined, nodes: {} };
  delete copy.loading;
  for (const [id, n] of Object.entries(c.nodes)) {
    const m = { ...n };
    if (m.attachments) m.attachments = m.attachments.map((a) => (a.kind === 'image' ? { kind: 'image', name: a.name, mime: a.mime, size: a.size } : a));
    copy.nodes[id] = m;
  }
  return copy;
}

let saveTimers = new Map(); // id -> { t: timer, write }
let lastWrite = Promise.resolve(true);
/** Resolves (true when kept) once the latest save reached this browser's storage (the importer checks it). */
export const flushed = () => lastWrite;
/* Other tabs of this page (bug sweep AS5): each save and delete is told to them, so a tab never
   writes back a chat another tab deleted, and shows chats another tab made or changed. */
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('eden-convs') : null;
const tell = (type, id) => { try { if (channel) channel.postMessage({ type, id }); } catch { /* closed */ } };
if (channel) { channel.onmessage = (e) => { fromOtherTab(e.data).catch(() => {}); }; if (typeof channel.unref === 'function') channel.unref(); } // (unref: Node, in the tests)
async function fromOtherTab(m) {
  if (!m || typeof m.id !== 'string') return;
  const mine = state.convs.find((x) => x.id === m.id);
  if (mine && state.streams.has(m.id)) return; // a reply is being written here: this tab's copy goes on
  if (m.type === 'deleted') {
    Convs.listSaw(m.id, null); // (a tab on older code doesn't keep the sidebar's list records)
    if (!mine) return;
    const pending = saveTimers.get(m.id);
    if (pending) { clearTimeout(pending.t); saveTimers.delete(m.id); }
    state.convs = state.convs.filter((x) => x !== mine);
    if (state.current === mine) { state.current = null; ui.render(); }
    ui.renderSidebar();
    return;
  }
  if (m.type !== 'saved') return;
  const stored = await Convs.get(m.id);
  if (!stored || stored.temp) return;
  Convs.listSaw(m.id, stored);
  stored.queue = [];
  stored.status = 'idle';
  const now = state.convs.find((x) => x.id === m.id);
  if (!now) {
    const at = state.convs.findIndex((x) => (x.updated || 0) < (stored.updated || 0));
    if (at < 0) state.convs.push(stored); else state.convs.splice(at, 0, stored);
  } else {
    // Both tabs' messages (by id), the newer side's title and pins (sync-model.js merge); the object stays the same.
    const { merge } = await import('./sync-model.js'); // (loaded only when another tab is open)
    const merged = merge(now, stored);
    for (const k of Object.keys(now)) if (!(k in merged) && k !== 'queue' && k !== 'status') delete now[k];
    Object.assign(now, merged, { queue: now.queue || [], status: now.status || 'idle' });
    if (state.current === now) ui.render();
  }
  ui.renderSidebar();
}

/** Writes a conversation now without telling sync (a copy that came from another device). */
export function persistConversation(c) {
  store.set('jchat:index', state.convs.filter((x) => !x.temp).map((x) => x.id));
  const done = Convs.put(stripForStorage(c));
  done.then((ok) => { if (ok !== false) tell('saved', c.id); });
  return done;
}
export function saveConversation(c, { now = false } = {}) {
  if (!c || c.temp) return;
  const write = () => {
    saveTimers.delete(c.id);
    if (!state.convs.includes(c)) return;
    store.set('jchat:index', state.convs.filter((x) => !x.temp).map((x) => x.id));
    lastWrite = Convs.put(stripForStorage(c)).then((ok) => { if (!ok) console.warn('Eden: could not save the conversation (storage full?)'); else { store.del(`${Convs.PENDING}${c.id}`); tell('saved', c.id); } return ok; });
    dispatchEvent(new CustomEvent('eden:conv-saved', { detail: { id: c.id } })); // Eden sync (sync.js) pushes it
  };
  const pending = saveTimers.get(c.id);
  if (pending) clearTimeout(pending.t);
  if (now) write(); else saveTimers.set(c.id, { t: setTimeout(write, 300), write, c });
}

/** Every save still waiting out its 300 ms, now (the page is going away or hidden: bug sweep AS4). */
export function flushSaves() {
  for (const { t, write } of [...saveTimers.values()]) { clearTimeout(t); write(); }
}
// Going away: an IndexedDB write started now can be cut off by the unload, so each one also leaves a
// copy in localStorage (synchronous), which the next load takes (convstore.js loadAll) unless the write landed.
function onPageHide() {
  for (const { c } of saveTimers.values()) if (c && state.convs.includes(c)) store.set(`${Convs.PENDING}${c.id}`, stripForStorage(c));
  flushSaves();
}
if (typeof addEventListener === 'function') addEventListener('pagehide', onPageHide);
if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(); });
}

export function addConversation(c) {
  state.convs.unshift(c);
  saveConversation(c, { now: true });
}

export function deleteConversation(c) {
  state.convs = state.convs.filter((x) => x !== c);
  const pending = saveTimers.get(c.id);
  if (pending) { clearTimeout(pending.t); saveTimers.delete(c.id); }
  store.del(`${Convs.PENDING}${c.id}`);
  Convs.del(c.id).then(() => { if (!c.temp) tell('deleted', c.id); });
  store.set('jchat:index', state.convs.filter((x) => !x.temp).map((x) => x.id));
  if (!c.temp) dispatchEvent(new CustomEvent('eden:conv-deleted', { detail: { id: c.id } })); // sync.js: a tombstone
}

/* ---------- the message tree ---------- */

export function parentOf(c, node) { return node.parent ? c.nodes[node.parent] : c.root; }
export function siblings(c, node) { return parentOf(c, node).children; }

export function addNode(c, parentId, node) {
  const n = { id: uid('m'), parent: parentId || null, children: [], sel: 0, created: Date.now(), ...node };
  c.nodes[n.id] = n;
  const p = parentId ? c.nodes[parentId] : c.root;
  p.children.push(n.id);
  p.sel = p.children.length - 1;
  c.updated = Date.now();
  return n;
}

/** The visible path: from the root, following each node's selected child. */
export function path(c) {
  const out = [];
  if (!c) return out;
  let p = c.root;
  while (p.children.length) {
    const id = p.children[Math.min(p.sel, p.children.length - 1)];
    const n = c.nodes[id];
    if (!n) break;
    out.push(n);
    p = n;
  }
  return out;
}

export function selectSibling(c, node, delta) {
  const p = parentOf(c, node);
  const i = p.children.indexOf(node.id);
  const j = i + delta;
  if (j < 0 || j >= p.children.length) return null;
  p.sel = j;
  return c.nodes[p.children[j]];
}

export function nodeText(n) {
  if (!n) return '';
  if (n.role === 'user') return n.content || '';
  return (n.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
}

export function sessionCost(c) {
  let total = 0;
  const turns = [];
  for (const n of path(c)) {
    if (n.role !== 'assistant') continue;
    const v = n.usage && typeof n.usage.costUSD === 'number' ? n.usage.costUSD : null;
    if (v !== null) { total += v; turns.push(v); }
  }
  return { total, turns, notional: path(c).some((n) => n.usage && n.usage.notional) };
}

export function persona(id) { return state.personas.find((p) => p.id === id) || null; }

export function conversationMarkdown(c) {
  const lines = [`# ${c.title}`, ''];
  const p = persona(c.personaId);
  if (p) lines.push(`_Persona: ${p.name}_`, '');
  for (const n of path(c)) {
    if (n.role === 'user') {
      lines.push('## You', '', n.content || '');
      if (n.attachments && n.attachments.length) lines.push('', `_Attachments: ${n.attachments.map((a) => a.name).join(', ')}_`);
      lines.push('');
    } else {
      const who = n.route ? `${n.route.modelName || n.route.model}${n.route.effortLabel ? ` · ${n.route.effortLabel}` : ''}` : 'Eden';
      lines.push(`## ${who}`, '');
      for (const part of n.parts || []) {
        if (part.type === 'text') lines.push(part.text);
        else if (part.type === 'tool') lines.push('', `> Tool: ${part.name} ${summarizeInput(part.input)}`, '');
      }
      if (n.citations && n.citations.length) lines.push('', 'Sources:', ...n.citations.map((s, i) => `${i + 1}. [${s.title || s.url}](${s.url})`));
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  return input.file_path || input.path || input.command || input.pattern || input.url || input.query || input.description || '';
}
