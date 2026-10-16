// Eden Code's Spec mode (web/features/code-spec.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { summary, spoken, tip, words, moreItem, canStart } = require('../../src/jarvis/web/features/code-spec.js');

test('a receipt counts the requirements met', () => {
  assert.deepEqual(summary([{ status: 'met' }, { status: 'unmet' }, { status: 'met' }]), { met: 2, total: 3 });
  assert.deepEqual(summary(null), { met: 0, total: 0 });
});

test('a requirement reads aloud with its evidence', () => {
  assert.equal(
    spoken({ id: 'R1', title: 'Sign in', status: 'met', evidence: ['R1.1: test_r1_1 passed'] }),
    'R1 Sign in: met. R1.1: test_r1_1 passed',
  );
  assert.equal(spoken({ id: 'R2', status: 'unchecked', evidence: [] }), 'R2: not checked');
  assert.equal(words.partly, 'Partly met');
});

test('the switch says what Spec mode does', () => {
  assert.match(tip(true), /asks you after each/);
  assert.match(tip(false), /checked against them/);
});

// Spec mode out of Labs (2026-10-16): its switch is in the toolbar's More menu, shown only
// before a session starts in a project; nothing it or the other graduated features add goes
// in the composer (the owner wants .jc-composer and its children as they are).
test('the switch is a More menu item, only where a session is about to start', () => {
  assert.deepEqual(moreItem(false), { label: 'Spec mode', note: 'Requirements, design and tasks first', switch: false });
  assert.equal(moreItem(true).switch, true);
  assert.match(moreItem(true).note, /next session/);
  assert.equal(canStart(null, 'app'), true);
  assert.equal(canStart({ id: 1 }, 'app'), false);
  assert.equal(canStart(null, ''), false);
});

test('Spec mode, Plugins and the first-run tips add nothing to the composer', () => {
  for (const name of ['code-spec.js', 'code-plugins.js', 'code-getstarted.js']) {
    const src = readFileSync(new URL(`../../src/jarvis/web/features/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /#deck-composer|jc-composer|jc-dock|registerComposerRender/, name);
  }
});
