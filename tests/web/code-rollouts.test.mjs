// Rollouts, the window's helpers (web/features/code-rollouts.js): what a watch's card says
// about its state, deploy, errors and time left, which watches offer a fix or a revert,
// and the order they're listed in. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ro = require('../../src/jarvis/web/features/code-rollouts.js');

const broken = { id: 'ro-1', state: 'watching', merged_at: 100, reasons: [{ text: 'x', strong: true }], acted: '' };

test('a regression not acted on says so and offers a fix and a revert, whatever its window', () => {
  assert.equal(ro.stateLabel(broken), 'Looks broken');
  assert.equal(ro.stateTone(broken), 'bad');
  assert.ok(ro.offers(broken));
  const ended = { ...broken, state: 'regressed' };
  assert.ok(ro.offers(ended) && ro.stateLabel(ended) === 'Looks broken');
  for (const acted of ['fix', 'revert', 'dismissed']) assert.ok(!ro.offers({ ...broken, acted }), acted);
  assert.equal(ro.stateLabel({ ...broken, acted: 'fix' }), 'Watching');
  assert.ok(!ro.offers({ ...broken, state: 'stopped' }));
  assert.equal(ro.stateLabel({ state: 'healthy', reasons: [] }), 'Looked healthy');
  assert.equal(ro.stateTone({ state: 'healthy', reasons: [] }), 'good');
});

test('the deploy, the errors and the time left in words', () => {
  assert.equal(ro.deployLine({ state: 'success', environment: 'production' }), 'Deployed (production)');
  assert.equal(ro.deployLine({ state: 'failure', environment: 'production' }), 'The deployment failed (production)');
  assert.equal(ro.deployLine({ state: 'none' }), 'No deployment seen');
  assert.equal(ro.deployLine(null), 'No deployment seen');
  assert.equal(ro.rateLine({ issues: 2, events: 14, per_hour: 7 }), '14 events in 2 issues since the merge, about 7 an hour');
  assert.equal(ro.rateLine({ issues: 1, events: 1, per_hour: 6 }), '1 event in 1 issue since the merge, about 6 an hour');
  assert.equal(ro.rateLine({ issues: 0 }), '');
  assert.equal(ro.timeLeft({ state: 'watching', ends: 1000 + 18 * 60 }, 1000), '18 min left');
  assert.equal(ro.timeLeft({ state: 'watching', ends: 1000 }, 1000), 'Ending now');
  assert.equal(ro.timeLeft({ state: 'healthy', ends: 99999 }, 1000), '');
});

test('where a trace meets the change, and the addresses typed', () => {
  assert.equal(ro.hitWhere({ file: 'src/a.py', line: 3, function: 'charge' }), 'src/a.py:3 (charge)');
  assert.equal(ro.hitWhere({ file: 'src/a.py' }), 'src/a.py');
  assert.equal(ro.hitWhere(null), '');
  assert.deepEqual(ro.listOf('https://a.example.com/h, https://b.example.com/h\nhttp://localhost:3000'), [
    'https://a.example.com/h', 'https://b.example.com/h', 'http://localhost:3000']);
  assert.equal(ro.listOf('a b c d e f g').length, 5);
});

test('a regression is listed first, then what is still watched, then the newest', () => {
  const healthyNew = { id: 'a', state: 'healthy', merged_at: 300, reasons: [] };
  const watching = { id: 'b', state: 'watching', merged_at: 50, reasons: [] };
  const healthyOld = { id: 'c', state: 'healthy', merged_at: 10, reasons: [] };
  assert.deepEqual(ro.ordered([healthyOld, healthyNew, watching, broken]).map((w) => w.id), ['ro-1', 'b', 'a', 'c']);
});

test('its words are in Chinese, and none of them says something else in another dictionary', () => {
  const web = new URL('../../src/jarvis/web/', import.meta.url);
  const mine = JSON.parse(readFileSync(new URL('i18n/code-rollouts.json', web), 'utf8')).strings;
  for (const word of ['Looks broken', 'Looked healthy', 'Open a fix session', 'Prepare a revert PR', 'Rollouts', 'Watching after a merge']) {
    assert.ok(mine[word], word);
  }
  const base = JSON.parse(readFileSync(new URL('i18n-zh.json', web), 'utf8')).strings || {};
  for (const [k, v] of Object.entries(mine)) if (k in base) assert.equal(base[k], v, k);
});
