// Eden Code's sidebar, as wide as the owner drags it (web/features/code-side.js), in a
// stand-in window (tests/web/fixtures/stand-dom.mjs): the drag within its limits, the
// handle's keys and its reset, the width remembered per window kind and narrowed to a
// smaller window, and what a screen reader hears of it. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const side = require('../../src/jarvis/web/features/code-side.js');
const WEB = new URL('../../src/jarvis/web/', import.meta.url);
const read = (name) => readFileSync(new URL(name, WEB), 'utf8');
const SOURCE = read('features/code-side.js');

// A style that keeps custom properties (the stand-in's style is a plain object).
function styleOf() {
  const props = new Map();
  return {
    props,
    setProperty: (k, v) => props.set(k, String(v)),
    getPropertyValue: (k) => props.get(k) || '',
    removeProperty: (k) => { props.delete(k); },
  };
}

function stand({ width = 1400, app = 'eden-code', saved = {}, storage = true, cssWidth = '260px' } = {}) {
  const document = makeDocument();
  const el = elFor(document);
  if (app) document.body.dataset.app = app;
  const cc = el('section', 'deck jc');
  cc.id = 'cc';
  cc.style = styleOf();
  const aside = el('aside', 'jc-side');
  aside.id = 'jc-side';
  cc.append(aside, el('div', 'jc-main'));
  document.body.append(cc);
  const store = new Map(Object.entries(saved));
  const localStorage = storage
    ? { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
    : { getItem() { throw new Error('private'); }, setItem() { throw new Error('private'); }, removeItem() { throw new Error('private'); } };
  const frames = [];
  const listeners = {};
  const resized = [];
  cc.addEventListener('jc-side-resize', (e) => resized.push(e.detail.width));
  const window = {
    document, innerWidth: width, localStorage,
    jarvisFeatures: { t: (s) => s },
    // The stylesheet's width, unless the owner's is set inline.
    getComputedStyle: (node) => ({ getPropertyValue: (k) => (node.style.getPropertyValue(k) || (k === '--jc-side-w' ? cssWidth : '')) }),
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  };
  load(SOURCE, { window, document });
  const flush = () => { for (let n = 0; frames.length && n < 20; n += 1) frames.shift()(); };
  flush();
  const handle = document.getElementById('jc-side-handle');
  const pointer = (type, clientX) => handle.dispatchEvent(document.event(type, { clientX, pointerId: 1, button: 0 }));
  const press = (key, extra = {}) => { handle.focus(); return document.key(key, extra); };
  const resize = (w) => { window.innerWidth = w; for (const fn of listeners.resize || []) fn({}); flush(); };
  const shown = () => cc.style.getPropertyValue('--jc-side-w');
  return { document, window, cc, handle, store, pointer, press, resize, shown, resized, flush };
}

test('the limits: never under 200px, never past 45% of the window or under 420px for the main column', () => {
  assert.equal(side.maxWidth(2000), 900);            // 45% of a wide window
  assert.equal(side.maxWidth(1200), 540);
  assert.equal(side.maxWidth(800), 800 - 420 - side.GUTTERS);  // the main column's 420 first
  assert.equal(side.maxWidth(500), side.MIN);        // too small for both: the narrowest
  assert.equal(side.maxWidth(Number.NaN), side.MIN);
  assert.equal(side.clampWidth(120, 1400), 200);
  assert.equal(side.clampWidth(900, 1400), 630);
  assert.equal(side.clampWidth('333.4', 1400), 333);
  assert.equal(side.clampWidth('', 1400), null);
  assert.equal(side.clampWidth(null, 1400), null);  // nothing kept
  assert.equal(side.clampWidth('wide', 1400), null);
  assert.equal(side.storageKey('eden-code'), 'jc.sideWidth.eden-code');
  assert.equal(side.storageKey(undefined), 'jc.sideWidth.secretary');
  assert.equal(side.storageKey('a b/c'), 'jc.sideWidth.abc');
});

test('the handle is a labelled vertical separator with its width as its value', () => {
  const w = stand();
  const h = w.handle;
  assert.ok(h, 'the handle is on the sidebar');
  assert.equal(h.parentNode.id, 'jc-side');
  assert.equal(h.getAttribute('role'), 'separator');
  assert.equal(h.getAttribute('aria-orientation'), 'vertical');
  assert.equal(h.getAttribute('aria-label'), 'Resize sidebar');
  assert.equal(h.getAttribute('aria-controls'), 'jc-side');
  assert.equal(h.tabIndex, 0);
  assert.equal(h.getAttribute('aria-valuenow'), '260');  // the look's own
  assert.equal(h.getAttribute('aria-valuemin'), '200');
  assert.equal(h.getAttribute('aria-valuemax'), '630');  // 45% of 1400
  assert.equal(w.shown(), '', 'no width of its own till it is moved');
});

test('dragging the edge moves the width live, within its limits, and remembers it on release', () => {
  const w = stand();
  w.pointer('pointerdown', 272);
  assert.ok(w.cc.classList.contains('jc-side-dragging'), 'no glide while dragged');
  w.pointer('pointermove', 372);
  assert.equal(w.shown(), '360px');
  assert.equal(w.handle.getAttribute('aria-valuenow'), '360');
  assert.equal(w.resized.at(-1), 360, 'split view hears it');
  assert.equal(w.store.get('jc.sideWidth.eden-code'), undefined, 'kept only once let go');
  w.pointer('pointermove', 2000);
  assert.equal(w.shown(), '630px', 'never past 45%');
  w.pointer('pointermove', 0);
  assert.equal(w.shown(), '200px', 'never under 200');
  w.pointer('pointermove', 312);
  w.pointer('pointerup', 312);
  assert.ok(!w.cc.classList.contains('jc-side-dragging'));
  assert.equal(w.store.get('jc.sideWidth.eden-code'), '300');
  w.pointer('pointermove', 600);  // after the release: nothing
  assert.equal(w.shown(), '300px');
});

test('← → by 16px (Shift: 64), Home and End to the ends, Enter and a double-click back to the default', () => {
  const w = stand();
  w.press('ArrowRight');
  assert.equal(w.shown(), '276px');
  w.press('ArrowRight', { shiftKey: true });
  assert.equal(w.shown(), '340px');
  w.press('ArrowLeft');
  assert.equal(w.shown(), '324px');
  assert.equal(w.store.get('jc.sideWidth.eden-code'), '324');
  w.press('End');
  assert.equal(w.handle.getAttribute('aria-valuenow'), '630');
  w.press('Home');
  assert.equal(w.shown(), '200px');
  w.press('ArrowLeft', { shiftKey: true });
  assert.equal(w.shown(), '200px', 'still the narrowest');
  assert.equal(w.document.key('Enter'), false, 'Enter is the handle’s');
  assert.equal(w.shown(), '', 'the look’s width again');
  assert.equal(w.handle.getAttribute('aria-valuenow'), '260');
  assert.equal(w.store.has('jc.sideWidth.eden-code'), false);
  w.press('End');
  w.handle.dispatchEvent(w.document.event('dblclick'));
  assert.equal(w.shown(), '');
  assert.equal(w.store.has('jc.sideWidth.eden-code'), false);
  // Other keys (and ⌘ chords) are the window's.
  assert.equal(w.press('a'), true);
  assert.equal(w.press('ArrowRight', { metaKey: true }), true);
  assert.equal(w.shown(), '');
});

test('the width comes back per window kind, narrowed to a smaller window and widened again', () => {
  const saved = { 'jc.sideWidth.eden-code': '500', 'jc.sideWidth.secretary': '220' };
  const code = stand({ saved });
  assert.equal(code.shown(), '500px');
  const secretary = stand({ saved, app: '' });
  assert.equal(secretary.shown(), '220px');
  code.resize(1000);  // 1000 - 420 - 36 = 544, 45% = 450
  assert.equal(code.shown(), '450px');
  assert.equal(code.handle.getAttribute('aria-valuemax'), '450');
  assert.equal(code.store.get('jc.sideWidth.eden-code'), '500', 'the owner’s width is kept');
  code.resize(1600);
  assert.equal(code.shown(), '500px', 'and given back once there’s room');
  // A nonsense value is the default; a private window still drags.
  assert.equal(stand({ saved: { 'jc.sideWidth.eden-code': 'x' } }).shown(), '');
  const priv = stand({ storage: false });
  priv.press('ArrowRight');
  assert.equal(priv.shown(), '276px');
});

test('folding the sidebar keeps the width; split view’s pane gets no handle', () => {
  const w = stand();
  w.press('ArrowRight');
  w.cc.classList.add('side-hidden');
  w.cc.classList.remove('side-hidden');
  assert.equal(w.shown(), '276px');
  const document = makeDocument();
  document.body.classList.add('jc-split-pane');
  const cc = document.createElement('section');
  cc.id = 'cc';
  const aside = document.createElement('aside');
  aside.id = 'jc-side';
  cc.append(aside);
  document.body.append(cc);
  load(SOURCE, { window: { document, jarvisFeatures: { t: (s) => s } }, document });
  assert.equal(document.getElementById('jc-side-handle'), null);
});

test('every look places the sidebar and the main column from --jc-side-w, and the handle is said in Chinese', () => {
  const app = read('app.css');
  const eden = read('eden-code.css');
  assert.match(app, /\.jc-side \{ position: absolute;[^}]*width: var\(--jc-side-w\)/);
  assert.match(app, /\.jc-main \{ position: absolute; inset: 0 0 0 var\(--jc-main-l\)/);
  assert.doesNotMatch(app, /\.jc-main \{ left: 284px; \}/);
  assert.match(eden, /body:not\(\[data-skin\]\) \.deck\.jc \{ --jc-side-w: 260px; --jc-main-l: calc\(var\(--jc-side-w\) \+ 24px\); \}/);
  assert.match(eden, /body:not\(\[data-skin\]\) \.jc-main \{ inset: 12px 12px 0 var\(--jc-main-l\); \}/);
  assert.match(read('features/code-split.css'), /--sv-l: var\(--jc-main-l, 284px\)/);
  assert.match(read('features/code-logbook.css'), /\.jc-side \{ top: 0; left: 0; bottom: 0; width: var\(--jc-side-w\)/);
  assert.match(read('features/code-split.js'), /addEventListener\('jc-side-resize'/);
  const zh = JSON.parse(read('i18n/code-side.json'));
  assert.ok(zh.strings['Resize sidebar']);
  assert.equal('300 px'.replace(new RegExp(zh.patterns[0][0]), zh.patterns[0][1]), '300 像素');
});
