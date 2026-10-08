// Eden's cloud browser: the rules (src/browser/rules.js: which addresses, the blocklist, the
// viewer's mouse and keys as CDP, rate limits, history and suggestions, minutes) and the
// per-account object (src/browser/session.js) on a fake Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Bucket, LIMITS, addUse, addVisit, addressAllowed, allowance, closeReason, hostBlocked, keyEvent, minutesLeft,
  mouseEvent, privateHost, requestVerdict, suggest, textInput, toUrl, toggleBookmark, viewport, zoomStep,
  FrameFlow, botWall, cursorOf, density, iconData, navFailure, recentSites,
} from '../src/browser/rules.js';
import { BrowserSession } from '../src/browser/session.js';
import { browserApi } from '../src/browser/api.js';
import { Storage } from './fakes.js';

// ── addresses ──

test('private and local hosts are never opened', () => {
  for (const h of ['localhost', 'a.localhost', 'printer.local', 'nas', 'x.internal', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '[::1]', '[::]', '[fd00::1]', '[fe80::1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.1]']) {
    assert.ok(privateHost(h), h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '[2606:4700::1111]', 'www.bbc.co.uk']) assert.ok(!privateHost(h), h);
  // URL normalizes the tricks: decimal, hex and short forms of 127.0.0.1
  for (const u of ['http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/']) assert.equal(addressAllowed(u).why, 'private', u);
});

test('only http(s) pages; resources may be data:, blob: and web sockets too', () => {
  assert.equal(addressAllowed('https://example.com/a').ok, true);
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,hi', 'ftp://x.com']) assert.equal(addressAllowed(u).ok, false, u);
  assert.equal(addressAllowed('https://user:pw@example.com').why, 'credentials');
  assert.equal(addressAllowed('data:image/png;base64,AA', 'resource').ok, true);
  assert.equal(addressAllowed('wss://example.com/s', 'resource').ok, true);
  assert.equal(addressAllowed('ws://10.0.0.2/s', 'resource').ok, false);
  assert.equal(addressAllowed(`https://e.com/${'a'.repeat(LIMITS.urlMax)}`).why, 'long');
});

test('the address bar: hosts get https, words a search, local and other schemes are refused', () => {
  assert.equal(toUrl('example.com').url, 'https://example.com/');
  assert.equal(toUrl('example.com/a?b=1').url, 'https://example.com/a?b=1');
  assert.equal(toUrl('http://example.com').url, 'http://example.com/');
  assert.equal(toUrl('weather in paris').url, 'https://duckduckgo.com/?q=weather%20in%20paris');
  assert.equal(toUrl('weather', 'google').url, 'https://www.google.com/search?q=weather');
  assert.equal(toUrl('weather').search, true);
  assert.equal(toUrl('localhost:3000').why, 'private');
  assert.equal(toUrl('192.168.1.5').why, 'private');
  assert.equal(toUrl('devbox:8080').why, 'private');
  assert.equal(toUrl('javascript:alert(1)').why, 'scheme');
  assert.equal(toUrl('file:///etc/hosts').why, 'scheme');
  assert.equal(toUrl('').ok, false);
});

test('ads and trackers are blocked by host (and parents); a site’s own requests go through', () => {
  const set = new Set(['doubleclick.net', 'ads.example.org']);
  assert.ok(hostBlocked('doubleclick.net', set));
  assert.ok(hostBlocked('stats.g.doubleclick.net', set));
  assert.ok(!hostBlocked('example.org', set));
  assert.ok(hostBlocked('googleads.g.doubleclick.net'), 'the generated list has the usual ones');
  assert.equal(requestVerdict('https://googleads.g.doubleclick.net/pagead/x.js', { pageHost: 'news.com' }), 'ad');
  assert.equal(requestVerdict('https://googleads.g.doubleclick.net/pagead/x.js', { adblock: false }), 'allow');
  assert.equal(requestVerdict('https://cdn.news.com/app.js', { pageHost: 'news.com' }), 'allow');
  assert.equal(requestVerdict('http://169.254.169.254/latest/meta-data', { pageHost: 'news.com' }), 'unsafe');
  assert.equal(requestVerdict('chrome-extension://x/y', {}), 'scheme');
});

// ── the viewer's input ──

test('mouse: panel pixels to page pixels at the zoom; buttons, clicks and wheel', () => {
  assert.deepEqual(mouseEvent({ e: 'down', x: 200, y: 100, b: 0, n: 2 }, 2), { x: 100, y: 50, modifiers: 0, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 2 });
  assert.equal(mouseEvent({ e: 'up', x: 1, y: 1, b: 2 }).button, 'right');
  assert.equal(mouseEvent({ e: 'move', x: 1, y: 1, held: true }).buttons, 1);
  const w = mouseEvent({ e: 'wheel', x: 10, y: 10, dx: 0, dy: 120, m: { shift: true } });
  assert.equal(w.type, 'mouseWheel');
  assert.equal(w.deltaY, 120);
  assert.equal(w.modifiers, 8);
  assert.equal(mouseEvent({ e: 'down', x: -50, y: 1e9 }).x, 0, 'clamped');
  assert.equal(mouseEvent({ e: 'nope' }), null);
});

test('keys: text goes as text (IME-safe); special keys and ⌘ shortcuts as keys, ⌘ becoming Ctrl', () => {
  assert.equal(keyEvent({ e: 'down', key: 'a' }), null, 'a letter is text');
  assert.equal(keyEvent({ e: 'down', key: 'é' }), null);
  const enter = keyEvent({ e: 'down', key: 'Enter', code: 'Enter' });
  assert.equal(enter.type, 'keyDown');
  assert.equal(enter.text, '\r');
  assert.equal(enter.windowsVirtualKeyCode, 13);
  assert.equal(keyEvent({ e: 'up', key: 'Enter' }).type, 'keyUp');
  const back = keyEvent({ e: 'down', key: 'Backspace' });
  assert.equal(back.type, 'rawKeyDown');
  assert.equal(back.windowsVirtualKeyCode, 8);
  const all = keyEvent({ e: 'down', key: 'a', code: 'KeyA', m: { meta: true } });
  assert.equal(all.modifiers, 2, '⌘ is Ctrl');
  assert.deepEqual(all.commands, ['selectAll']);
  assert.equal(all.windowsVirtualKeyCode, 65);
  assert.deepEqual(keyEvent({ e: 'down', key: 'c', m: { ctrl: true } }).commands, ['copy']);
  assert.equal(keyEvent({ e: 'down', key: 'ArrowDown', m: { shift: true } }).modifiers, 8);
  assert.equal(keyEvent({ e: 'down', key: '' }), null);
  assert.deepEqual(textInput('a\r\nb'), { text: 'a\nb' });
  assert.equal(textInput('x'.repeat(9000)).text.length, LIMITS.insertMax);
  assert.equal(textInput(''), null);
});

test('viewport and zoom: zooming in makes the page narrower; ×1.1 steps, 100% snaps', () => {
  assert.deepEqual(viewport(800, 600, 1), { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(viewport(800, 600, 2), { width: 400, height: 300, deviceScaleFactor: 2, mobile: false });
  assert.equal(viewport(10, 10).width, 240, 'at least 240 wide');
  assert.equal(zoomStep(1, 1), 1.1);
  assert.equal(zoomStep(1.1, -1), 1);
  assert.equal(zoomStep(3, 1), 3);
  assert.equal(zoomStep(2, 0), 1);
});

test('rate limits: a token bucket per socket', () => {
  let t = 0;
  const b = new Bucket(2, 3, () => t);
  assert.ok(b.take() && b.take() && b.take());
  assert.ok(!b.take(), 'burst spent');
  t = 500;
  assert.ok(b.take(), 'refilled at 2 a second');
  assert.ok(!b.take());
});

// ── history, bookmarks, suggestions, minutes ──

test('history: newest first, capped, a reload counts a visit; bookmarks toggle', () => {
  let h = addVisit([], { url: 'https://a.com/', title: 'A', at: 1 });
  h = addVisit(h, { url: 'https://a.com/', title: 'A', at: 2 });
  assert.equal(h.length, 1);
  assert.equal(h[0].n, 2);
  h = addVisit(h, { url: 'javascript:1', at: 3 });
  assert.equal(h.length, 1, 'only web pages');
  for (let i = 0; i < LIMITS.history + 5; i++) h = addVisit(h, { url: `https://x.com/${i}`, at: i });
  assert.equal(h.length, LIMITS.history);
  let r = toggleBookmark([], { url: 'https://a.com/', title: 'A' });
  assert.equal(r.on, true);
  r = toggleBookmark(r.bookmarks, { url: 'https://a.com/' });
  assert.equal(r.on, false);
  assert.equal(r.bookmarks.length, 0);
});

test('suggestions rank as J.A.R.V.I.S.’s browser does: open tabs, then bookmarks, then visits', () => {
  const now = Date.now();
  const rows = suggest('git', {
    tabs: [{ id: 't2', url: 'https://github.com/x', title: 'X', active: false }],
    bookmarks: [{ url: 'https://gitlab.com/', title: 'GitLab' }],
    history: [{ url: 'https://example.com/git-guide', title: 'A git guide', at: now }],
    now,
  });
  assert.deepEqual(rows.map((r) => r.kind), ['tab', 'bookmark', 'history']);
  assert.equal(rows[0].tab, 't2');
  assert.deepEqual(suggest('', {}), []);
});

test('minutes: a month at a time, by plan; closing reasons', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(allowance({}, false), 60);
  assert.equal(allowance({}, true), 600);
  assert.equal(allowance({ BROWSER_MINUTES_FREE: '5' }, false), 5);
  let u = addUse(null, 30 * 60000, now);
  assert.equal(minutesLeft(u, 60, now), 30);
  u = addUse({ month: '2026-09', ms: 1e9 }, 60000, now);
  assert.equal(u.ms, 60000, 'a new month starts at zero');
  const base = { now, startedAt: now - 1000, lastInput: now - 1000, connected: true, usage: null, limit: 60 };
  assert.equal(closeReason(base), '');
  assert.equal(closeReason({ ...base, lastInput: now - LIMITS.idleMs }), 'idle');
  assert.equal(closeReason({ ...base, startedAt: now - LIMITS.maxSessionMs }), 'max');
  assert.equal(closeReason({ ...base, usage: { month: '2026-10', ms: 60 * 60000 } }), 'allowance');
  assert.equal(closeReason({ ...base, connected: false, disconnectedAt: now - LIMITS.graceMs }), 'gone');
});

// ── the object, on a fake Chrome ──

class FakeCDP {
  constructor(answers = {}) { this.sent = []; this.handlers = {}; this.answers = answers; }
  async send(method, params) {
    this.sent.push([method, params]);
    const a = this.answers[method];
    return typeof a === 'function' ? a(params) : a || {};
  }
  on(ev, fn) { (this.handlers[ev] ??= []).push(fn); }
  emit(ev, e) { for (const fn of this.handlers[ev] || []) fn(e); }
  of(method) { return this.sent.filter(([m]) => m === method).map(([, p]) => p); }
}
function fakeChrome() {
  const pages = [];
  const bcdp = new FakeCDP();
  const browser = {
    closed: false,
    handlers: {},
    async newPage() {
      const cdp = new FakeCDP({
        'Page.getFrameTree': { frameTree: { frame: { id: 'main' } } },
        'Page.getNavigationHistory': { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] },
        'Runtime.evaluate': ({ expression }) => ({ result: { value: expression.includes('innerText') ? 'Page words' : expression.includes('getSelection') ? 'picked' : { n: 3, i: 1 } } }),
      });
      const page = { cdp, title: async () => 'Example', url: () => 'about:blank', createCDPSession: async () => cdp, bringToFront: async () => {}, close: async () => {}, on() {} };
      pages.push(page);
      return page;
    },
    async pages() { return []; },
    target: () => ({ createCDPSession: async () => bcdp }),
    on(ev, fn) { this.handlers[ev] = fn; },
    async close() { this.closed = true; },
  };
  return { browser, pages, bcdp };
}
function session({ plus = false, usage = null, env = {} } = {}) {
  const storage = new Storage();
  if (usage) storage.map.set('usage', usage);
  const s = new BrowserSession({ storage }, { BROWSER: {}, ...env });
  const chrome = fakeChrome();
  s.launched = [];
  s.launch = async (binding, opts) => { s.launched.push(opts); return chrome.browser; };
  s.out = [];
  s.ws = { send: (m) => s.out.push(typeof m === 'string' ? JSON.parse(m) : m) };
  s.plus = plus;
  return { s, chrome, storage };
}
const last = (s, t) => s.out.filter((m) => m.t === t).at(-1);

test('session: start launches one Chrome (keep-alive), opens a tab and starts the screencast at the panel’s size', async () => {
  const { s, chrome, storage } = session();
  await s.onMessage({ t: 'hello', w: 900, h: 700 });
  assert.equal(last(s, 'state').running, false, 'nothing launched until asked');
  await s.onMessage({ t: 'start' });
  await s.onMessage({ t: 'start' });
  assert.equal(s.launched.length, 1);
  assert.equal(s.launched[0].keep_alive, LIMITS.keepAliveMs);
  assert.equal(chrome.pages.length, 1);
  const cdp = chrome.pages[0].cdp;
  assert.deepEqual(cdp.of('Emulation.setDeviceMetricsOverride')[0], { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  assert.equal(cdp.of('Page.startScreencast').at(-1).maxWidth, 900);
  assert.equal(cdp.of('Fetch.enable').length, 1, 'every request is checked');
  assert.equal(last(s, 'state').running, true);
  assert.equal(last(s, 'state').minutesLeft, 60);
  assert.ok(storage.alarm, 'the clock runs');
  assert.deepEqual(chrome.bcdp.of('Browser.setDownloadBehavior')[0].eventsEnabled, true);
});

test('session: the month’s minutes used up: no browser', async () => {
  const { s } = session({ usage: { month: new Date().toISOString().slice(0, 7), ms: 61 * 60000 } });
  await s.onMessage({ t: 'start' });
  assert.equal(s.launched.length, 0);
  assert.equal(last(s, 'closed').why, 'allowance');
});

test('session: addresses typed go through the rules; private ones never reach Chrome', async () => {
  const { s, chrome } = session();
  await s.onMessage({ t: 'go', url: 'example.com' });
  const cdp = chrome.pages[0].cdp;
  assert.equal(cdp.of('Page.navigate')[0].url, 'https://example.com/');
  for (const bad of ['http://192.168.1.1', 'localhost:8080', 'javascript:alert(1)', 'file:///etc/passwd']) {
    await s.onMessage({ t: 'go', url: bad });
  }
  assert.equal(cdp.of('Page.navigate').length, 1);
  assert.equal(s.out.filter((m) => m.t === 'error').length, 4);
});

test('session: requests: ads blocked and counted, private ones refused, a site’s own allowed; off per site', async () => {
  const { s, chrome } = session();
  await s.onMessage({ t: 'start' });
  const tab = [...s.tabs.values()][0];
  tab.url = 'https://news.com/';
  const cdp = chrome.pages[0].cdp;
  const req = (url, type = 'Script', frameId = 'main') => cdp.emit('Fetch.requestPaused', { requestId: url, request: { url }, resourceType: type, frameId });
  req('https://googleads.g.doubleclick.net/x.js');
  req('http://10.0.0.1/admin');
  req('https://news.com/app.js');
  req('http://127.0.0.1/', 'Document');
  assert.deepEqual(cdp.of('Fetch.failRequest').map((p) => p.requestId), ['https://googleads.g.doubleclick.net/x.js', 'http://10.0.0.1/admin', 'http://127.0.0.1/']);
  assert.deepEqual(cdp.of('Fetch.continueRequest').map((p) => p.requestId), ['https://news.com/app.js']);
  assert.equal(tab.blocked, 1);
  await s.onMessage({ t: 'adblock', site: true, on: false });
  req('https://googleads.g.doubleclick.net/y.js');
  assert.equal(cdp.of('Fetch.continueRequest').at(-1).requestId, 'https://googleads.g.doubleclick.net/y.js');
  assert.equal(last(s, 'state').siteAdblock, false);
});

test('session: input becomes CDP at the zoom; text is inserted; ⌘C copies the page’s selection to the viewer', async () => {
  const { s, chrome } = session();
  await s.onMessage({ t: 'hello', w: 800, h: 600 });
  await s.onMessage({ t: 'start' });
  const cdp = chrome.pages[0].cdp;
  await s.onMessage({ t: 'zoom', dir: 1 });
  assert.equal([...s.tabs.values()][0].zoom, 1.1);
  await s.onMessage({ t: 'mouse', e: 'down', x: 110, y: 55, b: 0, n: 1 });
  const p = cdp.of('Input.dispatchMouseEvent')[0];
  assert.equal(Math.round(p.x), 100);
  assert.equal(Math.round(p.y), 50);
  await s.onMessage({ t: 'text', text: 'héllo 日本' });
  assert.deepEqual(cdp.of('Input.insertText')[0], { text: 'héllo 日本' });
  await s.onMessage({ t: 'key', e: 'down', key: 'c', m: { meta: true } });
  assert.deepEqual(cdp.of('Input.dispatchKeyEvent')[0].commands, ['copy']);
  assert.equal(last(s, 'copied').text, 'picked');
});

test('session: frames: at most two in flight, the rest wait for the viewer’s ack', async () => {
  const { s, chrome } = session();
  await s.onMessage({ t: 'start' });
  const cdp = chrome.pages[0].cdp;
  const frame = (id) => cdp.emit('Page.screencastFrame', { sessionId: id, data: btoa('JPEG') });
  frame(1);
  frame(2);
  assert.deepEqual(cdp.of('Page.screencastFrameAck').map((p) => p.sessionId), [1]);
  assert.equal(s.out.filter((m) => m instanceof Uint8Array).length, 2);
  await s.onMessage({ t: 'ack' });
  assert.deepEqual(cdp.of('Page.screencastFrameAck').map((p) => p.sessionId), [1, 2]);
});

test('session: history, bookmarks, suggestions, find, page text', async () => {
  const { s, chrome, storage } = session();
  await s.onMessage({ t: 'start' });
  const cdp = chrome.pages[0].cdp;
  cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/' } });
  await new Promise((r) => setTimeout(r, 5));
  cdp.emit('Page.frameStoppedLoading', { frameId: 'main' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await storage.get('hist'))[0].title, 'Example');
  await s.onMessage({ t: 'bookmark' });
  assert.equal(last(s, 'state').bookmarked, true);
  await s.onMessage({ t: 'suggest', q: 'exa' });
  assert.equal(last(s, 'suggest').rows[0].url, 'https://example.com/');
  await s.onMessage({ t: 'find', q: 'word', dir: 1 });
  assert.deepEqual([last(s, 'find').n, last(s, 'find').i], [3, 1]);
  await s.onMessage({ t: 'pagetext' });
  assert.equal(last(s, 'pagetext').text, 'Page words');
  await s.onMessage({ t: 'history-clear' });
  assert.equal(await storage.get('hist'), undefined);
});

test('session: downloads are cancelled in the cloud and offered as a link', async () => {
  const { s, chrome } = session();
  await s.onMessage({ t: 'start' });
  chrome.bcdp.emit('Browser.downloadWillBegin', { guid: 'g1', url: 'https://example.com/a.pdf', suggestedFilename: 'a.pdf' });
  chrome.bcdp.emit('Browser.downloadWillBegin', { guid: 'g2', url: 'http://10.0.0.1/a.pdf', suggestedFilename: 'b.pdf' });
  assert.deepEqual(chrome.bcdp.of('Browser.cancelDownload').map((p) => p.guid), ['g1', 'g2']);
  assert.deepEqual(s.out.filter((m) => m.t === 'download').map((m) => m.name), ['a.pdf']);
});

test('session: idle closes the browser and counts its minutes; tabs are capped', async () => {
  const { s, chrome, storage } = session();
  let t = Date.parse('2026-10-07T12:00:00Z');
  s.now = () => t;
  await s.onMessage({ t: 'start' });
  for (let i = 0; i < LIMITS.maxTabs + 2; i++) await s.onMessage({ t: 'tab', op: 'new' });
  assert.equal(s.tabs.size, LIMITS.maxTabs);
  t += LIMITS.idleMs + 1;
  await s.alarm();
  assert.equal(chrome.browser.closed, true);
  assert.equal(last(s, 'closed').why, 'idle');
  assert.equal(Math.round((await storage.get('usage')).ms / 60000), 5);
});

// ── the socket's door ──

test('connect: a WebSocket from this site only, signed in, with the binding', async () => {
  const req = (headers) => new Request('https://askeden.com/api/chat/browser', { headers });
  assert.equal((await browserApi(req({}), {})).status, 426);
  assert.equal((await browserApi(req({ upgrade: 'websocket', origin: 'https://evil.com' }), {})).status, 403);
  assert.equal((await browserApi(req({ upgrade: 'websocket' }), {})).status, 403, 'no Origin: not a page of this site');
  assert.equal((await browserApi(req({ upgrade: 'websocket', origin: 'https://askeden.com' }), {})).status, 503);
  assert.equal((await browserApi(req({ upgrade: 'websocket', origin: 'https://askeden.com' }), { BROWSER: {}, BROWSER_SESSIONS: {}, ACCOUNTS: {} })).status, 401);
});

// ── feel: sharpness, flow, the cursor, failures ──

test('the picture is drawn at the viewer’s density (Retina 2x), in the same CSS pixels; huge panels drop density', () => {
  assert.deepEqual(viewport(800, 600, 1, 2), { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
  assert.deepEqual(viewport(800, 600, 1.5, 2), { width: 533, height: 400, deviceScaleFactor: 3, mobile: false }, 'zoom and density multiply');
  assert.equal(viewport(800, 600, 1, 3).deviceScaleFactor, 2, 'never past 2x');
  assert.equal(viewport(390, 700, 1, 3, true).mobile, true);
  assert.equal(density(2, 2560, 1600), 1);
  assert.equal(density(2, 1600, 1000), 1.5);
  assert.equal(density(2, 1280, 800), 2);
  assert.equal(mouseEvent({ e: 'move', x: 100, y: 50 }, 1).x, 100, 'input stays in CSS pixels whatever the density');
});

test('frame flow: at most two on the way, crisp frames count too, acks release the waiting one', () => {
  const f = new FrameFlow(2);
  assert.equal(f.sent(1), true);
  assert.equal(f.sent(2), false, 'the second waits for the viewer');
  assert.equal(f.room, false);
  assert.equal(f.acked(), 2);
  assert.equal(f.acked(), null);
  assert.equal(f.room, true);
  assert.equal(f.sent(null), false, 'a crisp frame has nothing to ack');
  assert.equal(f.inflight, 1);
  f.reset();
  assert.equal(f.inflight, 0);
  assert.equal(f.acked(), null);
  assert.equal(f.inflight, 0, 'never below zero');
});

test('cursor keywords only; bot walls and network failures in words; recent sites; small icons as data:', () => {
  assert.equal(cursorOf('pointer'), 'pointer');
  assert.equal(cursorOf('url(x.png) 2 2, text'), 'text');
  assert.equal(cursorOf('javascript:alert(1)'), 'default');
  assert.ok(botWall('Just a moment...'));
  assert.ok(botWall('Access Denied'));
  assert.ok(!botWall('The New York Times'));
  assert.equal(navFailure('net::ERR_NAME_NOT_RESOLVED').title, 'Can’t find that site');
  assert.equal(navFailure('net::ERR_CERT_DATE_INVALID').title, 'This site’s connection isn’t private');
  assert.equal(navFailure('').title, 'Couldn’t open that page');
  assert.deepEqual(recentSites([{ url: 'https://www.a.com/x', title: 'A x' }, { url: 'https://a.com/y' }, { url: 'https://b.org/', title: '' }]).map((r) => [r.site, r.title]), [['a.com', 'A x'], ['b.org', 'b.org']]);
  assert.equal(iconData(new Uint8Array([1, 2, 3]), 'image/png; charset=x'), 'data:image/png;base64,AQID');
  assert.equal(iconData(new Uint8Array([1]), 'text/html'), '');
  assert.equal(iconData(new Uint8Array(60 * 1024), 'image/png'), '', 'small icons only');
});

test('session: the panel’s density reaches Chrome; a still picture gets one crisp frame; the cursor and right-click', async () => {
  const { s, chrome } = session();
  await s.onMessage({ t: 'hello', w: 600, h: 400, dpr: 2 });
  await s.onMessage({ t: 'start' });
  const cdp = chrome.pages[0].cdp;
  assert.equal(cdp.of('Emulation.setDeviceMetricsOverride').at(-1).deviceScaleFactor, 2);
  assert.equal(cdp.of('Page.startScreencast').at(-1).maxWidth, 1200);
  assert.equal(cdp.of('Runtime.addBinding')[0].name, '__edenCursor');
  cdp.answers['Page.captureScreenshot'] = { data: btoa('WEBP') };
  cdp.emit('Page.screencastFrame', { sessionId: 1, data: btoa('JPEG') });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(cdp.of('Page.captureScreenshot').length, 1);
  assert.equal(s.out.filter((m) => m instanceof Uint8Array).length, 2, 'the moving frame, then the crisp one');
  await s.onMessage({ t: 'ack' });
  cdp.emit('Page.screencastFrame', { sessionId: 2, data: btoa('JPEG') });
  assert.equal(s.out.filter((m) => m instanceof Uint8Array).length, 2, 'the repaint the capture causes is skipped');
  assert.equal(cdp.of('Page.screencastFrameAck').at(-1).sessionId, 2);
  await s.onMessage({ t: 'mouse', e: 'move', x: 1, y: 1 });
  cdp.emit('Page.screencastFrame', { sessionId: 3, data: btoa('JPEG') });
  assert.equal(s.out.filter((m) => m instanceof Uint8Array).length, 3, 'after input, frames flow again');
  cdp.emit('Runtime.bindingCalled', { name: '__edenCursor', payload: 'pointer' });
  cdp.emit('Runtime.bindingCalled', { name: '__edenCursor', payload: 'pointer' });
  assert.deepEqual(s.out.filter((m) => m.t === 'cursor').map((m) => m.c), ['pointer'], 'told once per change');
  await s.onMessage({ t: 'resize', w: 600, h: 400, dpr: 2 });
  assert.equal(cdp.of('Emulation.setDeviceMetricsOverride').length, 1, 'the same size again changes nothing');
  await s.onMessage({ t: 'zoom', to: 1.5 });
  assert.equal([...s.tabs.values()][0].zoom, 1.5);
  await s.shutdown('', true);
});

test('session: a page that fails to open shows Eden’s own error, with its address', async () => {
  const { s, chrome } = session();
  await s.onMessage({ t: 'start' });
  const cdp = chrome.pages[0].cdp;
  cdp.answers['Page.navigate'] = { errorText: 'net::ERR_NAME_NOT_RESOLVED' };
  await s.onMessage({ t: 'go', url: 'nosuch.example' });
  assert.equal(last(s, 'state').failed.title, 'Can’t find that site');
  assert.equal(last(s, 'state').failed.url, 'https://nosuch.example/');
  cdp.emit('Page.frameStartedLoading', { frameId: 'main' });
  assert.equal([...s.tabs.values()][0].failed, null, 'cleared by the next load');
  await s.shutdown('', true);
});
