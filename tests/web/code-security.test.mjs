// Eden Code settings › Security scanning (web/features/code-security.js): each tool's row,
// installed or with how to install it. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { rows, LABEL } = require('../../src/jarvis/web/features/code-security.js');

test('each tool is a row: its name, what it checks, installed or how to install it', () => {
  assert.deepEqual(rows([
    { id: 'semgrep', label: 'Semgrep', what: 'static analysis of the changed code', installed: false, install: 'brew install semgrep' },
    { id: 'npm-audit', label: 'npm audit', what: 'known vulnerabilities in npm packages', installed: true, install: 'comes with Node.js' },
  ]), [
    ['Semgrep', 'static analysis of the changed code', false, 'brew install semgrep'],
    ['npm audit', 'known vulnerabilities in npm packages', true, 'comes with Node.js'],
  ]);
  assert.deepEqual(rows(null), []);
  assert.deepEqual(rows([{ id: 'x' }]), [['x', '', false, '']]);
  assert.equal(LABEL, 'Scan changes with my security tools');
});
