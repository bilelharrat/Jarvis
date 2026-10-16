// Eden Code's engine radar pane (web/features/code-radar.js; the backend is
// features/code_radar.py and code_engines.py): how its numbers read, the way back to the
// engine before an update, a shift's card with its buttons, the engines with their pins,
// its settings, and the Health pane's line (code-health.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const R = require('../../src/jarvis/web/features/code-radar.js');
const H = require('../../src/jarvis/web/features/code-health.js');
const source = readFileSync(new URL('../../src/jarvis/web/features/code-radar.js', import.meta.url), 'utf8');

test('numbers as the pane shows them', () => {
  assert.equal(R.shown('share', 0.194), '19%');
  assert.equal(R.shown('cost', 1.5), '$1.50');
  assert.equal(R.shown('mean', 4.25), '4.3');
  assert.equal(R.shown('share', null), '–');
});

const SHIFT = {
  key: '|claude-opus|2.1.277/claude-opus-5-5>2.1.294/claude-opus-5-5', scope: '', family: 'claude-opus',
  change: 'engine', status: 'shift',
  before: { engine: '2.1.277', model: 'claude-opus-5-5', turns: 60 },
  after: { engine: '2.1.294', model: 'claude-opus-5-5', turns: 60 },
  rows: [
    { metric: 'read_ratio', label: 'Reads per edit', kind: 'mean', before: 5, after: 1, p: 0.0001, enough: true, significant: true, worse: true },
    { metric: 'tests', label: 'Test runs that passed', kind: 'share', before: 0.9, after: 0.88, p: 0.7, enough: true, significant: false, worse: true },
  ],
};
const ENGINES = {
  current: { version: '2.1.294', path: '/sdk/_bundled/claude', pinned: false, bundled: true },
  pin: null,
  candidates: [
    { path: '/sdk/_bundled/claude', version: '2.1.294', source: 'built-in', current: true, usable: true },
    { path: '/data/claude_engines/2.1.277/claude', version: '2.1.277', source: 'kept', current: false, usable: true },
    { path: '/old/claude', version: '1.0.1', source: 'installed', current: false, usable: false },
  ],
  limits: ['Eden Code can go back only to an engine it kept a copy of.'],
};

test('what changed, the way back, and the Health pane’s words', () => {
  assert.equal(R.changeTitle(SHIFT), 'Claude Code 2.1.277 → 2.1.294');
  assert.equal(R.changeTitle({ ...SHIFT, change: 'model', before: { model: 'a' }, after: { model: 'b' } }), 'a → b');
  assert.equal(R.wayBack(SHIFT, ENGINES.candidates).path, '/data/claude_engines/2.1.277/claude');
  assert.equal(R.wayBack({ ...SHIFT, change: 'model' }, ENGINES.candidates), null);
  assert.equal(R.wayBack(SHIFT, ENGINES.candidates.slice(0, 1)), null);
  for (const [r, words] of [
    [{ status: 'shift', shifts: 1 }, 'Worse after an update'], [{ status: 'shift', shifts: 2 }, 'Worse after updates'],
    [{ status: 'collecting' }, 'Watching the latest update'], [{ status: 'steady' }, 'No change after updates'],
    [{ status: 'empty' }, 'Nothing measured yet'], [{ status: 'steady', on: false }, 'Off'],
  ]) {
    assert.equal(R.healthWords(r), words);
    assert.equal(H.radarWords(r), words);  // (the two panes say it the same way)
  }
});

function stand() {
  const document = makeDocument();
  const el = elFor(document);
  const general = el('div');
  general.id = 'jcs-general';
  const close = el('button');
  close.id = 'jcs-close';
  const pane = el('div');
  pane.id = 'jc-pane';
  const body = el('div');
  body.id = 'jc-pane-body';
  pane.append(body);
  document.body.append(general, close, pane);
  const handlers = {};
  const panes = new Map();
  const sent = [];
  const opened = [];
  const scope = { currentPane: 'cw-radar' };
  const F = {
    el, t: (x) => x, $: (id) => document.getElementById(id),
    send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerPane: (id, p) => panes.set(id, p), registerMoreItem() {}, registerSlash() {},
    openPane: (id) => opened.push(id),
  };
  Object.assign(scope, { window: { jarvisFeatures: F }, document });
  load(source, scope);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  return { document, body, fire, sent, panes, opened };
}

const byText = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);

test('a shift’s card: its numbers, going back, pinning, dismissing', () => {
  const w = stand();
  w.panes.get('cw-radar').render(w.body);
  assert.deepEqual(w.sent.map((m) => m.type), ['cw_radar', 'cw_engines']);
  w.fire('cw_engines', ENGINES);
  w.fire('cw_radar', { turns: 120, changes: [SHIFT], breakdown: { '': [] }, projects: [], names: {}, dismissed: [], on: true });
  const card = w.body.querySelector('.rd-change');
  assert.ok(card.classList.contains('shift'));
  assert.match(card.textContent, /Claude Code 2\.1\.277 → 2\.1\.294/);
  const worse = card.querySelectorAll('tr.rd-worse');
  assert.equal(worse.length, 1);
  assert.match(worse[0].textContent, /Reads per edit5\.01\.0Yes/);
  byText(card, 'Use the engine before').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cw_engine_pin', path: '/data/claude_engines/2.1.277/claude' });
  byText(card, 'Pin this version').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cw_engine_pin', path: '/sdk/_bundled/claude' });
  byText(card, 'Dismiss').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cw_radar_dismiss', key: SHIFT.key });
  // Dismissed: out of sight until asked for.
  w.fire('cw_radar', { turns: 120, changes: [SHIFT], breakdown: { '': [] }, projects: [], names: {}, dismissed: [SHIFT.key], on: true });
  assert.equal(w.body.querySelector('.rd-change'), null);
  byText(w.body, 'Show dismissed').click();
  assert.ok(w.body.querySelector('.rd-change.dismissed'));
});

test('no copy of the engine before: it says how to get one', () => {
  const w = stand();
  w.panes.get('cw-radar').render(w.body);
  w.fire('cw_engines', { ...ENGINES, candidates: ENGINES.candidates.slice(0, 1) });
  w.fire('cw_radar', { turns: 120, changes: [SHIFT], breakdown: { '': [] }, projects: [], names: {}, dismissed: [], on: true });
  assert.equal(byText(w.body, 'Use the engine before'), undefined);
  assert.match(w.body.textContent, /no copy of the engine before this update/);
});

test('the engines: use one, a path of my own, back to the built-in one', () => {
  const w = stand();
  w.panes.get('cw-radar').render(w.body);
  w.fire('cw_radar', { turns: 0, changes: [], breakdown: { '': [] }, projects: [], names: {}, dismissed: [], on: true });
  w.fire('cw_engines', ENGINES);
  const rows = w.body.querySelectorAll('li.rd-engine');
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Running/);
  assert.match(rows[2].textContent, /Too old/);
  byText(rows[1], 'Use this').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cw_engine_pin', path: '/data/claude_engines/2.1.277/claude' });
  const form = w.body.querySelector('form.rd-own');
  form.querySelector('input').value = '  /Users/me/.local/share/claude/versions/2.1.270 ';
  form.dispatchEvent(w.document.event('submit'));
  assert.deepEqual(w.sent.at(-1), { type: 'cw_engine_pin', path: '/Users/me/.local/share/claude/versions/2.1.270' });
  assert.match(w.body.textContent, /Nothing measured yet/);
  w.fire('cw_engines', { ...ENGINES, current: { version: '2.1.277', path: '/x/claude', pinned: true } });
  byText(w.body, 'Use the built-in engine').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cw_engine_unpin' });
});

test('its settings: three switches and the engine, which opens the pane', () => {
  const w = stand();
  const group = w.document.getElementById('jcs-radar');
  assert.ok(group);
  w.fire('prefs', { features: { code_radar_on: true, code_radar_alerts: false, code_engine_pin: { path: '/x/claude', version: '2.1.277' } } });
  assert.equal(w.document.getElementById('jcx-radar-on').getAttribute('aria-checked'), 'true');
  assert.equal(w.document.getElementById('jcx-radar-alerts').getAttribute('aria-checked'), 'false');
  assert.equal(w.document.getElementById('jcx-engine-keep').getAttribute('aria-checked'), 'true');
  assert.match(group.textContent, /Pinned: 2\.1\.277/);
  w.document.getElementById('jcx-radar-alerts').click();
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_radar_alerts: true } });
  byText(group, 'Choose…').click();
  assert.deepEqual(w.opened, ['cw-radar']);
});

// Every word the radar's and the ledger's window scripts show has its Chinese, in some
// dictionary the window merges (as code-workspace.test.mjs checks the workspace's).
test('every word the radar and the ledger show has its Chinese', async () => {
  const { readdirSync } = await import('node:fs');
  const web = new URL('../../src/jarvis/web/', import.meta.url);
  const files = ['i18n-zh.json', ...readdirSync(new URL('i18n/', web)).filter((n) => n.endsWith('.json')).map((n) => `i18n/${n}`)];
  const strings = {};
  for (const name of files) Object.assign(strings, JSON.parse(readFileSync(new URL(name, web), 'utf8')).strings || {});
  const q = "'((?:[^'\\\\]|\\\\.)+)'";
  const forms = [
    new RegExp(`\\bel\\('[\\w-]+', '[^']*', ${q}\\)`, 'g'),
    new RegExp(`\\bbutton\\(${q}`, 'g'),
    new RegExp(`(?:^|[^\\w.])t\\(${q}\\)`, 'g'),
    new RegExp(`\\b(?:label|note|help|title): ${q}`, 'g'),
    new RegExp(`, ${q}\\)`, 'g'),
    new RegExp(`switchRow\\('[\\w-]+', ${q}, ${q}`, 'g'),
    new RegExp(`fact\\(${q}`, 'g'),
    new RegExp(`\\['code_ledger_\\w+', ${q}, ${q}`, 'g'),
  ];
  const missing = [];
  let total = 0;
  for (const name of ['code-radar.js', 'code-ledger.js']) {
    const text = readFileSync(new URL(`features/${name}`, web), 'utf8');
    const found = new Set();
    for (const re of forms) for (const m of text.matchAll(re)) { found.add(m[1]); if (m[2]) found.add(m[2]); }
    for (const m of text.matchAll(/\b(?:shift|steady|collecting): '([^']+)'/g)) found.add(m[1]);
    for (const m of text.matchAll(/for \(const h of \[([^\]]+)\]\)/g)) for (const w of m[1].matchAll(/'([^']+)'/g)) found.add(w[1]);
    const words = [...found].filter((s) => /\p{L}/u.test(s) && (/\s/.test(s) || /^\p{Lu}/u.test(s)) && !/^[a-z]+(?:-[a-z]+)+(?: [a-z-]+)*$/.test(s));
    missing.push(...words.filter((w) => !(w.replace(/\s+/g, ' ').trim() in strings)).map((w) => `${name}: ${w}`));
    total += words.length;
  }
  assert.ok(total > 80, `found only ${total}`);
  assert.deepEqual(missing, []);
});
