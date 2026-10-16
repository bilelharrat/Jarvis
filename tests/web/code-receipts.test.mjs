// A turn's proof card (web/features/code-receipts.js): its tests line. A run that exited
// fine but said no counts reads "Tests ran", and no line ever says "(0)". node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { testsLine } = require('../../src/jarvis/web/features/code-receipts.js');

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
