// The built-in browser's own settings file (app/browser-store.js): node --test tests/web/
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { BrowserStore, clean } = require('../../app/browser-store.js');

test('a missing, damaged or hand-edited file gives what’s valid in it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-store-'));
  assert.deepEqual(new BrowserStore(join(dir, 'none.json')).data, { engine: 'google', restore: true, sites: {}, zoom: {}, session: { tabs: [], active: 0 } });
  writeFileSync(join(dir, 'bad.json'), '{"engine": "kagi", "sites": {');
  assert.deepEqual(new BrowserStore(join(dir, 'bad.json')).data, { engine: 'google', restore: true, sites: {}, zoom: {}, session: { tabs: [], active: 0 } });
  const empty = { tabs: [], active: 0 };
  assert.deepEqual(clean({ engine: 'altavista', sites: { 'https://a.example': { camera: 'allow', midi: 'allow' }, nope: 1 } }),
    { engine: 'google', restore: true, sites: { 'https://a.example': { camera: 'allow' } }, zoom: {}, session: empty });
  assert.deepEqual(clean([1, 2]), { engine: 'google', restore: true, sites: {}, zoom: {}, session: empty });
  assert.equal(clean({ engine: 'duckduckgo' }).engine, 'duckduckgo');
  assert.equal(clean({ engine: 'constructor' }).engine, 'google', 'only an engine of its own');
});

test('a change is saved a moment later, whole, and read back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-store-'));
  const file = join(dir, 'browser-state.json');
  const store = new BrowserStore(file, { delay: 10 });
  store.data.engine = 'brave';
  store.data.sites['https://meet.google.com'] = { camera: 'allow' };
  store.save();
  store.save(); // one write for both
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sites, { 'https://meet.google.com': { camera: 'allow' } });
  assert.equal(new BrowserStore(file).data.engine, 'brave');
  assert.equal(new BrowserStore(join(dir, 'nowhere', 'x.json')).flush(), false, 'an unwritable place is no crash');
});

test('quitting writes a save still waiting, and nothing when none is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-store-'));
  const file = join(dir, 'browser-state.json');
  const store = new BrowserStore(file, { delay: 60_000 });
  assert.equal(store.flushPending(), true);
  assert.throws(() => readFileSync(file), 'wrote with nothing to save');
  store.data.engine = 'kagi';
  store.save();
  assert.equal(store.flushPending(), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).engine, 'kagi');
  assert.equal(store.timer, null, 'the waiting save is done with');
});

test('the session and zoom kept are read defensively; reopening tabs is on unless turned off', () => {
  const { cleanSession, cleanZoom, TABS_MAX, ENTRIES_MAX } = require('../../app/browser-store.js');
  assert.equal(clean({}).restore, true);
  assert.equal(clean({ restore: false }).restore, false);
  assert.equal(clean({ restore: 'no' }).restore, true);
  assert.deepEqual(cleanZoom({ 'a.example': 1.25, 'b.example': 1, 'c.example': 99, 'd.example': 'big', '': 2 }), { 'a.example': 1.25 });
  assert.deepEqual(cleanSession({ tabs: [
    { url: 'https://a.example/', title: 'A', pinned: true, entries: [{ url: 'https://a.example/', title: 'A' }], index: 7 },
    { url: 'javascript:alert(1)', entries: [] },
    { url: 42 },
    null,
    { entries: [{ url: 'https://b.example/1' }, { url: 'data:text/html,x' }, { url: 'https://b.example/2', title: 'B2' }], index: 0 },
  ], active: 9 }), {
    tabs: [
      { url: 'https://a.example/', title: 'A', pinned: true, entries: [{ url: 'https://a.example/', title: 'A' }], index: 0 },
      { url: 'https://b.example/2', title: '', pinned: false, entries: [{ url: 'https://b.example/1', title: '' }, { url: 'https://b.example/2', title: 'B2' }], index: 0 },
    ],
    active: 0,
  });
  const many = cleanSession({ tabs: Array.from({ length: 100 }, (_, i) => ({ url: `https://t${i}.example/`, entries: Array.from({ length: 40 }, (_, j) => ({ url: `https://t${i}.example/${j}` })) })) });
  assert.equal(many.tabs.length, TABS_MAX);
  assert.equal(many.tabs[0].entries.length, ENTRIES_MAX, 'the latest pages of a long back list');
  assert.deepEqual(cleanSession('nonsense'), { tabs: [], active: 0 });
});
