// Which Research Center pages the user can type on (its sign-in pages): node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// main.js runs in Electron, so the two pieces are taken from its source.
const MAIN = readFileSync(fileURLToPath(new URL('../../app/main.js', import.meta.url)), 'utf8');
const auth = MAIN.match(/const RESEARCH_AUTH = (\/.+\/);/)[1];
const start = MAIN.indexOf('function researchPath(');
const source = MAIN.slice(start, MAIN.indexOf('\n}\n', start) + 2);
const signIn = (base, url) => new Function('researchBase', `${source}\nreturn ${auth}.test(researchPath(${JSON.stringify(url)}));`)(base);

test('the hosted sign-in page under /research can be typed on', () => {
  const base = 'https://app.bshventures.com/research';
  assert.equal(signIn(base, 'https://app.bshventures.com/research/login'), true);
  assert.equal(signIn(base, 'https://app.bshventures.com/research/login?next=%2Fmarkets'), true);
  assert.equal(signIn(base, 'https://app.bshventures.com/research/reset/abc'), true);
  assert.equal(signIn(base, 'https://app.bshventures.com/login'), true); // the app also answers at /
  assert.equal(signIn(base, 'https://app.bshventures.com/research/markets'), false);
  assert.equal(signIn(base, 'https://app.bshventures.com/research/'), false);
  assert.equal(signIn(base, 'https://app.bshventures.com/research/loginx'), false);
});

test('a local Research Center at the root works as before', () => {
  const base = 'http://127.0.0.1:8010';
  assert.equal(signIn(base, 'http://127.0.0.1:8010/login'), true);
  assert.equal(signIn(base, 'http://127.0.0.1:8010/markets'), false);
});
