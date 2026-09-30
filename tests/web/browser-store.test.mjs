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
  assert.deepEqual(new BrowserStore(join(dir, 'none.json')).data, { engine: 'google', sites: {} });
  writeFileSync(join(dir, 'bad.json'), '{"engine": "kagi", "sites": {');
  assert.deepEqual(new BrowserStore(join(dir, 'bad.json')).data, { engine: 'google', sites: {} });
  assert.deepEqual(clean({ engine: 'altavista', sites: { 'https://a.example': { camera: 'allow', midi: 'allow' }, nope: 1 } }),
    { engine: 'google', sites: { 'https://a.example': { camera: 'allow' } } });
  assert.deepEqual(clean([1, 2]), { engine: 'google', sites: {} });
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
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { engine: 'brave', sites: { 'https://meet.google.com': { camera: 'allow' } } });
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
