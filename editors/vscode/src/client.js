// Eden Code's local API, from an editor: where it is, its token, and every call the review
// extension makes (docs/eden-code-api.md; the server is src/jarvis/features/code_api.py).
//
// No VS Code here, so node --test drives it against a fake server (tests/web/
// vscode-extension.test.mjs). Node's own http only: no packages, no build step.
//
// Where Eden Code is, in the order the eden-code command looks (jarvis/eden_code_cli.py):
// the extension's own setting, EDEN_CODE_URL, the address the app wrote to code_api.json in
// its data folder, else http://127.0.0.1:8767. Only this Mac's own address is ever used:
// the API answers nothing else, and the token must never go anywhere else.
//
// The token: the one pasted into the extension (kept in the editor's secret storage), else
// EDEN_CODE_TOKEN, else the Keychain item the app keeps it in ("Jarvis connectors",
// code-api:token), read with macOS's own `security` tool (the Mac asks the owner first).
//
// Cost policy: no model is called here; the API itself calls none.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_URL = 'http://127.0.0.1:8767';
const KEYCHAIN = { service: 'Jarvis connectors', account: 'code-api:token' };
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/?$/;

class EdenError extends Error {
  // The API said no: its status and its reason, in its own words.
  constructor(status, message) {
    super(message);
    this.name = 'EdenError';
    this.status = status;
  }
}

class Unreachable extends Error {
  constructor(message) {
    super(message);
    this.name = 'Unreachable';
  }
}

// The app's data folder (osplat.app_support): where code_api.json is.
function dataFolder(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Jarvis');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Jarvis');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Jarvis');
}

function isLocal(url) {
  return typeof url === 'string' && LOCAL.test(url.trim());
}

function findUrl({ setting = '', env = process.env, folder = dataFolder() } = {}) {
  for (const candidate of [setting, env.EDEN_CODE_URL]) {
    if (isLocal(candidate)) return candidate.trim().replace(/\/$/, '');
  }
  try {
    const found = JSON.parse(fs.readFileSync(path.join(folder, 'code_api.json'), 'utf8'));
    if (isLocal(found && found.url)) return found.url.replace(/\/$/, '');
  } catch { /* not written yet: the API is off, or never was on */ }
  return DEFAULT_URL;
}

// The Keychain's copy of the token, or '' (not a Mac, no item, or the owner said no).
function keychainToken(run = execFile, platform = process.platform) {
  if (platform !== 'darwin') return Promise.resolve('');
  return new Promise((resolve) => {
    run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'],
      { timeout: 60000 }, (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
}

async function findToken({ secret = '', env = process.env, keychain = keychainToken } = {}) {
  if (secret && secret.trim()) return secret.trim();
  if (env.EDEN_CODE_TOKEN && env.EDEN_CODE_TOKEN.trim()) return env.EDEN_CODE_TOKEN.trim();
  return (await keychain()) || '';
}

class Client {
  constructor(url, token, { timeout = 30000 } = {}) {
    if (!isLocal(url)) throw new Unreachable(`only this Mac's own address: ${url}`);
    this.url = url.replace(/\/$/, '');
    this.token = token || '';
    this.timeout = timeout;
  }

  // One call: its JSON answer, an EdenError when the API says no, Unreachable when there's
  // no answer. No Origin header (the API refuses any web page's); a body is always JSON.
  request(method, route, body) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    if (data) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': data.length });
    return new Promise((resolve, reject) => {
      const req = http.request(`${this.url}${route}`, { method, headers, timeout: this.timeout }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = null; }
          if (res.statusCode >= 400) {
            reject(new EdenError(res.statusCode, (parsed && parsed.error) || res.statusMessage || 'refused'));
          } else if (parsed === null) {
            reject(new EdenError(res.statusCode, 'not JSON'));
          } else {
            resolve(parsed);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (err) => reject(new Unreachable(err.message || String(err))));
      if (data) req.write(data);
      req.end();
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  async sessions() { return (await this.request('GET', '/v1/sessions')).sessions || []; }
  session(id) { return this.request('GET', `/v1/sessions/${enc(id)}`); }

  // The Changes pane's view: 'turn', 'session' (the default) or 'branch'; with a path, that
  // one file's lines ({file}), for a file the whole view listed as omitted.
  changes(id, view = 'session', file = '') {
    const q = new URLSearchParams({ view });
    if (file) q.set('path', file);
    return this.request('GET', `/v1/sessions/${enc(id)}/changes?${q}`);
  }

  lines(id, file, start, end) {
    const q = new URLSearchParams({ path: file, start: String(start), end: String(end) });
    return this.request('GET', `/v1/sessions/${enc(id)}/lines?${q}`);
  }

  async receipts(id, tail = 20) {
    return (await this.request('GET', `/v1/sessions/${enc(id)}/receipts?tail=${tail}`)).receipts || [];
  }

  hunk(id, hunk, action, view = 'session', file = '') {
    return this.request('POST', `/v1/sessions/${enc(id)}/hunks`, { hunk, action, view, path: file });
  }
  keep(id, hunk, view) { return this.hunk(id, hunk, 'keep', view); }
  unkeep(id, hunk, view) { return this.hunk(id, hunk, 'unkeep', view); }
  undo(id, hunk, view, file) { return this.hunk(id, hunk, 'undo', view, file); }

  // Line comments, sent together as one message (the server words it as the window does).
  comments(id, comments) { return this.request('POST', `/v1/sessions/${enc(id)}/comments`, { comments }); }
  send(id, text) { return this.request('POST', `/v1/sessions/${enc(id)}/messages`, { text }); }
  stop(id) { return this.request('POST', `/v1/sessions/${enc(id)}/stop`, {}); }

  // The event stream: onEvent for each JSON line, onEnd(err?) once when it ends. Returns
  // close(). The caller reconnects (the server closes a stream that falls far behind).
  events(onEvent, onEnd = () => {}) {
    let ended = false;
    const end = (err) => { if (!ended) { ended = true; onEnd(err); } };
    const req = http.request(`${this.url}/v1/events`, {
      method: 'GET', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/x-ndjson' },
    }, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let why = res.statusMessage;
          try { why = JSON.parse(Buffer.concat(chunks).toString('utf8')).error || why; } catch { /* keep it */ }
          end(new EdenError(res.statusCode, why));
        });
        return;
      }
      const split = lineSplitter(onEvent);
      res.setEncoding('utf8');
      res.on('data', split);
      res.on('end', () => end());
      res.on('error', (err) => end(new Unreachable(err.message)));
    });
    req.on('error', (err) => end(new Unreachable(err.message || String(err))));
    req.end();
    return () => { ended = true; req.destroy(); };
  }
}

// Whole JSON lines out of chunks that may cut a line anywhere; a line that isn't JSON is
// skipped (it can't be one of the API's).
function lineSplitter(onEvent) {
  let rest = '';
  return (chunk) => {
    rest += chunk;
    let at;
    while ((at = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, at).trim();
      rest = rest.slice(at + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      onEvent(event);
    }
  };
}

function enc(id) { return encodeURIComponent(String(id)); }

module.exports = {
  Client, EdenError, Unreachable, DEFAULT_URL, KEYCHAIN,
  dataFolder, findUrl, findToken, keychainToken, isLocal, lineSplitter,
};
