// Crash reports from the app itself (audit O1; the backend's side is features/crash_reports.py).
// Only while the owner has them on (prefs.json's features.crash_reports, Settings › Health ›
// Diagnostics; read as the app starts, so turning them on or off holds from the next launch):
// - Electron's crashReporter, started with uploadToServer false: its minidumps stay in
//   <data>/crash-reports/electron and go nowhere (a minidump is the process's memory, which
//   can't be masked: the diagnostics file lists them, names and sizes, and never takes one);
// - a window's renderer or a helper process that goes away (render-process-gone,
//   child-process-gone) is written down as a small JSON report in <data>/crash-reports,
//   which the backend scrubs again as it puts it in the diagnostics file.
// Nothing here sends anything anywhere. Pure parts are exported for node --test
// (tests/web/crash-reports.test.mjs).
'use strict';

const path = require('path');

const FOLDER = 'crash-reports';
const ELECTRON = 'electron';
const KEEP = 50; // = crash_reports.KEEP
const PER_HOUR = 20; // = crash_reports.PER_HOUR: reports kept in an hour, at most
const REPEAT_MS = 600 * 1000; // = crash_reports.REPEAT_SECONDS: the same again is counted
const REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']);

// Whether the owner turned crash reports on (prefs.json in the backend's data folder).
function wanted(dataDir, fs) {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, 'prefs.json'), 'utf8'));
    return Boolean(prefs && prefs.features && prefs.features.crash_reports === true);
  } catch {
    return false;
  }
}

// A process that went away, as a report: only Electron's own words for it (its reason, exit
// code and process type), never a page's address or title.
function reportFor(kind, details, now = new Date()) {
  const d = details || {};
  const reason = REASONS.has(d.reason) ? d.reason : 'unknown';
  const code = Number.isInteger(d.exitCode) ? d.exitCode : null;
  const type = /^[A-Za-z -]{1,40}$/.test(String(d.type || '')) ? String(d.type) : '';
  return {
    version: 1,
    source: 'electron',
    kind: kind === 'renderer' ? 'renderer gone' : `${type || 'helper'} process gone`,
    message: `${reason}${code === null ? '' : ` (exit code ${code})`}`,
    stack: '',
    where: kind === 'renderer' ? 'a window' : type,
    at: now.toISOString().slice(0, 19),
    times: 1,
  };
}

// Keep one: <folder>/<stamp>-electron-<n>.json, owner-only; the oldest go past KEEP. A clean
// exit isn't a crash and isn't kept. Its path, or '' when nothing was written.
function keep(fs, folder, report, now = new Date()) {
  if (!report || report.message.startsWith('clean-exit')) return '';
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let name = '';
    for (let n = 1; n < 100 && !name; n += 1) {
      const candidate = `${stamp}-electron-${String(n).padStart(2, '0')}.json`;
      if (!fs.existsSync(path.join(folder, candidate))) name = candidate;
    }
    if (!name) return '';
    const file = path.join(folder, name);
    fs.writeFileSync(file, JSON.stringify(report, null, 1), { mode: 0o600 });
    const all = fs.readdirSync(folder).filter((f) => f.endsWith('.json')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
      try { fs.unlinkSync(path.join(folder, old)); } catch { /* (gone already) */ }
    }
    return file;
  } catch {
    return '';
  }
}

// keep, for one run of the app: the same report again within REPEAT_MS is counted into the
// file kept for it (times), never a file of its own, and at most PER_HOUR are kept an hour.
// A window whose renderer dies as it loads is reloaded a second later (main.js): a report a
// second, which pruned every backend report from the folder within a minute (REL3-16).
function keeper(fs, folder, clock = () => new Date()) {
  let last = null; // { sig, file, at }
  let keptAt = []; // when each report this hour was kept (ms)
  return (report) => {
    if (!report || report.message.startsWith('clean-exit')) return '';
    const now = clock();
    const ms = now.getTime();
    const sig = `${report.kind}\n${report.message}\n${report.where}`;
    if (last && last.sig === sig && ms - last.at < REPEAT_MS) {
      try {
        const kept = JSON.parse(fs.readFileSync(last.file, 'utf8'));
        kept.times = Math.max(1, Number(kept.times) || 1) + 1;
        fs.writeFileSync(last.file, JSON.stringify(kept, null, 1), { mode: 0o600 });
        return last.file;
      } catch {
        last = null; // (deleted, by the owner or the pruning: kept afresh, as the backend does)
      }
    }
    keptAt = keptAt.filter((t) => ms - t < 3600 * 1000);
    if (keptAt.length >= PER_HOUR) return '';
    const file = keep(fs, folder, report, now);
    if (file) {
      keptAt.push(ms);
      last = { sig, file, at: ms };
    }
    return file;
  };
}

function install(ctx, deps = {}) {
  const fs = deps.fs || require('fs');
  const electron = deps.electron || require('electron');
  const { app, crashReporter } = electron;
  if (!ctx.dataDir || !wanted(ctx.dataDir, fs)) return false;
  const folder = path.join(ctx.dataDir, FOLDER);
  try {
    app.setPath('crashDumps', path.join(folder, ELECTRON));
    crashReporter.start({ uploadToServer: false, compress: true });
  } catch (err) {
    console.error(`crash reports: Electron's crash reporter didn't start (${err && err.message})`);
  }
  const kept = keeper(fs, folder);
  app.on('render-process-gone', (_event, _contents, details) => kept(reportFor('renderer', details)));
  app.on('child-process-gone', (_event, details) => kept(reportFor('child', details)));
  return true;
}

module.exports = { install, wanted, reportFor, keep, keeper, FOLDER, ELECTRON, KEEP, PER_HOUR, REPEAT_MS };
