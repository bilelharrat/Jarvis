// Which Research Center pages the user can type on (its sign-in pages), and which pages may be
// locked at all: node --test tests/web/
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

// Which pages keep page-preload.js's wheel and touch blockers (main.js's mayLock): a page that
// may be locked has to have them before the lock comes, or a scroll while it's busy gets through.
const fn = (name) => {
  const at = MAIN.indexOf(`function ${name}(`);
  return MAIN.slice(at, MAIN.indexOf('\n}\n', at) + 2);
};
const mayLock = (base, lockWanted, url) => new Function('researchBase', 'browserStore',
  `${fn('researchOrigin')}\n${fn('onResearch')}\n${fn('mayLock')}\nreturn mayLock(${JSON.stringify(url)});`)(base, () => ({ researchLock: lockWanted }));

test('every Research Center page may be locked, its sign-in pages too; no other page', () => {
  const base = 'https://app.bshventures.com/research';
  for (const lockWanted of [true, false]) { // the badge can turn the lock on at any moment
    assert.equal(mayLock(base, lockWanted, 'https://app.bshventures.com/research/markets'), true);
    assert.equal(mayLock(base, lockWanted, 'https://app.bshventures.com/research/login'), true); // it moves on without loading
    assert.equal(mayLock(base, lockWanted, 'https://app.bshventures.com/other'), true); // same origin
    assert.equal(mayLock(base, lockWanted, 'https://www.youtube.com/watch?v=x'), false);
    assert.equal(mayLock(base, lockWanted, 'http://app.bshventures.com/research/markets'), false);
    assert.equal(mayLock(base, lockWanted, 'about:blank'), false);
    assert.equal(mayLock(base, lockWanted, ''), false);
  }
});

test('before the Research Center’s address is known, every page may be locked while the lock is wanted', () => {
  assert.equal(mayLock('', true, 'https://www.youtube.com/'), true);
  assert.equal(mayLock('', false, 'https://www.youtube.com/'), false);
});

test('pages hear whether they may be locked as they load, and again before any lock it changes', () => {
  // As each page loads...
  assert.match(MAIN, /wc\.on\('did-navigate', \(_event, url\) => \{[^\n]*tellLockable\(wc\);[^\n]*\}\);/);
  // ...when the badge changes what's wanted (before the lock itself goes to the page)...
  const badge = fn('setResearchLock');
  assert.ok(badge.indexOf('tellLockable') > 0 && badge.indexOf('tellLockable') < badge.indexOf('updateLock()'), badge);
  // ...and when the Research Center's address changes, before its page is opened and locked.
  const research = MAIN.slice(MAIN.indexOf("case 'research':"), MAIN.indexOf("case 'back':"));
  assert.ok(research.indexOf('tellLockable') > 0 && research.indexOf('tellLockable') < research.indexOf('researchOpen('), research);
});
