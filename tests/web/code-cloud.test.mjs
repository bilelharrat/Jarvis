// Eden Code in the cloud (web/features/code-cloud.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { tip } = require('../../src/jarvis/web/features/code-cloud.js');

test('the switch says where sessions go, or why it cannot', () => {
  assert.match(tip(null), /Add a cloud machine/);
  assert.match(tip({ machine: 'jarvis-cloud', ready: false, problem: 'claude is not signed in' }), /isn't ready: claude is not signed in/);
  assert.equal(tip({ machine: 'jarvis-cloud', ready: true }), 'Runs on jarvis-cloud: it keeps working while your Mac sleeps or is shut.');
});

test('the switch: pressed only while the machine can take it; why is a note, not just a tooltip', () => {
  const { view } = require('../../src/jarvis/web/features/code-cloud.js');
  const ready = { machine: 'jarvis-cloud', ready: true };
  const notReady = { machine: 'jarvis-cloud', ready: false, problem: 'claude is not signed in' };
  assert.deepEqual(view(ready, true, true), { hidden: false, usable: true, pressed: true, note: '' });
  const v = view(notReady, true, true);
  assert.equal(v.pressed, false);  // (not sent while it can't run there)…
  assert.match(v.note, /isn't ready: claude is not signed in/);  // …and said beside the switch
  assert.equal(view(null, false, true).hidden, true);  // no machine: no switch
  assert.equal(view(ready, true, false).hidden, true);  // a session open: no switch
});

// The feature in a stand-in window: the switch's choice outlasts a start that failed, and
// goes once the session is open.
test('the switch keeps "on" until a session starts, through a failed start', async () => {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const source = fs.readFileSync(new URL('../../src/jarvis/web/features/code-cloud.js', import.meta.url), 'utf8');
  const node = () => {
    const n = {
      attrs: {}, classes: new Set(), hidden: false, isConnected: false, listeners: {}, textContent: '', title: '',
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      classList: { toggle: (c, on) => (on ? n.classes.add(c) : n.classes.delete(c)) },
      addEventListener(type, fn) { this.listeners[type] = fn; }, append() {}, after(x) { x.isConnected = true; },
      click() { this.listeners.click && this.listeners.click(); },
    };
    return n;
  };
  const handlers = {};
  const made = [];
  let option = null;
  let current = null;
  const F = {
    el: () => { const n = node(); made.push(n); return n; }, send: () => true, t: (s) => s, currentTask: () => current,
    registerSessionOption: (fn) => { option = fn; }, registerSlash() {},
    on: (type, fn) => { handlers[type] = fn; },
  };
  const row = { insertBefore: (n) => { n.isConnected = true; }, querySelector: () => null };
  const document = { querySelector: () => row, getElementById: () => null };
  vm.runInNewContext(source, { window: { jarvisFeatures: F }, document, deckProject: 'shop', MutationObserver: class { observe() {} } });
  const [button, , note] = made;  // (the switch, its label, then its note)
  handlers.code_cloud({ machine: 'jarvis-cloud', ready: true });
  assert.deepEqual({ ...option() }, {});  // off: nothing asked
  button.click();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-describedby'), 'jcx-cloud-note');
  assert.deepEqual({ ...option() }, { cloud: true, isolated: true });
  handlers.tasks();  // the start failed: still the start screen, still on
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  // The machine not ready for a moment: not pressed, the note says why, and it's remembered.
  handlers.code_cloud({ machine: 'jarvis-cloud', ready: false, problem: 'offline' });
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /offline/);
  assert.deepEqual({ ...option() }, {});
  handlers.code_cloud({ machine: 'jarvis-cloud', ready: true });
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual({ ...option() }, { cloud: true, isolated: true });
  current = { id: 3 };  // the session started: the switch goes off for the next one
  handlers.tasks();
  current = null;
  handlers.tasks();
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});
