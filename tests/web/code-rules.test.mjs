// Permission rules, the Permissions pane's helpers (web/features/code-rules.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cr = require('../../src/jarvis/web/features/code-rules.js');

test('a rule’s badge says what it is about', () => {
  assert.equal(cr.ruleKind('WebFetch(domain:example.com)'), 'web');
  assert.equal(cr.ruleKind('WebFetch'), 'web');
  assert.equal(cr.ruleKind('mcp__github'), 'mcp');
  assert.equal(cr.ruleKind('mcp__github__create_issue'), 'mcp');
  assert.equal(cr.ruleKind('Read(src/**)'), 'files');
  assert.equal(cr.ruleKind('Edit(//etc/hosts)'), 'files');
  assert.equal(cr.ruleKind('Bash(git push:*)'), 'command');
  assert.equal(cr.ruleKind('Bash'), 'command');
  assert.equal(cr.ruleKind('Read'), 'tool');  // (the whole tool)
  assert.equal(cr.ruleKind('TodoWrite'), 'tool');
  assert.equal(cr.ruleKind('not a rule ('), 'tool');
});

test('the rules in a project’s .claude files, as rows, deny first', () => {
  const rows = cr.claudeRows({
    'settings.json': { allow: ['Bash(npm test:*)'], deny: ['Read(.env)'] },
    'settings.local.json': { ask: ['Bash(git push:*)'] },
  });
  assert.deepEqual(rows, [
    ['settings.json', 'deny', 'Read(.env)'],
    ['settings.json', 'allow', 'Bash(npm test:*)'],
    ['settings.local.json', 'ask', 'Bash(git push:*)'],
  ]);
  assert.deepEqual(cr.claudeRows(null), []);
  assert.equal(cr.count({ deny: ['a'], allow: ['b', 'c'] }), 3);
  assert.equal(cr.count(undefined), 0);
});

test('every string the Permissions pane shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-rules.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-rules.js', import.meta.url), 'utf8');
  // (What's marked as data, mine(el(…)), is shown as it is: rules, names, examples.)
  const shown = [...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]);
  const extra = ['Deny', 'Ask first', 'Allow', 'Never, in any mode.', 'A card every time, even in Bypass.', 'Without asking.',
    'Web', 'MCP', 'Files', 'Command', 'Tool', 'Remove this rule', 'What the rule does', 'A rule, in Claude Code’s syntax',
    'Export to settings.local.json', 'Export to settings.json', 'Press again to write settings.local.json',
    'Press again to write settings.json (shared with the project)', 'Permissions',
    'Adds these rules to .claude/settings.local.json, keeping what’s there', 'Adds these rules to .claude/settings.json, keeping what’s there'];
  assert.deepEqual([...shown, ...extra].filter((s) => !(s in zh.strings)), []);
  for (const [re] of zh.patterns) assert.doesNotThrow(() => new RegExp(re));
});
