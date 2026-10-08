// Eden's cloud browser: one per signed-in account (a Durable Object named by the account), a
// real Chrome on Cloudflare's Browser Rendering (the BROWSER binding), driven over the Chrome
// DevTools Protocol. The page in Eden's browser panel is a picture of it: the active tab's
// screencast (JPEG frames, one or two in flight, the panel acks each), drawn on a canvas; the
// panel sends back the mouse, keys and text (rules.js maps them), and the address bar, tabs,
// find, zoom, bookmarks and history work through this object. Nothing of J.A.R.V.I.S. or a Mac
// is involved.
//
// Safety: only http(s) pages, never a local or private network address (every request is
// checked before it leaves Chrome, with the ad and tracker blocklist); downloads are cancelled
// in the cloud and offered to the viewer as a link; one browser per account, closed after 5
// idle minutes, an hour at most, and while the month's browser minutes last (rules.js
// allowance). Page content goes to the viewer only: never logged, never stored (history keeps
// addresses and titles, as a browser does).
//
// Kept per account (this object's storage): history (2000), bookmarks (2000), the search
// engine, ad blocking (on, sites it's off for), zoom per site, and the month's minutes.

import {
  CAST, CLOSED, ENGINES, FrameFlow, LIMITS, RATES, REFUSED, Bucket, addUse, addVisit, addressAllowed, allowance,
  botWall, closeReason, cursorOf, hostOf, iconData, keyEvent, minutesLeft, mouseEvent, navFailure, recentSites,
  requestVerdict, setTitle, siteOf, suggest, textInput, toUrl, toggleBookmark, viewport, zoomStep, ZOOM,
} from './rules.js';
import { runTool, takePending } from './agent.js';
import { TOOL_NAMES, validateCall } from './agent-tools.js';

const AGENT_IDLE_MS = 90 * 1000; // "Eden is controlling" ends by itself if the chat's turn went away

const TICK_MS = 20 * 1000;
const NEW_TAB = 'about:blank';

// In the page (Runtime.evaluate): find with the CSS Custom Highlight API, as J.A.R.V.I.S.
// highlights ranges itself rather than Chrome's find bar.
const FIND = `(q, dir) => {
  const S = (window.__edenFind ??= { q: '', ranges: [], i: -1 });
  const css = document.getElementById('__eden_find_css') || Object.assign(document.createElement('style'), { id: '__eden_find_css', textContent: '::highlight(eden-find){background:#ffe066;color:#000}::highlight(eden-find-now){background:#ff9632;color:#000}' });
  if (!css.isConnected) document.documentElement.append(css);
  if (!q) { CSS.highlights.delete('eden-find'); CSS.highlights.delete('eden-find-now'); S.q = ''; S.ranges = []; return { n: 0, i: 0 }; }
  if (q !== S.q) {
    S.q = q; S.ranges = []; S.i = -1;
    const needle = q.toLowerCase();
    const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
      const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      return p.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
    for (let n = walk.nextNode(); n && S.ranges.length < 1000; n = walk.nextNode()) {
      const t = n.data.toLowerCase(); let at = t.indexOf(needle);
      while (at >= 0 && S.ranges.length < 1000) { const r = new Range(); r.setStart(n, at); r.setEnd(n, at + q.length); S.ranges.push(r); at = t.indexOf(needle, at + q.length); }
    }
    CSS.highlights.set('eden-find', new Highlight(...S.ranges));
  }
  if (!S.ranges.length) { CSS.highlights.delete('eden-find-now'); return { n: 0, i: 0 }; }
  S.i = (S.i + (dir < 0 ? -1 : 1) + S.ranges.length) % S.ranges.length;
  const r = S.ranges[S.i];
  CSS.highlights.set('eden-find-now', new Highlight(r));
  const el = r.startContainer.parentElement; if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  return { n: S.ranges.length, i: S.i + 1 };
}`;
const SELECTION = `(() => { const a = document.activeElement; if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.selectionStart != null && a.type !== 'password') return a.value.slice(a.selectionStart, a.selectionEnd); return String(getSelection() || ''); })()`;
// In the page's own isolated world (pages can't see or call it): the cursor under the mouse,
// told to the panel only when it changes, so the viewer's pointer changes at once.
const CURSOR = `(() => {
  let last = '';
  const tell = (c) => { if (c !== last) { last = c; try { __edenCursor(c); } catch {} } };
  addEventListener('mousemove', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    let c = getComputedStyle(t).cursor;
    if (c === 'auto') {
      c = 'default';
      if (t.closest('textarea,[contenteditable=""],[contenteditable="true"]') || (t.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(t.type))) c = 'text';
      else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (r && r.startContainer.nodeType === 3 && r.startContainer.data.trim()) {
          const rr = document.createRange(); rr.selectNodeContents(r.startContainer);
          for (const b of rr.getClientRects()) if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) { c = 'text'; break; }
        }
      }
    }
    tell(c);
  }, { capture: true, passive: true });
})()`;
// What's under a right-click: the link, the image, the selection (for the panel's menu).
const HIT = `(x, y) => {
  const e = document.elementFromPoint(x, y); const sel = String(getSelection() || '').slice(0, 20000);
  if (!e) return { selection: sel };
  const a = e.closest('a[href]'); const img = e.closest('img');
  return { link: a ? a.href : '', image: img ? (img.currentSrc || img.src || '') : '', selection: sel, editable: Boolean(e.closest('input,textarea,[contenteditable]')) };
}`;
// The page's icon: an SVG or a small PNG it names, else /favicon.ico.
const ICON = `(() => {
  const l = [...document.querySelectorAll('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]')].filter((x) => x.href);
  const size = (x) => { const m = /(\\d+)x/.exec(x.sizes && x.sizes.value || ''); return m ? Number(m[1]) : 0; };
  const pick = l.find((x) => /svg/.test(x.type || x.href)) || l.filter((x) => /icon/.test(x.rel)).sort((a, b) => Math.abs(size(a) - 32) - Math.abs(size(b) - 32))[0] || l[0];
  return pick ? pick.href : location.origin + '/favicon.ico';
})()`;
const PAGE_TEXT = `(() => (document.body ? document.body.innerText : '').slice(0, ${LIMITS.textMax}))()`;

/** base64 (CDP's pictures) as bytes for the socket. */
function bytesOf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class BrowserSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.ws = null;
    this.browser = null; // puppeteer's Browser, while one is open
    this.starting = null;
    this.tabs = new Map(); // id -> tab
    this.active = '';
    this.seq = 0;
    this.view = { w: 1024, h: 768, dpr: 1, touch: false };
    this.plus = false;
    this.flow = new FrameFlow();
    this.inputSeq = 0;
    this.restTimer = 0;
    this.cursor = '';
    this.icons = new Map(); // site -> data: address ('' when it has none)
    this.dialog = null;
  }

  now() { return Date.now(); }

  /** A new Chrome on Browser Rendering (the tests give a fake one). */
  async launch(binding, options) {
    const { default: puppeteer } = await import('@cloudflare/puppeteer');
    return puppeteer.launch(binding, options);
  }

  async prefs() {
    return { engine: 'duckduckgo', adblock: true, allow: [], zoom: {}, ...((await this.storage.get('prefs')) || {}) };
  }

  // ── the panel's socket ──

  async fetch(request) {
    // Eden's chat driving this browser (eden/browser-turn.js), from this Worker only (a binding).
    if (request.method === 'POST' && new URL(request.url).pathname === '/agent') {
      let body = {};
      try { body = await request.json(); } catch { /* empty */ }
      try { return Response.json(await this.agentOp(body)); } catch (err) {
        console.error('cloud browser agent', String((err && err.message) || err).slice(0, 200));
        return Response.json({ error: 'That didn’t work in the cloud browser.' });
      }
    }
    // The account was deleted (accounts/index.js eraseAccount): close the browser and forget everything it kept.
    if (request.method === 'POST' && new URL(request.url).pathname === '/erase') {
      if (this.ws) { try { this.ws.close(4001, 'account deleted'); } catch { /* gone */ } this.ws = null; }
      await this.shutdown('').catch(() => {});
      await this.storage.deleteAll();
      return Response.json({ erased: true });
    }
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('websocket only', { status: 426 });
    this.plus = request.headers.get('x-eden-plus') === '1';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (this.ws) { try { this.ws.send(JSON.stringify({ t: 'replaced' })); this.ws.close(4000, 'replaced'); } catch { /* gone */ } }
    this.ws = server;
    this.flow.reset();
    this.cursor = '';
    this.disconnectedAt = 0;
    const input = new Bucket(...RATES.input, () => this.now());
    const action = new Bucket(...RATES.action, () => this.now());
    server.addEventListener('message', (e) => {
      if (this.ws !== server) return;
      if (typeof e.data !== 'string' || e.data.length > 20000) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      // The viewer's own hands on the page while Eden is controlling: Eden pauses (Take over).
      if (this.agent && this.agent.on && !this.agent.paused && ((msg.t === 'mouse' && msg.e === 'down') || msg.t === 'key' || msg.t === 'text')) this.agentPause(true);
      const cheap = ['mouse', 'key', 'text', 'ack', 'suggest', 'hello', 'resize', 'ping'].includes(msg.t);
      if (!(cheap ? input : action).take()) { if (!cheap) this.send({ t: 'error', message: 'Slow down a little.' }); return; }
      this.onMessage(msg).catch((err) => this.failed(err));
    });
    const gone = () => {
      if (this.ws !== server) return;
      this.ws = null;
      this.disconnectedAt = this.now();
      this.stopCast();
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(msg) {
    if (!this.ws) return;
    try { this.ws.send(typeof msg === 'string' || msg instanceof ArrayBuffer || ArrayBuffer.isView(msg) ? msg : JSON.stringify(msg)); } catch { /* closed */ }
  }

  failed(err) {
    const text = String((err && err.message) || err || '');
    // Never the page's content: only what failed, briefly.
    console.error('cloud browser', text.slice(0, 200));
    if (/Target closed|Session closed|Connection closed|Protocol error.*(closed|detached)|WebSocket is not open/i.test(text)) { this.shutdown('error'); return; }
    this.send({ t: 'error', message: 'That didn’t work in the cloud browser.' });
  }

  async onMessage(msg) {
    const tab = this.tabs.get(this.active);
    if (['mouse', 'key', 'text', 'go', 'tab', 'back', 'forward', 'reload', 'stop', 'find', 'zoom', 'ping'].includes(msg.t)) this.lastInput = this.now();
    if (['mouse', 'key', 'text'].includes(msg.t)) this.inputSeq += 1;
    switch (msg.t) {
      case 'hello':
        this.view = this.viewOf(msg, { w: 1024, h: 768 });
        this.lastInput = this.now();
        await this.sendState();
        if (this.browser) { if (tab) await this.applyViewport(tab); await this.startCast(); }
        return;
      case 'resize': {
        const v = this.viewOf(msg, this.view);
        if (v.w === this.view.w && v.h === this.view.h && v.dpr === this.view.dpr && v.touch === this.view.touch) return;
        this.view = v;
        if (tab) { await this.applyViewport(tab); await this.startCast(); }
        return;
      }
      case 'ping': return; // the panel is open: the browser stays warm (the hour's limit still holds)
      case 'ack': {
        const id = this.flow.acked();
        if (id != null && tab) tab.cdp.send('Page.screencastFrameAck', { sessionId: id }).catch(() => {});
        return;
      }
      case 'hit': {
        if (!tab || !/^https?:/.test(tab.url)) return this.send({ t: 'hit', id: msg.id });
        const z = tab.zoom || 1;
        const x = Math.max(0, Math.min(4000, Number(msg.x) || 0)) / z;
        const y = Math.max(0, Math.min(4000, Number(msg.y) || 0)) / z;
        const r = (await this.evaluate(tab, `(${HIT})(${x}, ${y})`).catch(() => null)) || {};
        const web = (u) => { const ok = addressAllowed(String(u || '')); return ok.ok ? ok.url : ''; };
        return this.send({ t: 'hit', id: msg.id, link: web(r.link), image: web(r.image), selection: String(r.selection || '').slice(0, 20000), editable: Boolean(r.editable) });
      }
      case 'start': await this.ensureBrowser(); if (!this.tabs.size) await this.openTab(NEW_TAB); return;
      case 'end': await this.shutdown('', true); return;
      case 'go': return this.go(msg.url);
      case 'tab': return this.tabOp(msg);
      case 'back': case 'forward': return tab && this.history(tab, msg.t === 'back' ? -1 : 1);
      case 'reload': return tab && tab.cdp.send('Page.reload', { ignoreCache: !!msg.hard });
      case 'stop': return tab && tab.cdp.send('Page.stopLoading');
      case 'mouse': {
        if (!tab) return;
        const p = mouseEvent(msg, tab.zoom);
        if (p) await tab.cdp.send('Input.dispatchMouseEvent', p);
        return;
      }
      case 'key': {
        if (!tab) return;
        const p = keyEvent(msg);
        if (p) await tab.cdp.send('Input.dispatchKeyEvent', p);
        if (p && p.commands && p.commands[0] === 'copy' && p.type !== 'keyUp') await this.copy(tab);
        return;
      }
      case 'text': {
        const p = tab && textInput(msg.text);
        if (p) await tab.cdp.send('Input.insertText', p);
        return;
      }
      case 'copy': return tab && this.copy(tab);
      case 'zoom': {
        if (!tab) return;
        tab.zoom = Number.isFinite(Number(msg.to)) && msg.to !== null ? Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, Number(msg.to))) * 100) / 100 : zoomStep(tab.zoom, Number(msg.dir) || 0);
        const prefs = await this.prefs();
        const site = siteOf(tab.url);
        if (site) {
          if (tab.zoom === 1) delete prefs.zoom[site]; else prefs.zoom[site] = tab.zoom;
          const keys = Object.keys(prefs.zoom);
          if (keys.length > LIMITS.zoomSites) delete prefs.zoom[keys[0]];
          await this.storage.put('prefs', prefs);
        }
        await this.applyViewport(tab);
        await this.startCast();
        return this.sendState();
      }
      case 'find': {
        if (!tab) return;
        const q = String(msg.q || '').slice(0, LIMITS.findMax);
        const r = await this.evaluate(tab, `(${FIND})(${JSON.stringify(q)}, ${Number(msg.dir) < 0 ? -1 : 1})`);
        return this.send({ t: 'find', q, n: (r && r.n) || 0, i: (r && r.i) || 0 });
      }
      case 'suggest': {
        const q = String(msg.q || '').slice(0, 200);
        const [history, bookmarks] = await Promise.all([this.storage.get('hist'), this.storage.get('bm')]);
        const tabs = [...this.tabs.values()].map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === this.active }));
        return this.send({ t: 'suggest', q, rows: suggest(q, { tabs, bookmarks: bookmarks || [], history: history || [], now: this.now() }) });
      }
      case 'bookmark': {
        if (!tab || !/^https?:/.test(tab.url)) return;
        const r = toggleBookmark((await this.storage.get('bm')) || [], { url: tab.url, title: tab.title, folder: msg.folder });
        await this.storage.put('bm', r.bookmarks);
        return this.sendState();
      }
      case 'library': {
        const what = msg.what === 'history' ? 'hist' : 'bm';
        const q = String(msg.q || '').toLowerCase().slice(0, 200);
        const list = ((await this.storage.get(what)) || []).filter((r) => !q || r.url.toLowerCase().includes(q) || String(r.title || '').toLowerCase().includes(q));
        return this.send({ t: 'library', what: msg.what === 'history' ? 'history' : 'bookmarks', q, rows: list.slice(0, 300) });
      }
      case 'library-remove': {
        const what = msg.what === 'history' ? 'hist' : 'bm';
        const url = String(msg.url || '');
        await this.storage.put(what, ((await this.storage.get(what)) || []).filter((r) => r.url !== url));
        if (what === 'bm') await this.sendState();
        return this.onMessage({ t: 'library', what: msg.what, q: msg.q });
      }
      case 'history-clear':
        await this.storage.delete('hist');
        return this.onMessage({ t: 'library', what: 'history' });
      case 'adblock': {
        const prefs = await this.prefs();
        if (msg.site) {
          const site = siteOf(tab ? tab.url : '');
          if (!site) return;
          prefs.allow = prefs.allow.filter((s) => s !== site);
          if (msg.on === false) prefs.allow = [site, ...prefs.allow].slice(0, LIMITS.allowSites);
        } else prefs.adblock = msg.on !== false;
        await this.storage.put('prefs', prefs);
        for (const t of this.tabs.values()) t.prefs = prefs;
        return this.sendState();
      }
      case 'engine': {
        const prefs = await this.prefs();
        if (!Object.hasOwn(ENGINES, String(msg.id))) return;
        prefs.engine = msg.id;
        await this.storage.put('prefs', prefs);
        return this.sendState();
      }
      case 'pagetext': {
        if (!tab || !/^https?:/.test(tab.url)) return this.send({ t: 'pagetext', error: 'Open a page first.' });
        const text = await this.evaluate(tab, PAGE_TEXT);
        return this.send({ t: 'pagetext', url: tab.url, title: tab.title, text: String(text || ''), for: String(msg.for || '').slice(0, 20) });
      }
      case 'agent': // Take over / Resume in the panel
        if (msg.op === 'pause') this.agentPause(true);
        else if (msg.op === 'resume') this.agentPause(false);
        return;
      case 'dialog': {
        const d = this.dialog;
        if (!d) return;
        this.dialog = null;
        clearTimeout(d.timer);
        await d.tab.cdp.send('Page.handleJavaScriptDialog', { accept: !!msg.ok, ...(typeof msg.text === 'string' ? { promptText: msg.text.slice(0, 2000) } : {}) }).catch(() => {});
        return;
      }
      default:
    }
  }

  // ── Eden at the controls (eden/browser-turn.js calls these; browser/agent.js runs the tools) ──

  agentPause(paused) {
    if (!this.agent) this.agent = { on: false, paused: false, at: 0, step: '' };
    this.agent.paused = paused;
    this.agentState();
  }

  agentState() {
    const a = this.agent || {};
    this.send({ t: 'agent', on: Boolean(a.on), paused: Boolean(a.paused), step: a.step || '' });
    clearTimeout(this.agentTimer);
    if (a.on) this.agentTimer = setTimeout(() => { if (this.agent && this.agent.on && this.now() - this.agent.at >= AGENT_IDLE_MS) { this.agent.on = false; this.agentState(); } }, AGENT_IDLE_MS + 1000);
  }

  async agentOp(body) {
    const op = String(body.op || '');
    const now = this.now();
    if (op === 'begin') {
      if (typeof body.plus === 'boolean' && !this.ws) this.plus = body.plus;
      const paused = Boolean(this.agent && this.agent.paused && body.resume !== true);
      if (paused) return { paused: true };
      const browser = await this.ensureBrowser();
      if (!browser) return { error: 'The cloud browser couldn’t start (it may be busy, or this month’s browser minutes are used up).' };
      if (!this.tabs.size) await this.openTab(NEW_TAB);
      this.lastInput = now;
      this.agent = { on: true, paused: false, at: now, step: '', run: String(body.run || '') };
      this.steers = [];
      this.agentState();
      const tab = this.tabs.get(this.active);
      return { ok: true, url: tab && tab.url !== NEW_TAB ? tab.url : '', title: tab ? tab.title : '', tabs: this.tabs.size, log: (await this.storage.get('agentLog')) || [], panel: Boolean(this.ws) };
    }
    if (op === 'end') {
      if (Array.isArray(body.log) && body.log.length) await this.storage.put('agentLog', [...((await this.storage.get('agentLog')) || []), ...body.log.map((x) => String(x).slice(0, 200))].slice(-30));
      if (this.agent) { this.agent.on = false; this.agent.step = ''; this.agent.run = ''; }
      this.agentState();
      return { ok: true };
    }
    if (op === 'act' || op === 'approve') {
      if (!this.browser) return { error: 'The cloud browser closed. Start again (navigate) if needed.', closed: true };
      if (this.agent && this.agent.paused) return { paused: true };
      let name = body.name;
      let args = body.args;
      let approved = false;
      if (op === 'approve') {
        const t = await takePending(this, String(body.id || ''));
        if (t.error) return { error: t.error, text: t.error };
        ({ name, args } = t.pending);
        approved = true;
      }
      if (!TOOL_NAMES.includes(name)) return { error: 'Unknown tool.' };
      const v = validateCall(name, args);
      if (!v.ok) return { error: v.error, text: v.error };
      this.lastInput = now;
      this.agent = { ...(this.agent || {}), on: true, at: now };
      const r = await runTool(this, name, v.args, { approved, vision: body.vision !== false });
      if (r.step) { this.agent.step = r.step; this.agentState(); }
      return r;
    }
    // Steering a running turn (eden/browser-turn.js reads these before each model step).
    if (op === 'steer') {
      const run = String(body.run || '');
      if (!run || !this.agent || this.agent.run !== run) return { error: 'not_running' };
      this.steers = this.steers || [];
      if (this.steers.length >= 5) return { error: 'full' };
      this.steers.push(String(body.text || '').slice(0, 2000));
      return { ok: true };
    }
    if (op === 'steers') {
      if (!this.agent || this.agent.run !== String(body.run || '')) return { texts: [] };
      const texts = this.steers || [];
      this.steers = [];
      return { texts };
    }
    if (op === 'deny') {
      const p = await this.storage.get('agentPending');
      if (p && p.id === body.id) await this.storage.delete('agentPending');
      return { ok: true };
    }
    if (op === 'state') return { on: Boolean(this.agent && this.agent.on), paused: Boolean(this.agent && this.agent.paused), running: Boolean(this.browser) };
    return { error: 'Unknown op.' };
  }

  // ── the browser ──

  async ensureBrowser() {
    if (this.browser) return this.browser;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const usage = await this.storage.get('usage');
      const limit = allowance(this.env, this.plus);
      if (minutesLeft(usage, limit, this.now()) <= 0) { this.send({ t: 'closed', why: 'allowance', message: CLOSED.allowance }); throw Object.assign(new Error('allowance'), { quiet: true }); }
      if (!this.env.BROWSER) { this.send({ t: 'closed', why: 'error', message: 'The cloud browser isn’t set up here.' }); throw Object.assign(new Error('no binding'), { quiet: true }); }
      let browser;
      try {
        browser = await this.launch(this.env.BROWSER, { keep_alive: LIMITS.keepAliveMs });
      } catch (err) {
        console.error('cloud browser launch', String(err && err.message).slice(0, 200));
        this.send({ t: 'closed', why: 'busy', message: CLOSED.busy });
        throw Object.assign(new Error('busy'), { quiet: true });
      }
      this.browser = browser;
      this.startedAt = this.now();
      this.lastTick = this.now();
      this.lastInput = this.now();
      browser.on('disconnected', () => { if (this.browser === browser) this.shutdown('error'); });
      browser.on('targetcreated', (target) => this.adopt(target).catch(() => {}));
      const bcdp = await browser.target().createCDPSession();
      this.bcdp = bcdp;
      // Downloads: never kept in the cloud; the viewer gets the link.
      await bcdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: '/tmp/eden-downloads', eventsEnabled: true }).catch(() => {});
      bcdp.on('Browser.downloadWillBegin', (e) => {
        bcdp.send('Browser.cancelDownload', { guid: e.guid }).catch(() => {});
        const ok = addressAllowed(e.url);
        if (ok.ok) this.send({ t: 'download', url: ok.url, name: String(e.suggestedFilename || '').slice(0, 200) });
      });
      // The page Browser Rendering opens with: closed; tabs are made by openTab.
      for (const p of await browser.pages()) await p.close().catch(() => {});
      await this.storage.setAlarm(this.now() + TICK_MS);
      return browser;
    })();
    try { return await this.starting; } catch (err) { if (!err.quiet) throw err; return null; } finally { this.starting = null; }
  }

  /** A page Chrome opened by itself (window.open, target=_blank): a tab of its own. */
  async adopt(target) {
    if (target.type() !== 'page' || !target.opener()) return;
    const page = await target.page();
    if (!page || [...this.tabs.values()].some((t) => t.page === page)) return;
    if (this.tabs.size >= LIMITS.maxTabs) { await page.close().catch(() => {}); this.send({ t: 'error', message: `At most ${LIMITS.maxTabs} tabs.` }); return; }
    const tab = await this.setupTab(page);
    await this.select(tab.id);
  }

  async openTab(url) {
    const browser = await this.ensureBrowser();
    if (!browser) return null;
    if (this.tabs.size >= LIMITS.maxTabs) { this.send({ t: 'error', message: `At most ${LIMITS.maxTabs} tabs.` }); return null; }
    const page = await browser.newPage();
    const tab = await this.setupTab(page);
    await this.select(tab.id);
    if (url && url !== NEW_TAB) await this.navigate(tab, url);
    return tab;
  }

  async setupTab(page) {
    const id = `t${++this.seq}`;
    const cdp = await page.createCDPSession();
    const tab = { id, page, cdp, url: page.url() || NEW_TAB, title: '', icon: '', wall: false, failed: null, loading: false, blocked: 0, zoom: 1, prefs: await this.prefs(), mainFrame: '' };
    this.tabs.set(id, tab);
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }),
      this.applyViewport(tab),
      cdp.send('Runtime.enable').catch(() => {}), // for the cursor binding's calls
      cdp.send('Runtime.addBinding', { name: '__edenCursor', executionContextName: 'eden' }).catch(() => {}),
      cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR, worldName: 'eden' }).catch(() => {}),
    ]);
    cdp.on('Runtime.bindingCalled', (e) => {
      if (e.name !== '__edenCursor' || tab.id !== this.active) return;
      const c = cursorOf(e.payload);
      if (c !== this.cursor) { this.cursor = c; this.send({ t: 'cursor', c }); }
    });
    const tree = await cdp.send('Page.getFrameTree').catch(() => null);
    tab.mainFrame = tree ? tree.frameTree.frame.id : '';
    cdp.on('Fetch.requestPaused', (e) => this.paused(tab, e));
    cdp.on('Page.screencastFrame', (e) => this.frame(tab, e));
    cdp.on('Page.frameStartedLoading', (e) => { if (e.frameId === tab.mainFrame) { tab.loading = true; tab.failed = null; tab.wall = false; this.sendState(); } });
    cdp.on('Page.frameStoppedLoading', (e) => { if (e.frameId === tab.mainFrame) { tab.loading = false; this.titled(tab); } });
    cdp.on('Page.frameNavigated', (e) => {
      if (e.frame.parentId) return;
      // Chrome's own error page: the panel draws its own, for the address that failed.
      if (e.frame.unreachableUrl || /^chrome-error:/.test(e.frame.url)) {
        const url = e.frame.unreachableUrl || tab.url;
        if (!tab.failed || tab.failed.url !== url) tab.failed = { url, ...navFailure('') };
        tab.url = url;
        this.sendState();
        return;
      }
      this.navigated(tab, e.frame.url);
    });
    cdp.on('Page.navigatedWithinDocument', (e) => { if (e.frameId === tab.mainFrame) this.navigated(tab, e.url); });
    cdp.on('Page.javascriptDialogOpening', (e) => this.dialogOpened(tab, e));
    page.on('close', () => this.closed(tab.id));
    return tab;
  }

  /** Every request a tab makes: blocked if unsafe, or an ad or tracker while blocking is on. */
  paused(tab, e) {
    const url = e.request.url;
    const doc = e.resourceType === 'Document';
    const site = siteOf(tab.url);
    const adblock = tab.prefs.adblock && !(site && tab.prefs.allow.includes(site));
    const verdict = doc && e.frameId === tab.mainFrame ? (addressAllowed(url).ok ? 'allow' : 'unsafe') : requestVerdict(url, { adblock, pageHost: hostOf(tab.url) });
    if (verdict === 'allow') { tab.cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {}); return; }
    tab.cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    if (verdict === 'ad') { tab.blocked += 1; this.soonState(); }
    else if (doc && e.frameId === tab.mainFrame) {
      const why = addressAllowed(url).why || 'scheme';
      this.send({ t: 'error', message: REFUSED[why] || REFUSED.bad });
    }
  }

  async navigated(tab, url) {
    const was = tab.url;
    tab.url = url;
    if (/^https?:/.test(url)) {
      const site = siteOf(url);
      if (siteOf(was) !== site) {
        tab.blocked = 0;
        const z = (tab.prefs.zoom || {})[site] || 1;
        if (z !== tab.zoom) { tab.zoom = z; await this.applyViewport(tab); if (tab.id === this.active) await this.startCast(); }
      }
      await this.storage.put('hist', addVisit((await this.storage.get('hist')) || [], { url, title: tab.title && was === url ? tab.title : '', at: this.now() }));
    }
    await this.sendState();
  }

  async titled(tab) {
    try { tab.title = String(await tab.page.title()).slice(0, LIMITS.titleMax); } catch { /* closed */ }
    tab.wall = botWall(tab.title);
    if (tab.title && /^https?:/.test(tab.url)) await this.storage.put('hist', setTitle((await this.storage.get('hist')) || [], tab.url, tab.title));
    await this.sendState();
    if (/^https?:/.test(tab.url)) this.iconFor(tab).then((got) => { if (got) this.sendState(); }).catch(() => {});
  }

  /** The tab's site icon, fetched here (never by the viewer) and kept: true when it's new. */
  async iconFor(tab) {
    const site = siteOf(tab.url);
    if (!site) return false;
    if (!this.icons.has(site)) {
      const kept = await this.storage.get(`icon:${site}`);
      if (typeof kept === 'string') this.icons.set(site, kept);
    }
    if (this.icons.has(site)) { const was = tab.icon; tab.icon = this.icons.get(site); return was !== tab.icon; }
    this.icons.set(site, ''); // one try per site while this browser lasts
    const href = await this.evaluate(tab, ICON).catch(() => '');
    if (typeof href !== 'string') { console.log('cloud browser icon: none named'); return false; }
    let url = href;
    let data = '';
    for (let hop = 0; hop < 3 && !data; hop++) {
      const ok = addressAllowed(url);
      if (!ok.ok) return false;
      const res = await this.fetchIcon(ok.url);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), ok.url).href; continue; }
      if (!res.ok || Number(res.headers.get('content-length') || 0) > 48 * 1024) { console.log('cloud browser icon: status', res.status); return false; }
      data = iconData(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type'));
      if (!data) return false;
    }
    if (!data) return false;
    this.icons.set(site, data);
    if (this.icons.size > 300) this.icons.delete(this.icons.keys().next().value);
    await this.storage.put(`icon:${site}`, data);
    tab.icon = data;
    return true;
  }

  fetchIcon(url) {
    return fetch(url, { redirect: 'manual', headers: { accept: 'image/*', 'user-agent': 'EdenBrowser/1.0 (site icons; +https://askeden.com)' }, signal: AbortSignal.timeout(4000) });
  }

  dialogOpened(tab, e) {
    if (e.type === 'beforeunload') { tab.cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); return; }
    const timer = setTimeout(() => { if (this.dialog && this.dialog.tab === tab) { this.dialog = null; tab.cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); this.send({ t: 'dialog', done: true }); } }, 60000);
    this.dialog = { tab, timer };
    this.send({ t: 'dialog', kind: e.type, message: String(e.message || '').slice(0, 1000), site: siteOf(tab.url), value: String(e.defaultPrompt || '').slice(0, 200) });
  }

  async go(text) {
    const prefs = await this.prefs();
    const r = toUrl(text, prefs.engine);
    if (!r.ok) { this.send({ t: 'error', message: REFUSED[r.why] || REFUSED.bad }); return; }
    const tab = this.tabs.get(this.active);
    if (!tab) { await this.openTab(r.url); return; }
    await this.navigate(tab, r.url);
  }

  async navigate(tab, url) {
    const ok = addressAllowed(url);
    if (!ok.ok) { this.send({ t: 'error', message: REFUSED[ok.why] }); return; }
    tab.failed = null;
    const r = await tab.cdp.send('Page.navigate', { url: ok.url });
    if (r && r.errorText && !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(r.errorText)) {
      tab.failed = { url: ok.url, ...navFailure(r.errorText) };
      tab.loading = false;
      await this.sendState();
    }
  }

  async history(tab, dir) {
    const h = await tab.cdp.send('Page.getNavigationHistory');
    const entry = h.entries[h.currentIndex + dir];
    if (entry) await tab.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
  }

  async tabOp(msg) {
    if (msg.op === 'new') { await this.openTab(typeof msg.url === 'string' && msg.url ? (toUrl(msg.url, (await this.prefs()).engine).url || NEW_TAB) : NEW_TAB); return; }
    const tab = this.tabs.get(String(msg.id || ''));
    if (!tab) return;
    if (msg.op === 'select') await this.select(tab.id);
    if (msg.op === 'close') {
      await tab.page.close().catch(() => {});
      this.closed(tab.id);
    }
  }

  closed(id) {
    if (!this.tabs.has(id)) return;
    this.tabs.delete(id);
    if (this.active === id) {
      this.active = '';
      const next = [...this.tabs.keys()].at(-1);
      if (next) this.select(next).catch(() => {});
    }
    this.sendState();
  }

  async select(id) {
    if (!this.tabs.has(id)) return;
    if (this.active && this.active !== id) await this.stopCast();
    this.active = id;
    const tab = this.tabs.get(id);
    await tab.page.bringToFront().catch(() => {});
    await this.startCast();
    await this.sendState();
  }

  viewOf(msg, was) {
    return { w: Number(msg.w) || was.w, h: Number(msg.h) || was.h, dpr: Math.min(3, Math.max(1, Number(msg.dpr) || 1)), touch: Boolean(msg.touch) };
  }

  async applyViewport(tab) {
    const v = viewport(this.view.w, this.view.h, tab.zoom, this.view.dpr, this.view.touch && this.view.w < 600);
    await tab.cdp.send('Emulation.setDeviceMetricsOverride', v);
    tab.viewport = v;
  }

  // ── the picture ──

  async startCast() {
    const tab = this.tabs.get(this.active);
    if (!tab || !this.ws) return;
    await tab.cdp.send('Page.stopScreencast').catch(() => {});
    this.flow.reset();
    const v = tab.viewport || viewport(this.view.w, this.view.h, tab.zoom, this.view.dpr);
    await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: CAST.moving, maxWidth: Math.round(v.width * v.deviceScaleFactor), maxHeight: Math.round(v.height * v.deviceScaleFactor), everyNthFrame: 1 });
    this.restSoon(tab);
  }

  async stopCast() {
    const tab = this.tabs.get(this.active);
    if (tab) await tab.cdp.send('Page.stopScreencast').catch(() => {});
  }

  frame(tab, e) {
    if (tab.id !== this.active || !this.ws) { tab.cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {}); return; }
    // Taking the crisp picture makes Chrome paint once more: that frame is the same picture,
    // only blurrier, so it's skipped (unless the viewer did something since).
    if (this.crispAt && this.now() - this.crispAt < 600 && this.crispSeq === this.inputSeq) {
      tab.cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
      return;
    }
    this.crispAt = 0;
    this.send(bytesOf(e.data));
    if (this.flow.sent(e.sessionId)) tab.cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
    this.restSoon(tab);
  }

  /** Once the picture has been still a moment: one crisp frame, unless the viewer did something since. */
  restSoon(tab) {
    clearTimeout(this.restTimer);
    this.restTimer = setTimeout(() => { this.restTimer = 0; this.crisp(tab).catch(() => {}); }, CAST.restMs);
  }

  async crisp(tab) {
    if (tab.id !== this.active || !this.ws || !this.browser) return;
    if (!this.flow.room) { this.restSoon(tab); return; }
    const seq = this.inputSeq;
    // Once per burst of input; while a page keeps changing by itself, at most every 2 seconds.
    if (this.lastCrisp && seq === this.lastCrisp.seq && this.now() - this.lastCrisp.at < 2000) return;
    this.lastCrisp = { seq, at: this.now() };
    const r = await tab.cdp.send('Page.captureScreenshot', { format: 'webp', quality: CAST.rest, fromSurface: true });
    if (!r || !r.data || tab.id !== this.active || !this.ws) return;
    if (seq !== this.inputSeq) { this.restSoon(tab); return; }
    this.send(bytesOf(r.data));
    this.flow.sent(null);
    this.crispAt = this.now();
    this.crispSeq = seq;
  }

  async evaluate(tab, expression) {
    const r = await tab.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 3000 });
    return r && r.result ? r.result.value : null;
  }

  async copy(tab) {
    const text = await this.evaluate(tab, SELECTION);
    if (text) this.send({ t: 'copied', text: String(text).slice(0, 100000) });
  }

  // ── what the panel shows ──

  soonState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => { this.stateTimer = 0; this.sendState(); }, 400);
  }

  async sendState() {
    if (!this.ws) return;
    const [prefs, bookmarks, usage, history] = await Promise.all([this.prefs(), this.storage.get('bm'), this.storage.get('usage'), this.storage.get('hist')]);
    const tab = this.tabs.get(this.active);
    let canBack = false;
    let canForward = false;
    if (tab) {
      try {
        const h = await tab.cdp.send('Page.getNavigationHistory');
        canBack = h.currentIndex > 0 && !(h.currentIndex === 1 && h.entries[0].url === NEW_TAB);
        canForward = h.currentIndex < h.entries.length - 1;
      } catch { /* closing */ }
    }
    const site = tab ? siteOf(tab.url) : '';
    this.send({
      t: 'state',
      running: Boolean(this.browser),
      tabs: [...this.tabs.values()].map((t) => ({ id: t.id, title: t.title, url: t.url === NEW_TAB ? '' : t.url, loading: t.loading, icon: t.icon || '' })),
      active: this.active,
      url: tab && tab.url !== NEW_TAB ? tab.url : '',
      title: tab ? tab.title : '',
      loading: tab ? tab.loading : false,
      canBack, canForward,
      zoom: tab ? tab.zoom : 1,
      blocked: tab ? tab.blocked : 0,
      adblock: prefs.adblock,
      siteAdblock: !(site && prefs.allow.includes(site)),
      bookmarked: Boolean(tab && (bookmarks || []).some((b) => b.url === tab.url)),
      bookmarks: (bookmarks || []).slice(0, 12).map((b) => ({ url: b.url, title: b.title, icon: this.icons.get(siteOf(b.url)) || '' })),
      recent: tab && tab.url !== NEW_TAB ? [] : recentSites(history || [], 8).map((r) => ({ ...r, icon: this.icons.get(r.site) || '' })),
      failed: tab && tab.failed ? tab.failed : null,
      wall: Boolean(tab && tab.wall),
      engine: prefs.engine,
      minutesLeft: Math.floor(minutesLeft(usage, allowance(this.env, this.plus), this.now())),
      plus: this.plus,
    });
  }

  // ── time: minutes counted, idle and longest sessions closed ──

  async alarm() {
    if (!this.browser) return;
    const now = this.now();
    const usage = addUse(await this.storage.get('usage'), now - (this.lastTick || now), now);
    this.lastTick = now;
    await this.storage.put('usage', usage);
    const why = closeReason({ now, startedAt: this.startedAt, lastInput: this.lastInput || now, connected: Boolean(this.ws), disconnectedAt: this.disconnectedAt, usage, limit: allowance(this.env, this.plus) });
    if (why) { await this.shutdown(why); return; }
    await this.storage.setAlarm(now + TICK_MS);
  }

  async shutdown(why, asked = false) {
    const browser = this.browser;
    if (browser) {
      const now = this.now();
      await this.storage.put('usage', addUse(await this.storage.get('usage'), now - (this.lastTick || now), now)).catch(() => {});
    }
    this.browser = null;
    clearTimeout(this.restTimer);
    this.tabs.clear();
    this.active = '';
    this.dialog = null;
    if (this.agent) this.agent.on = false;
    if (browser) { try { await browser.close(); } catch { /* already gone */ } }
    await Promise.resolve(this.storage.deleteAlarm?.()).catch(() => {});
    if (why || asked) this.send({ t: 'closed', why: why || 'ended', message: CLOSED[why] || '' });
    await this.sendState();
  }
}
