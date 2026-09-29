// What the browser dock calls a Research Center page: node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// app.js is one of the window's classic scripts, so pageName is taken from its source.
const APP = readFileSync(fileURLToPath(new URL('../../src/jarvis/web/app.js', import.meta.url)), 'utf8');
const start = APP.indexOf('function pageName(');
const source = APP.slice(start, APP.indexOf('\n}\n', start) + 2);
const pageName = new Function('RC_NAMES', `${source}\nreturn pageName;`)({ '/markets': 'Markets' });

test('a page title loses the site name, however it is joined on', () => {
  const at = 'http://127.0.0.1:8010/markets';
  assert.equal(pageName(at, 'Deal desk | BSH Research Center'), 'Deal desk');
  assert.equal(pageName(at, 'Hormuz—BSH Research Center  '), 'Hormuz');
  assert.equal(pageName(at, '  Lab \u00a0 ·  bsh research center'), 'Lab');
  assert.equal(pageName(at, 'BSH Research Center'), 'Markets');
  assert.equal(pageName('http://127.0.0.1:8010/deal-notes//', ''), 'Deal notes');
});

test('a title with a long run of spaces is read at once', () => {
  // A space before the separator was tried from every space of a run: 50,000 took 2.5 s.
  const title = `a${' '.repeat(50_000)}b`;
  const started = performance.now();
  assert.equal(pageName('http://127.0.0.1:8010/', title), title);
  assert.equal(pageName('http://127.0.0.1:8010/', `${title} | BSH Research Center`), title);
  assert.ok(performance.now() - started < 50);
});

test('a malformed %-escape in the address is shown as it is, never an error', () => {
  assert.equal(pageName('http://127.0.0.1:8010/%E0%A4%A', ''), '%E0%A4%A');
  assert.equal(pageName('http://127.0.0.1:8010/deal%20notes', ''), 'Deal notes');
});

test('the hosted Research Center names its pages without its /research base', () => {
  const base = 'https://app.bshventures.com/research';
  assert.equal(pageName('https://app.bshventures.com/research/markets', '', base), 'Markets');
  assert.equal(pageName('https://app.bshventures.com/research/', '', base), 'Home');
  assert.equal(pageName('https://app.bshventures.com/research', '', base), 'Home');
  assert.equal(pageName('https://app.bshventures.com/researchers', '', base), 'Researchers');
});
