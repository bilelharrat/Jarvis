// The website ↔ server contract (docs/chat-api.md). With ?mock=1 every call is answered in
// the browser by mock.js, through the same Response/stream path.

import { nativeTransport } from './native.js';
import { actingAnswer } from './acting.js';

const MOCK = new URLSearchParams(location.search).get('mock') === '1';

/**
 * Where the server lives. Every request is built from API_ROOT: by default the path the page
 * is served under its chat mount (http://localhost:5174/ → "",
 * https://askeden.com/ai/ → "/ai"). A <meta name="jarvis-api-root" content="…"> in
 * index.html re-points it (another path or origin).
 */
const metaRoot = document.querySelector('meta[name="jarvis-api-root"]');
export const API_ROOT = (metaRoot && metaRoot.content.trim() ? metaRoot.content.trim() : location.pathname.replace(/\/chat(?:\/.*)?$/, '').replace(/\/[^/]*\.html?$/, '')).replace(/\/$/, '');
export const API_BASE = `${API_ROOT}/api/chat`;
/** A server path ("/api/chat/meta", "/artifact/x") as a URL under API_ROOT. */
export function apiUrl(path) {
  if (/^[a-z][\w+.-]*:/i.test(path)) return path; // already absolute (or blob: in mock mode)
  return path.startsWith('/') ? `${API_ROOT}${path}` : path;
}

let mockFetch = null;
async function transport(path, init) {
  // acting for someone at askeden.com: what the grant can't do is answered here, unsent (acting.js)
  const refused = actingAnswer(init && init.method, path);
  if (refused) return refused;
  // inside the Eden iPhone app, a turn may run on the phone itself (native.js); null elsewhere
  return nativeTransport(path, init, network) || network(path, init);
}
async function network(path, init) {
  if (MOCK) {
    if (!mockFetch) mockFetch = (await import('./mock.js')).mockFetch;
    return mockFetch(path, init);
  }
  return fetch(apiUrl(path), init);
}
export const isMock = MOCK;

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function headers(path, extra = {}) {
  const h = { ...extra };
  if (path.startsWith('/api/chat')) h['X-Jarvis-Chat'] = '1';
  return h;
}

async function errorFrom(res) {
  let msg = `${res.status} ${res.statusText || ''}`.trim();
  try {
    const j = await res.json();
    if (j && (j.error || j.message)) msg = j.error || j.message;
  } catch { /* not JSON */ }
  if (res.status === 404) msg = `${msg} — is the Eden server running (model-router-ui)?`;
  return new ApiError(res.status, msg);
}

export async function getJSON(path, { signal } = {}) {
  let res;
  try { res = await transport(path, { method: 'GET', headers: headers(path), signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(0, 'Can’t reach the server.'); }
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

export async function postJSON(path, body, { signal } = {}) {
  let res;
  try {
    res = await transport(path, { method: 'POST', headers: headers(path, { 'content-type': 'application/json' }), body: JSON.stringify(body), signal });
  } catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(0, 'Can’t reach the server.'); }
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

/**
 * POST and read Server-Sent Events from the response body: onEvent(type, data) for each
 * `event: <type>\ndata: <json>` block. Resolves when the stream ends; rejects with
 * AbortError when aborted.
 */
export async function streamSSE(path, body, { signal, onEvent }) {
  let res;
  try {
    res = await transport(path, { method: 'POST', headers: headers(path, { 'content-type': 'application/json', accept: 'text/event-stream' }), body: JSON.stringify(body), signal });
  } catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(0, 'Can’t reach the server.'); }
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ApiError(0, 'The server sent no stream.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (block) => {
    let type = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return;
    let parsed;
    try { parsed = JSON.parse(data.join('\n')); } catch { parsed = { text: data.join('\n') }; }
    onEvent(type, parsed);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        flush(block);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) flush(buf);
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Jarvis's first call from Eden waits for the owner's "Let Eden use Jarvis?" card on the Mac.
 * While any Jarvis call has run 3 s, the status is polled; when the server says the call is
 * waiting on that card, `eden:jarvis-approval` fires on window with { waiting: true }, and with
 * { waiting: false } once nothing is waiting. jarvisApprovalWaiting() reads the current state.
 */
let jarvisPending = 0, approvalPoll = null, approvalWaiting = false;
function setApproval(w) {
  if (w === approvalWaiting) return;
  approvalWaiting = w;
  dispatchEvent(new CustomEvent('eden:jarvis-approval', { detail: { waiting: w } }));
}
export const jarvisApprovalWaiting = () => approvalWaiting;
async function watchApproval(p) {
  jarvisPending++;
  if (!approvalPoll) {
    const me = {};
    const poll = () => getJSON('/api/chat/jarvis/status')
      .then((s) => { if (approvalPoll === me) setApproval(!!s && s.approval === 'waiting'); }, () => {})
      .finally(() => { if (approvalPoll === me) me.t = setTimeout(poll, 1500); });
    me.t = setTimeout(poll, 3000);
    approvalPoll = me;
  }
  try { return await p; } finally {
    if (!--jarvisPending) { clearTimeout(approvalPoll.t); approvalPoll = null; setApproval(false); }
  }
}

export const api = {
  meta: () => getJSON('/api/chat/meta'),
  route: (body, signal) => postJSON('/api/route', body, { signal }),
  keys: () => getJSON('/api/chat/keys'),
  setKey: (provider, key) => postJSON('/api/chat/keys', { provider, key }),
  // Eden's memory across chats on askeden.com (Settings › Memory): { on, notice, items }
  memory: () => getJSON('/api/chat/memory'),
  memoryDo: (body) => postJSON('/api/chat/memory', body),
  jarvisStatus: () => getJSON('/api/chat/jarvis/status'),
  jarvis: (tool, args = {}) => watchApproval(postJSON('/api/chat/jarvis', { tool, arguments: args })),
  projects: () => getJSON('/api/chat/projects'),
  addProject: (path) => postJSON('/api/chat/projects', { path }),
  changes: (project) => getJSON(`/api/chat/code/changes?project=${encodeURIComponent(project)}`),
  artifact: (html) => postJSON('/api/chat/artifact', { html }),
  // A turn that uses the Mac ("Use my Mac", project knowledge: files.js) goes to mac/send, which askeden.com forwards to the Mac.
  send: (body, opts) => streamSSE(body && body.mac ? '/api/chat/mac/send' : '/api/chat/send', body, opts),
  // Compare (G6): several models at once, lane-tagged events; its estimate; stop one lane.
  compare: (body, opts) => streamSSE('/api/chat/compare', body, opts),
  compareEstimate: (body, signal) => postJSON('/api/chat/compare/estimate', body, { signal }),
  compareStop: (id, lane) => postJSON('/api/chat/compare/stop', { id, lane }),
  code: (body, opts) => streamSSE('/api/chat/code', body, opts),
  gmail: (action, args = {}) => postJSON('/api/chat/gmail', { action, args }),
  googleStatus: () => getJSON('/api/chat/google/status'),
  googleConfig: (clientId, clientSecret) => postJSON('/api/chat/google/config', { clientId, clientSecret }),
  googleConnect: (scope) => postJSON('/api/chat/google/connect', scope ? { scope } : {}), // scope (askeden.com: its own consent): gmail | calendar
  googleDisconnect: () => postJSON('/api/chat/google/disconnect', {}),
  codeSteer: (turnId, text) => postJSON('/api/chat/code/steer', { turnId, text }),
};
