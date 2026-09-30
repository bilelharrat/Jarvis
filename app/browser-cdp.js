// One built-in browser tab over the Chrome DevTools Protocol (webContents.debugger): attached
// the first time JARVIS or a Jarvis Code session uses the tab, never before. It keeps what the
// agent needs to know about the tab as it goes (its frames in other processes, console
// messages, network requests, which page it's on) and gives every call a time limit, so a
// page that stops answering can never hang the app. Opening the page's developer tools
// detaches it; it attaches again at the next use.
'use strict';

const CALL_MS = 8000;
const CONSOLE_KEPT = 300;
const NETWORK_KEPT = 400;
const WORLD = 'jarvis-agent';
// Electron's own development-time warnings, not the page's.
const NOT_THE_PAGE = /^%cElectron (Security )?(Warning|Deprecation)/;

class CdpError extends Error {
  constructor(message, code = 'cdp') {
    super(message);
    this.code = code;
  }
}

function plain(err) {
  const text = String((err && err.message) || err || '');
  if (/No node with given id|Could not find node|Node with given id does not belong|No node found/i.test(text)) return new CdpError(text, 'gone');
  if (/Cannot find context|Execution context was destroyed|Inspected target navigated|Target closed|Session with given id not found/i.test(text)) return new CdpError(text, 'navigated');
  return err instanceof CdpError ? err : new CdpError(text || 'The page gave an error.', 'cdp');
}

function preview(arg) {
  if (!arg) return '';
  if (arg.type === 'string') return String(arg.value);
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  if (arg.unserializableValue) return String(arg.unserializableValue);
  return String(arg.description || arg.className || arg.type || '');
}

class TabCdp {
  constructor(wc, { now = Date.now } = {}) {
    this.wc = wc;
    this.id = wc.id;
    this.now = now;
    this.attached = false;
    this.attaching = null;
    this.docGen = 0; // bumps whenever the main frame shows a new document
    this.mainFrameId = '';
    this.sessions = new Map(); // sessionId -> { targetId, parent, url }
    this.worlds = new Map(); // `${session}|${frameId}` -> executionContextId
    this.console = [];
    this.requests = []; // newest last
    this.byRequest = new Map();
    this.inflight = new Map(); // requestId -> started (ms)
    this.lastNetwork = 0;
    this.watchingSince = 0;
    this.waiters = new Set();
    this.nativeDialog = null; // a dialog Electron is showing itself (from a subframe)
    this.onMessage = this.onMessage.bind(this);
    this.onDetach = this.onDetach.bind(this);
  }

  get alive() {
    return !this.wc.isDestroyed();
  }

  async ensure() {
    if (this.attached) return;
    if (this.attaching) return this.attaching;
    this.attaching = this.attach().finally(() => { this.attaching = null; });
    return this.attaching;
  }

  async attach() {
    const { wc } = this;
    if (wc.isDestroyed()) throw new CdpError('That tab is closed.', 'closed');
    if (wc.isDevToolsOpened()) {
      throw new CdpError("The page's developer tools are open, so I can't drive it. Close them first.", 'devtools');
    }
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (err) {
      throw new CdpError(`I couldn't attach to the page (${err.message}).`, 'attach');
    }
    dbg.removeListener('message', this.onMessage);
    dbg.removeListener('detach', this.onDetach);
    dbg.on('message', this.onMessage);
    dbg.on('detach', this.onDetach);
    this.attached = true;
    this.watchingSince = this.now();
    // A tab that has never loaded a page answers these once it has one; each has its limit.
    const quiet = (p) => p.catch(() => {});
    await Promise.all([
      quiet(this.send('Page.enable', {}, { timeout: 4000 })),
      quiet(this.send('Runtime.enable', {}, { timeout: 4000 })),
      quiet(this.send('Log.enable', {}, { timeout: 4000 })),
      quiet(this.send('Network.enable', { maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 500_000 }, { timeout: 4000 })),
      quiet(this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, { timeout: 4000 })),
    ]);
    const tree = await this.send('Page.getFrameTree', {}, { timeout: 4000 }).catch(() => null);
    if (tree && tree.frameTree) this.mainFrameId = tree.frameTree.frame.id;
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    try {
      const dbg = this.wc.debugger;
      dbg.removeListener('message', this.onMessage);
      dbg.removeListener('detach', this.onDetach);
      if (dbg.isAttached()) dbg.detach();
    } catch { /* the tab is going */ }
    this.reset('I let go of the page.');
  }

  reset(why) {
    this.sessions.clear();
    this.worlds.clear();
    this.inflight.clear();
    for (const w of this.waiters) w.fail(new CdpError(why, 'detached'));
    this.waiters.clear();
  }

  onDetach(_event, reason) {
    this.attached = false;
    try {
      this.wc.debugger.removeListener('message', this.onMessage);
      this.wc.debugger.removeListener('detach', this.onDetach);
    } catch { /* gone */ }
    this.reset(/devtools/i.test(String(reason)) ? "The page's developer tools were opened." : 'The page went away.');
  }

  // A CDP call with a time limit (a stuck page never hangs the app).
  send(method, params = {}, { session = undefined, timeout = CALL_MS } = {}) {
    if (!this.attached && !this.attaching) return Promise.reject(new CdpError('Not attached to the page.', 'detached'));
    if (this.wc.isDestroyed()) return Promise.reject(new CdpError('That tab is closed.', 'closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError(`The page didn't answer in time (${method}).`, 'timeout')), timeout);
      let call;
      try {
        call = session ? this.wc.debugger.sendCommand(method, params, session) : this.wc.debugger.sendCommand(method, params);
      } catch (err) {
        clearTimeout(timer);
        reject(plain(err));
        return;
      }
      call.then((value) => { clearTimeout(timer); resolve(value || {}); }, (err) => { clearTimeout(timer); reject(plain(err)); });
    });
  }

  // The next event that passes test(method, params, session), within ms (null on time out).
  waitFor(test, ms) {
    return new Promise((resolve) => {
      const waiter = {
        test,
        done: (value) => { clearTimeout(waiter.timer); this.waiters.delete(waiter); resolve(value); },
        fail: () => { clearTimeout(waiter.timer); this.waiters.delete(waiter); resolve(null); },
      };
      waiter.timer = setTimeout(() => waiter.fail(), ms);
      this.waiters.add(waiter);
    });
  }

  onMessage(_event, method, params = {}, sessionId = '') {
    const session = sessionId || '';
    try {
      this.note(method, params, session);
    } catch (err) {
      console.error('browser-cdp: event', method, err && err.message);
    }
    for (const w of [...this.waiters]) {
      try { if (w.test(method, params, session)) w.done({ method, params, session }); } catch { /* a bad test */ }
    }
  }

  note(method, params, session) {
    switch (method) {
      case 'Target.attachedToTarget': {
        const info = params.targetInfo || {};
        if (info.type !== 'iframe') return;
        this.sessions.set(params.sessionId, { targetId: info.targetId, parent: session, url: info.url || '' });
        const child = { session: params.sessionId, timeout: 4000 };
        const quiet = (p) => p.catch(() => {});
        quiet(this.send('Page.enable', {}, child));
        quiet(this.send('Runtime.enable', {}, child));
        quiet(this.send('Network.enable', { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 250_000 }, child));
        quiet(this.send('Log.enable', {}, child));
        quiet(this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child));
        return;
      }
      case 'Target.detachedFromTarget':
        this.sessions.delete(params.sessionId);
        for (const key of [...this.worlds.keys()]) if (key.startsWith(`${params.sessionId}|`)) this.worlds.delete(key);
        return;
      case 'Target.targetInfoChanged': {
        const info = params.targetInfo || {};
        for (const s of this.sessions.values()) if (s.targetId === info.targetId) s.url = info.url || s.url;
        return;
      }
      case 'Page.frameNavigated': {
        const frame = params.frame || {};
        for (const key of [...this.worlds.keys()]) if (key === `${session}|${frame.id}`) this.worlds.delete(key);
        if (!session && !frame.parentId) {
          this.mainFrameId = frame.id;
          this.docGen += 1;
        }
        return;
      }
      case 'Runtime.executionContextsCleared':
        for (const key of [...this.worlds.keys()]) if (key.startsWith(`${session}|`)) this.worlds.delete(key);
        return;
      case 'Runtime.executionContextDestroyed':
        for (const [key, id] of [...this.worlds]) if (id === params.executionContextId && key.startsWith(`${session}|`)) this.worlds.delete(key);
        return;
      case 'Runtime.consoleAPICalled': {
        const args = (params.args || []).map(preview);
        const text = args.join(' ');
        if (NOT_THE_PAGE.test(text)) return;
        const frame = (params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]) || {};
        this.keepConsole({ level: params.type === 'warning' ? 'warning' : params.type || 'log', text, url: frame.url || '', line: frame.lineNumber, frame: session ? 'iframe' : '' });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        const text = (d.exception && d.exception.description) || d.text || 'Uncaught exception';
        this.keepConsole({ level: 'error', text: `Uncaught ${text}`.replace(/^Uncaught Uncaught/, 'Uncaught'), url: d.url || '', line: d.lineNumber, frame: session ? 'iframe' : '' });
        return;
      }
      case 'Log.entryAdded': {
        const e = params.entry || {};
        if (NOT_THE_PAGE.test(String(e.text || ''))) return;
        this.keepConsole({ level: e.level === 'verbose' ? 'debug' : e.level || 'info', text: String(e.text || ''), url: e.url || '', line: e.lineNumber, source: e.source || '', frame: session ? 'iframe' : '' });
        return;
      }
      case 'Network.requestWillBeSent': {
        const r = params.request || {};
        const earlier = this.byRequest.get(params.requestId);
        if (earlier && params.redirectResponse) {
          earlier.status = params.redirectResponse.status;
          earlier.redirected = r.url;
        }
        if (params.type === 'WebSocket' || params.type === 'EventSource') return;
        const entry = { id: params.requestId, method: r.method || 'GET', url: r.url || '', type: params.type || '', at: this.now(), status: 0, failed: '', done: false, frame: session ? 'iframe' : '' };
        this.byRequest.set(params.requestId, entry);
        this.requests.push(entry);
        if (this.requests.length > NETWORK_KEPT) {
          const old = this.requests.shift();
          if (this.byRequest.get(old.id) === old) this.byRequest.delete(old.id);
        }
        if (params.type !== 'Other' || !/^data:/.test(r.url || '')) this.inflight.set(params.requestId, this.now());
        this.lastNetwork = this.now();
        return;
      }
      case 'Network.responseReceived': {
        const entry = this.byRequest.get(params.requestId);
        const res = params.response || {};
        if (entry) { entry.status = res.status || 0; entry.mime = res.mimeType || ''; entry.cached = Boolean(res.fromDiskCache || res.fromServiceWorker); }
        return;
      }
      case 'Network.loadingFinished':
      case 'Network.loadingFailed': {
        const entry = this.byRequest.get(params.requestId);
        if (entry) {
          entry.done = true;
          entry.ms = this.now() - entry.at;
          if (method === 'Network.loadingFailed') entry.failed = params.canceled ? 'canceled' : params.blockedReason ? `blocked (${params.blockedReason})` : params.errorText || 'failed';
          if (params.encodedDataLength !== undefined) entry.bytes = params.encodedDataLength;
        }
        this.inflight.delete(params.requestId);
        this.lastNetwork = this.now();
        return;
      }
      case 'Page.javascriptDialogOpening':
        this.nativeDialog = { type: params.type, message: String(params.message || '').slice(0, 2000), url: params.url || '', at: this.now() };
        return;
      case 'Page.javascriptDialogClosed':
        this.nativeDialog = null;
        return;
      default:
    }
  }

  keepConsole(entry) {
    this.console.push({ at: this.now(), ...entry, text: String(entry.text || '').slice(0, 2000) });
    if (this.console.length > CONSOLE_KEPT) this.console.splice(0, this.console.length - CONSOLE_KEPT);
  }

  // Requests still loading, other than long-lived ones (older than ms: a stream, a poll).
  busy(ms = 5000) {
    const now = this.now();
    let n = 0;
    for (const started of this.inflight.values()) if (now - started < ms) n += 1;
    return n;
  }

  // An isolated world in this frame: the agent's own scripts run there, out of the page's
  // reach (the DOM is shared, the page's JavaScript isn't).
  async world(session, frameId) {
    const key = `${session || ''}|${frameId}`;
    if (this.worlds.has(key)) return this.worlds.get(key);
    const r = await this.send('Page.createIsolatedWorld', { frameId, worldName: WORLD, grantUniveralAccess: false }, { session: session || undefined });
    this.worlds.set(key, r.executionContextId);
    return r.executionContextId;
  }

  // Run fn (a function's source) on the element, in the agent's world; its answer by value.
  async onNode(ref, fn, args = [], { timeout = CALL_MS, awaitPromise = false } = {}) {
    const session = ref.session || undefined;
    const contextId = await this.world(ref.session, ref.frameId);
    const { object } = await this.send('DOM.resolveNode', { backendNodeId: ref.backendNodeId, executionContextId: contextId, objectGroup: WORLD }, { session });
    const r = await this.send('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise,
    }, { session, timeout });
    if (r.exceptionDetails) throw new CdpError((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'The page gave an error.', 'script');
    return r.result ? r.result.value : undefined;
  }

  release(session) {
    return this.send('Runtime.releaseObjectGroup', { objectGroup: WORLD }, { session: session || undefined, timeout: 2000 }).catch(() => {});
  }
}

module.exports = { TabCdp, CdpError, WORLD };
