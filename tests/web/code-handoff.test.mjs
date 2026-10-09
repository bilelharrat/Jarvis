// Eden Code hand-off, its window helpers (web/features/code-handoff.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ch = require('../../src/jarvis/web/features/code-handoff.js');

test('a hand-off says how it is doing, a dropped connection first', () => {
  assert.equal(ch.stateWord({ state: 'working' }), 'Working');
  assert.equal(ch.stateWord({ state: 'idle' }), 'Waiting for you');
  assert.equal(ch.stateWord({ state: 'working', lost: true }), 'Reconnecting…');
  assert.equal(ch.stateWord({ state: 'stopped', lost: true }), 'Stopped');
  assert.equal(ch.stateWord({ state: 'something new' }), 'Ended');
  assert.equal(ch.stateWord(null), '');
  assert.ok(ch.isLive({ state: 'idle' }) && !ch.isLive({ state: 'ended' }) && !ch.isLive(null));
});

test('the cost reads as dollars, never negative', () => {
  assert.equal(ch.fmtCost(0.256), '$0.26');
  assert.equal(ch.fmtCost(-1), '$0.00');
  assert.equal(ch.fmtCost('junk'), '$0.00');
});

test('a session finds its hand-off by number', () => {
  const list = [{ task_id: 3, alias: 'studio' }, { task_id: 0, alias: 'old' }];
  assert.equal(ch.handoffFor(list, 3).alias, 'studio');
  assert.equal(ch.handoffFor(list, 0), null);
  assert.equal(ch.handoffFor(undefined, 3), null);
});

test('a machine says whether it is ready and how it asks', () => {
  assert.equal(ch.machineStatus({ alias: 'a', checked: 0 }).word, 'Not checked yet');
  assert.equal(ch.machineStatus({ checked: 1, ok: false, problem: 'a isn’t reachable right now.' }).word, 'a isn’t reachable right now.');
  const ready = ch.machineStatus({ checked: 1, ok: true, permissions: true, tmux: true, claude_version: '2.1.0 (Claude Code)' });
  assert.deepEqual(ready, { word: 'Ready: asks you here', facts: 'Claude Code 2.1.0 · tmux' });
  assert.equal(ch.machineStatus({ checked: 1, ok: true }).word, 'Ready: Accept edits only');
});

test('every word it shows has Chinese', () => {
  const web = new URL('../../src/jarvis/web/', import.meta.url);
  const zh = { strings: {}, patterns: [] };
  const files = [new URL('i18n-zh.json', web), ...readdirSync(new URL('i18n/', web)).map((f) => new URL(`i18n/${f}`, web))];
  for (const file of files) {
    const data = JSON.parse(readFileSync(file));
    Object.assign(zh.strings, data.strings || {});
    zh.patterns.push(...(data.patterns || []));
  }
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-handoff.js', import.meta.url), 'utf8');
  const shown = [...source.matchAll(/'([A-Z][^'\n]*[a-z…][^'\n]*)'/g)].map((m) => m[1])
    .filter((s) => !/^(code_|jch|jcs|Claude Code \$)/.test(s));
  const patterns = zh.patterns.map(([p]) => new RegExp(p));
  const missing = shown.filter((s) => !(s in zh.strings) && !patterns.some((p) => p.test(s)));
  assert.deepEqual(missing, []);
  for (const word of Object.values(ch.STATE_WORDS)) assert.ok(word in zh.strings, word);
  for (const sample of ['On studio', 'Bring back from studio', 'Stop on studio']) assert.ok(patterns.some((p) => p.test(sample)), sample);
});
