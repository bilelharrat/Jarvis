// Crash reports from the window (audit O1; features/crash_reports.py keeps them): while the
// owner has them on (prefs.features.crash_reports, the switch in Settings › Health ›
// Diagnostics, in ops.js), window.onerror and unhandled promise rejections are sent to the
// backend as crash_report {kind, message, stack, where}; the backend scrubs and keeps them on
// this Mac, and the diagnostics file carries them. Off, nothing is sent. The same error again
// is sent once; at most PER_MINUTE a minute. Pure helpers are exported for node --test
// (tests/web/crash-reports.test.mjs).
(function (root) {
  'use strict';

  const PREF = 'crash_reports';
  const PER_MINUTE = 10;
  const LIMITS = { message: 4000, stack: 16000, where: 500 };

  // What a window error is, as the backend takes it.
  function reportOf(kind, error, message, where) {
    const err = error && typeof error === 'object' ? error : null;
    const text = String((err && err.message) || message || (error !== undefined && error !== null && !err ? error : '') || 'Unknown error');
    const name = err && typeof err.name === 'string' ? err.name : '';
    return {
      type: 'crash_report',
      kind: name ? `${kind}: ${name}` : kind,
      message: text.slice(0, LIMITS.message),
      stack: String((err && err.stack) || '').slice(0, LIMITS.stack),
      where: String(where || '').slice(0, LIMITS.where),
    };
  }

  // Whether a report may go now: not one sent already, and under PER_MINUTE this minute.
  function limiter(now = () => Date.now()) {
    const sent = new Set();
    let times = [];
    return (report) => {
      const key = `${report.kind}|${report.message}|${report.stack.slice(0, 500)}`;
      const at = now();
      times = times.filter((t) => at - t < 60_000);
      if (sent.has(key) || times.length >= PER_MINUTE) return false;
      if (sent.size > 500) sent.clear();
      sent.add(key);
      times.push(at);
      return true;
    };
  }

  const api = { reportOf, limiter, PREF, PER_MINUTE };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  let on = false;
  const may = limiter();
  const take = (features) => { on = Boolean(features && features[PREF] === true); };
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });

  function report(kind, error, message, where) {
    if (!on) return;
    try {
      const r = reportOf(kind, error, message, where);
      if (may(r)) F.send(r);
    } catch { /* (a report that fails never adds an error of its own) */ }
  }
  root.addEventListener('error', (e) => {
    if (!e || e.target !== root) return;  // (a picture that didn't load isn't a crash)
    const where = e.filename ? `${String(e.filename).replace(/[?#].*$/, '')}:${e.lineno || 0}:${e.colno || 0}` : '';
    report('window error', e.error, e.message, where);
  });
  root.addEventListener('unhandledrejection', (e) => report('unhandled rejection', e && e.reason, '', ''));
})(typeof window === 'object' ? window : globalThis);
