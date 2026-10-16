// A turn's proof (features/code_receipts.py): the transcript's "Proof · …" entry drawn as one
// card: what changed, the tests, whether its tests still test (code_test_integrity: a test
// weakened, mutants caught), the check after the turn with its picture, and the risk, in a
// colour and in words; for a Spec mode task, which requirements it met (code-spec.js). The
// entry's text stays the same everywhere else (the phone, voice). Its settings (Settings ›
// Eden Code › Receipts): the integrity check (on) and the quick mutation pass (off).
(function (root) {
  'use strict';

  // The tests line as [class, words, count], by the run's state (codesupervisor.tests_verdict):
  // "Tests passed" only for a real pass (passed true, a count, nothing changed after it),
  // amber when a test was weakened; failed with its count; "Tests ran" when it said none;
  // stopped, refused or out of date said so. Never "(0)": count is 0 then. A receipt from
  // before states were sent (no state) reads its passed as it always did.
  function testsLine(t) {
    if (!t) return ['rc-none', 'No tests run', 0];
    const state = t.state || (t.passed == null ? 'unknown' : t.passed ? 'passed' : 'failed');
    const passed = Number(t.passed_count) || 0;
    if (state === 'passed' && t.passed === true && passed > 0) return [t.trusted === false ? 'rc-warn' : 'rc-ok', 'Tests passed', passed];
    if (state === 'failed') return ['rc-bad', 'Tests failed', Number(t.failed_count) || 0];
    if (state === 'stale') return ['rc-warn', 'Tests passed before its last edits', passed];
    if (state === 'cancelled') return ['rc-warn', 'Tests didn’t finish', 0];
    if (state === 'refused') return ['rc-none', 'Tests not run (not allowed)', 0];
    return ['rc-none', 'Tests ran (no result shown)', 0];
  }

  // The integrity lines (code_test_integrity) as [class, text]: the backend's own words.
  const TONE = { ok: 'rc-ok', warn: 'rc-warn', bad: 'rc-bad', none: 'rc-none' };
  function integrityLines(r) {
    const lines = (r && r.integrity && Array.isArray(r.integrity.lines)) ? r.integrity.lines : [];
    return lines.filter((x) => x && x.text).slice(0, 4).map((x) => [TONE[x.tone] || 'rc-none', String(x.text)]);
  }

  if (typeof module === 'object' && module.exports) { module.exports = { testsLine, integrityLines }; return; }
  const F = root.jarvisFeatures;
  if (!F) return;
  const own = F.own || ((secretary) => secretary);  // the app's own words (app.js, jarvisFeatures.own)
  const el = F.el;
  const RISK = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

  // A picture as the check and the video keep it (base64 JPEG) or an address of the app's.
  function picture(value) {
    if (typeof value !== 'string' || !value) return '';
    if (value.startsWith('/') || value.startsWith('data:image/')) return value;
    return /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? `data:image/jpeg;base64,${value}` : '';
  }

  function testsFact(t) {
    const [cls, words, n] = testsLine(t);
    return el('li', cls, n > 0 ? `${F.t(words)} (${n})` : F.t(words));
  }

  function card(e, li) {
    const r = e && e.receipt;
    if (!r || !li) return;
    li.className = `jc-note rc-card rc-${r.risk}`;
    const head = el('div', 'rc-head');
    head.append(el('span', `rc-risk rc-${r.risk}`, F.t(RISK[r.risk] || r.risk)), el('span', 'rc-why', r.why));
    const facts = el('ul', 'rc-facts');
    facts.append(el('li', '', `${r.file_count} ${r.file_count === 1 ? F.t('file changed') : F.t('files changed')}`));
    if (r.stopped) facts.append(el('li', 'rc-warn', F.t('Stopped before it finished')));
    facts.append(testsFact(r.tests));
    for (const [cls, text] of integrityLines(r)) facts.append(el('li', `${cls} rc-integrity`, text));
    if (r.check) facts.append(el('li', r.check.status === 'problems' ? 'rc-bad' : 'rc-ok', r.check.text || r.check.status));
    // The session's own check of its work (code_selfcheck: "Check it yourself").
    const selfCheck = r.selfcheck;
    if (selfCheck && selfCheck.headline) facts.append(el('li', selfCheck.verdict === 'pass' ? 'rc-ok' : 'rc-bad', selfCheck.headline));
    li.replaceChildren(head, facts);
    const thumb = picture((r.check && r.check.thumb) || (selfCheck && selfCheck.thumb));
    if (thumb) {
      const img = el('img', 'rc-thumb');
      img.src = thumb;
      img.alt = F.t('The page after this turn');
      li.append(img);
    }
    const v = r.video || (selfCheck && selfCheck.video);
    if (v && /^[0-9a-f]{24}$/.test(v.id || '')) {
      const video = el('video', 'rc-video');
      video.controls = true;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'none';
      video.src = `/f/code-video/${v.id}`;
      const poster = picture(v.poster);
      if (poster) video.poster = poster;
      li.append(video);
    }
    const reqs = Array.isArray(r.requirements) ? r.requirements : [];
    const spec = root.jarvisSpec;  // (features/code-spec.js: Spec mode's words)
    if (reqs.length && spec) {
      const { met, total } = spec.summary(reqs);
      const box = el('section', 'rc-reqs');
      box.setAttribute('aria-label', `${F.t('Requirements met')}: ${met} / ${total}`);
      box.append(el('h4', '', `${F.t('Requirements met')}: ${met} / ${total}`));
      const list = el('ul', '');
      for (const q of reqs) {
        const item = el('li', `rc-req-${q.status}`);
        item.setAttribute('aria-label', spec.spoken(q));
        item.append(el('span', 'rc-req-state', F.t(spec.words[q.status] || q.status)), el('span', '', `${q.id} ${q.title || ''}`));
        for (const ev of (q.evidence || []).slice(0, 6)) item.append(el('div', 'rc-req-ev', ev));
        list.append(item);
      }
      box.append(list);
      li.append(box);
    }
    const qa = el('button', 'rc-qa', F.t('Try it like a user'));
    qa.type = 'button';
    qa.title = F.t(own('Eden Secretary has the session use what it built in the browser or Simulator, then report what broke', 'Eden Code has the session use what it built in the browser or Simulator, then report what broke'));
    qa.addEventListener('click', () => { const t = F.currentTask(); if (t) F.send({ type: 'code_qa', id: t.id }); qa.disabled = true; });
    li.append(qa);
    if (r.files && r.files.length) {
      const more = el('details', 'rc-files');
      more.append(el('summary', '', F.t('Files')), ...r.files.map((f) => el('div', '', f)));
      li.append(more);
    }
  }
  F.registerEntryDecorator(card);

  // ── Settings › Eden Code: Receipts (prefs.features) ──
  const features = {};
  const SWITCHES = [
    ['code_test_integrity', true, 'Check tests weren’t weakened', 'Before a receipt says the tests passed, read the turn’s test changes for assertions taken out or loosened, skips, a test command that can’t fail, tests deleted and mocks of the code under test.'],
    ['code_mutation_pass', false, 'Quick mutation pass', 'After a turn whose tests passed, make a few small changes to the lines it changed and rerun the relevant tests in a scratch copy, to show how many they catch. Up to 3 minutes; no AI is used.'],
  ];
  const switches = {};
  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', F.t('Receipts'));
    const group = el('div', 'jcs-group');
    for (const [key, , name, note] of SWITCHES) {
      const row = el('div', 'jcs-row');
      const text = el('span');
      text.append(document.createTextNode(F.t(name)), el('small', '', F.t(note)));
      const sw = el('button', 'jcs-switch');
      sw.type = 'button';
      sw.id = `rc-pref-${key}`;
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', F.t(name));
      sw.addEventListener('click', () => F.send({ type: 'feature_prefs', changes: { [key]: !valueOf(key) } }));
      switches[key] = sw;
      row.append(text, sw);
      group.append(row);
    }
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
  })();
  function valueOf(key) {
    const found = SWITCHES.find((s) => s[0] === key);
    return key in features ? !!features[key] : !!(found && found[1]);
  }
  function drawSettings() { for (const [key] of SWITCHES) if (switches[key]) switches[key].setAttribute('aria-checked', String(valueOf(key))); }
  function prefsFrom(prefs) { if (prefs && prefs.features) Object.assign(features, prefs.features); drawSettings(); }
  F.on('hello', (ev) => prefsFrom(ev.prefs), { replay: true });
  F.on('prefs', (ev) => prefsFrom(ev), { replay: true });
  drawSettings();
})(typeof window === 'object' ? window : globalThis);
