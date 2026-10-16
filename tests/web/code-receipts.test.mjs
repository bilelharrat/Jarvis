// A turn's proof card (web/features/code-receipts.js): its tests line. A run that exited
// fine but said no counts reads "Tests ran", and no line ever says "(0)". node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { testsLine, integrityLines } = require('../../src/jarvis/web/features/code-receipts.js');

test('the tests line: a count when the run said one, never "(0)"', () => {
  assert.deepEqual(testsLine(null), ['rc-none', 'No tests run', 0]);
  assert.deepEqual(testsLine({ passed: true, passed_count: 12, failed_count: 0 }), ['rc-ok', 'Tests passed', 12]);
  assert.deepEqual(testsLine({ passed: false, passed_count: 9, failed_count: 3 }), ['rc-bad', 'Tests failed', 3]);
  // Failed without a count it could read: failed, with no number.
  assert.deepEqual(testsLine({ passed: false, passed_count: 0, failed_count: 0 }), ['rc-bad', 'Tests failed', 0]);
  // Exited fine, no counts: unknown (the backend sends passed: null), not passed.
  assert.deepEqual(testsLine({ passed: null, passed_count: 0, failed_count: 0 }), ['rc-none', 'Tests ran (no result shown)', 0]);
});

test('the security line: findings with their count, clean, not scanned, or nothing', () => {
  const { securityLine } = require('../../src/jarvis/web/features/code-receipts.js');
  assert.equal(securityLine(null), null);
  assert.equal(securityLine({ ran: [], count: 0, missing: [] }), null);
  assert.deepEqual(securityLine({ ran: ['Semgrep'], count: 2, high: 1 }), ['rc-bad', 'Security findings', 2]);
  assert.deepEqual(securityLine({ ran: ['Semgrep'], count: 1, high: 0 }), ['rc-warn', 'Security findings', 1]);
  assert.deepEqual(securityLine({ ran: ['Semgrep', 'npm audit'], count: 0 }), ['rc-ok', 'Security scan clean', 0]);
  // No tool installed that would have checked it: said, dimly (the card lists how to install them).
  assert.deepEqual(securityLine({ ran: [], count: 0, missing: [{ id: 'semgrep' }] }), ['rc-none', 'Not security-scanned', 0]);
});

// Receipts accuracy (roadmap 1, 34): the card says "Tests passed" only for a real pass; a
// stopped, refused or out-of-date run says so; a weakened test turns the pass amber; and the
// integrity lines come through in their tone.
test('the tests line by state: never a pass that did not happen', () => {
  assert.deepEqual(testsLine({ state: 'passed', passed: true, passed_count: 7, failed_count: 0 }), ['rc-ok', 'Tests passed', 7]);
  assert.deepEqual(testsLine({ state: 'passed', passed: true, passed_count: 7, trusted: false }), ['rc-warn', 'Tests passed', 7]);
  // A "passed" with nothing to back it (no count, or passed not true) is not shown as one.
  assert.deepEqual(testsLine({ state: 'passed', passed: true, passed_count: 0 }), ['rc-none', 'Tests ran (no result shown)', 0]);
  assert.deepEqual(testsLine({ state: 'passed', passed: null, passed_count: 4 }), ['rc-none', 'Tests ran (no result shown)', 0]);
  assert.deepEqual(testsLine({ state: 'failed', passed: false, passed_count: 49, failed_count: 1, note: 'a later, narrower run passed' }), ['rc-bad', 'Tests failed', 1]);
  assert.deepEqual(testsLine({ state: 'cancelled', passed: null }), ['rc-warn', 'Tests didn\u2019t finish', 0]);
  assert.deepEqual(testsLine({ state: 'refused', passed: null }), ['rc-none', 'Tests not run (not allowed)', 0]);
  assert.deepEqual(testsLine({ state: 'stale', passed: null, passed_count: 8 }), ['rc-warn', 'Tests passed before its last edits', 8]);
  assert.deepEqual(testsLine({ state: 'unknown', passed: null }), ['rc-none', 'Tests ran (no result shown)', 0]);
});

test('the integrity lines keep their tone and their words', () => {
  assert.deepEqual(integrityLines({}), []);
  assert.deepEqual(integrityLines({ integrity: { lines: [
    { tone: 'bad', text: 'A test was weakened: 1 assertion taken out of tests/test_a.py' },
    { tone: 'ok', text: 'Tests constrain this change: 7 of 9 mutants caught' },
    { tone: 'odd', text: 'Mutation pass skipped: its tests failed' },
    { tone: 'ok', text: '' },
  ] } }), [
    ['rc-bad', 'A test was weakened: 1 assertion taken out of tests/test_a.py'],
    ['rc-ok', 'Tests constrain this change: 7 of 9 mutants caught'],
    ['rc-none', 'Mutation pass skipped: its tests failed'],
  ]);
});
