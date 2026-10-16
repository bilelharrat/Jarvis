// Eden Code's cost forecast in the window (web/features/code-forecast.js): its words at the
// end of the status line under the composer (the composer untouched), its tooltip, each in
// Chinese; the to-do cards' plan tags and the Run dialog's summary (code-todo.js); and the
// first-run card that proposes a daily cap (code-usage.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const web = new URL('../../src/jarvis/web/', import.meta.url);
const read = (f) => readFileSync(new URL(f, web), 'utf8');
const cf = require('../../src/jarvis/web/features/code-forecast.js');
const todo = require('../../src/jarvis/web/features/code-todo.js');
const usage = require('../../src/jarvis/web/features/code-usage.js');

// The window's Chinese, as web/i18n.js looks it up (strings, then patterns, in file order).
const files = ['i18n-zh.json', ...readdirSync(new URL('i18n/', web)).filter((f) => f.endsWith('.json')).sort().map((f) => `i18n/${f}`)];
const strings = {};
const patterns = [];
for (const f of files) {
  const data = JSON.parse(read(f));
  Object.assign(strings, data.strings || {});
  for (const [p, r] of data.patterns || []) patterns.push([new RegExp(p), r]);
}
function zh(text) {
  const key = String(text).replace(/\s+/g, ' ').trim();
  if (key in strings) return strings[key];
  const found = patterns.find(([re]) => re.test(key));
  return found ? key.replace(found[0], found[1]) : String(text);
}

const F5 = { n: 9, low: 0.2, mid: 0.35, high: 0.6, scope: 'project', confidence: 'good',
  windows: { five_hour: { low: 0.03, mid: 0.04, high: 0.06 }, seven_day: { low: 0.002, mid: 0.003, high: 0.004 } },
  now: { five_hour: { used: 0.41, resets: 0 }, seven_day: { used: 0.2, resets: 0 } } };

test('the forecast’s words: a cost range, and the 5-hour share when it’s known', () => {
  assert.equal(cf.money(0.345), '$0.35');
  assert.equal(cf.money(20), '$20');
  assert.equal(cf.costRange(0.2, 0.6), '$0.20–$0.60');
  assert.equal(cf.costRange(0.2, 0.2), '$0.20');
  assert.equal(cf.shareRange(0.03, 0.06), '3–6%');
  assert.equal(cf.shareRange(0.001, 0.004), '<1%');
  assert.equal(cf.shareRange(0.002, 0.03), '<1–3%');
  assert.equal(cf.lineText(F5), '≈ $0.20–$0.60 · 3–6% of the 5-hour limit');
  assert.equal(cf.lineText({ ...F5, windows: {} }), '≈ $0.20–$0.60');
  assert.equal(cf.lineText({ n: 0 }), '');
  assert.equal(cf.lineText(null), '');
});

test('it warns when the message may not fit what’s left of the 5-hour limit', () => {
  assert.equal(cf.mayNotFit(F5), false);
  assert.equal(cf.mayNotFit({ ...F5, now: { five_hour: { used: 0.92 } } }), true);
  assert.equal(cf.mayNotFit({ ...F5, now: { five_hour: { used: null } } }), false);
  assert.equal(cf.mayNotFit({ n: 3, low: 1, high: 2 }), false);  // (no rate known yet)
  const said = cf.detail({ ...F5, now: { five_hour: { used: 0.92 } } });
  assert.ok(said.includes('It may not fit what’s left of the 5-hour limit.'));
  assert.equal(said.at(-1), 'A forecast from statistics: no model is asked.');
});

test('every sentence of the forecast has its Chinese, the numbers kept', () => {
  const cases = [
    F5,
    { ...F5, scope: 'all', confidence: 'rough' },
    { ...F5, scope: 'recent', now: {} },
    { ...F5, windows: {}, now: { five_hour: { used: 0.97 } } },
  ];
  for (const f of cases) {
    for (const sentence of [cf.lineText(f), ...cf.detail(f)].filter((x) => /[a-z]/i.test(x))) {
      const said = zh(sentence);
      assert.notEqual(said, sentence, sentence);
      assert.doesNotMatch(said, /\b(of|limit|messages|Likely|typically|From)\b/, said);
    }
  }
  assert.equal(zh(cf.lineText(F5)), '≈ $0.20–$0.60 · 占 5 小时额度的 3–6%');
  const settings = JSON.parse(read('i18n/code-forecast.json')).strings;
  const source = read('features/code-forecast.js');
  for (const m of source.matchAll(/\['code_[a-z_]+', '([^']+)', '([^']+)'\]/g)) {
    assert.ok(settings[m[1]] && settings[m[2]], m[1]);
  }
});

test('the forecast lives in the status line: the composer and the page’s markup are untouched', () => {
  const source = read('features/code-forecast.js');
  assert.doesNotMatch(source, /jc-composer|jc-composer-row|jc-composer-top/);
  assert.match(source, /\.jc-dock \.jc-statusline/);
  const html = read('index.html');
  assert.doesNotMatch(html, /cf-line/);
});

test('in the window: typing asks once a moment after, and the answer is drawn in the status line', async () => {
  const document = makeDocument();
  const dock = document.createElement('div');
  dock.className = 'jc-dock';
  const status = document.createElement('p');
  status.className = 'jc-statusline';
  const mode = document.createElement('span');
  mode.id = 'cc-mode';
  mode.textContent = 'Manual · ⇧⇥ to switch';
  status.append(mode);
  const input = document.createElement('textarea');
  input.id = 'deck-input';
  dock.append(input, status);
  document.body.append(dock);
  const sent = [];
  const handlers = {};
  let render = null;
  const F = {
    el: elFor(document), t: (x) => x, send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerComposerRender: (fn) => { render = fn; },
  };
  load(read('features/code-forecast.js'), { window: { jarvisFeatures: F }, document, deckProject: '/p/web', setTimeout, clearTimeout, MutationObserver: class { observe() {} } });
  render({ t: { id: 4 }, ref: 'sonnet' });
  input.value = 'fix the flaky login test';
  for (const fn of input.listeners.input) fn({});
  for (const fn of input.listeners.input) fn({});  // (two keys: one question)
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0], rid: '' }, { type: 'cf_forecast', rid: '', text: 'fix the flaky login test', model: 'sonnet', id: 4 });
  for (const fn of handlers.cf_forecast) fn({ rid: 'someone else’s', ...F5, low: 9 });
  assert.equal(document.getElementById('cf-line'), null);  // (another window's answer: not drawn)
  for (const fn of handlers.cf_forecast) fn({ rid: sent[0].rid, ...F5 });
  const line = document.getElementById('cf-line');
  assert.equal(line.parentNode, status);
  assert.ok(!line.hidden);
  assert.equal(line.querySelector('.cf-text').textContent, '≈ $0.20–$0.60 · 3–6% of the 5-hour limit');
  assert.match(line.title, /From 9 similar messages in this project\./);
  assert.equal(mode.textContent, 'Manual · ⇧⇥ to switch');  // (the status line's own words stay)
  // Turned off in Settings: hidden, and nothing more is asked.
  for (const fn of handlers.prefs) fn({ features: { code_forecast_show: false } });
  assert.ok(line.hidden);
  input.value = 'another one';
  for (const fn of input.listeners.input) fn({});
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sent.length, 1);
});

test('a waiting card’s plan tag, and the Run dialog’s summary', () => {
  assert.equal(todo.planTag({ action: 'now', reason: 'fits' }), 'Runs now');
  assert.equal(todo.planTag({ action: 'now', reason: 'no_data' }), 'In its turn');
  assert.equal(todo.planTag({ action: 'wait', reason: 'five' }), 'Waits for a reset');
  assert.equal(todo.planTag({ action: 'wait', reason: 'money' }), 'Waits for tomorrow');
  assert.equal(todo.planTag({ action: 'cheaper' }), 'Cheaper model');
  assert.equal(todo.planTag({ action: 'other' }), 'Other provider');
  assert.equal(todo.planTag({ action: 'overnight' }), 'Overnight');
  assert.equal(todo.planTag(null), '');
  const cards = [{ id: 'a', state: 'todo' }, { id: 'b', state: 'todo' }, { id: 'c', state: 'todo' }, { id: 'd', state: 'done' }];
  const plans = { a: { action: 'now', reason: 'fits' }, b: { action: 'wait', reason: 'five' }, c: { action: 'now', reason: 'fits' }, d: { action: 'now' } };
  assert.deepEqual(todo.planSummary(cards, plans), [['Runs now', 2], ['Waits for a reset', 1]]);
  for (const tag of ['Runs now', 'In its turn', 'Waits for a reset', 'Waits for tomorrow', 'Cheaper model', 'Other provider', 'Overnight']) {
    assert.notEqual(zh(tag), tag, tag);
  }
});

test('the first-run card shows until it’s answered, and never with a daily cap set', () => {
  const meter = { offer: { show: true, cap: 30 } };
  assert.equal(usage.offerShown(meter, {}), true);
  assert.equal(usage.offerShown(meter, { code_budget_offer: 'no' }), false);
  assert.equal(usage.offerShown(meter, { code_budget_offer: 'set' }), false);
  assert.equal(usage.offerShown(meter, { code_budget_day: 25 }), false);
  assert.equal(usage.offerShown({ offer: { show: false } }, {}), false);
  assert.equal(usage.offerShown(null, {}), false);
});

test('in the window: the first-run card sets the proposed cap, or goes for good with No thanks', () => {
  function window(answer) {
    const document = makeDocument();
    const welcome = document.createElement('div');
    welcome.id = 'cc-welcome';
    const hint = document.createElement('p');
    hint.className = 'jc-hint';
    welcome.append(hint);
    document.body.append(welcome);
    const sent = [];
    const handlers = {};
    const F = {
      el: elFor(document), t: (x) => x, send: (m) => { sent.push(m); return true; },
      on: (type, fn) => { (handlers[type] ||= []).push(fn); },
      registerPane() {}, registerMoreItem() {}, registerSlash() {}, openPane() {}, currentTask: () => null,
    };
    load(read('features/code-usage.js'), { window: { jarvisFeatures: F }, document, MutationObserver: class { observe() {} } });
    for (const fn of handlers.hello) fn({ prefs: { features: {} } });
    assert.deepEqual(sent.at(-1), { type: 'cu_state' });  // (asked for, for the card)
    for (const fn of handlers.cu_state) fn({ offer: { show: true, cap: 30 }, windows: [], recent: [] });
    const card = welcome.querySelector('.cu-offer');
    assert.ok(card, 'the card shows on the welcome screen');
    assert.equal(welcome.children.indexOf(card), 0);  // (before the hint)
    assert.equal(card.querySelector('input').value, '30');
    const button = card.querySelectorAll('button').find((b) => b.textContent === answer);
    for (const fn of button.listeners.click) fn({});
    assert.equal(welcome.querySelector('.cu-offer'), null);  // (gone at once)
    for (const fn of handlers.cu_state) fn({ offer: { show: true, cap: 30 }, windows: [], recent: [] });
    assert.equal(welcome.querySelector('.cu-offer'), null);  // (and stays gone: answered)
    return sent.filter((m) => m.type === 'feature_prefs').map((m) => m.changes);
  }
  assert.deepEqual(window('Set the limit'), [{ code_budget_day: 30, code_budget_offer: 'set' }]);
  assert.deepEqual(window('No thanks'), [{ code_budget_offer: 'no' }]);
});
