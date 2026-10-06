// The website ↔ server contract (docs/chat-api.md). With ?mock=1 every call is answered in
// the browser by mock.js, through the same Response/stream path.

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

export const api = {
  meta: () => getJSON('/api/chat/meta'),
  route: (body, signal) => postJSON('/api/route', body, { signal }),
  keys: () => getJSON('/api/chat/keys'),
  setKey: (provider, key) => postJSON('/api/chat/keys', { provider, key }),
  jarvisStatus: () => getJSON('/api/chat/jarvis/status'),
  jarvis: (tool, args = {}) => postJSON('/api/chat/jarvis', { tool, arguments: args }),
  projects: () => getJSON('/api/chat/projects'),
  addProject: (path) => postJSON('/api/chat/projects', { path }),
  changes: (project) => getJSON(`/api/chat/code/changes?project=${encodeURIComponent(project)}`),
  artifact: (html) => postJSON('/api/chat/artifact', { html }),
  send: (body, opts) => streamSSE('/api/chat/send', body, opts),
  code: (body, opts) => streamSSE('/api/chat/code', body, opts),
  gmail: (action, args = {}) => postJSON('/api/chat/gmail', { action, args }),
  googleStatus: () => getJSON('/api/chat/google/status'),
  googleConfig: (clientId, clientSecret) => postJSON('/api/chat/google/config', { clientId, clientSecret }),
  googleConnect: () => postJSON('/api/chat/google/connect', {}),
  googleDisconnect: () => postJSON('/api/chat/google/disconnect', {}),
  codeSteer: (turnId, text) => postJSON('/api/chat/code/steer', { turnId, text }),
};
