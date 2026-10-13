// What the built-in browser takes on trust, and no longer does: an address the window's page
// sends by itself is never "typed" (so never a file on this Mac), the agent never reads a file:
// page the user didn't open (audit S29), and a click's "needs your OK" is decided in the main
// process too, from what the click submits (S31). main.js runs in Electron: its wiring is read
// from its source. node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const guards = require('../../app/window-guards.js');
const agent = require('../../app/browser-agent.js');
const lib = require('../../app/browser-lib.js');
const MAIN = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
const PARITY = readFileSync(new URL('../../app/browser-parity.js', import.meta.url), 'utf8');
const PRELOAD = readFileSync(new URL('../../app/page-preload.js', import.meta.url), 'utf8');

test('typed means the person just pressed a key or the mouse in the window, not that its page said so', () => {
  const wc = new EventEmitter();
  let now = 1000;
  const typed = guards.inputClock(wc, { now: () => now });
  assert.equal(typed(), false, 'nothing yet');
  wc.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter' });
  now += 400;
  assert.equal(typed(), true);
  now += 2000;
  assert.equal(typed(), false, 'a moment later it isn’t');
  wc.emit('before-mouse-event', {}, { type: 'mouseMove' });
  assert.equal(typed(), false, 'a move isn’t a press');
  wc.emit('before-mouse-event', {}, { type: 'mouseDown' });
  assert.equal(typed(), true);
});

test('main.js and the popped-out window type an address only on that clock, and remember the file the user opened', () => {
  assert.match(MAIN, /const target = toUrl\(url, \{ typed: windowTyped\(\) \}\);\s*if \(\/\^file:\/i\.test\(target\)\) browserView\.userFile = target;/);
  assert.ok(!/toUrl\(url, \{ typed: true \}\)/.test(MAIN), 'never typed: true on the page’s word');
  assert.match(MAIN, /windowTyped = guards\.inputClock\(win\.webContents\)/);
  assert.match(PARITY, /popWin\.typed = inputClock\(popWin\.webContents\)/);
  assert.ok(!/toUrl\(url\.slice\(0, 4000\), \{ typed: true \}\)/.test(PARITY));
  assert.match(MAIN, /\['read', 'click', 'type', 'search', 'scroll', 'pointed'\]\.includes\(action\) && fileNotTheirs\(view\)\) return \{ ok: false, message: FILE_REFUSED \}/);
});

test('the agent never reads, shows or acts in a file: page the user didn’t open themselves', async () => {
  const view = (url, userFile) => ({ userFile, webContents: Object.assign(new EventEmitter(), { id: 7, getURL: () => url, isDestroyed: () => false }) });
  assert.equal(agent.fileNotTheirs(view('file:///Users/me/.ssh/id_ed25519')), true);
  assert.equal(agent.fileNotTheirs(view('file:///Users/me/notes.html', 'file:///Users/me/notes.html')), false, 'the one they typed');
  assert.equal(agent.fileNotTheirs(view('file:///Users/me/other.html', 'file:///Users/me/notes.html')), true, 'a link from it is not');
  assert.equal(agent.fileNotTheirs(view('https://example.com/')), false);
  const tab = view('file:///etc/hosts');
  const a = new agent.BrowserAgent({ ensureBrowser: () => tab, tabs: () => [tab] });
  for (const action of ['snapshot', 'screenshot', 'eval', 'act', 'describe']) {
    assert.deepEqual(await a.run(action, {}), { ok: false, message: agent.FILE_REFUSED }, action);
  }
});

test('“needs your OK”: what the click submits counts, whatever the page calls the button', () => {
  const page = 'https://shop.example/cart';
  assert.equal(lib.riskyClick({ risky: true }, page), true, 'the page’s own sign still counts');
  assert.equal(lib.riskyClick({ risky: false, label: 'Next' }, 'https://news.example/story'), false, 'a plain button elsewhere');
  assert.equal(lib.riskyClick({ risky: false, label: 'Next' }, 'https://shop.example/checkout/step-2'), true, 'a checkout page');
  assert.equal(lib.riskyClick({ risky: false, label: 'Next', form: { action: 'https://shop.example/api/pay', method: 'get' } }, page), true);
  assert.equal(lib.riskyClick({ risky: false, label: 'Continue', form: { action: page, method: 'post' } }, page), true, 'a POST');
  assert.equal(lib.riskyClick({ risky: false, label: 'Go', form: { action: 'https://shop.example/search', method: 'get', payment: true } }, page), true, 'a card number in the form');
  assert.equal(lib.riskyClick({ risky: false, label: 'Go', form: { action: 'https://shop.example/search', method: 'get', password: true } }, page), true);
  assert.equal(lib.riskyClick({ risky: false, label: 'Go', form: { action: 'https://collector.example/q', method: 'get' } }, page), true, 'sent to another site');
  assert.equal(lib.riskyClick({ risky: false, label: 'Search', form: { action: 'https://shop.example/search?q=', method: 'get' } }, page), false, 'a search stays a search');
  assert.equal(lib.riskyClick(null, page), true, 'nothing said: ask');
  assert.match(MAIN, /if \(riskyClick\(found, wc\.getURL\(\)\) && !args\.force\)/);
  assert.match(PRELOAD, /risky: risky\(el\), form: formOf\(el\)/);
});
