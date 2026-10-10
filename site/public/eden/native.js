// Eden inside the Eden iPhone app (ios/): the page's side of the app's bridge. In a browser
// (no "EdenApp/" in the user agent) nothing here runs: no listeners, no DOM, no requests,
// and nativeTransport() always says "not mine".
//
// In the app:
// - Answers on this iPhone (ROADMAP H12): Apple's on-device model, run by the app. A chat
//   turn goes there when "On this iPhone" is the model picked, in privacy mode (`privacy:
//   true`), or when the network is gone (offline, or Eden's server didn't answer). The app
//   streams back the events POST /api/chat/send would (route, text, usage, error, done), as
//   SSE text in a Response, so chat.js and render.js show the reply like any other.
// - "On this iPhone" in the model menu: added to /api/chat/meta's models while the app can
//   run it (and when offline, a model list of just that).
// - Live Activities for long tasks (H10): a Code session, a compare run, a research report or
//   a browser task still running after a few seconds shows on the Lock Screen and in the
//   Dynamic Island (model, step, elapsed time). A feature without a stream in state.streams
//   reports its own: dispatchEvent(new CustomEvent('eden:task', { detail: { id, op:
//   'start' | 'update' | 'end', kind, title, model, step, outcome } })).
// - The share sheet and Siri's "Ask Eden": what they bring arrives as eden:attach (composer.js
//   attaches the files, fills the box, and sends when asked to).
//
// Messages: to the app, document 'eden:to-app' with JSON text (the bridge, in the app's own
// JavaScript world, passes it on); from the app, window 'eden:from-app' with an object.

import { state, ui } from './state.js';
// i18n.js's t (no import: the tests load this file alone)
const tx = (s) => (globalThis.edenI18n ? globalThis.edenI18n.t(s) : s);

export const IN_APP = typeof navigator !== 'undefined' && /\bEdenApp\//.test(navigator.userAgent || '');
/** The model id of Apple's on-device model, as the page knows it. */
export const ON_DEVICE = 'apple-on-device';

const caps = { online: true, serverLocal: false, activities: false, browser: false, ondevice: { available: false, reason: 'unknown', words: '' } };
const turns = new Map(); // turn id -> { push(event, data), end(), fail(error) }

function toApp(msg) {
  document.dispatchEvent(new CustomEvent('eden:to-app', { detail: JSON.stringify(msg) }));
}

/**
 * The app's own browser (iOS: native WebKit, Browser.swift) instead of the cloud browser panel:
 * true when the app took it (in the app, once it said it has one), false on the website.
 */
export function openAppBrowser(url = '') {
  if (!IN_APP || !caps.browser) return false;
  toApp({ kind: 'browser', op: 'open', url: typeof url === 'string' ? url : '' });
  return true;
}

/* ---------- the model list: "On this iPhone" ---------- */

/** Shown in the model menu unless this iPhone can never run it (too old, not eligible). */
function listed() {
  const o = caps.ondevice;
  return o.available || o.reason === 'appleIntelligenceOff' || o.reason === 'modelNotReady';
}
function onDeviceModel() {
  return {
    id: ON_DEVICE, name: 'On this iPhone', provider: 'apple', tier: 'fast', efforts: [], defaultEffort: null,
    available: !!caps.ondevice.available, vision: false, onDevice: true,
    note: caps.ondevice.available ? 'Private · works offline' : caps.ondevice.words,
  };
}
function withOnDevice(models) {
  const rest = (Array.isArray(models) ? models : []).filter((m) => m && m.id !== ON_DEVICE);
  return listed() ? [...rest, onDeviceModel()] : rest;
}
/** Privacy mode's "local model" on the phone is this one (privacy.js reads meta.local). */
function withPhoneLocal(meta) {
  const phone = { available: true, onDevice: true, reason: null, models: [{ id: ON_DEVICE, serverName: 'this iPhone' }], servers: [] };
  if (caps.ondevice.available) return { ...meta, local: phone };
  return meta.local && meta.local.onDevice ? { ...meta, local: undefined } : meta;
}
function offlineMeta() {
  return withPhoneLocal({
    providers: [], models: withOnDevice([]), levels: [],
    classifier: { mode: 'off', available: false, reason: 'Offline' },
    search: { available: false }, jarvis: { available: false, reason: 'Offline' }, code: { available: false, reason: 'Offline' },
    scope: 'Offline · answers on this iPhone', offline: true,
  });
}
const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** The page's model list follows the app (Apple Intelligence switched on or off, the model ready). */
function refreshModels() {
  if (!state.meta && state.metaError && caps.ondevice.available && offline()) {
    state.meta = offlineMeta(); // the list didn't load for want of a network: this iPhone still answers
    state.metaError = null;
  } else if (!state.meta || !Array.isArray(state.meta.models)) return;
  else state.meta = withPhoneLocal({ ...state.meta, models: withOnDevice(state.meta.models) });
  ui.renderComposer();
  ui.renderTitle(); // privacy.js's bar says where private chats are answered
}

/* ---------- turns on this iPhone ---------- */

const offline = () => (caps.online === false && !caps.serverLocal) || (typeof navigator !== 'undefined' && navigator.onLine === false);

function onDeviceTurn(body, signal, why) {
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const enc = new TextEncoder();
  let ctrl = null, closed = false, quiet = null;
  const stream = new ReadableStream({
    start(c) { ctrl = c; },
    cancel() { stop(); },
  });
  const finish = () => { closed = true; clearTimeout(quiet); turns.delete(id); };
  const t = {
    push(event, data) {
      if (closed) return;
      clearTimeout(quiet);
      ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`));
      if (event === 'done' || event === 'error') { finish(); try { ctrl.close(); } catch { /* closed */ } }
    },
    fail(err) { if (closed) return; finish(); try { ctrl.error(err); } catch { /* closed */ } },
  };
  function stop() { if (closed) return; toApp({ kind: 'cancel', id }); finish(); }
  turns.set(id, t);
  if (signal) {
    if (signal.aborted) { stop(); return Promise.reject(new DOMException('Aborted', 'AbortError')); }
    signal.addEventListener('abort', () => { if (closed) return; stop(); try { ctrl.error(new DOMException('Aborted', 'AbortError')); } catch { /* closed */ } }, { once: true });
  }
  if (!caps.ondevice.available) {
    queueMicrotask(() => t.push('error', { message: caps.ondevice.words || 'This iPhone can’t answer on its own right now.' }));
  } else {
    toApp({
      kind: 'turn', id, why,
      request: { messages: body.messages || [], system: body.system || null, context: body.context || [], mode: body.mode || 'chat' },
    });
    // the app answers at once (a route event); silence means it never got the turn
    quiet = setTimeout(() => t.push('error', { message: 'This iPhone didn’t answer. Try again.' }), 20000);
  }
  return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
}

/**
 * api.js's transport asks here first: a Response promise for a call the app answers (or
 * changes), else null for the network as usual. `next(path, init)` is that usual way.
 */
export function nativeTransport(path, init, next) {
  if (!IN_APP) return null;
  if (path === '/api/chat/meta') {
    return next(path, init).then(async (res) => {
      if (!res.ok || !listed()) return res;
      const meta = await res.clone().json().catch(() => null);
      if (!meta || !Array.isArray(meta.models)) return res;
      return jsonResponse(withPhoneLocal({ ...meta, models: withOnDevice(meta.models) }));
    }, (e) => {
      if (e && e.name !== 'AbortError' && caps.ondevice.available) return jsonResponse(offlineMeta());
      throw e;
    });
  }
  if (path !== '/api/chat/send' || !init || typeof init.body !== 'string') return null;
  let body;
  try { body = JSON.parse(init.body); } catch { return null; }
  const picked = !!(body.override && body.override.model === ON_DEVICE);
  const why = picked ? 'picked'
    : body.privacy === true && caps.ondevice.available ? 'private'
      : offline() && caps.ondevice.available ? 'offline' : null;
  if (why) return onDeviceTurn(body, init.signal, why);
  if (!caps.ondevice.available) return null;
  // the network first; when it fails before any answer, this iPhone answers instead
  return next(path, init).catch((e) => {
    if (e && e.name === 'AbortError') throw e;
    return onDeviceTurn(body, init.signal, 'unreachable');
  });
}

/* ---------- Live Activities: long tasks on the Lock Screen ---------- */

const START_AFTER_MS = 3000; // quick ones never flash up
const tracked = new Map(); // id -> { sig, at, node, own }

function taskKind(s) {
  const node = s.node || {};
  if (s.kind === 'code') return 'code';
  if (s.kind === 'browser') return 'browser';
  if (s.kind === 'compare' || node.mode === 'compare') return 'compare';
  if (node.mode === 'research') return 'research';
  return '';
}
const clip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
function stepOf(node, kind) {
  const parts = node.parts || [];
  const last = parts[parts.length - 1];
  if (last && last.type === 'perm' && (!last.state || last.state === 'pending')) return 'Waiting for your OK';
  if (last && last.type === 'tool') {
    const i = last.input || {};
    const what = i.command || i.file_path || i.pattern || i.path || i.url || i.description || '';
    return clip(`${last.name}${what ? ` · ${String(what).split('/').pop()}` : ''}`, 60);
  }
  if (node.thinkingLive) return 'Thinking';
  if (kind === 'research') return (node.citations || []).length ? `Reading · ${node.citations.length} sources` : 'Searching the web';
  if (kind === 'compare') return 'Comparing answers';
  return parts.some((p) => p.type === 'text' && p.text) ? 'Writing' : 'Starting';
}
function outcomeOf(node) {
  if (!node) return 'done';
  if (node.error) return 'failed';
  if (node.finish === 'aborted') return 'stopped';
  if ((node.parts || []).some((p) => p.type === 'perm' && (!p.state || p.state === 'pending'))) return 'waiting';
  return 'done';
}
const sigOf = (a) => `${a.model}\u0000${a.step}`;

function scan() {
  const now = Date.now();
  const live = new Set();
  for (const [cid, s] of state.streams) {
    const kind = taskKind(s);
    const node = s.node || {};
    if (!kind || now - (node.startedAt || now) < START_AFTER_MS) continue;
    live.add(cid);
    const c = state.convs.find((x) => x.id === cid);
    const a = {
      id: cid, task: kind,
      title: clip(kind === 'code' && c && c.project ? `${c.project.name} · ${c.title || 'Code session'}` : (c && c.title) || node.topic || 'Eden', 80),
      model: clip((node.route && (node.route.modelName || node.route.model)) || (kind === 'code' ? 'Claude Code' : 'Eden'), 40),
      step: tx(stepOf(node, kind)), // the Live Activity's line, in the page's language
    };
    const t = tracked.get(cid);
    if (!t) {
      tracked.set(cid, { sig: sigOf(a), at: now, node });
      toApp({ kind: 'activity', op: 'start', ...a, startedAt: node.startedAt || now });
    } else if (sigOf(a) !== t.sig && now - t.at >= 1500) {
      Object.assign(t, { sig: sigOf(a), at: now, node });
      toApp({ kind: 'activity', op: 'update', ...a });
    }
  }
  for (const [id, t] of tracked) {
    if (t.own || live.has(id)) continue;
    tracked.delete(id);
    toApp({ kind: 'activity', op: 'end', id, outcome: outcomeOf(t.node), step: t.node && t.node.error ? clip(t.node.error, 60) : '' });
  }
}

/** A feature's own long task (eden:task): passed on as it is, checked. */
function ownTask(e) {
  const d = e.detail;
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id) return;
  const id = `task:${d.id.slice(0, 60)}`;
  const op = ['start', 'update', 'end'].includes(d.op) ? d.op : '';
  if (!op || (op !== 'start' && !tracked.has(id))) return;
  if (op === 'end') {
    tracked.delete(id);
    toApp({ kind: 'activity', op, id, outcome: ['done', 'failed', 'stopped', 'waiting'].includes(d.outcome) ? d.outcome : 'done', step: clip(d.step, 60) });
    return;
  }
  const kind = ['code', 'browser', 'compare', 'research'].includes(d.kind) ? d.kind : 'task';
  const a = { id, task: kind, title: clip(d.title || 'Eden', 80), model: clip(d.model || 'Eden', 40), step: clip(d.step || '', 60) };
  const t = tracked.get(id);
  if (op === 'start' && t) return; // started already (a feature that polls says start once, then update)
  if (op === 'update') {
    // only what changed, at most every 1.5 s (Live Activity updates are rationed)
    if (t.sig === sigOf(a) || Date.now() - t.at < 1500) return;
    Object.assign(t, { sig: sigOf(a), at: Date.now() });
  } else tracked.set(id, { sig: sigOf(a), at: Date.now(), node: null, own: true });
  toApp({ kind: 'activity', op, ...a, ...(op === 'start' ? { startedAt: Number(d.startedAt) || Date.now() } : {}) });
}

/* ---------- from the app ---------- */

function fromApp(e) {
  const m = e.detail;
  if (!m || typeof m !== 'object') return;
  if (m.kind === 'caps') {
    const was = JSON.stringify([listed(), caps.ondevice.available]);
    caps.online = m.online !== false;
    caps.serverLocal = !!m.serverLocal;
    caps.activities = !!m.activities;
    caps.browser = !!m.browser;
    if (m.ondevice && typeof m.ondevice === 'object') {
      caps.ondevice = { available: !!m.ondevice.available, reason: String(m.ondevice.reason || ''), words: String(m.ondevice.words || '') };
    }
    if (JSON.stringify([listed(), caps.ondevice.available]) !== was) refreshModels();
  } else if (m.kind === 'turn') {
    const t = turns.get(m.id);
    if (t && typeof m.event === 'string') t.push(m.event, m.data);
  } else if (m.kind === 'attach') {
    // A new chat for what was shared or asked, unless this one is still empty. Not for a link
    // (askeden://ask: words only, never sent; any app or page can open one): it never replaces
    // what's being typed, so it's `fresh` only when the app says so (B7).
    const files = Array.isArray(m.files) ? m.files : [];
    const link = m.link === true || (!m.send && !files.length);
    const fresh = m.fresh === true || (m.fresh !== false && !link);
    if (fresh) { const b = document.getElementById('btnNew'); if (b) b.click(); }
    // the app sends shares one at a time, each with an id: `attached` tells it this one is done (composer.js calls done)
    const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
    dispatchEvent(new CustomEvent('eden:attach', { detail: { prompt: m.prompt || '', send: !!m.send, fresh, files, ...(id !== null ? { done: () => toApp({ kind: 'attached', id }) } : {}) } }));
  }
}

function hello() {
  toApp({ kind: 'hello', v: 1 });
  toApp({ kind: 'activity', op: 'sync', ids: [...tracked.keys()] });
}

if (IN_APP) {
  addEventListener('eden:from-app', fromApp);
  addEventListener('eden:task', ownTask);
  // the bridge may arrive after this page's first hello (it's added when the document ends)
  document.addEventListener('eden:bridge-ready', hello);
  const start = () => setTimeout(() => {
    hello();
    const t = setInterval(scan, 1000);
    if (t && t.unref) t.unref(); // (tests run this in Node)
  }, 0);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
}
