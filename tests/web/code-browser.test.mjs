// Eden Code's Browser pane (web/features/code-browser.js, app/browser-pane-lib.js): its pure
// helpers (addresses, tabs, the dev server it offers, the width, what lies over the slot,
// Select element's rule) and the pane itself in a stand-in window with a fake app browser:
// the toolbar and tabs, the native view placed over the slot and stepped aside for an overlay,
// taken off when the pane closes, the dev server opened by itself, the agent watched and held
// while the owner has taken over, and Select element.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const B = require('../../src/jarvis/web/features/code-browser.js');
const lib = require('../../app/browser-pane-lib.js');
const source = readFileSync(new URL('../../src/jarvis/web/features/code-browser.js', import.meta.url), 'utf8');
const web = (name) => readFileSync(new URL(`../../src/jarvis/web/${name}`, import.meta.url), 'utf8');

// ── pure parts ──

test('what is typed: an address, a page on this Mac, or words to search for', () => {
  for (const s of ['https://example.com', 'example.com', 'example.com/a?b=1', 'localhost:5173', 'localhost', '127.0.0.1:8000/x', 'app.localhost', 'devbox:8080', 'printer.local', '[::1]:3000', 'file:///Users/me/a.html', 'about:blank']) {
    assert.equal(B.addressKind(s), 'url', s);
  }
  for (const s of ['weather', 'how to center a div', 'react hooks', 'host:99999']) assert.equal(B.addressKind(s), 'search', s);
  assert.equal(B.addressKind('   '), 'empty');
  assert.equal(B.fieldText('about:blank'), '');
  assert.equal(B.fieldText('http://localhost:3000/'), 'http://localhost:3000/');
});

test('pages on this Mac, and what Select element works on (S29)', () => {
  for (const u of ['http://localhost:5173/', 'https://app.localhost/', 'http://127.0.0.1:8000/', 'http://[::1]:3000/']) assert.ok(B.isLocalUrl(u), u);
  for (const u of ['https://example.com/', 'http://localhost.evil.com/', 'http://192.168.1.4/', 'file:///etc/passwd', '']) assert.ok(!B.isLocalUrl(u), u);
  assert.equal(B.pickBlocked('http://localhost:5173/'), '');
  assert.equal(B.pickBlocked('file:///Users/me/site/index.html'), '');  // (the app checks it's one the owner opened)
  assert.equal(B.pickBlocked('https://example.com/'), B.NOT_LOCAL);
  assert.match(B.NOT_LOCAL, /dev server/);
});

test('tabs: their words, and the session that opened one', () => {
  assert.equal(B.tabTitle({ title: 'Docs', url: 'https://x.dev/' }), 'Docs');
  assert.equal(B.tabTitle({ title: 'https://x.dev/', url: 'https://x.dev/' }), 'x.dev');
  assert.equal(B.tabTitle({ title: '', url: '' }), 'New tab');
  assert.equal(B.sessionOf('code:12'), 12);
  assert.equal(B.sessionOf('jarvis'), null);
  assert.equal(B.sessionOf(''), null);
});

test('the dev server offered: a live one to open (ready first), else one to start; none when it shows', () => {
  const project = '/p/app';
  const servers = [
    { key: 'a', project, name: 'api', url: 'http://localhost:8000', status: 'starting' },
    { key: 'w', project, name: 'web', url: 'http://localhost:5173', status: 'ready' },
    { key: 'x', project: '/other', name: 'other', url: 'http://localhost:9000', status: 'running' },
    { key: 'd', project, name: 'dead', url: '', status: 'exited' },
  ];
  assert.deepEqual(B.devOffer({ servers, project, shown: '' }), { kind: 'open', name: 'web', url: 'http://localhost:5173', key: 'w' });
  assert.equal(B.devOffer({ servers, project, shown: 'http://localhost:5173/about' }), null);  // already on it
  assert.deepEqual(B.devOffer({ servers: [servers[0]], project }), { kind: 'starting', name: 'api', url: 'http://localhost:8000', key: 'a' });
  assert.deepEqual(B.devOffer({ servers: [], configs: [{ name: 'web' }], project }), { kind: 'start', name: 'web' });
  assert.equal(B.devOffer({ servers, project: '' }), null);
  assert.ok(B.blankish('') && B.blankish('about:blank') && B.blankish('https://www.google.com/') && B.blankish('https://duckduckgo.com'));
  assert.ok(!B.blankish('https://www.google.com/search?q=x') && !B.blankish('http://localhost:3000/'));
});

test('the pane is half the window by default, and never squeezes the conversation out', () => {
  assert.equal(B.paneWidth(0, 1400), 700);
  assert.equal(B.paneWidth(900, 1400), 900);
  assert.equal(B.paneWidth(1300, 1400), 1400 - B.MAIN_MIN);
  assert.equal(B.paneWidth(100, 1400), B.MIN_W);
  assert.equal(B.paneWidth(0, 500), B.MIN_W);
});

test('what lies over the slot is found anywhere on it, corners included', () => {
  const rect = { left: 600, top: 100, right: 1200, bottom: 800, width: 600, height: 700 };
  const pts = B.probePoints(rect);
  assert.ok(pts.length >= 16 && pts.every(([x, y]) => x > 600 && x < 1200 && y > 100 && y < 800));
  const slot = {};
  assert.equal(B.covered(rect, () => slot, (n) => n === slot), false);
  // a menu over the top-right corner only
  const menu = {};
  assert.equal(B.covered(rect, (x, y) => (x > 1100 && y < 160 ? menu : slot), (n) => n === slot), true);
  assert.deepEqual(B.probePoints({ width: 0, height: 0 }), []);
  assert.equal(B.rectKey({ x: 1.2, y: 2, width: 300.6, height: 40 }), '1,2,301,40');
});

test('the banner says who is using the browser', () => {
  assert.equal(B.agentWords({ kind: 'tab', session: 3 }, (id) => `Fix login (${id})`), 'Eden is using the browser · Fix login (3)');
  assert.equal(B.agentWords({ kind: 'check' }), 'Eden is checking its work in a hidden preview');
  assert.equal(B.agentWords(null), '');
});

test('the view goes inside the window, zoomed, and comes off when nothing of the slot shows', () => {
  assert.deepEqual(lib.viewRect({ x: 600, y: 120, width: 580, height: 640 }, 1, { width: 1240, height: 820 }), { x: 600, y: 120, width: 580, height: 640 });
  assert.deepEqual(lib.viewRect({ x: 100, y: 50, width: 200, height: 100 }, 1.25), { x: 125, y: 63, width: 250, height: 125 });
  // past the window's right and bottom edges: cut to the window
  assert.deepEqual(lib.viewRect({ x: 1000, y: 700, width: 400, height: 300 }, 1, { width: 1240, height: 820 }), { x: 1000, y: 700, width: 240, height: 120 });
  assert.equal(lib.viewRect({ x: 0, y: 0, width: 0, height: 0 }), null);  // the pane mid-close: off, never a 0 × 0 page
  assert.equal(lib.viewRect({ x: 2000, y: 10, width: 300, height: 300 }, 1, { width: 1240, height: 820 }), null);  // all outside
  assert.equal(lib.viewRect({ x: 'a', y: 0, width: 10, height: 10 }), null);
  assert.equal(lib.viewRect(null), null);
});

test('only a web page opens in the default browser', () => {
  assert.equal(lib.externalUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(lib.externalUrl('http://localhost:3000/'), 'http://localhost:3000/');
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'eden-app://x', '', null]) assert.equal(lib.externalUrl(u), '', String(u));
});

// ── the pane in a stand-in window ──

function stand({ url = '' } = {}) {
  const document = makeDocument();
  document.body.setAttribute('data-app', 'eden-code');
  document.body.style.setProperty = (k, v) => { document.body.style[k] = v; };
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  const el = elFor(document);
  const cc = el('div'); cc.id = 'cc';
  const btn = el('button', 'jc-tool'); btn.id = 'jc-browser';
  const pane = el('aside', 'jc-pane'); pane.id = 'jc-pane'; pane.hidden = true;
  const body = el('div'); body.id = 'jc-pane-body';
  pane.append(body);
  cc.append(btn, pane);
  document.body.append(cc);
  const calls = [];
  const listeners = {};
  const fakeBrowser = {
    place: async (b) => { calls.push(['place', b]); return true; },
    park: async () => { calls.push(['park']); return 'data:image/jpeg;base64,AAAA'; },
    hide: async () => { calls.push(['hide']); },
    nav: (action, u) => calls.push(['nav', action, u]),
    tab: (action, id, u) => calls.push(['tab', action, id, u]),
    external: async () => calls.push(['external']),
    devtools: async () => { calls.push(['devtools']); return true; },
    onState: (fn) => { listeners.state = fn; },
    onPageFullscreen: (fn) => { listeners.full = fn; },
    find: (o) => calls.push(['find', o]),
    onFound: (fn) => { listeners.found = fn; },
    onDownload: (fn) => { listeners.download = fn; },
    onNote: (fn) => { listeners.note = fn; },
    shortcut: (a) => calls.push(['shortcut', a]),
    download: (id, a) => calls.push(['download', id, a]),
    data: async (a, u, t) => { calls.push(['data', a, u, t]); return { bookmarks: [{ url: u }] }; },
    pane: async (m) => { calls.push(['pane', m]); return paneAnswers[m.action] !== undefined ? (typeof paneAnswers[m.action] === 'function' ? paneAnswers[m.action](m) : paneAnswers[m.action]) : true; },
  };
  const paneAnswers = {};
  const invoked = [];
  const featureAnswers = {};
  const bridgeOn = {};
  const frames = [];
  const timers = [];
  const attached = [];
  const observers = [];
  const handlers = {};
  const sent = [];
  const notes = [];
  const panes = new Map();
  const picks = [];
  const F = {
    el, t: (x) => x, $: (id) => document.getElementById(id),
    send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerPane: (id, p) => panes.set(id, p), registerMoreItem() {},
    openPane: (id) => { pane.dataset.kind = id; pane.hidden = false; },
    currentTask: () => ({ id: 7, kind: 'code', path: '/p/app' }),
  };
  const win = {
    jarvisFeatures: F,
    jarvisApp: {
      browser: fakeBrowser,
      feature: {
        invoke: async (ch, m) => { invoked.push([ch, m]); return featureAnswers[ch] !== undefined ? featureAnswers[ch] : { ok: false }; },
        on: (ch, fn) => { bridgeOn[ch] = fn; },
      },
    },
    jarvisCodePick: { available: () => true, start: async () => { picks.push('start'); } },
    innerWidth: 1400,
    addEventListener() {},
  };
  class MO { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} }
  let pointed = null;  // what elementFromPoint finds (null: the slot)
  document.elementFromPoint = () => pointed || document.querySelector('.cb-slot');
  const scope = {
    window: win, document, MutationObserver: MO, localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    jcNote: (text) => notes.push(text), ccTasks: [{ id: 3, title: 'Fix login' }],
    attachItems: (items) => { attached.push(...items); return items.length; },
    closePane: () => { pane.hidden = true; delete pane.dataset.kind; for (const o of observers) o.fn(); },
  };
  load(source, scope);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  const open = () => { F.openPane('browser'); panes.get('browser').render(body); for (const o of observers) o.fn(); };
  const state = (st) => listeners.state({ url, tabs: [], canBack: false, canForward: false, loading: false, ...st });
  const tick = async () => { const fn = frames.shift(); if (fn) fn(); await new Promise((r) => setImmediate(r)); };
  const point = (node) => { pointed = node; };
  const flush = async () => { while (timers.length) timers.shift()(); for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
  return { document, win, pane, body, btn, calls, sent, notes, picks, fire, open, state, tick, point, listeners, scope, paneAnswers, invoked, featureAnswers, bridgeOn, attached, flush };
}

test('the globe is on the title bar in the app, and its pane has the whole toolbar', () => {
  const w = stand();
  assert.equal(w.btn.hidden, false);
  w.open();
  const labels = w.body.querySelectorAll('button').map((b) => b.getAttribute('aria-label'));
  for (const want of ['New tab', 'Back', 'Forward', 'Reload', 'Select element: send it with your next message', 'Screenshot', 'Developer tools', 'More']) {
    assert.ok(labels.includes(want), want);
  }
  assert.ok(w.body.querySelector('.cb-url').hasAttribute('data-no-i18n'));  // (the address is data)
  assert.equal(w.document.body.style['--cb-w'], '700px');  // half the window
  assert.ok(w.pane.querySelector('.cb-resize'));
  // the index page's button opens this pane (not Eden Secretary's dock), with its shortcut
  assert.match(web('index.html'), /id="jc-browser" data-pane="browser" title="Browser \(⌥⌘B\)"/);
  assert.doesNotMatch(web('eden-code.css'), /#jc-browser \{ display: none; \}/);
});

test('the toolbar follows the page, and drives it', () => {
  const w = stand();
  w.open();
  w.state({ url: 'http://localhost:5173/', canBack: true, loading: true, tabs: [
    { id: 1, title: 'App', url: 'http://localhost:5173/', active: true },
    { id: 2, title: 'Docs', url: 'https://vite.dev/', active: false, owner: 'code:3' },
  ] });
  const by = (label) => w.body.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === label);
  assert.equal(by('Back').disabled, false);
  assert.equal(by('Forward').disabled, true);
  assert.ok(by('Stop'));  // loading: Reload is Stop
  assert.equal(w.body.querySelector('.cb-url').value, 'http://localhost:5173/');
  assert.equal(w.body.querySelector('.cb-progress').hidden, false);
  const tabs = w.body.querySelectorAll('.cb-tab');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.match(tabs[1].querySelector('.cb-tab-agent').title, /Fix login/);  // a session's own tab
  tabs[1].click();
  assert.deepEqual(w.calls.at(-1), ['tab', 'select', 2, undefined]);
  tabs[1].querySelector('.cb-tab-x').click();
  assert.deepEqual(w.calls.at(-1), ['tab', 'close', 2, undefined]);
  by('Stop').click();
  assert.deepEqual(w.calls.at(-1), ['nav', 'stop', undefined]);
  by('New tab').click();
  assert.deepEqual(w.calls.at(-1), ['tab', 'new', undefined, undefined]);
  const input = w.body.querySelector('.cb-url');
  input.value = 'localhost:3000';
  w.body.querySelector('.cb-bar').dispatchEvent(w.document.event('submit'));
  assert.deepEqual(w.calls.at(-1), ['nav', 'go', 'localhost:3000']);
});

test('the page is laid over the slot, steps aside under an overlay, and comes off with the pane', async () => {
  const w = stand();
  w.open();
  const slot = w.body.querySelector('.cb-slot');
  slot.getBoundingClientRect = () => ({ left: 700, top: 120, right: 1380, bottom: 800, width: 680, height: 680 });
  await w.tick();
  assert.deepEqual(w.calls.find((c) => c[0] === 'place'), ['place', { x: 700, y: 120, width: 680, height: 680 }]);
  const placed = w.calls.length;
  await w.tick();
  assert.equal(w.calls.length, placed);  // nothing moved: nothing sent
  // Settings (or a menu) over the slot: the view steps aside, its picture stands in
  w.point(w.document.body);
  await w.tick();
  assert.deepEqual(w.calls.at(-1), ['park']);
  assert.equal(w.body.querySelector('.cb-snap').hidden, false);
  await w.tick();
  assert.equal(w.calls.filter((c) => c[0] === 'park').length, 1);  // once, not every frame
  // the overlay gone: back over the slot
  w.point(null);
  await w.tick();
  assert.equal(w.calls.at(-1)[0], 'place');
  assert.equal(w.body.querySelector('.cb-snap').hidden, true);
  // the window resized: moved
  slot.getBoundingClientRect = () => ({ left: 500, top: 120, right: 1180, bottom: 700, width: 680, height: 580 });
  await w.tick();
  assert.deepEqual(w.calls.at(-1), ['place', { x: 500, y: 120, width: 680, height: 580 }]);
  // the pane closed: the view comes off
  w.scope.closePane();
  assert.deepEqual(w.calls.at(-1), ['hide']);
});

test('the project’s running dev server opens by itself over an empty tab, else is offered', () => {
  const w = stand();
  w.open();
  assert.deepEqual(w.sent.at(-1), { type: 'cv_state', id: 7 });
  w.state({ url: 'https://www.google.com/' });
  w.fire('cv_state', { id: 7, path: '/p/app', configs: [{ name: 'web' }], servers: [{ key: 'k', project: '/p/app', name: 'web', url: 'http://localhost:5173', status: 'ready' }] });
  assert.deepEqual(w.calls.at(-1), ['nav', 'go', 'http://localhost:5173']);
  // once only: on another page it's offered instead
  w.state({ url: 'https://example.com/' });
  const offer = w.body.querySelector('.cb-offer');
  assert.equal(offer.hidden, false);
  assert.match(offer.textContent, /web is running at localhost:5173/);
  offer.querySelector('button').click();
  assert.deepEqual(w.calls.at(-1), ['nav', 'go', 'http://localhost:5173']);
  // none running: Start, and it opens once it answers
  w.fire('devservers', { items: [] });
  assert.match(offer.textContent, /Dev server web isn’t running\./);
  offer.querySelector('button').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cv_server', action: 'start', name: 'web', id: 7 });
  w.fire('devservers', { items: [{ key: 'k2', project: '/p/app', name: 'web', url: 'http://localhost:5174', status: 'ready' }] });
  assert.deepEqual(w.calls.at(-1), ['nav', 'go', 'http://localhost:5174']);
});

test('watching the agent: the banner, Take over holds its browser steps, Hand back lets them go', () => {
  const w = stand();
  w.open();
  const pane = w.win.jarvisCodeBrowser;
  const ev = { id: 'c1', action: 'click', args: { owner: 'code:3', ref: 'e4' } };
  assert.equal(pane.agentStart(ev), '');
  const banner = w.body.querySelector('.cb-agent');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /Eden is using the browser/);
  assert.match(banner.textContent, /Fix login/);
  assert.ok(w.btn.classList.contains('cb-busy'));
  pane.agentEnd(ev, { ok: true, url: 'http://localhost:5173/cart' });
  assert.match(banner.textContent, /localhost:5173\/cart/);
  banner.querySelector('.cb-take').click();
  assert.equal(pane.agentStart(ev), B.HELD);
  assert.equal(pane.checkStart({ session: 3, action: 'act' }), B.HELD);  // a check waits too
  assert.match(banner.textContent, /You have the browser/);
  assert.equal(banner.querySelector('.cb-give').hidden, false);
  banner.querySelector('.cb-give').click();
  assert.equal(pane.agentStart(ev), '');
  // a check's hidden preview: said as such, and taken over into a tab of its own
  pane.checkStart({ session: 3, action: 'snapshot' });
  pane.checkEnd({ session: 3, action: 'snapshot' }, { ok: true, url: 'http://localhost:5173/' });
  assert.match(banner.textContent, /checking its work in a hidden preview/);
  banner.querySelector('.cb-take').click();
  assert.deepEqual(w.calls.at(-1), ['tab', 'new', undefined, 'http://localhost:5173/']);
});

test('Select element: Pick mode on a page on this Mac; elsewhere it says why', async () => {
  const w = stand();
  w.open();
  const pick = w.body.querySelector('.cb-pick');
  w.state({ url: 'https://example.com/' });
  assert.ok(pick.classList.contains('cb-off'));
  pick.click();
  assert.deepEqual(w.picks, []);
  assert.equal(w.notes.at(-1), B.NOT_LOCAL);
  w.state({ url: 'http://localhost:5173/' });
  assert.ok(!pick.classList.contains('cb-off'));
  pick.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.picks, ['start']);  // code-pick's chip on the composer: nothing new drawn there
});

test('the window hands the browser to the pane in Eden Code (no dock there)', () => {
  const app = web('app.js');
  assert.match(app, /if \(inEdenCode\) \{\n\s+if \(open && currentPane !== 'browser'\) openPane\('browser'\);/);
  assert.match(app, /const held = pane \? pane\.agentStart\(ev\) : '';/);
  assert.match(app, /if \(pane\) pane\.agentEnd\(ev, result\);/);
  assert.match(web('features/code-selfcheck.js'), /pane\.checkStart\(ev\)/);
  const preload = readFileSync(new URL('../../app/preload.js', import.meta.url), 'utf8');
  for (const name of ['place', 'park', 'external', 'devtools']) assert.match(preload, new RegExp(`${name}: \\(`));
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  for (const ch of ['browser:place', 'browser:park', 'browser:external', 'browser:devtools']) assert.match(main, new RegExp(`ipcMain\\.handle\\('${ch}', `));
  assert.match(main, /paneLib\.viewRect\(/);
});

test('the address field is one pill: the input inside it has no box of its own', () => {
  const css = readFileSync(new URL('../../src/jarvis/web/features/code-browser.css', import.meta.url), 'utf8');
  assert.match(css, /\.cb-field input\.cb-url, \.cb-field input\.cb-url:focus \{[^}]*border: 0; border-radius: 0;[^}]*box-shadow: none;[^}]*background: transparent;/);
});

// ── the pane as the Claude desktop app's browser: pure parts ──

test('the address says what the page is: secure, not secure, this Mac, a file, past a warning', () => {
  assert.equal(B.security('https://example.com/').kind, 'secure');
  assert.equal(B.security('http://example.com/').kind, 'insecure');
  assert.match(B.security('http://example.com/').label, /Not secure/);
  assert.equal(B.security('http://localhost:5173/').kind, 'local');
  assert.equal(B.security('file:///Users/me/a.html').kind, 'file');
  assert.equal(B.security('https://bad.example/', true).kind, 'unsafe');
  assert.equal(B.security('view-source:http://example.com/').kind, 'insecure');
  for (const u of ['', 'about:blank', 'eden-app://x']) assert.equal(B.security(u).kind, 'none', u);
});

test('inline completion finishes the site first, then the address; never words', () => {
  const rows = [{ kind: 'history', url: 'https://www.github.com/anthropics/claude' }, { kind: 'history', url: 'https://gitlab.com/' }];
  assert.equal(B.inlineCompletion('git', rows), 'github.com');
  assert.equal(B.inlineCompletion('GitH', rows), 'GitHub.com');  // what's typed keeps its case
  assert.equal(B.inlineCompletion('github.com/an', rows), 'github.com/anthropics/claude');
  assert.equal(B.inlineCompletion('github.com', rows), '');  // nothing left to add
  assert.equal(B.inlineCompletion('how to', rows), '');
  assert.equal(B.inlineCompletion('https://git', rows), '');
  assert.equal(B.inlineCompletion('x', [{ url: 'javascript:alert(1)' }]), '');
});

test('size presets: the page laid out at a phone’s or tablet’s size, zoomed down to fit, centred', () => {
  const slot = { left: 700, top: 120, width: 680, height: 680, right: 1380, bottom: 800 };
  assert.equal(B.presetRect(slot, 'desktop'), null);
  assert.equal(B.presetRect(slot, ''), null);
  const phone = B.presetRect(slot, 'phone');
  assert.ok(phone.fit < 1);
  assert.ok(Math.abs(phone.width / phone.fit - 375) < 2 && Math.abs(phone.height / phone.fit - 812) < 2);  // its page is 375 × 812
  assert.ok(phone.height <= 680 - 24 && phone.top >= 120);
  assert.ok(Math.abs(phone.left + phone.width / 2 - 1040) <= 1);  // centred
  assert.equal(Math.round(phone.width / phone.fit), 375);  // exactly a phone's width, not one short
  const roomy = B.presetRect({ left: 0, top: 0, width: 2000, height: 1400 }, 'tablet');
  assert.deepEqual([roomy.width, roomy.height, roomy.fit], [768, 1024, 1]);  // never zoomed up
});

test('find, downloads and the console say what they show', () => {
  assert.equal(B.findLabel({ matches: 9, active: 2 }, 'x'), '2 of 9');
  assert.equal(B.findLabel({ matches: 0 }, 'x'), 'No matches');
  assert.equal(B.findLabel({ matches: 3, active: 1 }, ''), '');
  assert.match(B.downloadNote({ state: 'asking', from: 'example.com', total: 2.5e6 }), /From example\.com · 2\.5 MB · Save it\?/);
  assert.equal(B.downloadNote({ state: 'progressing', received: 1e6, total: 4e6 }), '1.0 MB of 4.0 MB');
  assert.equal(B.downloadNote({ state: 'completed', total: 3e3 }), 'Saved to Downloads · 3 KB');
  assert.equal(B.downloadShare({ state: 'progressing', received: 1, total: 4 }), 0.25);
  assert.equal(B.downloadShare({ state: 'asking' }), null);
  const net = B.logRows('network', [{ method: 'POST', url: 'http://localhost:5173/api', status: 500, done: true, ms: 12, type: 'Fetch' }, { url: 'http://x/a.js', failed: 'blocked (client)' }]);
  assert.deepEqual(net.map((r) => [r.level, r.head]), [['error', 'POST 500'], ['error', 'GET blocked (client)']]);
  assert.equal(net[0].meta, 'Fetch · 12 ms');
  const log = B.logRows('console', [{ level: 'error', text: 'boom', url: 'http://localhost:5173/main.js', line: 4 }, { level: 'log', text: 'hi' }]);
  assert.deepEqual(log.map((r) => [r.level, r.head, r.meta]), [['error', 'error', 'localhost:5173/main.js:4'], ['info', 'log', '']]);
});

test('the keys are Chrome’s and the Claude app’s', () => {
  const k = (key, mods = {}) => B.keyAction({ key, metaKey: true, ...mods });
  assert.equal(k('t'), 'new-tab');
  assert.equal(k('w'), 'close-tab');
  assert.equal(k('T', { shiftKey: true }), 'reopen');
  assert.equal(k('f'), 'find');
  assert.equal(k('l'), 'address');
  assert.equal(k('='), 'zoom-in');
  assert.equal(k('-'), 'zoom-out');
  assert.equal(k('0'), 'zoom-reset');
  assert.equal(k('3'), 'tab3');
  assert.equal(k('['), 'back');
  assert.equal(k('i', { altKey: true }), 'devtools');
  assert.equal(k('f', { ctrlKey: true }), 'full');
  assert.equal(B.keyAction({ key: 'Tab', ctrlKey: true }), 'next');
  assert.equal(B.keyAction({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'previous');
  assert.equal(B.keyAction({ key: 't' }), '');  // without ⌘: typing
  assert.equal(k('a'), '');  // ⌘A, ⌘C, ⌘V: the field's own
  assert.equal(k('c'), '');
});

test('the ⋯ menu: its rows as a native menu, the state checked, the id picked comes back', () => {
  const spec = B.menuSpec({ url: 'https://example.com/', zoom: 125, pane: { devtools: 'docked', scheme: 'dark' } }, { preset: 'phone', drawer: true });
  const picked = [];
  const tpl = lib.menuTemplate(spec, (id) => picked.push(id));
  const sub = (label) => tpl.find((x) => x.label === label).submenu;
  assert.equal(sub('Size').find((x) => x.label.startsWith('Phone')).checked, true);
  assert.equal(sub('Size').find((x) => x.label === 'Desktop').checked, false);
  assert.equal(sub('Appearance').find((x) => x.label === 'Dark').checked, true);
  assert.equal(sub('Developer tools').find((x) => x.label === 'Docked in the pane').checked, true);
  assert.equal(tpl.find((x) => x.label === 'Console and network').checked, true);
  assert.equal(tpl.find((x) => x.label === 'Actual size').enabled, true);
  sub('Screenshot').find((x) => x.label === 'Attach to your message').click();
  tpl.find((x) => x.label === 'View page source').click();
  assert.deepEqual(picked, ['shot:attach', 'source']);
  // a local file: no source, no default browser
  const file = lib.menuTemplate(B.menuSpec({ url: 'file:///a.html' }), () => {});
  assert.equal(file.find((x) => x.label === 'View page source').enabled, false);
  assert.equal(file.find((x) => x.label === 'Open in your default browser').enabled, false);
  // what comes from the window is only words: no roles, nothing nested past two, labels cut
  const odd = lib.menuTemplate([{ type: 'separator' }, { id: 'a', label: 'x'.repeat(200), role: 'quit' }, { type: 'separator' }, { type: 'separator' },
    { label: 'Deep', submenu: [{ label: 'Deeper', submenu: [{ id: 'z', label: 'Z' }] }] }, { label: 'no id' }, { type: 'separator' }], () => {});
  assert.equal(odd[0].label.length, 80);
  assert.equal(odd[0].role, undefined);
  assert.equal(odd.filter((x) => x.type === 'separator').length, 1);
  assert.equal(odd.at(-1).label, 'Deep');
  assert.equal(odd.at(-1).submenu.length, 0);  // (a third level is dropped)
});

test('history menus, the page’s source, a screenshot’s name, pages on this Mac', () => {
  const entries = [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: '' }, { url: 'https://c.example/', title: 'C' }, { url: 'https://d.example/', title: 'D' }];
  assert.deepEqual(lib.historyItems(entries, 2, 'back').map((x) => [x.index, x.label]), [[1, 'https://b.example/'], [0, 'A']]);
  assert.deepEqual(lib.historyItems(entries, 2, 'forward').map((x) => x.index), [3]);
  assert.deepEqual(lib.historyItems(entries, 9, 'back'), []);
  assert.equal(lib.historyItems(Array.from({ length: 40 }, (_, i) => ({ url: `https://x/${i}` })), 39, 'back').length, 15);
  assert.equal(lib.sourceUrl('https://example.com/a'), 'view-source:https://example.com/a');
  for (const u of ['file:///etc/hosts', 'view-source:https://x/', 'data:text/html,x', 'eden-app://x', '']) assert.equal(lib.sourceUrl(u), '', u);
  assert.equal(lib.shotName('https://www.example.com/x', new Date(2026, 9, 16, 9, 5, 7)), 'Screenshot example.com 2026-10-16 at 09.05.07.png');
  assert.equal(lib.shotName('', new Date(2026, 0, 2, 3, 4, 5)), 'Screenshot 2026-01-02 at 03.04.05.png');
  for (const u of ['http://localhost:5173/', 'http://app.localhost/', 'http://127.0.0.1:8000/', 'http://[::1]:3000/']) assert.ok(lib.isLoopback(u), u);
  for (const u of ['https://example.com/', 'http://localhost.evil.com/', 'file:///x', '']) assert.ok(!lib.isLoopback(u), u);
});

// ── the pane as the Claude desktop app's browser: in the stand-in window ──

test('⌘F finds in the page: as you type, ↩ and ⇧↩, the count, Esc back to the page', () => {
  const w = stand();
  w.open();
  w.win.jarvisCodeBrowser.key('find');  // ⌘F with the page focused (main.js → app.js browserKey)
  const find = w.body.querySelector('.cb-find');
  const input = w.body.querySelector('.cb-find-input');
  assert.equal(find.hidden, false);
  assert.equal(w.document.activeElement, input);
  input.value = 'login';
  input.dispatchEvent(w.document.event('input'));
  assert.deepEqual(w.calls.at(-1), ['find', { text: 'login', forward: true, next: false }]);
  w.listeners.found({ matches: 4, active: 1 });
  assert.equal(w.body.querySelector('.cb-find-count').textContent, '1 of 4');
  w.document.key('Enter');
  assert.deepEqual(w.calls.at(-1), ['find', { text: 'login', forward: true, next: true }]);
  w.document.key('Enter', { shiftKey: true });
  assert.deepEqual(w.calls.at(-1), ['find', { text: 'login', forward: false, next: true }]);
  w.document.key('Escape');
  assert.equal(find.hidden, true);
  assert.deepEqual(w.calls.slice(-2), [['find', { stop: true }], ['pane', { action: 'focus' }]]);
});

test('the pane’s own keys while it has the keyboard; the conversation’s ⌘F is left alone', () => {
  const w = stand();
  w.open();
  w.state({ url: 'https://example.com/', tabs: [{ id: 1, url: 'https://example.com/', active: true }] });
  const input = w.body.querySelector('.cb-url');
  input.focus();
  const key = (k, mods = {}) => w.document.key(k, { metaKey: true, ...mods });
  assert.equal(key('t'), false);  // handled: the conversation never sees it
  assert.deepEqual(w.calls.find((c) => c[0] === 'tab'), ['tab', 'new', undefined, undefined]);
  key('=');
  assert.deepEqual(w.calls.at(-1), ['shortcut', 'zoom-in']);
  key('2');
  assert.deepEqual(w.calls.at(-1), ['shortcut', 'tab2']);
  key('T', { shiftKey: true });
  assert.deepEqual(w.calls.at(-1), ['shortcut', 'reopen']);
  key('f');
  assert.equal(w.body.querySelector('.cb-find').hidden, false);
  // the last tab: ⌘W closes the pane
  input.focus();
  key('w');
  assert.equal(w.pane.hidden, true);
  assert.deepEqual(w.calls.at(-1), ['hide']);
});

test('the address: suggestions from tabs, bookmarks and history, completed inline, ↓ and ↩ to go', async () => {
  const w = stand();
  w.open();
  w.state({ url: 'https://example.com/' });
  w.featureAnswers['feature:browser:suggest'] = {
    typed: { text: 'git', url: 'https://www.google.com/search?q=git', search: true, engine: 'Google' },
    rows: [{ kind: 'history', url: 'https://github.com/anthropics', title: 'Anthropic' }, { kind: 'tab', url: 'https://gitlab.com/', title: 'GitLab', tab: 4 }],
  };
  const input = w.body.querySelector('.cb-url');
  let sel = null;
  input.setSelectionRange = (a, b) => { sel = [a, b]; };
  input.focus();
  input.value = 'git';
  input.dispatchEvent(w.document.event('input', { inputType: 'insertText' }));
  await w.flush();
  assert.deepEqual(w.invoked.at(-1), ['feature:browser:suggest', { text: 'git' }]);
  assert.equal(input.value, 'github.com');  // the rest of the site, selected
  assert.deepEqual(sel, [3, 10]);
  const box = w.body.querySelector('.cb-suggest');
  assert.equal(box.hidden, false);
  const rows = box.querySelectorAll('.cb-sug');
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /github\.com.*Open/);  // the first row is the completed address, which ↩ opens
  assert.match(rows[2].textContent, /Switch to tab/);
  w.document.key('ArrowDown');
  w.document.key('ArrowDown');
  assert.equal(input.value, 'https://gitlab.com/');
  w.document.key('Enter');
  assert.deepEqual(w.calls.find((c) => c[0] === 'tab'), ['tab', 'select', 4, undefined]);  // an open tab: switched to
  assert.equal(box.hidden, true);
  // Esc puts the page's own address back, and gives the page the keyboard
  input.focus();
  input.value = 'whatever';
  w.document.key('Escape');
  assert.equal(input.value, 'https://example.com/');
  assert.deepEqual(w.calls.at(-1), ['pane', { action: 'focus' }]);
});

test('the address’s icon: a lock, “Not secure”, this Mac; a click is the site’s settings', () => {
  const w = stand();
  w.open();
  const site = w.body.querySelector('.cb-site');
  w.state({ url: 'https://example.com/' });
  assert.equal(site.dataset.kind, 'secure');
  w.state({ url: 'http://example.com/' });
  assert.equal(site.dataset.kind, 'insecure');
  assert.match(site.title, /Not secure/);
  w.state({ url: 'http://localhost:5173/' });
  assert.equal(site.dataset.kind, 'local');
  w.state({ url: 'https://expired.example/' });
  w.bridgeOn['feature:browser:site-state']({ unsafe: true });
  assert.equal(site.dataset.kind, 'unsafe');
  site.click();
  assert.equal(w.invoked.at(-1)[0], 'feature:browser:site-menu');
});

test('a site’s request, sign-in and certificate warning show in the pane (features/browser.js’s)', () => {
  const w = stand();
  const doc = w.document;
  const strip = doc.createElement('div'); strip.id = 'bd-ask';
  const cert = doc.createElement('div'); cert.id = 'bd-cert';
  const dock = doc.createElement('div'); dock.append(strip, cert);
  doc.body.append(dock);
  w.open();
  assert.equal(strip.parentNode, w.body.querySelector('.cb-asks'));
  assert.equal(cert.parentNode, w.body.querySelector('.cb-slot'));
});

test('downloads: Save first, then progress, Open and Show in Finder', () => {
  const w = stand();
  w.open();
  w.listeners.download({ id: 5, name: 'report.pdf', state: 'asking', from: 'example.com', total: 2e6, received: 0 });
  const list = w.body.querySelector('.cb-dls');
  assert.equal(list.hidden, false);
  const buttons = () => list.querySelectorAll('button').map((b) => b.textContent);
  assert.deepEqual(buttons().slice(0, 2), ['Save', 'Cancel']);
  list.querySelectorAll('button')[0].click();
  assert.deepEqual(w.calls.at(-1), ['download', 5, 'save']);
  w.listeners.download({ id: 5, name: 'report.pdf', state: 'progressing', total: 2e6, received: 5e5 });
  assert.equal(list.querySelector('.cb-dl-bar').style.width, '25%');
  w.listeners.download({ id: 5, name: 'report.pdf', state: 'completed', total: 2e6, received: 2e6 });
  assert.deepEqual(buttons().slice(0, 2), ['Open', 'Show in Finder']);
  list.querySelectorAll('button')[0].click();
  assert.deepEqual(w.calls.at(-1), ['download', 5, 'open']);
  list.querySelector('.cb-dl-x').click();
  assert.equal(list.hidden, true);
});

test('sizes, docked DevTools: the view placed at the preset and the DevTools below the page', async () => {
  const w = stand();
  w.open();
  const slot = w.body.querySelector('.cb-slot');
  slot.getBoundingClientRect = () => ({ left: 700, top: 120, right: 1380, bottom: 800, width: 680, height: 680 });
  w.paneAnswers.menu = 'size:phone';
  w.body.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'More').click();
  await w.flush();
  const menu = w.calls.find((c) => c[0] === 'pane' && c[1].action === 'menu');
  assert.ok(menu[1].items.some((x) => x.label === 'Size'));
  await w.tick();
  const placed = w.calls.filter((c) => c[0] === 'place').at(-1)[1];
  assert.ok(placed.fit > 0 && placed.fit < 1);
  assert.ok(Math.abs(placed.width / placed.fit - 375) < 2);
  assert.match(w.body.querySelector('.cb-chips').textContent, /Phone 375×812/);
  w.body.querySelector('.cb-chip').click();  // back to Desktop
  await w.tick();
  assert.deepEqual(w.calls.filter((c) => c[0] === 'place').at(-1)[1], { x: 700, y: 120, width: 680, height: 680 });
  // DevTools docked: the app says so, and they get their place under the page
  w.state({ url: 'http://localhost:5173/', pane: { devtools: 'docked' } });
  const dt = w.body.querySelector('.cb-dt');
  assert.equal(dt.hidden, false);
  dt.getBoundingClientRect = () => ({ left: 700, top: 520, right: 1380, bottom: 800, width: 680, height: 280 });
  slot.getBoundingClientRect = () => ({ left: 700, top: 120, right: 1380, bottom: 519, width: 680, height: 399 });
  await w.tick();
  assert.deepEqual(w.calls.filter((c) => c[0] === 'place').at(-1)[1].dt, { x: 700, y: 526, width: 680, height: 274 });
  w.body.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Developer tools').click();
  assert.deepEqual(w.calls.at(-1), ['pane', { action: 'devtools', mode: 'docked', toggle: true }]);
});

test('a screenshot attaches to the message (the composer’s own attachItems), or is saved', async () => {
  const w = stand();
  w.open();
  w.state({ url: 'http://localhost:5173/' });
  w.paneAnswers.menu = 'shot:attach';
  w.paneAnswers.screenshot = (m) => (m.to === 'attach' ? { ok: true, to: 'attach', png: 'iVBORw0KGgo=', name: 'Screenshot localhost.png' } : { ok: true, to: 'file', name: 'Screenshot localhost.png' });
  w.body.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Screenshot').click();
  await w.flush();
  assert.deepEqual(w.attached, [{ data: 'iVBORw0KGgo=', media_type: 'image/png', name: 'Screenshot localhost.png' }]);
  assert.match(w.notes.at(-1), /on your message/);
  w.paneAnswers.menu = 'shot:file';
  w.body.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Screenshot').click();
  await w.flush();
  assert.match(w.notes.at(-1), /Saved Screenshot localhost\.png to Downloads/);
});

test('the console and network drawer shows what the agent reads', async () => {
  const w = stand();
  w.open();
  w.paneAnswers.menu = 'logs';
  w.paneAnswers.logs = (m) => (m.kind === 'network' ? { ok: true, entries: [{ method: 'GET', url: 'http://localhost:5173/api', status: 404, done: true }] } : { ok: true, entries: [{ level: 'error', text: 'Uncaught TypeError' }] });
  w.body.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'More').click();
  await w.flush();
  const drawer = w.body.querySelector('.cb-drawer');
  assert.equal(drawer.hidden, false);
  assert.match(drawer.textContent, /Uncaught TypeError/);
  assert.match(drawer.textContent, /Eden reads these too/);
  drawer.querySelectorAll('.cb-seg-btn')[1].click();
  await w.flush();
  assert.match(drawer.textContent, /GET 404/);
  w.scope.closePane();  // the pane closed: the drawer stops reading
  assert.equal(drawer.hidden, true);
});

test('the backend hears when the pane opens and closes (a session then works in its tab on show)', () => {
  const w = stand();
  w.open();
  assert.deepEqual(w.sent.find((m) => m.type === 'code_browser_pane'), { type: 'code_browser_pane', open: true });
  w.scope.closePane();
  assert.deepEqual(w.sent.at(-1), { type: 'code_browser_pane', open: false });
  w.fire('hello', {});
  assert.deepEqual(w.sent.at(-1), { type: 'code_browser_pane', open: false });  // said again to a backend that restarted
});

test('the app side: the pane’s asks, a dev-only second profile, ⌘-clicked links behind', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../../app/preload.js', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('browser:pane', /);
  assert.match(preload, /pane: \(msg\) => ipcRenderer\.invoke\('browser:pane', msg\)/);
  assert.match(main, /const DEV_USER_DATA = app\.isPackaged \? '' : String\(process\.env\.EDEN_DEV_USER_DATA \|\| ''\);/);
  assert.ok(main.indexOf('DEV_USER_DATA') < main.indexOf('requestSingleInstanceLock'));  // its own lock
  assert.match(main, /behind: details\.disposition === 'background-tab'/);
  assert.match(main, /if \(action === 'open' && d\.finished\) shell\.openPath\(d\.path\);/);
  assert.match(main, /label: 'View Page Source'/);
  assert.match(main, /paneLib\.isLoopback\(details\.url\)\) browserAgent\.watch\(view\);/);
});

test('an overlay hanging just over the slot’s top edge is found (the address’s suggestions)', () => {
  const rect = { left: 1000, top: 180, right: 1600, bottom: 860, width: 600, height: 680 };
  const list = { left: 1160, top: 120, right: 1760, bottom: 240 };  // 60px into the slot
  const inList = (x, y) => x >= list.left && x <= list.right && y >= list.top && y <= list.bottom;
  assert.ok(B.covered(rect, (x, y) => (inList(x, y) ? 'list' : 'slot'), (n) => n === 'slot'));
  assert.deepEqual(B.logRows('network', [{ url: 'data:image/png;base64,AAAA', status: 200 }]), []);
});

test('the address shows the tab’s page after a switch, even while the field keeps the focus', () => {
  const w = stand();
  w.open();
  const input = w.body.querySelector('.cb-url');
  input.focus();
  w.state({ url: '', tabs: [{ id: 9, url: '', active: true }] });
  w.state({ url: 'http://localhost:5173/', tabs: [{ id: 9, url: '', active: false }, { id: 2, url: 'http://localhost:5173/', active: true }] });
  assert.equal(input.value, 'http://localhost:5173/');
  input.value = 'typing';
  input.dispatchEvent(w.document.event('input', { inputType: 'insertText' }));
  w.state({ url: 'http://localhost:5173/x', tabs: [{ id: 2, url: 'http://localhost:5173/x', active: true }] });
  assert.equal(input.value, 'typing');  // what the owner types isn't overwritten by the page moving on
});
