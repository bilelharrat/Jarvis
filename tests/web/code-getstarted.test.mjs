// Eden Code's first-run cards and the Your context setting (web/features/code-getstarted.js):
// the phone page is offered once and only turned on by the owner's press; the tips cover what
// owners miss and stop at Got it; the life-context setting reads and sets its prefs.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const G = require('../../src/jarvis/web/features/code-getstarted.js');
const SOURCE = readFileSync(new URL('../../src/jarvis/web/features/code-getstarted.js', import.meta.url), 'utf8');

test('the phone page is offered until answered, and only a press turns it on', () => {
  assert.equal(G.cards({}, false).phone, true);
  assert.equal(G.cards({ code_phone_offered: true }, false).phone, false);
  assert.equal(G.cards({ code_phone_web: true }, false).phone, false);
  assert.deepEqual(G.phoneAnswer(true), { code_phone_web: true, code_phone_offered: true });
  assert.deepEqual(G.phoneAnswer(false), { code_phone_offered: true });  // (never the page itself)
  assert.equal(G.cards({}, true).tips, false);
});

test('the tips name every feature owners miss, and go round', () => {
  const all = G.TIPS.map(([what, where]) => `${what} ${where}`).join(' ');
  for (const word of [/proof card/, /Deep review/, /\$SECRET_/, /lesson/, /Changes pane/, /board/, /inbox/, /subagent/, /Best of N/, /voice/, /screen-reader/, /Spec mode/, /plugins/i]) {
    assert.match(all, word);
  }
  assert.equal(G.tipAt(G.TIPS.length), 0);
  assert.equal(G.tipAt('3'), 3);
  assert.equal(G.tipAt(null), 0);
  assert.equal(G.tipAt(-1), G.TIPS.length - 1);
});

function stand(features = {}) {
  const document = makeDocument();
  const welcome = document.createElement('div');
  welcome.id = 'cc-welcome';
  const past = document.createElement('div');
  past.id = 'cc-past-wrap';
  welcome.append(past);
  const general = document.createElement('div');
  general.id = 'jcs-general';
  const foot = document.createElement('p');
  foot.className = 'jcs-foot';
  general.append(foot);
  document.body.append(welcome, general);
  const sent = [];
  const handlers = {};
  const panes = [];
  const kept = {};
  const F = {
    el: elFor(document), $: (id) => document.getElementById(id), t: (x) => x,
    send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    openPane: (id) => panes.push(id),
  };
  const localStorage = { getItem: (k) => (k in kept ? kept[k] : null), setItem: (k, v) => { kept[k] = String(v); } };
  const window = { jarvisFeatures: F, document, localStorage };
  load(SOURCE, { window, document });
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  fire('hello', { prefs: { features } });
  const buttons = () => document.getElementById('gs-cards').querySelectorAll('button');
  const press = (label) => buttons().find((b) => b.textContent === label).click();
  return { document, sent, fire, panes, kept, buttons, press };
}

test('in the welcome: the phone offer and a tip; Turn on asks for the page and opens the Phone pane', () => {
  const w = stand();
  const box = w.document.getElementById('gs-cards');
  assert.ok(box.isConnected && !box.hidden);
  assert.match(box.textContent, /Carry on from your phone/);
  assert.match(box.textContent, /Good to know/);
  assert.deepEqual(w.sent, []);  // nothing turned on by showing it
  w.press('Turn on the phone page');
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_phone_web: true, code_phone_offered: true } });
  assert.deepEqual(w.panes, ['phone']);
});

test('Not now keeps the page off and stops asking; Next tip and Got it are the window’s own', () => {
  const w = stand();
  w.press('Not now');
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_phone_offered: true } });
  const box = w.document.getElementById('gs-cards');
  assert.doesNotMatch(box.textContent, /Carry on from your phone/);
  w.press('Next tip');
  assert.equal(w.kept['eden-code-tip-at'], '1');
  assert.match(box.textContent, new RegExp(`2 / ${G.TIPS.length}`));
  w.press('Got it');
  assert.equal(w.kept['eden-code-tips-done'], '1');
  assert.ok(box.hidden);
});

test('Your context: ask per project or never; forgetting the answers clears them', () => {
  const w = stand({ code_life_context_projects: { '/p': true } });
  const select = w.document.getElementById('gs-life');
  assert.equal(select.value, 'ask');
  w.fire('prefs', { features: { code_life_context: false } });
  assert.equal(select.value, 'off');
  select.value = 'ask';
  select.dispatchEvent(w.document.event('change'));
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_life_context: true } });
  const forget = w.document.getElementById('jcs-general').querySelectorAll('button').find((b) => /Forget/.test(b.textContent));
  assert.equal(forget.disabled, true);  // (no answers in the latest prefs)
  w.fire('prefs', { features: { code_life_context_projects: { '/p': false } } });
  forget.click();
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_life_context_projects: {} } });
});
