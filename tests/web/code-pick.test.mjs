// Click an element to send it (F3), the pure parts: what the page's preload takes of an
// element (app/element-pick-preload.js), which tabs may be picked from and where the picture
// is cut (app/element-pick-lib.js), and the window's helpers (web/features/code-pick.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const P = require('../../app/element-pick-preload.js');
const lib = require('../../app/element-pick-lib.js');
const W = require('../../src/jarvis/web/features/code-pick.js');

test('only a page on this Mac, or a file the owner opened, may be picked from (S29)', () => {
  for (const url of ['http://localhost:5173/', 'https://app.localhost/', 'http://127.0.0.1:8000/x', 'http://[::1]:3000/']) {
    assert.ok(lib.pickable(url), url);
  }
  for (const url of ['https://example.com/', 'http://192.168.1.4:3000/', 'http://localhost.evil.com/', 'javascript:alert(1)', 'data:text/html,hi', '']) {
    assert.ok(!lib.pickable(url), url);
  }
  assert.ok(lib.pickable('file:///Users/me/site/index.html', 'file:///Users/me/site/index.html'));  // typed by the owner
  assert.ok(!lib.pickable('file:///Users/me/.ssh/id_rsa'));  // a page or the agent went there
  assert.ok(!lib.pickable('file:///Users/me/a.html', 'file:///Users/me/b.html'));
});

test('the picture is cut around the element, zoomed, and inside the tab', () => {
  assert.deepEqual(lib.cropRect([40, 140, 140, 36], 1, { width: 1280, height: 800 }), { x: 32, y: 132, width: 156, height: 52 });
  assert.deepEqual(lib.cropRect([40, 140, 140, 36], 2, { width: 1280, height: 800 }), { x: 64, y: 264, width: 312, height: 104 });
  const edge = lib.cropRect([1270, 790, 400, 400], 1, { width: 1280, height: 800 });
  assert.ok(edge.x + edge.width <= 1280 && edge.y + edge.height <= 800 && edge.width >= 1 && edge.height >= 1);
  assert.deepEqual(lib.cropRect(null, 0, {}), { x: 0, y: 0, width: 1, height: 1 });  // nothing sensible: one pixel, never a throw
});

test('the outer HTML is trimmed: long attributes cut, at most HTML_MAX characters', () => {
  const pic = `<img src="data:image/png;base64,${'A'.repeat(5000)}" alt="Mug">`;
  const { html, cut } = P.trimHtml(pic);
  assert.ok(!cut && html.length < 260 && html.includes('alt="Mug"') && html.includes('…"'));
  const long = P.trimHtml(`<ul>${'<li>item</li>'.repeat(1000)}</ul>`);
  assert.ok(long.cut && long.html.length === P.HTML_MAX && long.html.endsWith('…'));
  assert.equal(P.trimHtml('<button\n   class="add">  Add\n to cart </button>').html, '<button class="add"> Add to cart </button>');
});

test('only the key computed styles that say something are kept', () => {
  const computed = { color: 'rgb(255, 255, 255)', 'background-color': 'rgb(0, 113, 227)', margin: '0px', position: 'static', 'border-radius': '8px', cursor: 'pointer' };
  assert.deepEqual(P.keyStyles((k) => computed[k] || ''), { color: 'rgb(255, 255, 255)', 'background-color': 'rgb(0, 113, 227)', 'border-radius': '8px' });
  assert.deepEqual(P.keyStyles(() => { throw new Error('gone'); }), {});
});

test('roles and names as a screen reader has them', () => {
  assert.equal(P.roleOf({ tag: 'BUTTON' }), 'button');
  assert.equal(P.roleOf({ tag: 'a', href: true }), 'link');
  assert.equal(P.roleOf({ tag: 'a', href: false }), '');
  assert.equal(P.roleOf({ tag: 'input', type: 'email' }), 'textbox');
  assert.equal(P.roleOf({ tag: 'input', type: 'checkbox' }), 'checkbox');
  assert.equal(P.roleOf({ tag: 'input', type: 'hidden' }), '');
  assert.equal(P.roleOf({ tag: 'div', role: 'button primary' }), 'button');
  assert.equal(P.roleOf({ tag: 'h2' }), 'heading');
  assert.equal(P.roleOf({ tag: 'img', role: 'presentation' }), 'img');  // (presentation: its tag's)
  assert.equal(P.nameFrom(['', '  ', ' Add   to cart ', 'later']), 'Add to cart');
  assert.equal(P.nameFrom(['x'.repeat(400)]).length, 160);
});

test('a selector that matches the element alone', () => {
  const node = (tagName, extra = {}) => ({ nodeType: 1, tagName, id: '', classList: [], children: [], parentElement: null, ...extra });
  const body = node('BODY');
  const main = node('MAIN', { parentElement: body });
  body.children = [main];
  const b1 = node('BUTTON', { classList: ['add', 'btn', 'big'], parentElement: main });
  const b2 = node('BUTTON', { classList: ['add', 'btn'], parentElement: main });
  main.children = [b1, b2];
  const unique = new Map([['main > button.add.btn:nth-of-type(2)', 1], ['#buy', 1]]);
  const count = (s) => unique.get(s) || 2;
  assert.equal(P.selectorFor(b2, count), 'main > button.add.btn:nth-of-type(2)');
  b2.id = 'buy';
  assert.equal(P.selectorFor(b2, count), '#buy');
  b2.id = 'not safe"]';  // an id that can't go into a selector as it is: the path instead
  assert.equal(P.selectorFor(b2, count), 'main > button.add.btn:nth-of-type(2)');
});

test('the window: Pick mode opens the dev server only when the tab is elsewhere', () => {
  assert.ok(W.showsAlready('http://localhost:5173/cart', 'http://localhost:5173/'));
  assert.ok(!W.showsAlready('http://localhost:3000/', 'http://localhost:5173/'));
  assert.ok(!W.showsAlready('', 'http://localhost:5173/'));
  assert.notEqual(W.newRef(), W.newRef());
  assert.match(W.attachedWords('Element: #buy'), /^Element: #buy is on your message/);
  assert.match(W.NO_APP, /Eden Code app/);
});
