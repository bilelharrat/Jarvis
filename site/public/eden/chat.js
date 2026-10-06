// Turns: a routed chat turn (POST /api/chat/send) or a Code turn (POST /api/chat/code),
// streamed as SSE into the assistant node; edit & resend (branches), regenerate (drafts),
// retry, stop, permissions (Allow once → "continue" with allowTools), steer queue.

import { toast, effortLabel, store, uid } from './util.js';
import { state, ui, addNode, path, parentOf, saveConversation, nodeText, attachmentData, persona, addConversation, newConversation } from './state.js';
import { api } from './api.js';
import { routeSettings, settingsSig, currentOverride, modelInfo } from './router.js';

function touch(c) { c.updated = Date.now(); saveConversation(c); }

function autoTitle(c, text) {
  // from the first message only (it used to retitle the chat with every message sent)
  if (c.titleSet || path(c).filter((n) => n.role === 'user').length > 1) return;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  c.title = t.length > 48 ? `${t.slice(0, 46).replace(/\s+\S*$/, '')}…` : t;
  ui.renderTitle();
}

export function ensureConversation() {
  if (!state.current) {
    const c = newConversation({ personaId: state.draftPersona || null });
    state.draftPersona = undefined;
    addConversation(c);
    state.current = c;
    store.set('jchat:current', c.id);
    ui.renderSidebar();
  }
  return state.current;
}

/** The composer's send: text + attachments ([{kind,name,mime,size,data,url,text}]). */
export function sendMessage(text, attachments = [], { context = [], steered = false } = {}) {
  const c = ensureConversation();
  if (state.streams.has(c.id)) { toast('Wait for the reply, or stop it first'); return false; }
  const last = path(c).at(-1);
  const user = addNode(c, last ? last.id : null, {
    role: 'user', content: text,
    attachments: attachments.map((a) => ({ kind: a.kind, name: a.name, mime: a.mime, size: a.size, ...(a.kind === 'text' ? { text: a.text } : {}) })),
    context: context.map((x) => ({ title: x.title, text: x.text })),
    ...(steered ? { steered: true } : {}),
  });
  if (attachments.some((a) => a.kind === 'image')) attachmentData.set(user.id, attachments.filter((a) => a.kind === 'image'));
  autoTitle(c, text || (attachments[0] && attachments[0].name));
  if (c.kind === 'code') return codeTurn(c, user, text, attachments, context);
  const asst = addNode(c, user.id, { role: 'assistant', parts: [], mode: c.mode, topic: text });
  touch(c);
  ui.render();
  runChat(c, asst);
  return true;
}

function historyFor(c, upTo) {
  const out = [];
  for (const n of path(c)) {
    if (n.id === upTo.id) break;
    if (n.role === 'user') {
      const live = attachmentData.get(n.id) || [];
      const atts = [];
      for (const a of n.attachments || []) {
        if (a.kind === 'image') {
          const d = live.find((x) => x.name === a.name);
          if (d && d.data) atts.push({ kind: 'image', name: a.name, mime: a.mime, data: d.data });
        } else if (a.kind === 'text') atts.push({ kind: 'text', name: a.name, text: a.text || '' });
      }
      out.push({ role: 'user', content: n.content || '', ...(atts.length ? { attachments: atts } : {}) });
    } else {
      const t = nodeText(n);
      if (t) out.push({ role: 'assistant', content: t });
      else if (out.length && out.at(-1).role === 'user') out.pop(); // a failed turn: its question goes again below
    }
  }
  return out;
}

function contextFor(c, user) {
  // context blocks attached to any user message on the path (Jarvis notes, memory)
  const blocks = [];
  for (const n of path(c)) {
    if (n.role === 'user') for (const x of n.context || []) blocks.push({ title: x.title, text: x.text });
    if (n.id === user.id) break;
  }
  return blocks;
}

function beginStream(c, node, kind) {
  const ctrl = new AbortController();
  state.streams.set(c.id, { abort: () => ctrl.abort(), node, kind, ctrl });
  node.streaming = true;
  node.startedAt = Date.now();
  c.status = 'running';
  ui.renderSidebar();
  ui.renderComposer();
  return ctrl;
}
function endStream(c, node) {
  node.streaming = false;
  node.thinkingLive = false;
  node.doneAt = Date.now();
  state.streams.delete(c.id);
  if (c.kind === 'code') c.queue = (c.queue || []).filter((q) => q.state !== 'sent');
  if (c.status === 'running') c.status = node.parts && node.parts.some((p) => p.type === 'perm' && (!p.state || p.state === 'pending')) ? 'waiting' : 'done';
  touch(c);
  ui.updateMessage(c, node, { final: true });
  ui.renderSidebar();
  ui.renderComposer();
  ui.renderTitle();
  if (state.selectedNode === node) ui.renderInspector();
}

// One repaint per frame per streaming message, spaced out as the message grows: a repaint
// re-renders the whole reply, so the gap is three times the last repaint's cost (a long
// reply then costs at most about a quarter of the main thread, and the page stays responsive).
const pending = new Set();
const paintCost = new WeakMap();
// A streaming reply is written to storage every 2 s and when the page goes away, so a reload
// (or a crash) mid-reply keeps what it had written, marked Stopped (it kept only "Stopped.").
const savedAt = new WeakMap();
function keepSafe(c) {
  const now = Date.now();
  if (now - (savedAt.get(c) || 0) < 2000) return;
  savedAt.set(c, now);
  saveConversation(c, { now: true });
}
addEventListener('pagehide', () => {
  for (const id of state.streams.keys()) { const c = state.convs.find((x) => x.id === id); if (c) saveConversation(c, { now: true }); }
});
function paint(c, node) {
  keepSafe(c);
  if (pending.has(node)) return;
  pending.add(node);
  const run = () => {
    pending.delete(node);
    if (!node.streaming) return; // endStream already drew the final state
    const t = performance.now();
    ui.updateMessage(c, node);
    paintCost.set(node, performance.now() - t);
  };
  const wait = Math.min(800, 3 * (paintCost.get(node) || 0));
  if (wait > 16) setTimeout(() => requestAnimationFrame(run), wait);
  else requestAnimationFrame(run);
}

function appendText(node, text) {
  const parts = node.parts || (node.parts = []);
  const last = parts.at(-1);
  if (last && last.type === 'text') last.text += text;
  else parts.push({ type: 'text', text });
}

export async function runChat(c, node, { override } = {}) {
  const user = parentOf(c, node);
  const ctrl = beginStream(c, node, 'chat');
  Object.assign(node, { parts: [], thinking: '', thinkMs: 0, route: null, usage: null, citations: [], notes: [], error: null, finish: null, mode: node.mode || c.mode });
  const ov = override || currentOverride();
  const sig = settingsSig();
  const p = persona(c.personaId);
  const ctx = contextFor(c, user);
  const body = {
    messages: [...historyFor(c, user), userPayload(user)],
    settings: routeSettings(),
    mode: node.mode || 'chat',
    ...(ov ? { override: ov } : {}),
    ...(!ov && c.lastRoute && c.lastRoute.sig === sig ? { sticky: { model: c.lastRoute.model, effort: c.lastRoute.effort } } : {}),
    ...(p && p.system ? { system: p.system } : {}),
    ...(ctx.length ? { context: ctx } : {}),
  };
  let thinkStart = 0;
  ui.updateMessage(c, node);
  try {
    await api.send(body, {
      signal: ctrl.signal,
      onEvent: (type, d) => {
        switch (type) {
          case 'route':
            node.route = { ...d, override: !!ov };
            if (!ov) c.lastRoute = { model: d.model, effort: d.effort, sig };
            if (state.selectedNode === null || state.selectedNode === undefined || state.selectedNode.parent === node.parent) { state.selectedNode = node; ui.renderInspector(); }
            break;
          case 'thinking':
            if (!thinkStart) thinkStart = Date.now();
            node.thinking = (node.thinking || '') + (d.text || '');
            node.thinkingLive = true;
            node.thinkMs = Date.now() - thinkStart;
            break;
          case 'text':
            if (node.thinkingLive) { node.thinkingLive = false; node.thinkMs = Date.now() - thinkStart; }
            appendText(node, d.text || '');
            break;
          case 'citations': {
            const seen = new Set((node.citations || []).map((s) => s.url));
            for (const s of d.sources || []) if (s && s.url && !seen.has(s.url)) { node.citations.push({ title: s.title || '', url: s.url }); seen.add(s.url); }
            break;
          }
          case 'usage': node.usage = d; break;
          case 'fallback': {
            const m = modelInfo(d.from && d.from.model);
            node.notes.push(`${m ? m.name : (d.from && d.from.model) || 'The pick'} failed (${d.reason || 'error'}); retried on the next choice.`);
            break;
          }
          case 'error': node.error = d.message || 'The turn failed.'; break;
          case 'done': node.finish = d.finish || 'stop'; break;
          default: break;
        }
        paint(c, node);
      },
    });
  } catch (e) {
    if (e.name === 'AbortError') node.finish = 'aborted';
    else node.error = failure(e);
  }
  if (node.thinkingLive && thinkStart) node.thinkMs = Date.now() - thinkStart;
  if (!node.finish && !node.error) node.finish = 'stop';
  if (!nodeText(node) && !node.error && node.finish === 'stop') node.error = 'The model sent an empty reply.';
  endStream(c, node);
  if (!node.error) drainQueue(c);
}

/** The browser's bare "network error" when the stream breaks, said plainly. */
function failure(e) {
  if (e && e.name === 'TypeError' && /network|fetch|load failed|connection/i.test(e.message || '')) {
    return 'The connection to the Eden server dropped before the reply finished. Is model-router-ui still running?';
  }
  return (e && e.message) || String(e);
}

function userPayload(user) {
  const live = attachmentData.get(user.id) || [];
  const atts = [];
  for (const a of user.attachments || []) {
    if (a.kind === 'image') { const d = live.find((x) => x.name === a.name); if (d && d.data) atts.push({ kind: 'image', name: a.name, mime: a.mime, data: d.data }); }
    else if (a.kind === 'text') atts.push({ kind: 'text', name: a.name, text: a.text || '' });
  }
  return { role: 'user', content: user.content || '', ...(atts.length ? { attachments: atts } : {}) };
}

export function stop(c = state.current) {
  const s = c && state.streams.get(c.id);
  if (s) { s.abort(); return true; }
  return false;
}

export function retry(c, node) {
  if (state.streams.has(c.id)) return;
  if (c.kind === 'code') { const user = parentOf(c, node); runCode(c, node, user.content || 'continue'); return; }
  runChat(c, node, { override: node.route && node.route.override ? { model: node.route.model, effort: node.route.effort } : undefined });
}

/** Try again: a new draft beside this one (same router, or a given model). */
export function regenerate(c, node, override) {
  if (state.streams.has(c.id)) { toast('Wait for the reply, or stop it first'); return; }
  const user = parentOf(c, node);
  const fresh = addNode(c, user.id, { role: 'assistant', parts: [], mode: node.mode || c.mode, topic: node.topic });
  ui.render();
  runChat(c, fresh, { override });
}

/** Edit & resend: a new user node beside the old one (a branch), then its reply. */
export function editResend(c, node, text) {
  if (state.streams.has(c.id)) { toast('Wait for the reply, or stop it first'); return; }
  const user = addNode(c, node.parent, { role: 'user', content: text, attachments: node.attachments || [], context: node.context || [] });
  if (attachmentData.has(node.id)) attachmentData.set(user.id, attachmentData.get(node.id));
  const asst = addNode(c, user.id, { role: 'assistant', parts: [], mode: c.mode, topic: text });
  touch(c);
  ui.render();
  runChat(c, asst);
}

/* ---------- Code turns ---------- */

const CODE_MODE = { default: 'default', acceptEdits: 'acceptEdits', plan: 'plan', bypassPermissions: 'bypassPermissions' };

function codeTurn(c, user, text, attachments, context = []) {
  const asst = addNode(c, user.id, { role: 'assistant', parts: [], mode: c.mode });
  touch(c);
  ui.render();
  runCode(c, asst, text, { images: attachments.filter((a) => a.kind === 'image').map((a) => ({ mime: a.mime, data: a.data })), texts: attachments.filter((a) => a.kind === 'text'), context });
  return true;
}

export async function runCode(c, node, prompt, { images = [], texts = [], allowTools = [], append = false, context = [] } = {}) {
  const ctrl = beginStream(c, node, 'code');
  if (!append) Object.assign(node, { parts: [], thinking: '', usage: null, error: null, finish: null, notes: [] });
  else { node.error = null; node.finish = null; }
  const ov = currentOverride();
  const om = ov && modelInfo(ov.model);
  let fullPrompt = prompt;
  for (const t of texts) fullPrompt += `\n\n<attached file="${t.name}">\n${t.text || ''}\n</attached>`;
  if (context.length) fullPrompt = `${context.map((x) => `[${x.title}]\n${x.text}`).join('\n\n')}\n\n${fullPrompt}`;
  const body = {
    project: c.project && c.project.path, prompt: fullPrompt, mode: CODE_MODE[c.mode] || 'default',
    ...(c.sessionId ? { sessionId: c.sessionId } : {}),
    ...(om && om.provider === 'anthropic' ? { model: ov.model, effort: ov.effort } : {}),
    ...([...new Set([...(c.allowTools || []), ...allowTools])].length ? { allowTools: [...new Set([...(c.allowTools || []), ...allowTools])] } : {}),
    ...(images.length ? { images } : {}),
  };
  let thinkStart = 0;
  ui.updateMessage(c, node);
  try {
    await api.code(body, {
      signal: ctrl.signal,
      onEvent: (type, d) => {
        switch (type) {
          case 'session': {
            c.sessionId = d.sessionId || c.sessionId;
            { const st = state.streams.get(c.id); if (st && d.turnId) { st.turnId = d.turnId; for (const q of c.queue || []) if (q.state === 'queued') steerCode(c, q); } }
            const m = modelInfo(d.model);
            node.route = { model: d.model, modelName: m ? m.name : (d.model || 'Claude'), provider: 'anthropic', via: 'claude-code', effort: body.effort, effortLabel: body.effort ? effortLabel(body.effort) : undefined, rationale: `Jarvis Code session ${String(c.sessionId || '').slice(0, 8)} · ${c.project ? c.project.name : ''}` };
            break;
          }
          case 'thinking':
            if (!thinkStart) thinkStart = Date.now();
            node.thinking = (node.thinking || '') + (d.text || '');
            node.thinkingLive = true; node.thinkMs = Date.now() - thinkStart;
            break;
          case 'text':
            if (node.thinkingLive) { node.thinkingLive = false; node.thinkMs = Date.now() - thinkStart; }
            appendText(node, d.text || '');
            break;
          case 'tool_use':
            node.parts.push({ type: 'tool', id: d.id, name: d.name, input: d.input || {} });
            if (d.name === 'TodoWrite' && d.input && Array.isArray(d.input.todos)) { c.todos = d.input.todos; ui.renderPlan(); }
            logActivity(c, 'p', `› ${d.name} ${toolLine(d)}`);
            break;
          case 'tool_result': {
            const part = node.parts.find((p) => p.type === 'tool' && p.id === d.id);
            if (part) part.result = { ok: d.ok !== false, output: d.output || '' };
            logActivity(c, d.ok === false ? 'bad' : 'ok', `${d.ok === false ? '✗' : '✓'} ${String(d.output || '').split('\n')[0].slice(0, 160)}`);
            if (part && /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/.test(part.name)) ui.loadChanges(true);
            break;
          }
          case 'permission':
            node.parts.push({ type: 'perm', denials: d.denials || [], state: 'pending' });
            c.status = 'waiting';
            break;
          case 'usage': node.usage = { ...(node.usage || {}), ...d, costUSD: (append && node.usage && typeof node.usage.costUSD === 'number' ? node.usage.costUSD : 0) + (d.costUSD || 0) }; break;
          case 'error': node.error = d.message || 'The Code turn failed.'; break;
          case 'done': node.finish = d.finish || 'stop'; break;
          default: break;
        }
        paint(c, node);
      },
    });
  } catch (e) {
    if (e.name === 'AbortError') node.finish = 'aborted';
    else node.error = failure(e);
  }
  if (!node.finish && !node.error) node.finish = 'stop';
  const waiting = node.parts.some((p) => p.type === 'perm' && p.state === 'pending');
  c.status = waiting ? 'waiting' : 'running';
  endStream(c, node);
  if (!waiting && !node.error && node.finish !== 'aborted') drainQueue(c);
}

function toolLine(d) {
  const i = d.input || {};
  return String(i.command || i.file_path || i.pattern || i.path || i.url || '').slice(0, 160);
}

export const activity = new Map(); // conv id -> lines
function logActivity(c, k, t) {
  const list = activity.get(c.id) || [];
  list.push({ k, t });
  if (list.length > 400) list.shift();
  activity.set(c.id, list);
  ui.renderActivity && ui.renderActivity();
}

export function answerPermission(c, node, index, choice) {
  const part = node.parts[index];
  if (!part || part.type !== 'perm') return;
  const tools = [...new Set((part.denials || []).map((d) => d.tool))];
  if (choice === 'deny') {
    part.state = 'denied';
    c.status = 'done';
    touch(c);
    ui.updateMessage(c, node, { final: true });
    ui.renderSidebar();
    toast('Denied');
    drainQueue(c);
    return;
  }
  part.state = choice === 'always' ? 'always' : 'allowed';
  if (choice === 'always') c.allowTools = [...new Set([...(c.allowTools || []), ...tools])];
  ui.updateMessage(c, node);
  toast(choice === 'always' ? `${tools.join(', ')} allowed for this session` : 'Allowed once');
  runCode(c, node, 'continue', { allowTools: tools, append: true });
}

/**
 * Steer without interrupting (Jarvis Code's Steer, for every conversation): while a reply
 * streams, what you send waits in the queue above the composer. A Code turn takes it at
 * once (POST /api/chat/code/steer, into the running step); a chat turn sends it as the next
 * message the moment the reply ends. "Steer now" stops the reply (keeping what it wrote)
 * and sends straight away.
 */
export function queueFollowUp(c, text) {
  c.queue = c.queue || [];
  const item = { id: uid('q'), text, state: 'queued' };
  c.queue.push(item);
  const st = state.streams.get(c.id);
  if (c.kind === 'code' && st && st.turnId) steerCode(c, item);
  ui.renderComposer();
  return item;
}

async function steerCode(c, item) {
  const st = state.streams.get(c.id);
  if (!st || !st.turnId || item.state !== 'queued') return;
  item.state = 'sending';
  ui.renderComposer();
  try {
    await api.codeSteer(st.turnId, item.text);
    item.state = 'sent';
    if (st.node) { st.node.parts.push({ type: 'note', text: `↳ Steered: ${item.text}` }); ui.updateMessage(c, st.node); }
  } catch (e) {
    item.state = 'queued';
    item.error = e.message;
    toast(`Couldn’t steer: ${e.message}. It goes as the next message.`);
  }
  ui.renderComposer();
}

export function steerNow(c, id) {
  const item = (c.queue || []).find((q) => q.id === id);
  if (!item) return;
  if (c.kind === 'code' && state.streams.has(c.id)) {
    if (item.state === 'queued') steerCode(c, item);
    return;
  }
  // chat: to the front, stop the reply (its words stay), and the queue sends it
  c.queue = [item, ...c.queue.filter((q) => q !== item)];
  const st = state.streams.get(c.id);
  if (st) st.abort(); else drainQueue(c);
}

export function dropQueued(c, id) {
  c.queue = (c.queue || []).filter((q) => q.id !== id);
  ui.renderComposer();
}

function drainQueue(c) {
  c.queue = (c.queue || []).filter((q) => q.state !== 'sent');
  ui.renderComposer();
  const next = c.queue.find((q) => q.state === 'queued');
  if (!next || state.streams.has(c.id)) return;
  c.queue = c.queue.filter((q) => q !== next);
  ui.renderComposer();
  setTimeout(() => { if (!state.streams.has(c.id)) sendMessage(next.text, [], { steered: true }); else c.queue.unshift(next); }, 60);
}
