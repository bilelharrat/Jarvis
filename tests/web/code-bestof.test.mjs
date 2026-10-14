// Best of N's window helpers (web/features/code_bestof.js): the model menu mixing models,
// other agents and the Model Router's pick; what Start sends; a merged hunk's line.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const bo = require('../../src/jarvis/web/features/code_bestof.js');

test('the model menu offers the models, the other agents and the router’s pick', () => {
  const models = [{ ref: 'sonnet', label: 'Sonnet 5.5' }];
  assert.deepEqual(bo.modelOptions(models, [{ id: 'codex', name: 'Codex' }], true), [
    ['sonnet', 'Sonnet 5.5'], ['acp:codex', 'Codex (agent)'], [bo.ROUTER, 'Model Router’s pick'],
  ]);
  assert.deepEqual(bo.modelOptions(models, null, false), [['sonnet', 'Sonnet 5.5']]);
});

test('Start sends the router’s pick as a routed model, and an agent without an effort', () => {
  const asked = [];
  const pick = (prompt) => { asked.push(prompt); return { ref: 'haiku', effort: 'low' }; };
  const variants = [{ model: bo.ROUTER, effort: 'max' }, { model: 'acp:codex', effort: 'high' }, { model: 'opus', effort: 'high' }];
  assert.deepEqual(bo.variantsToSend(variants, 'fix it', pick), [true, [
    { model: 'haiku', effort: 'low', routed: true }, { model: 'acp:codex' }, { model: 'opus', effort: 'high' },
  ]]);
  assert.deepEqual(asked, ['fix it']);
  const [ok, why] = bo.variantsToSend([{ model: bo.ROUTER }], 'x', () => null);
  assert.equal(ok, false);
  assert.match(why, /Model Router isn’t ready yet/);
  assert.equal(bo.variantsToSend([{ model: bo.ROUTER }], 'x', undefined)[0], false);
});

test('a merged hunk says where it is, which attempt it came from and why', () => {
  assert.equal(
    bo.hunkLine({ file: 'a.py', line: 3, where: 'add', label: 'Sonnet 5.5', added: 1, removed: 1, why: 'Clearer.' }),
    'a.py line 3 in add: from Sonnet 5.5 (+1 −1). Clearer.',
  );
  assert.equal(bo.hunkLine({ file: 'n.txt', line: 1, where: '', label: 'Codex', added: 2, removed: 0, why: '' }), 'n.txt line 1: from Codex (+2 −0)');
});

test('the merge’s strings have their Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code_bestof.json', import.meta.url), 'utf8'));
  const wanted = ['Merge best parts', 'Merge again', 'Merging…', 'Couldn’t merge.', 'Review in Changes', 'Keep the merge',
    'Model Router’s pick', 'Model Router isn’t ready yet. Try again in a moment, or pick a model.',
    'Done: pick the one to keep, or merge the best parts.', 'Merged: review it, then keep it or pick one above.', 'Merged changes'];
  assert.deepEqual(wanted.filter((s) => !(s in zh.strings)), []);
  assert.ok(zh.patterns.some(([re]) => new RegExp(re).test('Left out (3)')));
});
