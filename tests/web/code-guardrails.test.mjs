// The owner's rules, enforced (web/features/code-guardrails.js): the Permissions pane's
// Guardrails section's words, its place in code-rules.js's pane, the receipt's guardrails line
// (code-receipts.js), and every string shown has its Chinese. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const gr = require('../../src/jarvis/web/features/code-guardrails.js');
const { guardsLine } = require('../../src/jarvis/web/features/code-receipts.js');
const read = (path) => readFileSync(new URL(`../../src/jarvis/web/${path}`, import.meta.url), 'utf8');

test('a guardrail says where it is from and what it checks', () => {
  assert.equal(gr.sourceLabel('lesson'), 'Your lesson');
  assert.equal(gr.sourceLabel('suggested'), 'Confirmed suggestion');
  assert.equal(gr.sourceLabel('AGENTS.md'), 'AGENTS.md');  // (a file's name as it is)
  assert.equal(gr.kindLabel('deny'), 'Blocks');
  assert.equal(gr.kindLabel('nonsense'), 'Checks edits');
  assert.equal(gr.enforcedLine({ enforced: ['deny Bash(npm)', 'tests only with pnpm vitest'] }), 'deny Bash(npm) · tests only with pnpm vitest');
  assert.equal(gr.enforcedLine(null), '');
});

test('the section counts what holds, what is off and what stays as words', () => {
  assert.equal(gr.summary(null), '');
  assert.equal(gr.summary({ guardrails: [{ on: true }], prose_count: 0 }), '1 guardrail');
  assert.equal(gr.summary({ guardrails: [{ on: true }, { on: false }], prose_count: 3 }), '2 guardrails · 1 off · 3 rules stay as words');
  assert.equal(gr.summary({ guardrails: [], prose_count: 1 }), '0 guardrails · 1 rule stays as words');
});

test('the receipt says which guardrails fired, and how often', () => {
  assert.equal(guardsLine(undefined), null);
  assert.equal(guardsLine([]), null);
  assert.deepEqual(guardsLine([{ action: 'blocked', count: 2 }, { action: 'asked', count: 1 }]), ['rc-guard', 'Guardrails: 2 blocked, 1 asked']);
  assert.deepEqual(guardsLine([{ action: 'flagged' }, { action: 'blocked', count: 1 }]), ['rc-guard rc-flag', 'Guardrails: 1 blocked, 1 flagged']);
  assert.equal(guardsLine([{ action: 'weird', count: 3 }]), null);
});

test('the section sits in the Permissions pane, after the project’s own rules', () => {
  const rules = read('features/code-rules.js');
  assert.match(rules, /for \(const section of root\.jarvisRulesSections \|\| \[\]\)/);
  assert.match(rules, /root\.jarvisRulesRedraw = redraw;/);
  const source = read('features/code-guardrails.js');
  assert.match(source, /\(root\.jarvisRulesSections = root\.jarvisRulesSections \|\| \[\]\)\.push\(section\)/);
  // (the composer is the owner's as it is: nothing here touches it)
  assert.doesNotMatch(source + read('features/code-guardrails.css'), /jc-composer|jc-dock/);
});

test('every string the Guardrails section and the receipt show has its Chinese', () => {
  const zh = (name) => JSON.parse(read(`i18n/${name}.json`));
  const mine = zh('code-guardrails');
  const receipts = zh('code-receipts');
  const source = read('features/code-guardrails.js');
  const shown = [...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]);
  const extra = [...Object.values(gr.SOURCES), ...Object.values(gr.KINDS), gr.LABEL, gr.NOTE, 'This guardrail',
    'Suggesting…', 'Suggest a guardrail', 'One model call: a check for this rule, shown here first'];
  assert.deepEqual([...shown, ...extra].filter((s) => !(s in mine.strings)), []);
  const matches = (text) => mine.patterns.some(([re]) => new RegExp(re).test(text));
  for (const s of [{ guardrails: [{}], prose_count: 0 }, { guardrails: [{}, { on: false }], prose_count: 2 }, { guardrails: [{}, {}], prose_count: 1 }]) {
    assert.ok(matches(gr.summary(s)), gr.summary(s));
  }
  assert.ok(matches('3 rules stay as words') && matches('1 rule stays as words'));
  for (const s of ['Guardrails', 'blocked', 'asked', 'flagged']) assert.ok(s in receipts.strings, s);
  assert.ok(receipts.patterns.some(([re]) => new RegExp(re).test('Guardrails: 2 blocked, 1 asked')));
});
