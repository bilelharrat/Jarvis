// Share live's roles, co-control and internet links in the window (web/features/code_share.js)
// and the viewer pages' shared drawing (web/share-view.js, the same file askeden.com serves).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const pane = require('../../src/jarvis/web/features/code_share.js');
const view = require('../../src/jarvis/web/share-view.js');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('a driver’s request is said by who sent it, and only a plain message can be sent as is', () => {
  assert.equal(pane.requestText({ kind: 'message', name: 'Sam', text: 'run the tests' }), 'Sam asks to send: run the tests');
  assert.equal(pane.requestText({ kind: 'approve', name: 'Sam', label: 'Allow', question: 'Allow Bash: npm test?' }), 'Sam suggests “Allow” on: Allow Bash: npm test?');
  assert.ok(pane.sendable({ kind: 'message', text: 'add a test' }));
  for (const text of ['!rm -rf build', '  /bypass', '/clear']) assert.equal(pane.sendable({ kind: 'message', text }), false, text);
  assert.equal(pane.sendable({ kind: 'approve' }), false, 'an answer goes through the window’s own answer');
  assert.deepEqual(pane.ROLES.map(([r]) => r), ['viewer', 'commenter', 'driver']);  // = code_teams.SHARE_ROLES
  assert.equal(pane.roleText(''), 'No access');
  assert.equal(pane.logText({ who: 'Sam', role: 'driver', action: 'sent', via: 'internet' }), 'Sam (driver) had a message sent by you, through askeden.com');
});

test('an answer for a driver goes through the window’s own answer, never a command of its own', () => {
  const source = read('../../src/jarvis/web/features/code_share.js');
  assert.match(source, /F\.answerApproval\(r\.card, r\.choice\)/);
  assert.doesNotMatch(source, /type: 'approve'/);
  // and the window's answer says whether it was answered (Touch ID can say no)
  assert.match(read('../../src/jarvis/web/app.js'), /if \(check\) return check\.then\(\(ok\) => \{ if \(ok\) go\(\); return Boolean\(ok\); \}\);/);
});

test('the viewer pages share one drawing, the same file on the Mac and on askeden.com', () => {
  assert.equal(read('../../src/jarvis/web/share-view.js'), read('../../site/public/live/share-view.js'));
  assert.equal(read('../../src/jarvis/web/share.css'), read('../../site/public/live/share.css'));
  for (const f of ['../../src/jarvis/web/share-view.js', '../../src/jarvis/web/share.js', '../../site/public/live/live.js']) {
    assert.doesNotMatch(read(f), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
  }
  assert.equal(view.seatText('Sam', 'driver'), 'Sam · driver: can ask for messages and answers');
  assert.equal(view.seatText('', 'nonsense'), 'watching');
  assert.match(read('../../src/jarvis/web/share.html'), /<script src="\/share-view\.js" defer><\/script>\s*<script src="\/share\.js" defer>/);
});

test('every new string the Share pane shows has its Chinese', () => {
  const zh = JSON.parse(read('../../src/jarvis/web/i18n/code_share.json'));
  for (const [, label] of pane.ROLES) assert.ok(zh.strings[label], label);
  for (const s of ['Viewer', 'Commenter', 'Driver', 'No access', 'Personal links', 'Team', 'Send as yours', 'Answer as suggested']) assert.ok(zh.strings[s], s);
  const said = (text) => zh.patterns.some(([re]) => new RegExp(re).test(text));
  assert.ok(said('Invite the team: Core') && said('Sam asks to send: hi') && said('Request from Sam'));
});
