// App state: settings, conversations (a tree of messages, for branches and drafts),
// personas, and their persistence in localStorage. Image data is never persisted.

import { store, uid, toast } from './util.js';
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

/* ---------- whose chats these are (one browser, more than one account) ---------- */

/** askeden.com (and its preview and Edu hosts): a page with accounts, even when its meta call failed (account.js). */
export const ACCOUNT_HOST = typeof location !== 'undefined' && /(^|\.)(askeden\.com|askedenedu\.com)$/i.test(location.hostname || '');
// Each saved chat carries the account it belongs to (`account`; never sent: sync-model.js wire). Signing in to another
// account on this browser used to list the first account's chats and upload them into the second one. Now the
// other account's chats (its stubs too) are kept here but not listed, so no sync ever sees them, and they're back
// when it signs in again. A chat saved before this (no `account`) belongs to the first account that signs in.
const OWNER_KEY = 'jchat:account';
let owner = null; // the account askeden.com said this page is signed in to (claimChats)
let hint = store.get(OWNER_KEY, null); // the one the last page was, for the first paint until askeden.com answers
let others = []; // chats saved here under another account
const ours = (c) => ((owner || hint) ? !c.account || c.account === (owner || hint) : !c.account);
const tag = (c) => { if (owner && !c.account && !c.temp) c.account = owner; };
/**
 * Chats saved before chats had an account, that this browser synced with another account than `id`: id → that
 * account. The sync states (cloud-sync.js `jchat:csync:<account>`, sync.js `jchat:esync:<account>`) list each chat
 * an account sent or got here. Without this, the first account to sign in after the update took every one of them,
 * and uploaded them. A chat this account's own state lists stays its own (both hold it: brought in from one to the other).
 */
function syncedElsewhere(id) {
  const by = new Map();
  const mine = new Set();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const m = /^jchat:(csync|esync):(.+)$/.exec(localStorage.key(i) || '');
      if (!m) continue;
      const revs = (store.get(m[0], null) || {}).revs || {};
      for (const k of Object.keys(revs)) {
        const chat = m[1] === 'esync' ? (k.startsWith('eden/conv.') ? k.slice(10) : '') : k;
        if (!chat) continue;
        if (m[2] === id) mine.add(chat);
        else if (!by.has(chat)) by.set(chat, m[2]);
      }
    }
  } catch { /* storage blocked: nothing to go by */ }
  for (const chat of mine) by.delete(chat);
  return by;
}

/**
 * The account this page is signed in to (account.js, once /api/web/account answered): its chats are listed, any
 * other account's are put away, and chats that belong to nobody yet become its own. → true when the list changed.
 */
export function claimChats(id) {
  if (!id || typeof id !== 'string') return false;
  owner = id;
  if (hint !== id) store.set(OWNER_KEY, id);
  hint = id;
  // (an untagged chat another account synced here is that account's: put away with its account written in)
  const untagged = state.convs.filter((c) => !c.account && !c.temp);
  const elsewhere = untagged.length ? syncedElsewhere(id) : new Map();
  const theirs = untagged.filter((c) => elsewhere.has(c.id));
  for (const c of theirs) { c.account = elsewhere.get(c.id); Convs.put(stripForStorage(c)); }
  const away = state.convs.filter((c) => !ours(c));
  const back = others.filter(ours);
  state.convs = state.convs.filter(ours);
  for (const c of back) { const at = state.convs.findIndex((x) => (x.updated || 0) < (c.updated || 0)); if (at < 0) state.convs.push(c); else state.convs.splice(at, 0, c); }
  others = [...others.filter((c) => !ours(c)), ...away];
  for (const c of state.convs) if (!c.account && !c.temp) { tag(c); Convs.put(stripForStorage(c)); } // (once: written with its account)
  if (state.current && !state.convs.includes(state.current)) state.current = null;
  return away.length > 0 || back.length > 0;
}
/** Signed out (account.js, sync.js forgetAllKeys): the next page doesn't show this account's chats before askeden.com says who signed in. */
export function forgetOwner() { store.del(OWNER_KEY); hint = null; }
/**
 * A chat id this browser holds for another account (put away by claimChats). This account's sync leaves it alone:
 * storage keeps one record a chat id, and this account's copy written over it lost the other account's (its private
 * chats, pictures and turns not synced yet). Two accounts hold one id when chats were brought in from one to the other.
 */
export const heldElsewhere = (id) => others.some((c) => c.id === id);

/**
 * This browser is signed in to another account now (another tab signed in; askeden.com's 409 other_account): every
 * request from this page goes as that account, so its sync engines stop (`eden:other-account`: cloud-sync.js,
 * sync.js) until the page is reloaded, and the page says so once.
 */
let switched = false;
export function otherAccount() {
  if (switched) return;
  switched = true;
  try { toast('This browser is now signed in to another Eden account. Reload the page.'); } catch { /* no page (tests) */ }
  try { dispatchEvent(new CustomEvent('eden:other-account')); } catch { /* no window */ }
}
export const accountSwitched = () => switched;
// (another tab's claimChats wrote the account it signed in to)
if (typeof addEventListener === 'function') {
  addEventListener('storage', (e) => {
    if (!e || e.key !== OWNER_KEY || !owner || !e.newValue) return;
    let id = null;
    try { id = JSON.parse(e.newValue); } catch { return; }
    if (typeof id === 'string' && id && id !== owner) otherAccount();
  });
}

export async function loadConversations() {
  const out = [];
  for (const c of await Convs.loadAll()) {
    c.queue = [];
    c.status = c.status === 'running' ? 'idle' : (c.status || 'idle');
    // a turn that was streaming when the page closed
    for (const n of Object.values(c.nodes || {})) if (n.streaming) { n.streaming = false; n.finish = n.finish || 'aborted'; }
    out.push(c);
  }
  state.convs = out.filter(ours);
  others = out.filter((c) => !ours(c));
  store.set('jchat:index', out.filter((x) => !x.temp).map((x) => x.id));
}

function stripForStorage(c) {
  const copy = { ...c, queue: undefined, nodes: {} };
  delete copy.loading;
  delete copy.loadError;
  for (const [id, n] of Object.entries(c.nodes)) {
    const m = { ...n };
    if (m.attachments) m.attachments = m.attachments.map((a) => (a.kind === 'image' ? { kind: 'image', name: a.name, mime: a.mime, size: a.size } : a));
    copy.nodes[id] = m;
  }
  return copy;
}

let saveTimers = new Map(); // id -> { t: timer, write, c }
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
  if (!stored || stored.temp || !ours(stored)) return;
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

/**
 * What a write to this browser's storage came to (convstore.js put: true, 'backup' or false). Not kept at all:
 * `eden:conv-unsaved` (cloud-sync.js then doesn't count the chat as held here) and a warning, once a page.
 */
const warned = new Set();
function wrote(c, ok) {
  if (ok === true) return;
  if (!ok) {
    console.warn('Eden: could not save the conversation (storage full?)');
    try { dispatchEvent(new CustomEvent('eden:conv-unsaved', { detail: { id: c.id } })); } catch { /* no window */ }
  }
  const key = ok ? 'backup' : 'lost';
  if (warned.has(key)) return;
  warned.add(key);
  try { toast(ok ? 'This browser’s chat storage had a problem. A backup copy of your chat was kept on this device.' : 'Couldn’t save this chat on this device (is its storage full?). Keep this page open until it has synced.'); } catch { /* no page (tests) */ }
}

/** A chat's record written again as it is now, with nobody told (cloud-sync.js: the revision it was just synced at). */
export function rewriteConversation(c) {
  if (!c || c.temp || !state.convs.includes(c)) return Promise.resolve(false);
  tag(c);
  return Convs.put(stripForStorage(c)).then((ok) => { wrote(c, ok); return ok; });
}

/** Writes a conversation now without telling sync (a copy that came from another device). */
export function persistConversation(c) {
  tag(c);
  store.set('jchat:index', state.convs.filter((x) => !x.temp).map((x) => x.id));
  const done = Convs.put(stripForStorage(c));
  done.then((ok) => { wrote(c, ok); if (ok === true) tell('saved', c.id); });
  return done;
}
const writing = new Map(); // id -> the chat whose write to IndexedDB hasn't finished (onPageHide)
export function saveConversation(c, { now = false } = {}) {
  if (!c || c.temp) return;
  const write = () => {
    saveTimers.delete(c.id);
    if (!state.convs.includes(c)) return;
    tag(c);
    store.set('jchat:index', state.convs.filter((x) => !x.temp).map((x) => x.id));
    writing.set(c.id, c);
    const done = Convs.put(stripForStorage(c));
    lastWrite = done.then((ok) => { if (writing.get(c.id) === c) writing.delete(c.id); wrote(c, ok); if (ok === true) { store.del(`${Convs.PENDING}${c.id}`); tell('saved', c.id); } return ok; });
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
// Going away: an IndexedDB write started now (or a moment ago, still unfinished: a reply's last save is written
// at once) can be cut off by the unload, so each one also leaves a copy in localStorage (synchronous), which the
// next load takes (convstore.js loadAll) unless the write landed.
function onPageHide() {
  const going = new Map([...writing, ...[...saveTimers.values()].map(({ c }) => [c && c.id, c])]);
  for (const c of going.values()) if (c && state.convs.includes(c)) store.set(`${Convs.PENDING}${c.id}`, stripForStorage(c));
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
  if (c.temp) return;
  noteDelete(c.id, c.account || owner || hint);
  dispatchEvent(new CustomEvent('eden:conv-deleted', { detail: { id: c.id } })); // sync.js: a tombstone
}

/* ---------- deletes waiting for sync ---------- */

// A chat deleted before sync had started on this page (or while it was off, or couldn't start) came back from
// askeden.com: its delete was never kept. Every delete waits here, with the account the chat belonged to, until
// a sync engine for that account takes it (cloud-sync.js, sync.js: at once when one is running). Only on a page
// with accounts. Written once a tick ("Delete all chats" is many deletes).
const DELETES = 'jchat:deletes';
const MAX_DELETES = 2000;
let notedDeletes = [];
const storedDeletes = () => { const v = store.get(DELETES, []); return Array.isArray(v) ? v : []; };
function noteDelete(id, account) {
  if (!account && !ACCOUNT_HOST) return; // (the Mac's local server: no accounts, nothing to send them to)
  notedDeletes.push(account ? { id, account } : { id });
  if (notedDeletes.length > 1) return;
  queueMicrotask(() => {
    if (!notedDeletes.length) return;
    store.set(DELETES, [...storedDeletes(), ...notedDeletes].slice(-MAX_DELETES));
    notedDeletes = [];
  });
}
/** The deletes waiting for `account` (and those whose account isn't known), taken off the list: ids. */
export function takeDeletes(account) {
  const all = [...storedDeletes(), ...notedDeletes].filter((d) => d && typeof d.id === 'string');
  notedDeletes = [];
  if (!all.length) return [];
  const mine = all.filter((d) => !d.account || d.account === account);
  const rest = all.filter((d) => d.account && d.account !== account);
  if (rest.length) store.set(DELETES, rest); else store.del(DELETES);
  return [...new Set(mine.map((d) => d.id))];
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
