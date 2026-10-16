// Eden Code's "Check it yourself" (features/code_selfcheck.py): the session's own check of
// its UI work, asked of the app (app/features/self-check.js: a hidden preview it drives)
// through this window; each finished check in the transcript as one compact line, "Checked:
// 4 steps, 2 screenshots, no console errors", that opens to its pictures, what it did and
// what it found; and the session's switch in the More menu.
//
// Everything shown from the backend is data: text only (the page's and the session's words
// alike). Pure helpers are exported for node --test (tests/web/self-check.test.mjs).
(function (root) {
  'use strict';

  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

  // The compact line, as the backend writes it (code_selfcheck.headline).
  function headline(c) {
    const parts = [plural(Number(c.steps) || 0, 'step'), plural(Number(c.shots) || 0, 'screenshot')];
    if (c.target === 'ios') {
      const n = Number(c.log_errors) || 0;
      parts.push(n ? plural(n, 'app log error') : 'no app log errors');
    } else {
      const n = Number(c.console_errors) || 0;
      parts.push(n ? plural(n, 'console error') : 'no console errors');
      const failed = Number(c.network_failures) || 0;
      if (failed) parts.push(plural(failed, 'failed request'));
    }
    return `Checked: ${parts.join(', ')}`;
  }

  function verdictMark(v) { return v === 'pass' ? '✓' : v === 'fail' ? '✕' : '–'; }
  function verdictWord(v) { return v === 'pass' ? 'Passed' : v === 'fail' ? 'Found problems' : 'Not finished'; }

  function jpegSrc(data) {
    return typeof data === 'string' && data && /^[A-Za-z0-9+/]+={0,2}$/.test(data) ? `data:image/jpeg;base64,${data}` : '';
  }

  const api = { headline, verdictMark, verdictWord, jpegSrc };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  // ── the app does the checking, asked through this window ──

  F.on('sc_call', async (ev) => {
    const app = root.jarvisApp;
    if (!app || !app.feature) return;  // a window without the app: the app window answers
    // Eden Code's Browser pane shows the check as it runs, and holds it while the owner has
    // taken the browser over (features/code-browser.js).
    const pane = root.jarvisCodeBrowser;
    const held = pane ? pane.checkStart(ev) : '';
    if (held) { F.send({ type: 'sc_result', call: ev.call, result: { ok: false, message: held } }); return; }
    let result;
    try {
      result = await app.feature.invoke('feature:self-check:call', { session: ev.session, action: ev.action, args: ev.args || {} });
    } catch (err) {
      result = { error: String(err && err.message ? err.message : err) };
    }
    if (pane) pane.checkEnd(ev, result);
    F.send({ type: 'sc_result', call: ev.call, result });
  });

  // ── a picture, larger ──

  let lightbox = null;
  let opener = null;
  function closePicture() {
    if (!lightbox) return;
    lightbox.remove();
    lightbox = null;
    document.removeEventListener('keydown', escPicture, true);
    if (opener && opener.focus) opener.focus();
  }
  function escPicture(e) { if (e.key === 'Escape') { e.stopPropagation(); closePicture(); } }
  function openPicture(proof, thumb, label) {
    closePicture();
    opener = document.activeElement;
    lightbox = el('div', 'cv-lightbox');
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.setAttribute('aria-label', label);
    lightbox.dataset.proof = proof || '';
    const img = el('img');
    img.src = jpegSrc(thumb);
    img.alt = label;
    const close = el('button', 'jc-icon cv-lightbox-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', t('Close'));
    lightbox.append(img, close, el('p', 'cv-lightbox-note'));
    lightbox.addEventListener('click', closePicture);
    document.body.append(lightbox);
    document.addEventListener('keydown', escPicture, true);
    close.focus();
    if (proof) F.send({ type: 'cv_proof', proof });  // the full picture (code_verify keeps them)
  }
  F.on('cv_proof', (ev) => {
    if (!lightbox || lightbox.dataset.proof !== ev.proof) return;
    const src = jpegSrc(ev.jpeg);
    if (src) lightbox.querySelector('img').src = src;
    else lightbox.querySelector('.cv-lightbox-note').textContent = t('The full picture isn’t kept anymore.');
  });

  // ── a check in the transcript ──

  function checkEntry(e) {
    const c = (e && e.check) || {};
    const status = c.verdict === 'pass' ? 'passed' : c.verdict === 'fail' ? 'failed' : 'skipped';
    const li = el('li', `sc-check ${status}`);
    const box = el('details', 'sc-details');
    const sum = el('summary', 'sc-summary');
    const glyph = el('span', `cv-mark ${status}`, verdictMark(c.verdict));
    glyph.setAttribute('role', 'img');
    glyph.setAttribute('aria-label', t(verdictWord(c.verdict)));
    sum.append(glyph, el('strong', '', c.headline || headline(c)), el('span', 'cv-chip', verdictWord(c.verdict)));
    box.append(sum);
    const body = el('div', 'sc-body');
    const where = c.url || c.app || '';
    if (where) body.append(mine(el('small', 'cv-check-where', where)));
    if (c.goal) body.append(lineOf('Asked for', c.goal));
    if (c.summary) body.append(lineOf('What it saw', c.summary));
    if (c.compared) body.append(lineOf('Against the request', c.compared));
    const pics = (Array.isArray(c.pictures) ? c.pictures : []).filter((p) => p && (p.thumb || p.proof));
    if (pics.length) {
      const row = el('div', 'sc-pictures');
      pics.forEach((p, i) => {
        const label = `${t('Screenshot')} ${i + 1}`;
        const b = el('button', p.thumb ? 'cv-mini-thumb sc-thumb' : 'jc-btn small sc-shot', p.thumb ? '' : label);
        b.type = 'button';
        b.setAttribute('aria-label', label);
        if (p.thumb) { const img = el('img'); img.src = jpegSrc(p.thumb); img.alt = label; b.append(img); }
        b.addEventListener('click', () => openPicture(p.proof, p.thumb, label));
        row.append(b);
      });
      body.append(row);
    }
    const findings = Array.isArray(c.findings) ? c.findings : [];
    if (findings.length) {
      const list = el('ul', 'cv-findings');
      list.setAttribute('aria-label', t('What it found'));
      for (const f of findings) list.append(mine(el('li', 'cv-finding', String(f))));
      body.append(list);
    }
    const steps = Array.isArray(c.actions) ? c.actions : [];
    if (steps.length) {
      const list = el('ol', 'sc-steps');
      list.setAttribute('aria-label', t('What it did'));
      for (const s of steps) list.append(mine(el('li', '', String(s))));
      body.append(list);
    }
    const seconds = Number(c.seconds) || 0;
    body.append(el('small', 'cv-check-note', `${t('The session checked its own work in a hidden preview')} · ${seconds} s · ${c.steps || 0}/${c.budget || 0} ${t('steps')}`));
    box.append(body);
    li.append(box);
    return li;
  }
  function lineOf(label, text) {
    const p = el('p', 'sc-line');
    p.append(el('span', 'cv-kind', label), mine(el('span', '', String(text))));
    return p;
  }
  F.registerEntry('selfcheck', checkEntry);

  // ── the session's switch ──

  const states = new Map();  // session id -> what sc_state last said
  let askedFor = null;
  function ask() {
    const task = F.currentTask();
    const id = task ? task.id : null;
    if (id === askedFor) return;
    askedFor = id;
    if (id !== null) F.send({ type: 'sc_state', id });
  }
  F.on('tasks', ask);
  F.on('task_transcript', ask);
  F.on('sc_state', (ev) => { states.set(ev.id, ev); });
  const stateOf = (task) => (task ? states.get(task.id) || {} : {});

  F.registerMoreItem({
    label: 'Check it yourself',
    get note() {
      const s = stateOf(F.currentTask());
      return s.steps ? `${t('Before saying it’s done: open it, try it, look')} · ${s.steps} ${t('steps')}, ${s.minutes} min` : t('Before saying it’s done: open it, try it, look');
    },
    keepOpen: true,
    get switch() { return !!stateOf(F.currentTask()).on; },
    when: (task) => !!task,
    run: (on) => { const task = F.currentTask(); if (task) F.send({ type: 'sc_set', id: task.id, on: !!on }); },
  });

  // ── Eden Code settings › While it works: the QA pass after a UI change (code_qa.PREF_AUTO:
  // 'ui', the default, in UI projects only; true every project; false never) ──

  const qa = F.el('select', 'jcs-select');
  qa.id = 'jcx-qa-auto';
  qa.setAttribute('aria-label', 'Try UI changes like a user');
  for (const [value, label] of [['ui', 'In UI projects'], ['all', 'In every project'], ['off', 'Only when I ask']]) {
    const o = F.el('option', '', label);
    o.value = value;
    qa.append(o);
  }
  qa.addEventListener('change', () => F.send({ type: 'feature_prefs', changes: { code_qa_auto: qa.value === 'ui' ? 'ui' : qa.value === 'all' } }));
  (function addSetting() {
    const queue = typeof document.getElementById === 'function' ? document.getElementById('jcs-queue') : null;
    const group = queue && queue.closest('.jcs-group');
    if (!group) return;
    const row = F.el('label', 'jcs-row');
    const text = F.el('span');
    text.append(document.createTextNode(t('Try UI changes like a user')),
      F.el('small', '', 'After a turn that changes a page or a screen, the session walks through it and reports what broke, twice an hour at most. Not after a turn whose own check already passed.'));
    row.append(text, qa);
    group.append(row);
  })();
  const drawQa = (features) => {
    const v = (features || {}).code_qa_auto;
    qa.value = v === true ? 'all' : v === false ? 'off' : 'ui';
  };
  F.on('prefs', (ev) => drawQa(ev.features));
  F.on('hello', (ev) => drawQa(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
