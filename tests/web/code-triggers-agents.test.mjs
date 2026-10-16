// Eden Code settings › Eden's agents in Linear (web/features/code-triggers-agents.js): the
// presets (Eden · Opus on the picker's Opus, Eden · Exterminator), the form's rows from what's
// saved, and what Save sends (names trimmed, empty rows left out, the label its name unless
// it says otherwise). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ag = require('../../src/jarvis/web/features/code-triggers-agents.js');

const MODELS = [{ ref: 'anthropic:sonnet', label: 'Sonnet 5.5' }, { ref: 'anthropic:opus', label: 'Opus 5.5' }];

test('the presets name the agent and pick the strongest model the picker has', () => {
  assert.deepEqual(ag.preset('code', MODELS), { id: '', name: 'Eden · Opus', label: '', kind: 'code', model: 'anthropic:opus' });
  assert.equal(ag.preset('exterminator', MODELS).name, 'Eden · Exterminator');
  assert.equal(ag.preset('code', []).model, '');  // (the project's model)
  assert.equal(ag.preset('code', [{ ref: 'x:opus', label: 'Opus 5.5', needs_key: true }]).model, '');  // (no key: not chosen)
});

test('the form starts from what’s saved, and Save sends it cleaned', () => {
  const drafts = ag.draftsFrom({ agents: [{ id: 'opus', name: 'Eden · Opus', label: 'Eden · Opus', kind: 'code', model: 'm' }] });
  assert.deepEqual(drafts, [{ id: 'opus', name: 'Eden · Opus', label: '', kind: 'code', model: 'm' }]);
  assert.deepEqual(ag.draftsFrom(null), []);
  const msg = ag.message([...drafts, { name: '  ', kind: 'code' }, { name: ' Bug hunter ', label: 'bugs', kind: 'exterminator' }], 1);
  assert.equal(msg.type, 'code_linear_agents_set');
  assert.equal(msg.questions, true);
  assert.deepEqual(msg.agents.map((a) => [a.name, a.label, a.kind]), [['Eden · Opus', 'Eden · Opus', 'code'], ['Bug hunter', 'bugs', 'exterminator']]);
});

test('the steps cover both ways, and every one is translated', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-triggers-agents.json', import.meta.url), 'utf8'));
  for (const step of [...ag.STEPS.app, ...ag.STEPS.label]) assert.ok(zh.strings[step], step);
  for (const [, label] of ag.KINDS) assert.ok(zh.strings[label], label);
  assert.match(ag.STEPS.app.join(' '), /actor=app/);
  assert.match(ag.STEPS.app.join(' '), /app:assignable and app:mentionable/);
});
