// Which downloads the built-in browser stages at all (app/main.js's mayDownload): the ones the
// owner asked for; one a page starts by itself, as in Chrome, and no more until the owner acts
// in it again; never more than a few waiting for Save. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// main.js runs in Electron, so its pieces are taken from its source.
const MAIN = readFileSync(fileURLToPath(new URL('../../app/main.js', import.meta.url)), 'utf8');
const piece = (name) => {
  const start = MAIN.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.js has no ${name}`);
  return MAIN.slice(start, MAIN.indexOf('\n}\n', start) + 2);
};
const line = (re) => {
  const m = MAIN.match(re);
  assert.ok(m, `main.js has no ${re}`);
  return m[0];
};

// A page here is { url, clicked, lastAct }: clicked, the owner's click or key a moment ago;
// lastAct, when the owner last acted in it or sent it to a page (browser-parity.js's).
function limiter() {
  const notes = [];
  const downloads = new Map();
  const make = new Function('parity', 'downloads', 'win', `
    let browserView = null;
    const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
    ${line(/^const DOWNLOADS_WAITING_MAX = .*$/m)}
    ${line(/^const unaskedDownload = .*$/m)}
    ${line(/^let downloadNoted = .*$/m)}
    ${piece('mayDownload')}
    ${piece('refuseDownload')}
    return { may: mayDownload, show: (page) => { browserView = { webContents: page }; }, max: DOWNLOADS_WAITING_MAX };`);
  const parity = { gesture: (wc) => Boolean(wc.clicked), lastAct: (wc) => wc.lastAct || 0 };
  const win = { isDestroyed: () => false, webContents: { send: (channel, note) => notes.push([channel, note.text]) } };
  const l = make(parity, downloads, win);
  return { ...l, notes, downloads };
}
const page = (url = 'https://files.example/') => ({ url, clicked: false, lastAct: 0, isDestroyed: () => false, getURL() { return this.url; } });
const item = (gesture = false) => ({ hasUserGesture: () => gesture });

test('a page starts one download by itself; the rest wait for the owner to act in it again', () => {
  const l = limiter();
  const p = page();
  l.show(p);
  assert.equal(l.may(item(), p), true, 'the first a page starts by itself');
  assert.equal(l.may(item(), p), false);
  assert.equal(l.may(item(), p), false);
  assert.equal(l.notes.length, 1, 'said once, not once per refusal');
  assert.match(l.notes[0][1], /files\.example tried to download more files by itself/);
  p.lastAct = 1000; // the owner clicked in it, or sent it to another page
  assert.equal(l.may(item(), p), true);
  assert.equal(l.may(item(), p), false);
  // Another page has its own one.
  assert.equal(l.may(item(), page('https://other.example/')), true);
});

test('what the owner asked for goes ahead, however many', () => {
  const l = limiter();
  const p = page();
  p.clicked = true;
  for (let i = 0; i < 5; i++) assert.equal(l.may(item(), p), true, 'after a click');
  p.clicked = false;
  for (let i = 0; i < 5; i++) assert.equal(l.may(item(true), p), true, 'Chromium says a gesture started it');
  assert.equal(l.may(item(), null), true, 'no page: the app’s own');
});

test('no more than a few wait for Save at once, asked for or not; saved and failed ones don’t count', () => {
  const l = limiter();
  const p = page();
  l.show(p);
  p.clicked = true;
  for (let i = 0; i < l.max; i++) l.downloads.set(i, { saved: false, failed: '' });
  assert.equal(l.may(item(true), p), false, 'one more waiting');
  assert.match(l.notes.at(-1)[1], /waiting for Save/);
  l.downloads.get(0).saved = true;
  l.downloads.get(1).failed = 'cancelled';
  assert.equal(l.may(item(true), p), true);
});

test('a tab behind is refused without a word in the status line of the one on show', () => {
  const l = limiter();
  const shown = page();
  const behind = page('https://behind.example/');
  l.show(shown);
  assert.equal(l.may(item(), behind), true);
  assert.equal(l.may(item(), behind), false);
  assert.equal(l.notes.length, 0);
});
