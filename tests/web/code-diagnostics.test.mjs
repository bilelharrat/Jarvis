// Eden Code's error cards (web/features/code-diagnostics.js, audit O2): which entries are
// errors, what Copy details puts on the clipboard (masked), and the two actions on a card in
// a stand-in window: Send diagnostics makes the ops diagnostics file and shows where it is.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cd = require('../../src/jarvis/web/features/code-diagnostics.js');
const SOURCE = readFileSync(new URL('../../src/jarvis/web/features/code-diagnostics.js', import.meta.url), 'utf8');

test('the error entries: the backend’s own, and the notes that say something failed', () => {
  assert.ok(cd.isError({ role: 'system', text: 'Stopped with an error: the CLI crashed', error: true }));
  assert.ok(cd.isError({ role: 'system', text: 'Couldn’t switch the model: gone' }));
  assert.ok(cd.isError({ role: 'system', text: "Couldn't fork from that message: it's too far back." }));
  assert.ok(!cd.isError({ role: 'system', text: 'Permission mode: Manual.' }));
  assert.ok(!cd.isError({ role: 'assistant', text: 'Couldn’t find the file, so I made it.' }), 'Claude’s words are not a card');
  assert.ok(!cd.isError(null));
});

test('Copy details: what went wrong and where, with names, emails and keys masked', () => {
  const text = cd.details(
    { text: 'Stopped with an error: token=abcd1234efgh for ann@example.com in /Users/ann/proj (sk-ant-api03-abcdefghijklmnopqrstu)', at: '2026-10-13T09:00:00' },
    { id: 4, title: 'Fix login', model_label: 'Opus', mode: 'edits', status: 'failed', cwd: '/Users/ann/proj' },
    'Eden Code 1.2.0',
  );
  assert.match(text, /^Eden Code error\nWhat happened: Stopped with an error/);
  assert.match(text, /Session: Fix login \(#4\)/);
  assert.match(text, /Model: Opus/);
  assert.match(text, /Folder: ~\/proj/);
  assert.match(text, /App: Eden Code 1\.2\.0/);
  for (const secret of ['ann@example.com', '/Users/ann', 'abcd1234efgh', 'sk-ant-api03']) assert.ok(!text.includes(secret), secret);
});

function stand() {
  const sent = [];
  const handlers = {};
  let decorate = null;
  const nodes = [];
  const node = (tag, cls = '', text = '') => {
    const n = {
      tag, className: cls, textContent: text, children: [], attrs: {}, disabled: false, title: '', listeners: {},
      classList: { add(c) { n.className += ` ${c}`; } },
      append(...k) { n.children.push(...k); }, prepend(...k) { n.children.unshift(...k); },
      replaceChildren(...k) { n.children = k; },
      setAttribute(k, v) { n.attrs[k] = v; }, addEventListener(t, fn) { n.listeners[t] = fn; },
      querySelector: (sel) => (sel === '.cd-actions' ? n.children.find((c) => c.className === 'cd-actions') || null : null),
      focus() { n.focused = true; },
    };
    nodes.push(n);
    return n;
  };
  const F = {
    el: node, t: (x) => x, send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerEntryDecorator: (fn) => { decorate = fn; },
    currentTask: () => ({ id: 4, title: 'Fix login', model: 'claude-opus-5-5', mode: 'ask' }),
  };
  const copied = [];
  const window = {
    jarvisFeatures: F,
    navigator: { userAgent: 'Mozilla/5.0 Eden Code/1.2.0', clipboard: { writeText: async (t) => { copied.push(t); } } },
    document: { body: { dataset: { app: 'eden-code' } }, querySelectorAll: () => [] },
  };
  const document = { createTextNode: (t) => ({ text: t }) };
  new Function('window', 'document', SOURCE.replace(/typeof window === 'object' \? window : globalThis/, 'window'))(window, document);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  return { sent, fire, decorate: (e, li) => decorate(e, li), node, copied };
}

test('an error entry gets Copy details and Send diagnostics; the file is made and shown', async () => {
  const w = stand();
  const li = w.node('li', 'jc-note');
  w.decorate({ role: 'system', text: 'Stopped with an error: boom', error: true, at: '2026-10-13T09:00:00' }, li);
  const box = li.children.find((c) => c.className === 'cd-actions');
  assert.ok(box, 'the actions are there');
  assert.equal(box.attrs.role, 'group');
  const [copy, send, status] = box.children;
  assert.equal(copy.textContent, 'Copy details');
  assert.equal(send.textContent, 'Send diagnostics');
  assert.equal(status.attrs['aria-live'], 'polite');
  await copy.listeners.click({ stopPropagation() {} });
  assert.match(w.copied[0], /What happened: Stopped with an error: boom/);
  assert.match(w.copied[0], /Session: Fix login \(#4\)/);
  send.listeners.click({ stopPropagation() {} });
  assert.deepEqual(w.sent, [{ type: 'ops_diagnostics', megabytes: 2 }]);
  assert.equal(send.disabled, true);
  send.listeners.click({ stopPropagation() {} });
  assert.equal(w.sent.length, 1, 'one file at a time');
  w.fire('ops_diagnostics', { ok: true, path: '/x/Jarvis diagnostics.zip', name: 'Jarvis diagnostics.zip' });
  assert.equal(send.disabled, false);
  const show = status.children.find((c) => c.textContent === 'Show in Finder');
  show.listeners.click({ stopPropagation() {} });
  assert.deepEqual(w.sent.at(-1), { type: 'ops_reveal', path: '/x/Jarvis diagnostics.zip' });
  // A plain note gets nothing; an entry decorated twice gets them once.
  const plain = w.node('li', 'jc-note');
  w.decorate({ role: 'system', text: 'Permission mode: Manual.' }, plain);
  assert.equal(plain.children.length, 0);
  w.decorate({ role: 'system', text: 'Stopped with an error: boom', error: true }, li);
  assert.equal(li.children.filter((c) => c.className === 'cd-actions').length, 1);
});

// Audit G7: Show in Finder takes the focus only from the page or the card's own button (not
// from the composer, where Enter would then open Finder); a backend that restarted while
// the file was being made never answers, so the buttons give up and say so; a second card
// pressed meanwhile says one is already being made, and hears its answer.
test('Send diagnostics: no focus stolen, no button stuck, a second press said', async () => {
  const { makeDocument, elFor, load } = await import('./fixtures/stand-dom.mjs');
  const document = makeDocument();
  const handlers = {};
  const sent = [];
  let decorate = null;
  const timers = [];
  const F = {
    el: elFor(document), t: (x) => x, send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerEntryDecorator: (fn) => { decorate = fn; },
    currentTask: () => null,
  };
  const window = { jarvisFeatures: F, document, navigator: { userAgent: 'Eden Code/1.2.0' } };
  load(SOURCE, { window, document, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {} });
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  const card = () => {
    const li = document.createElement('li');
    document.body.append(li);
    decorate({ role: 'system', text: 'Stopped with an error: boom', error: true }, li);
    const [, send, status] = li.querySelector('.cd-actions').children;
    return { send, status };
  };
  const composer = document.createElement('textarea');
  document.body.append(composer);
  const a = card();
  const b = card();
  a.send.focus();
  a.send.click();
  b.send.click();
  assert.equal(sent.length, 1, 'one file at a time');
  assert.match(b.status.textContent, /Already making one/);
  assert.equal(b.send.textContent, 'Making it…');
  composer.focus();  // the owner went back to typing
  fire('ops_diagnostics', { ok: true, path: '/x/d.zip' });
  assert.ok(document.activeElement === composer, 'the composer keeps the keys');
  assert.match(a.status.textContent, /Show in Finder/);
  assert.match(b.status.textContent, /Show in Finder/, 'the second card heard it too');
  // From the page itself, Show in Finder takes the focus.
  composer.blur();
  a.send.click();
  fire('ops_diagnostics', { ok: true, path: '/x/e.zip' });
  assert.equal(document.activeElement.textContent, 'Show in Finder');
  // The backend restarts midway: no answer will come.
  a.send.click();
  assert.equal(a.send.disabled, true);
  fire('hello', {});
  assert.equal(a.send.disabled, false);
  assert.equal(a.send.textContent, 'Send diagnostics');
  assert.match(a.status.textContent, /restarted/);
  // Or it just takes too long.
  a.send.click();
  timers.at(-1)();
  assert.equal(a.send.disabled, false);
  assert.match(a.status.textContent, /too long/);
});
