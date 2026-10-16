// Eden Code's productivity ledger pane (web/features/code-ledger.js; the backend is
// features/code_ledger.py): money as it reads, the review-minutes clock (only a review pane
// in front counts, a long gap doesn't), a week that cost more than it saved, the owner's
// two numbers, the exports, and the review time sent each minute. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const L = require('../../src/jarvis/web/features/code-ledger.js');
const source = readFileSync(new URL('../../src/jarvis/web/features/code-ledger.js', import.meta.url), 'utf8');

test('money', () => {
  assert.equal(L.money(5.5), '$5.50');
  assert.equal(L.money(-25.5), '−$25.50');
  assert.equal(L.money(null), '–');
});

test('the review clock counts a review pane in front, per pane, and not a sleep', () => {
  const c = L.reviewClock();
  c.tick(0, 'diff', true);
  c.tick(5000, 'diff', true);
  c.tick(10000, 'diff', true);
  c.tick(15000, 'terminal', true);  // (not a review pane: the time since goes nowhere)
  c.tick(20000, 'pr', true);
  c.tick(25000, 'pr', false);  // (the window went behind another)
  c.tick(30000, 'pr', true);
  c.tick(35000, 'pr', true);
  c.tick(600000, 'pr', true);  // (the Mac slept: 30 seconds at most)
  assert.deepEqual(c.take(), [{ pane: 'diff', seconds: 10 }, { pane: 'pr', seconds: 35 }]);
  assert.deepEqual(c.take(), []);
});

const LEDGER = {
  weeks: [
    { week: '2026-10-12', turns: 4, changes: 4, landed: 4, undone: 0, review_minutes: 0, cost_usd: 1, cost_per_landed: 0.25, wasted_usd: 0, routed: 0, value_usd: 40, net_usd: 39, verdict: 'paid_off' },
    { week: '2026-10-05', turns: 5, changes: 4, landed: 1, undone: 3, review_minutes: 30, cost_usd: 5.5, cost_per_landed: 5.5, wasted_usd: 4, routed: 2, routed_usd: 0.64, alternative_usd: 0.6, value_usd: 10, net_usd: -25.5, verdict: 'cost_more' },
  ],
  totals: { week: '', turns: 9, changes: 8, landed: 5, undone: 3, review_minutes: 30, cost_usd: 6.5, cost_per_landed: 1.3, wasted_usd: 4, routed: 2, routed_usd: 0.64, alternative_usd: 0.6, value_usd: 50, net_usd: 13.5, verdict: 'paid_off' },
  rate: 60, minutes: 10, on: true,
  verdicts: { paid_off: 'Paid off', cost_more: 'Cost more than it saved' },
};

function stand() {
  const document = makeDocument();
  document.visibilityState = 'visible';
  document.hasFocus = () => true;
  const el = elFor(document);
  const general = el('div');
  general.id = 'jcs-general';
  const pane = el('div');
  pane.id = 'jc-pane';
  const body = el('div');
  body.id = 'jc-pane-body';
  pane.append(body);
  document.body.append(general, pane);
  const handlers = {};
  const panes = new Map();
  const sent = [];
  const timers = [];
  const scope = { currentPane: 'cw-ledger', setInterval: (fn) => timers.push(fn) };
  const F = {
    el, t: (x) => x, $: (id) => document.getElementById(id),
    send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerPane: (id, p) => panes.set(id, p), registerMoreItem() {}, registerSlash() {},
    openPane() {}, currentTask: () => ({ id: 7 }),
  };
  Object.assign(scope, { window: { jarvisFeatures: F }, document });
  load(source, scope);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  return { document, body, fire, sent, panes, timers, scope };
}

const byText = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);

test('weeks with their verdicts, the numbers, and the exports', () => {
  const w = stand();
  w.panes.get('cw-ledger').render(w.body);
  assert.deepEqual(w.sent.map((m) => m.type), ['cw_ledger']);
  w.fire('cw_ledger', LEDGER);
  const weeks = w.body.querySelectorAll('.lg-week');
  assert.equal(weeks.length, 3);  // two weeks and all of them
  assert.ok(weeks[1].classList.contains('bad'));
  assert.match(weeks[1].textContent, /Cost more than it saved/);
  assert.match(weeks[1].textContent, /Net −\$25\.50/);
  assert.match(weeks[1].textContent, /Router’s alternative \(its estimate\) \$0\.60/);
  assert.match(weeks[0].textContent, /Paid off/);
  assert.match(weeks[2].textContent, /All weeks/);
  byText(w.body, 'Export spreadsheet').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cw_ledger_export', format: 'csv' });
  byText(w.body, 'Export page').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cw_ledger_export', format: 'md' });
  w.fire('cw_ledger_export', { ok: true, path: '/Docs/Eden Code ledger 2026-10-16.md', name: 'Eden Code ledger 2026-10-16.md' });
  byText(w.body, 'Show in Finder').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cw_export_reveal', path: '/Docs/Eden Code ledger 2026-10-16.md' });
});

test('the owner’s two numbers, in the pane and in settings', () => {
  const w = stand();
  w.fire('prefs', { features: { code_ledger_rate: 60, code_ledger_minutes: 0 } });
  const inSettings = w.document.getElementById('jcs-ledger').querySelectorAll('input');
  assert.equal(inSettings[0].value, '60');
  assert.equal(inSettings[1].value, '');
  inSettings[1].value = '12';
  inSettings[1].dispatchEvent(w.document.event('change'));
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_ledger_minutes: 12 } });
  w.panes.get('cw-ledger').render(w.body);
  w.fire('cw_ledger', { ...LEDGER, rate: 0, minutes: 0, weeks: [] });
  assert.match(w.body.textContent, /no week is called a win/);
  assert.match(w.body.textContent, /Nothing counted yet/);
});

test('review minutes go to the backend each minute while a review pane is in front', () => {
  const w = stand();
  const [tick] = w.timers;
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    w.scope.currentPane = 'diff';
    for (let i = 0; i < 14; i += 1) { now += 5000; tick(); }
    const sent = () => w.sent.filter((m) => m.type === 'cw_review_time');
    // The first minute went at once; the rest waits for the next minute...
    assert.equal(sent().length, 1);
    assert.deepEqual(sent()[0], { type: 'cw_review_time', pane: 'diff', seconds: 55, id: 7 });
    // ... or for the review pane to close.
    w.scope.currentPane = 'terminal';
    now += 5000;
    tick();
    assert.deepEqual(sent().map((m) => m.seconds), [55, 10]);
  } finally {
    Date.now = real;
  }
});
