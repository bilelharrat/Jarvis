// What the built-in browser opens for an address (app/url-input.js): node --test tests/web/
// The cases are shared with brain.browser_address's tests (tests/fixtures/url_input.json).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { toUrl, isLocalHost, SEARCH, ENGINES, setSearchEngine, searchEngine, searchUrl, homeUrl } = require('../../app/url-input.js');
const FIXTURE = fileURLToPath(new URL('../fixtures/url_input.json', import.meta.url));
const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8'));

test('every shared case opens what it should', () => {
  for (const [input, typed, expected] of cases) {
    const got = toUrl(input, { typed });
    const want = expected === null ? SEARCH + encodeURIComponent(input.trim()) : expected;
    assert.equal(got, want, `${JSON.stringify(input)} (typed: ${typed})`);
  }
});

test('ports and local addresses are pages, never searches, and local ones get http', () => {
  assert.equal(toUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(toUrl('[::1]:5173'), 'http://[::1]:5173');
  assert.equal(toUrl('192.168.1.5'), 'http://192.168.1.5'); // was forced to https
  assert.ok(isLocalHost('printer.local') && isLocalHost('[::1]') && isLocalHost('127.0.0.1'));
  assert.ok(!isLocalHost('example.com') && !isLocalHost('local.example.com'));
});

test('a script, data or a file JARVIS asks for is never opened', () => {
  for (const input of ['javascript:alert(document.cookie)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', ' JAVASCRIPT:x']) {
    assert.ok(toUrl(input).startsWith(SEARCH), input);
  }
  assert.equal(toUrl('file:///Users/me/a.pdf', { typed: true }), 'file:///Users/me/a.pdf');
  assert.ok(toUrl('javascript:alert(1)', { typed: true }).startsWith(SEARCH));
});

test('a long run of input is read at once', () => {
  const started = performance.now();
  toUrl(`a${'.a'.repeat(50_000)}!`);
  toUrl(`${'a-'.repeat(50_000)}:`);
  assert.ok(performance.now() - started < 100);
});

test('words go to the search engine picked in Settings, and only a known one is picked', () => {
  try {
    assert.equal(setSearchEngine('duckduckgo'), 'duckduckgo');
    assert.equal(toUrl('best ramen'), 'https://duckduckgo.com/?q=best%20ramen');
    assert.equal(toUrl('example.com'), 'https://example.com', 'an address is still an address');
    assert.equal(homeUrl(), 'https://duckduckgo.com');
    assert.equal(searchEngine().name, 'DuckDuckGo');
    assert.equal(setSearchEngine('altavista'), 'duckduckgo', 'an unknown engine changes nothing');
    assert.equal(setSearchEngine('__proto__'), 'duckduckgo');
    for (const id of Object.keys(ENGINES)) assert.ok(searchUrl('a b', id).startsWith('https://') && searchUrl('a b', id).endsWith('a%20b'), id);
    assert.deepEqual(Object.keys(ENGINES), ['google', 'duckduckgo', 'bing', 'brave', 'kagi']);
  } finally {
    setSearchEngine('google');
  }
  assert.equal(toUrl('weather'), `${SEARCH}weather`);
});
