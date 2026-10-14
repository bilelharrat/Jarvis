// Crash reports (audit O1): the app's side (app/features/crash-reports.js) starts Electron's
// crash reporter only when the owner turned reports on, never to upload, and writes down a
// window or helper process that goes away; the window's side (web/features/crash-reports.js)
// turns an error into a report and sends the same one once, a few a minute. node --test tests/web/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const app = require('../../app/features/crash-reports.js');
const web = require('../../src/jarvis/web/features/crash-reports.js');

function dataDir(features) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-crash-'));
  if (features) fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ features }));
  return dir;
}

function fakeElectron() {
  const seen = { started: [], paths: {}, on: {} };
  return {
    seen,
    electron: {
      app: { setPath: (k, v) => { seen.paths[k] = v; }, on: (ev, fn) => { seen.on[ev] = fn; } },
      crashReporter: { start: (opts) => seen.started.push(opts) },
    },
  };
}

test('off unless the owner turned crash reports on', () => {
  for (const features of [null, {}, { crash_reports: false }, { crash_reports: 'yes' }]) {
    const { seen, electron } = fakeElectron();
    assert.equal(app.install({ dataDir: dataDir(features) }, { electron }), false);
    assert.deepEqual(seen.started, []);
  }
  const broken = dataDir();
  fs.writeFileSync(path.join(broken, 'prefs.json'), '{not json');
  assert.equal(app.wanted(broken, fs), false);
});

test('on: Electron keeps its minidumps here and uploads nothing; a renderer gone is written down', () => {
  const dir = dataDir({ crash_reports: true });
  const { seen, electron } = fakeElectron();
  assert.equal(app.install({ dataDir: dir }, { electron }), true);
  assert.deepEqual(seen.started, [{ uploadToServer: false, compress: true }]);
  assert.equal(seen.paths.crashDumps, path.join(dir, 'crash-reports', 'electron'));
  seen.on['render-process-gone']({}, { getURL: () => 'https://secret.example/page' }, { reason: 'crashed', exitCode: 11 });
  seen.on['child-process-gone']({}, { type: 'GPU', reason: 'oom', exitCode: 3 });
  seen.on['child-process-gone']({}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 });  // not a crash
  const files = fs.readdirSync(path.join(dir, 'crash-reports')).filter((f) => f.endsWith('.json')).sort();
  assert.equal(files.length, 2);
  const reports = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'crash-reports', f), 'utf8')));
  assert.deepEqual(reports.map((r) => [r.source, r.kind, r.message]).sort(), [
    ['electron', 'GPU process gone', 'oom (exit code 3)'],
    ['electron', 'renderer gone', 'crashed (exit code 11)'],
  ]);
  assert.ok(!JSON.stringify(reports).includes('secret.example'), 'never the page’s address');
  const mode = fs.statSync(path.join(dir, 'crash-reports', files[0])).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('a report from the app keeps only Electron’s own words, and only the newest are kept', () => {
  const r = app.reportFor('child', { type: '<img src=x>', reason: 'whatever the page said', exitCode: 'x' });
  assert.equal(r.kind, 'helper process gone');
  assert.equal(r.message, 'unknown');
  const folder = path.join(dataDir(), 'crash-reports');
  for (let i = 0; i < app.KEEP + 3; i += 1) app.keep(fs, folder, app.reportFor('renderer', { reason: 'crashed' }), new Date(Date.UTC(2026, 9, 13, 9, 0, i)));
  assert.equal(fs.readdirSync(folder).length, app.KEEP);
});

test('a window error as the backend takes it; the same one is sent once, a few a minute', () => {
  const err = new TypeError('x is undefined');
  const r = web.reportOf('window error', err, '', 'app.js:10:2');
  assert.equal(r.type, 'crash_report');
  assert.equal(r.kind, 'window error: TypeError');
  assert.equal(r.message, 'x is undefined');
  assert.match(r.stack, /TypeError/);
  assert.equal(web.reportOf('unhandled rejection', 'just words').message, 'just words');
  assert.equal(web.reportOf('unhandled rejection', undefined).message, 'Unknown error');
  let now = 0;
  const may = web.limiter(() => now);
  assert.equal(may(r), true);
  assert.equal(may(r), false, 'the same again');
  let sent = 1;
  for (let i = 0; i < 20; i += 1) if (may(web.reportOf('window error', null, `other ${i}`))) sent += 1;
  assert.equal(sent, web.PER_MINUTE);
  now = 61_000;
  assert.equal(may(web.reportOf('window error', null, 'later')), true);
});
