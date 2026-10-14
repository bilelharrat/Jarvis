// One Chinese for each English text across the window's dictionaries (round 2, U4). The
// server merges i18n-zh.json and every web/i18n/*.json into one dictionary, in name order,
// a later file's string winning (server.py zh_strings): two files giving one English text two
// Chinese meant only the last was ever shown, everywhere — code_bugfix's 已停下 beat the 已停止
// of the board, the tests and the lanes, its 待做 beat the to-do lane's 待办, and the finding
// status "Open" came out 打开 (memory.json) and the step "Fix" 修改 (conversation.json).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const web = new URL('../../src/jarvis/web/', import.meta.url);
const files = ['i18n-zh.json', ...readdirSync(new URL('i18n/', web)).filter((n) => n.endsWith('.json')).sort().map((n) => `i18n/${n}`)];
const strings = (name) => JSON.parse(readFileSync(new URL(name, web), 'utf8')).strings || {};

function merged() {
  const out = {};
  for (const name of files) Object.assign(out, strings(name));
  return out;
}

test('no English text has two different Chinese in two dictionaries', () => {
  const seen = new Map();  // English -> [file, Chinese]
  const clashes = [];
  for (const name of files) {
    for (const [en, zh] of Object.entries(strings(name))) {
      const first = seen.get(en);
      if (!first) seen.set(en, [name, zh]);
      else if (first[1] !== zh) clashes.push(`${JSON.stringify(en)}: ${first[0]} ${first[1]} / ${name} ${zh}`);
    }
  }
  assert.deepEqual(clashes, [], 'give the word one Chinese everywhere, or a key of its own (see code_bugfix.js own())');
});

test('the words the audit found: Stopped is 已停止, To do 待办, Exterminator’s own Open/Fix/Now under their own keys', () => {
  const zh = merged();
  assert.equal(zh.Stopped, '已停止');
  assert.equal(zh['To do'], '待办');
  assert.equal(zh['Exterminator Mode · Open'], '未处理');
  assert.equal(zh['Exterminator Mode · Fix'], '修复');
  assert.equal(zh['Exterminator Mode · Now'], '进行中');
  for (const key of ['Stopped: spending cap', 'Stopped: time cap', 'Stopped: no isolated copy']) assert.match(zh[key], /^已停止：/, key);
});

test('Exterminator Mode in Chinese: a finding still open says 未处理, the step R1 修复', () => {
  const zh = merged();
  const document = makeDocument();
  const body = document.createElement('div');
  document.body.append(body);
  const panes = new Map();
  const handlers = {};
  const F = {
    el: elFor(document), t: (x) => zh[x] ?? x, send: () => true,
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerPane: (id, pane) => panes.set(id, pane), registerMoreItem() {}, selectTask() {},
    currentTask: () => ({ id: 7, kind: 'code', folder: 'api', title: 'x' }),
  };
  load(readFileSync(new URL('features/code_bugfix.js', web), 'utf8'), { window: { jarvisFeatures: F }, document, deckProject: 'api', ccTasks: [] });
  panes.get('bugfix').render(body);
  const run = { id: 'r1', project: 'api', state: 'running', round: 1, step: 'fix', spent: 1, spend_cap: 10, folder: '/f', slug: 's',
    findings: [{ id: 'B1-1', severity: 'high', title: 'Crash', status: 'open', where: 'a.py:3', lane: 'sweep' }] };
  for (const fn of handlers.code_bugfix) fn({ runs: [run], active: {} });
  const chips = body.querySelectorAll('.jcx-chip').map((c) => c.textContent);
  assert.ok(chips.includes('未处理'), chips.join(','));
  const steps = body.querySelectorAll('.jcx-bf-step');
  const current = steps.find((s) => s.getAttribute('aria-current') === 'step');
  assert.equal(current.textContent, 'R1 修复');
  assert.equal(current.title, '进行中');
});
