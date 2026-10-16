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
  };
  const frames = [];
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
    jarvisApp: { browser: fakeBrowser, feature: { invoke: async () => ({ ok: false }) } },
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
    setTimeout: () => 0, clearTimeout() {}, jcNote: (text) => notes.push(text), ccTasks: [{ id: 3, title: 'Fix login' }],
    closePane: () => { pane.hidden = true; delete pane.dataset.kind; for (const o of observers) o.fn(); },
  };
  load(source, scope);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  const open = () => { F.openPane('browser'); panes.get('browser').render(body); for (const o of observers) o.fn(); };
  const state = (st) => listeners.state({ url, tabs: [], canBack: false, canForward: false, loading: false, ...st });
  const tick = async () => { const fn = frames.shift(); if (fn) fn(); await new Promise((r) => setImmediate(r)); };
  const point = (node) => { pointed = node; };
  return { document, win, pane, body, btn, calls, sent, notes, picks, fire, open, state, tick, point, listeners, scope };
}

test('the globe is on the title bar in the app, and its pane has the whole toolbar', () => {
  const w = stand();
  assert.equal(w.btn.hidden, false);
  w.open();
  const labels = w.body.querySelectorAll('button').map((b) => b.getAttribute('aria-label'));
  for (const want of ['New tab', 'Back', 'Forward', 'Reload', 'Select element: send it with your next message', 'Open in your default browser', 'Developer tools']) {
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
  by('Open in your default browser').click();
  assert.deepEqual(w.calls.at(-1), ['external']);
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
