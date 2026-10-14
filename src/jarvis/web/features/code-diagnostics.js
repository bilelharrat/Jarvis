// Every Eden Code error card gets two actions (audit O2): Copy details (what went wrong, when,
// the session's model, mode and folder, with the home folder's name, emails and anything
// that looks like a key masked) and Send diagnostics: the diagnostics file of Settings ›
// Health (features/ops/diagnostics.py: the recent logs with every secret masked, versions,
// a fresh checkup, and the crash reports if they're on), made at once and shown in Finder
// to send to whoever helps; nothing goes anywhere by itself.
// Error cards: a session's transcript entry that's an error (error: true from the backend,
// as tasks.py's "Stopped with an error", or a "Couldn't …" note), and Eden Code's own
// "Something went wrong" notices. Pure helpers are exported for node --test
// (tests/web/code-diagnostics.test.mjs).
(function (root) {
  'use strict';

  const ERROR_WORDS = /^(Stopped with an error|Couldn['’]t |Failed\b|Didn['’]t finish)/;

  // Whether a transcript entry is an error card.
  function isError(e) {
    if (!e || typeof e !== 'object') return false;
    if (e.error === true) return true;
    return (e.role === 'system' || e.role === 'note') && ERROR_WORDS.test(String(e.text || ''));
  }

  // Masked as a diagnostics file masks (a stand-in for ops/redact.py, in the window).
  function mask(text) {
    return String(text || '')
      .replace(/\/(Users|home)\/[^/\s'"]+/g, '~')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]')
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[hidden]')
      .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat)_[A-Za-z0-9_]{16,}/g, '[hidden]')
      .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[hidden]')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[hidden]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, '[hidden]')
      .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]')
      .replace(/\b((?:api[_-]?key|token|secret|passw(?:or)?d|authorization)\s*[:=]\s*)[^\s"',;]{4,}/gi, '$1[hidden]');
  }

  // The words Copy details puts on the clipboard.
  function details(e, task, app = '') {
    const t = task || {};
    const lines = ['Eden Code error', `What happened: ${(e && e.text) || ''}`];
    if (e && e.at) lines.push(`When: ${e.at}`);
    if (t.id) lines.push(`Session: ${t.title || 'Untitled'} (#${t.id})`);
    if (t.model_label || t.model) lines.push(`Model: ${t.model_label || t.model}`);
    if (t.mode) lines.push(`Mode: ${t.mode}`);
    if (t.status) lines.push(`Status: ${t.status}`);
    if (t.cwd || t.folder) lines.push(`Folder: ${t.cwd || t.folder}`);
    if (app) lines.push(`App: ${app}`);
    return mask(lines.join('\n'));
  }

  const api = { isError, mask, details };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || !F.registerEntryDecorator) return;
  const inEdenCode = root.document && root.document.body && root.document.body.dataset.app === 'eden-code';
  const waiting = new Set();  // the Send diagnostics buttons whose file is being made
  const appName = () => {
    const ua = String((root.navigator && root.navigator.userAgent) || '');
    const m = /(Eden[ \w]*|J\.A\.R\.V\.I\.S\.)\/([\d.]+)/.exec(ua);
    return m ? `${m[1]} ${m[2]}` : '';
  };

  function button(label, title, run) {
    const b = F.el('button', 'jc-mini cd-action', label);
    b.type = 'button';
    if (title) { b.title = F.t(title); b.setAttribute('aria-label', `${F.t(label)}: ${F.t(title)}`); }
    b.addEventListener('click', (ev) => { ev.stopPropagation(); run(b); });
    return b;
  }

  function actions(getText) {
    const box = F.el('div', 'cd-actions');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', F.t('Error actions'));
    const status = F.el('span', 'cd-status');
    status.setAttribute('aria-live', 'polite');
    const copy = button('Copy details', 'What went wrong, masked, for a bug report', async (b) => {
      try { await root.navigator.clipboard.writeText(getText()); b.textContent = F.t('Copied'); } catch { b.textContent = F.t('Couldn’t copy'); }
      setTimeout(() => { b.textContent = F.t('Copy details'); }, 1400);
    });
    const send = button('Send diagnostics', 'Makes a masked diagnostics file and shows it in Finder, for you to send', (b) => {
      if (waiting.size) return;  // (one file at a time: this one's answer comes with the other's)
      if (!F.send({ type: 'ops_diagnostics', megabytes: 2 })) { status.textContent = F.t('Not connected yet. Try again in a moment.'); return; }
      b.disabled = true;
      b.textContent = F.t('Making it…');
      b.cdStatus = status;
      waiting.add(b);
    });
    box.append(copy, send, status);
    return box;
  }

  F.on('ops_diagnostics', (ev) => {
    for (const b of waiting) {
      b.disabled = false;
      b.textContent = F.t('Send diagnostics');
      const status = b.cdStatus;
      if (!status) continue;
      status.replaceChildren();
      if (ev.ok) {
        status.append(F.el('span', '', 'Saved in Documents › Eden Secretary › Diagnostics.'));
        const show = button('Show in Finder', '', () => F.send({ type: 'ops_reveal', path: ev.path }));
        status.append(document.createTextNode(' '), show);
        show.focus();
      } else {
        status.append(F.el('span', 'cd-problem', ev.text || 'That didn’t work.'));
      }
    }
    waiting.clear();
  });

  // A session's error entries.
  F.registerEntryDecorator((e, li) => {
    if (!isError(e) || !li || li.querySelector('.cd-actions')) return;
    li.classList.add('cd-error');
    li.append(actions(() => details(e, F.currentTask ? F.currentTask() : null, appName())));
  });

  // Eden Code's own "Something went wrong" notices (app.js draws them before features hear).
  if (inEdenCode) {
    F.on('error', (ev) => {
      const text = String((ev && ev.text) || '');
      if (!text) return;
      const cards = [...root.document.querySelectorAll('#cards > .card.plain')];
      const card = cards.reverse().find((c) => c.noticeWords && c.noticeWords.includes(JSON.stringify(text).slice(1, -1)) && !c.querySelector('.cd-actions'));
      const row = card && card.querySelector('.card-actions');
      if (!row) return;
      row.prepend(actions(() => details({ text, at: new Date().toISOString().slice(0, 19) }, F.currentTask ? F.currentTask() : null, appName())));
    });
  }
})(typeof window === 'object' ? window : globalThis);
