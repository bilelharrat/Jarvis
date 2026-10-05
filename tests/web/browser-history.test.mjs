// The built-in browser's history and bookmarks file (browser.json, app/main.js): saved a moment
// after a change, off the main thread, one write at a time, the newest last, and never again
// when nothing changed. node --test tests/web/
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// main.js runs in Electron, so its pieces are taken from its source.
const MAIN = readFileSync(fileURLToPath(new URL('../../app/main.js', import.meta.url)), 'utf8');
const piece = (name) => {
  const start = MAIN.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.js has no ${name}`);
  return MAIN.slice(start, MAIN.indexOf('\n}\n', start) + 2);
};
const state = MAIN.match(/^let browserWritten = .*$/m)[0] + '\n' + MAIN.match(/^let browserWriting = .*$/m)[0];
const runs = MAIN.match(/^const pagesByItself = .*$/m)[0];

// The store's save and retitle, with the file at `file`, `files` for its writes, and timers
// the test fires itself.
function store(file, files = fs.promises) {
  const timers = [];
  const make = new Function('fs', 'browserFile', 'setTimeout', 'clearTimeout', `
    let browserData = { history: [], bookmarks: [], adblock: true, researchLock: false, allow: [] };
    let browserSave = null;
    ${state}
    const browserStore = () => browserData;
    // A tab here is { id, getTitle, byItself }: byItself, the page it's on came by itself.
    const parity = { wentByItself: (wc) => Boolean(wc.byItself), isPrivate: () => false };
    const onResearch = () => false;
    const RESEARCH_AUTH = /^$/;
    const researchPath = () => '/';
    ${runs}
    ${piece('saveBrowserStore')}
    ${piece('rememberVisit')}
    ${piece('retitleVisit')}
    return { data: () => browserData, save: saveBrowserStore, visit: rememberVisit, retitle: retitleVisit, writing: () => browserWriting };`);
  const s = make(
    { ...fs, promises: files },
    () => file,
    (fn) => { timers.push(fn); return timers.length; },
    (n) => { if (n) timers[n - 1] = null; },
  );
  s.fire = () => { const due = timers.splice(0).filter(Boolean); due.forEach((fn) => fn()); return due.length; };
  return s;
}

test('a change is written whole a moment later, through a .tmp file, after the save returns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-history-'));
  const file = join(dir, 'browser.json');
  const s = store(file);
  s.data().history.push({ url: 'https://a.example/', title: 'A', at: 1 });
  s.save();
  s.save(); // one write for both
  assert.equal(s.fire(), 1);
  assert.throws(() => readFileSync(file), 'written on the main thread');
  await s.writing();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), s.data());
  assert.deepEqual(fs.readdirSync(dir), ['browser.json'], 'a .tmp file was left behind');
  rmSync(dir, { recursive: true, force: true });
});

test('nothing changed: nothing written; a failed write is tried again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-history-'));
  const file = join(dir, 'browser.json');
  const writes = [];
  let failing = true;
  const files = {
    writeFile: async (to, text) => { writes.push(text); if (failing) throw new Error('disk full'); return fs.promises.writeFile(to, text); },
    rename: (a, b) => fs.promises.rename(a, b),
  };
  const s = store(file, files);
  s.data().bookmarks.push({ url: 'https://b.example/', title: 'B' });
  s.save(); s.fire(); await s.writing();
  assert.equal(writes.length, 1);
  failing = false;
  s.save(); s.fire(); await s.writing(); // the same store again, after a failure: written
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).bookmarks[0].url, 'https://b.example/');
  s.save(); s.fire(); await s.writing(); // unchanged since it was written
  assert.equal(writes.length, 2);
  s.data().adblock = false;
  s.save(); s.fire(); await s.writing();
  assert.equal(writes.length, 3);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).adblock, false);
  rmSync(dir, { recursive: true, force: true });
});

test('writes take turns, and the newest is the one left on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-history-'));
  const file = join(dir, 'browser.json');
  let busy = 0;
  let overlapped = false;
  const files = {
    writeFile: async (to, text) => {
      busy += 1;
      if (busy > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, JSON.parse(text).history.length === 1 ? 60 : 5)); // the first is slow
      await fs.promises.writeFile(to, text);
      busy -= 1;
    },
    rename: (a, b) => fs.promises.rename(a, b),
  };
  const s = store(file, files);
  s.data().history.push({ url: 'https://one.example/', title: '1', at: 1 });
  s.save(); s.fire();
  s.data().history.push({ url: 'https://two.example/', title: '2', at: 2 });
  s.save(); s.fire();
  await s.writing();
  assert.equal(overlapped, false, 'two writes shared the .tmp file at once');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).history.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('a page’s title is kept on its visit, and saved only when it changed', () => {
  const s = store(join(tmpdir(), 'never-written', 'browser.json'));
  s.data().history.push({ url: 'https://a.example/', title: '', at: 1 });
  s.retitle('https://a.example/', 'Hello');
  assert.equal(s.data().history[0].title, 'Hello');
  assert.equal(s.fire(), 1);
  s.retitle('https://a.example/', 'Hello'); // the same title again
  s.retitle('https://other.example/', 'Other'); // not the latest visit
  s.retitle('https://a.example/', ''); // no title
  assert.equal(s.fire(), 0);
  assert.equal(s.data().history[0].title, 'Hello');
});

test('a page sending itself somewhere new again and again is one row: the owner’s visits stay', () => {
  const s = store(join(tmpdir(), 'never-written', 'browser.json'));
  const history = s.data().history;
  for (let i = 0; i < 1990; i++) history.push({ url: `https://owner.example/${i}`, title: '', at: i });
  const tab = { id: 7, byItself: false, getTitle: () => 'Hop' };
  s.visit('https://hop.example/0', tab); // the owner went there
  tab.byItself = true;
  for (let i = 1; i <= 700; i++) s.visit(`https://hop.example/${i}`, tab);
  assert.equal(history.length, 1992);
  assert.equal(history.filter((h) => h.url.startsWith('https://owner.example/')).length, 1990);
  assert.deepEqual(history.slice(-2).map((h) => h.url), ['https://hop.example/0', 'https://hop.example/700']);
  // Another tab's visit meanwhile: the run's row moves last as it goes on.
  s.visit('https://other.example/', { id: 8, byItself: false, getTitle: () => 'Other' });
  s.visit('https://hop.example/701', tab);
  assert.deepEqual(history.slice(-3).map((h) => h.url), ['https://hop.example/0', 'https://other.example/', 'https://hop.example/701']);
  assert.equal(history.length, 1993);
  // The owner sends the tab on: a row of its own, and the page's next run is a new row.
  tab.byItself = false;
  s.visit('https://owner.example/next', tab);
  tab.byItself = true;
  s.visit('https://hop.example/again', tab);
  s.visit('https://hop.example/again-2', tab);
  assert.deepEqual(history.slice(-3).map((h) => h.url), ['https://hop.example/701', 'https://owner.example/next', 'https://hop.example/again-2']);
  // History cleared: the run starts a new row.
  s.data().history = [];
  s.visit('https://hop.example/after-clear', tab);
  assert.deepEqual(s.data().history.map((h) => h.url), ['https://hop.example/after-clear']);
});
