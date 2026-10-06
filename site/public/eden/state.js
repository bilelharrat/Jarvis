// App state: settings, conversations (a tree of messages, for branches and drafts),
// personas, and their persistence in localStorage. Image data is never persisted.

import { store, uid } from './util.js';

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
  preview: null, // the router's live pick for the composer text
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

export function loadConversations() {
  const ids = store.get('jchat:index', []);
  const out = [];
  for (const id of ids) {
    const c = store.get(`jchat:conv:${id}`, null);
    if (c && c.id) {
      c.queue = [];
      c.status = c.status === 'running' ? 'idle' : (c.status || 'idle');
      // a turn that was streaming when the page closed
      for (const n of Object.values(c.nodes || {})) if (n.streaming) { n.streaming = false; n.finish = n.finish || 'aborted'; }
      out.push(c);
    }
  }
  state.convs = out;
}

function stripForStorage(c) {
  const copy = { ...c, queue: undefined, nodes: {} };
  for (const [id, n] of Object.entries(c.nodes)) {
    const m = { ...n };
    if (m.attachments) m.attachments = m.attachments.map((a) => (a.kind === 'image' ? { kind: 'image', name: a.name, mime: a.mime, size: a.size } : a));
    copy.nodes[id] = m;
  }
  return copy;
}

let saveTimers = new Map();
export function saveConversation(c, { now = false } = {}) {
  if (!c || c.temp) return;
  const write = () => {
    saveTimers.delete(c.id);
    if (!state.convs.includes(c)) return;
    const ok = store.set(`jchat:conv:${c.id}`, stripForStorage(c));
    store.set('jchat:index', state.convs.filter((x) => !x.temp).map((x) => x.id));
    if (!ok) console.warn('Jarvis Chat: could not save the conversation (storage full?)');
  };
  clearTimeout(saveTimers.get(c.id));
  if (now) write(); else saveTimers.set(c.id, setTimeout(write, 300));
}

export function addConversation(c) {
  state.convs.unshift(c);
  saveConversation(c, { now: true });
}

export function deleteConversation(c) {
  state.convs = state.convs.filter((x) => x !== c);
  store.del(`jchat:conv:${c.id}`);
  store.set('jchat:index', state.convs.filter((x) => !x.temp).map((x) => x.id));
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
