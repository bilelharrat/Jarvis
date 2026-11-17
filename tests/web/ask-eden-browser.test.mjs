// Ask Eden's own browser on this computer (app/eden/local-browser.js), on a pretend Electron:
// what's typed becomes an address or a Google search, tabs go over the panel's slot only with a
// page, other schemes never load, the page's requests come only from Eden's page, and the
// Windows app's copy is the same file. node --test tests/web/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(REPO, 'app', 'eden', 'local-browser.js');
const lb = require(SRC);

test('toUrl: addresses, searches on Google, never another scheme', () => {
  assert.equal(lb.toUrl('example.com'), 'https://example.com/');
  assert.equal(lb.toUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(lb.toUrl('http://example.com'), 'http://example.com/');
  assert.equal(lb.toUrl('localhost:5174/x'), 'http://localhost:5174/x');
  assert.equal(lb.toUrl('192.168.1.1'), 'http://192.168.1.1/');
  assert.equal(lb.toUrl('blue bloods season 11'), 'https://www.google.com/search?q=blue%20bloods%20season%2011');
  assert.equal(lb.toUrl('weather'), 'https://www.google.com/search?q=weather');
  assert.equal(lb.toUrl('javascript:alert(1)'), '');
  assert.equal(lb.toUrl('file:///etc/passwd'), '');
  assert.equal(lb.toUrl('  '), '');
  assert.equal(lb.toUrl('about:blank'), 'about:blank');
  assert.equal(lb.allowed('https://a.b/'), true);
  assert.equal(lb.allowed('file:///x'), false);
  assert.equal(lb.allowed('chrome://settings'), false);
  assert.equal(lb.allowed('data:text/html,hi'), false);
});

test('cleanUa, rect, nextZoom, failure', () => {
  assert.equal(lb.cleanUa('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Electron/44.4.5 Safari/537.36 Ask Eden/0.1.8'),
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36');
  assert.deepEqual(lb.rect({ x: 10.4, y: 20, width: 300, height: 200 }, 2), { x: 21, y: 40, width: 600, height: 400 });
  assert.equal(lb.rect({ x: 0, y: 0, width: 0, height: 10 }), null);
  assert.equal(lb.rect('x'), null);
  assert.equal(lb.nextZoom(1, 1), 1.1);
  assert.equal(lb.nextZoom(1, -1), 0.9);
  assert.equal(lb.nextZoom(1.5, 0), 1);
  assert.equal(lb.nextZoom(3, 1), 3);
  assert.equal(lb.nextZoom(0.5, -1), 0.5);
  assert.match(lb.failure(-105, 'https://www.nope.test/x'), /Can’t find nope\.test/);
  assert.match(lb.failure(-106, 'https://a.b/'), /offline/);
  assert.match(lb.failure(-202, 'https://a.b/'), /certificate/);
});

// ── a pretend Electron ──
function fakeElectron() {
  const made = [];
  class WC {
    constructor() { this.h = {}; this.loaded = []; this.zoom = 1; this.sent = []; this.closed = false; this.back = false;
      this.navigationHistory = { canGoBack: () => this.back, canGoForward: () => false, goBack: () => this.loaded.push('<back>'), goForward() {}, clear() {} }; }
    on(ev, fn) { this.h[ev] = fn; }
    emit(ev, ...a) { if (this.h[ev]) this.h[ev](...a); }
    setWindowOpenHandler(fn) { this.open = fn; }
    loadURL(u) { this.loaded.push(u); return Promise.resolve(); }
    reload() { this.loaded.push('<reload>'); } reloadIgnoringCache() {} stop() {}
    setZoomFactor(z) { this.zoom = z; }
    close() { this.closed = true; }
    executeJavaScriptInIsolatedWorld(world, [{ code }]) { this.world = world; return Promise.resolve(code.includes('innerText') ? 'Words on the page' : 'picked'); }
    findInPage() { return 7; } stopFindInPage() {}
    capturePage() { return Promise.resolve({ isEmpty: () => false, toJPEG: () => Buffer.from('jpg') }); }
    getURL() { return this.committed || ''; } getTitle() { return this.committedTitle || ''; }
  }
  class WebContentsView { constructor(o) { this.opts = o; this.webContents = new WC(); this.bounds = null; made.push(this); } setBounds(b) { this.bounds = b; } }
  const ses = { ua: 'Mozilla/5.0 Chrome/140 Electron/44.0.0 Safari/537.36', getUserAgent() { return this.ua; }, setUserAgent(u) { this.ua = u; },
    setPermissionRequestHandler(f) { this.req = f; },
    fetch: async (u) => ({ ok: u.endsWith('.png'), headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer }), setPermissionCheckHandler(f) { this.check = f; }, clearStorageData: async () => {}, clearCache: async () => {} };
  const session = { fromPartition: (p) => { ses.partition = p; return ses; } };
  const opened = [];
  const shell = { openExternal: async (u) => { opened.push(u); } };
  const children = new Set();
  const host = {
    destroyed: false, isDestroyed() { return this.destroyed; },
    contentView: { addChildView: (v) => children.add(v), removeChildView: (v) => children.delete(v) },
    webContents: { sent: [], send(ch, p) { this.sent.push([ch, p]); }, getZoomFactor: () => 1 },
  };
  return { deps: { WebContentsView, session, shell, clipboard: { writeText() {} }, Menu: null, isMac: true }, made, ses, opened, children, host };
}
const tick = () => new Promise((r) => setTimeout(r, 30));
const lastState = (host) => host.webContents.sent.filter(([c]) => c === 'eden:browser:state').at(-1)[1];

test('a tab goes over the slot only when the panel shows it and it has a page; Google searches load', async () => {
  const f = fakeElectron();
  const b = lb.createLocalBrowser(f.deps);
  b.open(f.host, true);
  await tick();
  assert.equal(f.made.length, 1, 'a first, empty tab');
  assert.equal(f.ses.partition, 'persist:eden-browser');
  assert.doesNotMatch(f.ses.ua, /Electron/);
  const prefs = f.made[0].opts.webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.preload, undefined);
  b.show(f.host, { x: 400, y: 80, width: 600, height: 700 });
  assert.equal(f.children.size, 0, 'an empty tab: the panel draws the new tab page');
  b.nav('go', 'lisbon weather');
  await tick();
  assert.deepEqual(f.made[0].webContents.loaded, ['https://www.google.com/search?q=lisbon%20weather']);
  assert.equal(f.children.size, 1, 'a page: the view goes over the slot');
  assert.deepEqual(f.made[0].bounds, { x: 400, y: 80, width: 600, height: 700 });
  b.bounds(f.host, { x: 400, y: 80, width: 500, height: 700 });
  assert.equal(f.made[0].bounds.width, 500);
  await b.hide(f.host);
  assert.equal(f.children.size, 0, 'something of Eden’s over the slot: the view steps off');
  assert.deepEqual(f.host.webContents.sent.at(-1), ['eden:browser:command', { t: 'snapshot', url: 'data:image/jpeg;base64,anBn' }], 'leaving a picture of the page, not a blank');
  b.show(f.host, { x: 400, y: 80, width: 500, height: 700 });
  assert.equal(f.children.size, 1);
  const s = lastState(f.host);
  assert.equal(s.local, true);
  assert.equal(s.url, 'https://www.google.com/search?q=lisbon%20weather');
  assert.equal(s.tabs.length, 1);
  b.nav('go', 'javascript:alert(1)');
  assert.equal(f.made[0].webContents.loaded.length, 1, 'another scheme never loads');
});

test('a failed page: the panel draws it (the view steps off) and Reload tries the same address again', async () => {
  const f = fakeElectron();
  const b = lb.createLocalBrowser(f.deps);
  b.show(f.host, { x: 0, y: 0, width: 600, height: 600 });
  b.nav('go', 'https://nope.test/');
  const wc = f.made[0].webContents;
  wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://nope.test/', true);
  await tick();
  assert.equal(f.children.size, 0);
  assert.match(lastState(f.host).error.message, /Can’t find nope\.test/);
  b.nav('reload');
  assert.equal(wc.loaded.at(-1), 'https://nope.test/');
  // Back from a failed page: the page that was on show before it (it never left the view).
  wc.committed = 'https://was.test/'; wc.committedTitle = 'Was';
  wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://nope.test/', true);
  await tick();
  assert.equal(lastState(f.host).canBack, true);
  assert.equal(lastState(f.host).title, '', 'the failed page has no title of the last one');
  b.nav('back');
  await tick();
  assert.equal(lastState(f.host).url, 'https://was.test/');
  assert.equal(lastState(f.host).error, null);
  assert.equal(f.children.size, 1);
  wc.emit('did-fail-load', {}, -3, 'ABORTED', 'https://x.test/', true);
  wc.emit('did-navigate', {}, 'https://nope.test/');
  await tick();
  assert.equal(lastState(f.host).error, null, 'a stopped load isn’t a failure');
});

test('pages can’t leave the web, open windows become tabs, and get no camera or location', async () => {
  const f = fakeElectron();
  const b = lb.createLocalBrowser(f.deps);
  b.show(f.host, { x: 0, y: 0, width: 600, height: 600 });
  b.nav('go', 'https://a.test/');
  const wc = f.made[0].webContents;
  let stopped = false;
  wc.h['will-navigate']({ preventDefault: () => { stopped = true; } }, 'file:///etc/passwd');
  assert.equal(stopped, true);
  stopped = false;
  wc.h['will-navigate']({ preventDefault: () => { stopped = true; } }, 'mailto:a@b.c');
  assert.equal(stopped, true);
  assert.deepEqual(f.opened, ['mailto:a@b.c'], 'mail links go to the mail app');
  assert.deepEqual(wc.open({ url: 'https://b.test/', disposition: 'foreground-tab' }), { action: 'deny' });
  await tick();
  assert.equal(f.made.length, 2);
  assert.equal(lastState(f.host).tabs.find((t) => t.active).id, 2, 'a link opened in a new tab shows');
  let granted = null;
  f.ses.req(null, 'media', (ok) => { granted = ok; });
  assert.equal(granted, false);
  f.ses.req(null, 'geolocation', (ok) => { granted = ok; });
  assert.equal(granted, false);
  f.ses.req(null, 'fullscreen', (ok) => { granted = ok; });
  assert.equal(granted, true);
});

test('tabs: close the last and a new one opens; keys while the page has the keyboard', async () => {
  const f = fakeElectron();
  const b = lb.createLocalBrowser(f.deps);
  b.show(f.host, { x: 0, y: 0, width: 600, height: 600 });
  b.nav('go', 'https://a.test/');
  b.tab('close', 1);
  await tick();
  assert.equal(f.made[0].webContents.closed, true);
  assert.equal(lastState(f.host).tabs.length, 1, 'never no tab');
  const t = f.made[1].webContents;
  b.nav('go', 'https://a.test/');
  let prevented = 0;
  const key = (k, extra = {}) => t.h['before-input-event']({ preventDefault: () => { prevented += 1; } }, { type: 'keyDown', key: k, meta: true, ...extra });
  key('c'); key('v'); key('q');
  assert.equal(prevented, 0, 'copy, paste and the app menu’s keys stay with the page and the app');
  key('l');
  assert.deepEqual(f.host.webContents.sent.at(-1), ['eden:browser:command', { t: 'address' }]);
  key('b', { shift: true, code: 'KeyB' });
  assert.deepEqual(f.host.webContents.sent.at(-1), ['eden:browser:command', { t: 'key', key: 'b', code: 'KeyB', shift: true }]);
  key('=');
  await tick();
  assert.equal(t.zoom, 1.1);
  assert.equal(lastState(f.host).zoom, 1.1);
});

test('tab icons: fetched once and handed to the panel as a picture; not an image: none', async () => {
  const f = fakeElectron();
  const b = lb.createLocalBrowser(f.deps);
  b.show(f.host, { x: 0, y: 0, width: 600, height: 600 });
  b.nav('go', 'https://a.test/');
  const wc = f.made[0].webContents;
  wc.emit('page-favicon-updated', {}, ['http://a.test/x.png', 'https://a.test/favicon.png']);
  await tick();
  assert.equal(lastState(f.host).tabs[0].icon, 'data:image/png;base64,iVBORw==');
  wc.emit('page-favicon-updated', {}, ['https://a.test/favicon.ico']);
  await tick();
  assert.equal(lastState(f.host).tabs[0].icon, '');
});

test('the new tab page’s recent sites: one per site, newest first, with logos, kept in a file', async () => {
  const f = fakeElectron();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eden-recent-')), 'recent.json');
  const b = lb.createLocalBrowser({ ...f.deps, recentFile: file });
  b.show(f.host, { x: 0, y: 0, width: 600, height: 600 });
  const visit = (url, title) => { b.nav('go', url); const wc = f.made[0].webContents; wc.emit('did-navigate', {}, url); wc.emit('page-title-updated', {}, title); wc.emit('did-stop-loading'); };
  visit('https://www.a.test/1', 'A one');
  f.made[0].webContents.emit('page-favicon-updated', {}, ['https://www.a.test/i.png']);
  await tick();
  visit('https://b.test/', 'B');
  visit('https://www.a.test/2', 'A two');
  b.tab('new');
  await new Promise((r) => setTimeout(r, 1100));
  const s = lastState(f.host);
  assert.deepEqual(s.recent.map((r) => [r.site, r.title]), [['a.test', 'A two'], ['b.test', 'B']]);
  assert.match(s.recent[0].icon, /^data:image\/png;base64,/, 'a site keeps its logo');
  const again = lb.createLocalBrowser({ ...fakeElectron().deps, recentFile: file });
  assert.equal(again.state().recent.length, 0, 'no tab yet: nothing asked');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((r) => r.site), ['a.test', 'b.test']);
});

test('Ask Eden: the page’s words, read in a world of their own', async () => {
  const f = fakeElectron();
  const b = lb.createLocalBrowser(f.deps);
  assert.deepEqual(await b.pageText(), { error: 'Open a page first.' });
  b.show(f.host, { x: 0, y: 0, width: 600, height: 600 });
  b.nav('go', 'https://a.test/');
  f.made[0].webContents.emit('page-title-updated', {}, 'A page');
  assert.deepEqual(await b.pageText(), { url: 'https://a.test/', title: 'A page', text: 'Words on the page' });
  assert.notEqual(f.made[0].webContents.world, 0, 'not the page’s own world');
  assert.equal(await b.selection(), 'picked');
});

test('install: only Eden’s page may drive it', async () => {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const calls = [];
  const browser = new Proxy({}, { get: (_t, k) => (...a) => { calls.push([k, ...a]); return 'ok'; } });
  lb.install({ ipcMain, browser, fromPage: (e) => e.ok, host: () => 'win' });
  assert.equal(await handlers['eden:browser:nav']({ ok: false }, 'go', 'x'), null);
  assert.equal(calls.length, 0);
  await handlers['eden:browser:nav']({ ok: true }, 'go', 'x');
  await handlers['eden:browser:nav']({ ok: true }, 'evil', 'x');
  await handlers['eden:browser:show']({ ok: true }, { x: 1 });
  assert.deepEqual(calls, [['nav', 'go', 'x'], ['show', 'win', { x: 1 }]]);
});

test('Ask Eden for Windows carries the same file', () => {
  const win = path.join(REPO, '..', 'Eden Windows', 'ask-eden', 'local-browser.js');
  if (!fs.existsSync(path.dirname(win))) return;
  assert.equal(fs.readFileSync(win, 'utf8'), fs.readFileSync(SRC, 'utf8'), 'copy app/eden/local-browser.js to Eden Windows/ask-eden/');
});
