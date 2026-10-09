// Eden Code's usage meter, its window helpers (web/features/code-usage.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cu = require('../../src/jarvis/web/features/code-usage.js');

test('amounts read as the backend says them', () => {
  assert.equal(cu.fmtMoney(20), '$20');
  assert.equal(cu.fmtMoney(20.5), '$20.50');
  assert.equal(cu.fmtMoney(0.034), '$0.03');
  assert.equal(cu.fmtMoney(1500), '$1,500');
  assert.equal(cu.fmtMoney(-2), '$0');
  assert.equal(cu.fmtMoney('junk'), '$0');
});

test('a meter fills to its cap and warms up past half', () => {
  assert.equal(cu.percentOf(2, 0), null);
  assert.equal(cu.percentOf(2.5, 10), 25);
  assert.equal(cu.percentOf(30, 10), 100);
  assert.deepEqual([null, 10, 50, 79, 80, 100].map(cu.level), ['none', 'ok', 'warn', 'warn', 'high', 'full']);
});

test('a cap typed by the owner: an amount, no cap, the default, or not one', () => {
  assert.equal(cu.parseCap(''), null);
  assert.equal(cu.parseCap('  '), null);
  assert.equal(cu.parseCap('5'), 5);
  assert.equal(cu.parseCap('$12.50'), 12.5);
  assert.equal(cu.parseCap('1,200'), 1200);
  assert.equal(cu.parseCap('0'), 0);
  assert.equal(cu.parseCap('none'), 0);
  assert.equal(cu.parseCap('不限'), 0);
  assert.ok(Number.isNaN(cu.parseCap('lots')));
  assert.ok(Number.isNaN(cu.parseCap('-3')));
  assert.ok(Number.isNaN(cu.parseCap('1.234')));
  assert.ok(Number.isNaN(cu.parseCap('1000000')));
});

test('the chart’s bars are each day’s share of the busiest', () => {
  assert.deepEqual(cu.barHeights([{ total: 0 }, { total: 2 }, { total: 4 }]), [0, 50, 100]);
  assert.deepEqual(cu.barHeights([{ total: 0 }, { total: 0 }]), [0, 0]);
  assert.deepEqual(cu.barHeights([]), []);
});

test('a reset time: the time today, a weekday this week, a date after', () => {
  const now = new Date(2026, 8, 30, 10, 0).getTime();
  const at = (d, h) => new Date(2026, 8, d, h, 0).getTime() / 1000;
  assert.match(cu.resetText(at(30, 17), 'en-US', now), /^5:00\s?PM$/);
  assert.match(cu.resetText(at(2 + 30, 9), 'en-US', now), /^\w{3} 9:00\s?AM$/);
  assert.match(cu.resetText(at(30 + 12, 9), 'en-US', now), /^Oct 12$/);
  assert.equal(cu.resetText(0, 'en-US', now), '');
});

test('every string the meter shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-usage.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-usage.js', import.meta.url), 'utf8');
  // Literal window strings: el(tag, cls, 'Text') and a few labels passed through.
  const shown = [...source.matchAll(/el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]);
  const missing = shown.filter((s) => !(s in zh.strings));
  assert.deepEqual(missing, []);
  for (const [re] of zh.patterns) assert.doesNotThrow(() => new RegExp(re));
});
