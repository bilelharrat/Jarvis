// The code canvas's cloud runner (src/eden/run.js): what a run may carry, its limits, the
// run-minutes a month by plan, and the door (this site's page, signed in, POST only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_LIMITS, RUN_MINUTES, addRun, checkRun, mayRun, runAllowance, runApi, runCharge, runMinutesLeft } from '../src/eden/run.js';
import { RUNNER_CSP } from '../src/eden/web.js';

const NOW = Date.parse('2026-10-07T12:00:00Z');

test('a run names a language the runner has, carries some code, and stays under the size caps', () => {
  assert.deepEqual(checkRun({ lang: 'go', code: 'package main' }), { lang: 'go', code: 'package main', stdin: '' });
  for (const lang of ['typescript', 'bash', 'go', 'rust', 'c', 'cpp', 'java', 'ruby', 'php']) assert.equal(checkRun({ lang, code: 'x' }).lang, lang);
  const refuse = (body, code) => assert.throws(() => checkRun(body), (e) => e.code === code, JSON.stringify(body).slice(0, 60));
  refuse(null, 'bad_request');
  refuse({ lang: 'cobol', code: 'x' }, 'bad_language');
  refuse({ lang: 'go', code: '  \n ' }, 'no_code');
  refuse({ lang: 'go', code: 7 }, 'no_code');
  refuse({ lang: 'go', code: 'x', stdin: 5 }, 'bad_request');
  refuse({ lang: 'go', code: 'x'.repeat(RUN_LIMITS.codeBytes + 1) }, 'too_big');
  refuse({ lang: 'go', code: 'é'.repeat(RUN_LIMITS.codeBytes / 2 + 1) }, 'too_big'); // bytes, not characters
  refuse({ lang: 'go', code: 'x', stdin: 'y'.repeat(RUN_LIMITS.stdinBytes + 1) }, 'too_big');
  assert.equal(RUN_LIMITS.timeMs, 30_000);
  assert.ok(RUN_LIMITS.memoryMb > 0 && RUN_LIMITS.memoryMb <= 1024);
});

test('run-minutes: Free 30 and Plus 300 a month, settable, charged by whole seconds', () => {
  assert.deepEqual(RUN_MINUTES, { free: 30, plus: 300 });
  assert.equal(runAllowance({}, false), 30);
  assert.equal(runAllowance({}, true), 300);
  assert.equal(runAllowance({ RUN_MINUTES_FREE: '5', RUN_MINUTES_PLUS: '50' }, false), 5);
  assert.equal(runAllowance({ RUN_MINUTES_FREE: 'lots' }, false), 30, 'nonsense keeps the default');
  assert.equal(runCharge(0), 1000, 'a run costs at least a second');
  assert.equal(runCharge(1001), 2000);
  assert.equal(runCharge(10 * 60_000), RUN_LIMITS.timeMs, 'never more than the time limit');
  let u = addRun(null, 1500, NOW);
  assert.deepEqual(u, { month: '2026-10', ms: 2000, runs: 1 });
  u = addRun(u, 29_999, NOW);
  assert.deepEqual(u, { month: '2026-10', ms: 32_000, runs: 2 });
  assert.deepEqual(addRun(u, 500, Date.parse('2026-11-01T00:00:01Z')), { month: '2026-11', ms: 1000, runs: 1 }, 'a new month starts at 0');
});

test('a run starts only with a whole run’s time left', () => {
  const limit = 30;
  assert.equal(runMinutesLeft(null, limit, NOW), 30);
  assert.equal(mayRun(null, limit, NOW), true);
  const almost = { month: '2026-10', ms: limit * 60_000 - RUN_LIMITS.timeMs };
  assert.equal(mayRun(almost, limit, NOW), true);
  assert.equal(mayRun({ ...almost, ms: almost.ms + 1 }, limit, NOW), false);
  assert.equal(runMinutesLeft({ month: '2026-10', ms: 99 * 60_000 }, limit, NOW), 0);
  assert.equal(mayRun({ month: '2026-09', ms: 99 * 60_000 }, limit, NOW), true, 'last month’s use doesn’t count');
});

test('the door: POST from this site only, signed in', async () => {
  const req = (init = {}) => new Request('https://askeden.com/api/chat/run', { method: 'POST', body: '{}', ...init });
  assert.equal((await runApi(new Request('https://askeden.com/api/chat/run'), {})).status, 405);
  assert.equal((await runApi(req({ headers: { origin: 'https://evil.com' } }), {})).status, 403);
  assert.equal((await runApi(req(), {})).status, 403, 'no Origin: not a page of this site');
  const r = await runApi(req({ headers: { origin: 'https://askeden.com' } }), { ACCOUNTS: {} });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'signed_out');
});

test('the in-browser runner page is a sandbox with no network but Pyodide’s CDN', () => {
  assert.match(RUNNER_CSP, /^sandbox allow-scripts;/);
  assert.doesNotMatch(RUNNER_CSP, /allow-same-origin|connect-src[^;]*'self'/);
  assert.match(RUNNER_CSP, /connect-src https:\/\/cdn\.jsdelivr\.net;/);
});
