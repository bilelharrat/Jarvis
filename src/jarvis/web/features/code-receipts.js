// A turn's proof (features/code_receipts.py): the transcript's "Proof · …" entry drawn as one
// card: what changed, the tests, the check after the turn with its picture, and the risk,
// in a colour and in words; for a Spec mode task, which requirements it met (code-spec.js);
// the guardrails that fired (code_guardrails: blocked, asked, flagged).
// what the security scanners found (features/code_security.py), and the ones not installed.
// The entry's text stays the same everywhere else (the phone, voice).
(function (root) {
  'use strict';

  // The tests line as [class, words, count]: passed / failed with the count when the run
  // said one, "Tests ran" when it said none (passed is null: it exited fine, but there's no
  // count to trust; the output may have been cut off). Never "(0)": count is 0 then.
  function testsLine(t) {
    if (!t) return ['rc-none', 'No tests run', 0];
    if (t.passed == null) return ['rc-none', 'Tests ran (no result shown)', 0];
    const n = Number(t.passed ? t.passed_count : t.failed_count) || 0;
    return t.passed ? ['rc-ok', 'Tests passed', n] : ['rc-bad', 'Tests failed', n];
  }

  // The guardrails that fired in the turn (code_guardrails), as [class, words]: blocked, asked
  // and flagged with how many times each; null when none fired.
  const GUARD_WORDS = { blocked: 'blocked', asked: 'asked', flagged: 'flagged' };
  function guardsLine(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const counts = {};
    for (const g of list) if (GUARD_WORDS[g.action]) counts[g.action] = (counts[g.action] || 0) + (Number(g.count) || 1);
    const said = Object.keys(GUARD_WORDS).filter((a) => counts[a]).map((a) => `${counts[a]} ${GUARD_WORDS[a]}`);
    return said.length ? [counts.flagged ? 'rc-guard rc-flag' : 'rc-guard', `Guardrails: ${said.join(', ')}`] : null;
  }

  // The security scan's line as [class, words, count], or null when no tool ran or would
  // have (features/code_security.py: Semgrep, osv-scanner, npm audit, pip-audit).
  function securityLine(s) {
    if (!s) return null;
    const ran = Array.isArray(s.ran) ? s.ran : [];
    const n = Number(s.count) || 0;
    if (n > 0) return [s.high ? 'rc-bad' : 'rc-warn', 'Security findings', n];
    if (ran.length) return ['rc-ok', 'Security scan clean', 0];
    if (Array.isArray(s.missing) && s.missing.length) return ['rc-none', 'Not security-scanned', 0];
    return null;
  }

  if (typeof module === 'object' && module.exports) { module.exports = { testsLine, guardsLine, securityLine }; return; }
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

  // What the scanners found, each with its tool and where; the tools that would have
  // checked this and aren't installed, with how to install them (never installed for you).
  function securityBox(s) {
    const box = el('details', 'rc-security');
    const ran = (s.ran || []).join(', ');
    box.append(el('summary', '', ran ? `${F.t('Security scan')} · ${ran}` : F.t('Security scan')));
    const list = el('ul', '');
    for (const f of (s.findings || []).slice(0, 12)) {
      const item = el('li', `rc-sec-${f.severity}`);
      const where = el('code', '', f.line ? `${f.path}:${f.line}` : f.path);
      const title = el('span', '', f.title);
      title.dataset.noI18n = '';
      where.dataset.noI18n = '';
      item.append(el('span', `rc-sec-sev rc-sec-${f.severity}`, F.t(f.severity)), el('span', 'rc-sec-tool', f.tool), title, where);
      if (f.fix) { const fix = el('div', 'rc-sec-fix', f.fix); fix.dataset.noI18n = ''; item.append(fix); }
      list.append(item);
    }
    for (const m of s.missing || []) {
      const item = el('li', 'rc-sec-missing');
      const how = el('code', '', m.install);
      how.dataset.noI18n = '';
      item.append(el('span', '', `${m.label} ${F.t('isn\'t installed')}:`), how);
      list.append(item);
    }
    for (const e of s.errors || []) list.append(el('li', 'rc-sec-error', e));
    box.append(list);
    return box;
  }

  function card(e, li) {
    const r = e && e.receipt;
    if (!r || !li) return;
    li.className = `jc-note rc-card rc-${r.risk}`;
    const head = el('div', 'rc-head');
    head.append(el('span', `rc-risk rc-${r.risk}`, F.t(RISK[r.risk] || r.risk)), el('span', 'rc-why', r.why));
    const facts = el('ul', 'rc-facts');
    facts.append(el('li', '', `${r.file_count} ${r.file_count === 1 ? F.t('file changed') : F.t('files changed')}`));
    facts.append(testsFact(r.tests));
    if (r.check) facts.append(el('li', r.check.status === 'problems' ? 'rc-bad' : 'rc-ok', r.check.text || r.check.status));
    // The session's own check of its work (code_selfcheck: "Check it yourself").
    const selfCheck = r.selfcheck;
    if (selfCheck && selfCheck.headline) facts.append(el('li', selfCheck.verdict === 'pass' ? 'rc-ok' : 'rc-bad', selfCheck.headline));
    const guards = guardsLine(r.guardrails);  // the owner's rules that held (code-guardrails.js)
    if (guards) facts.append(el('li', guards[0], guards[1]));
    const scan = securityLine(r.security);
    if (scan) facts.append(el('li', scan[0], scan[2] > 0 ? `${F.t(scan[1])} (${scan[2]})` : F.t(scan[1])));
    li.replaceChildren(head, facts);
    if (scan) li.append(securityBox(r.security));
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
    // The turn's guesses made instead of asking, each with an Undo (code-assumptions.js).
    const guessed = root.jarvisAssumptions && Array.isArray(r.assumptions) ? root.jarvisAssumptions.section(r.assumptions) : null;
    if (guessed) li.append(guessed);
    const qa = el('button', 'rc-qa', F.t('Try it like a user'));
    qa.type = 'button';
    qa.title = F.t(own('Eden Secretary has the session use what it built in the browser or Simulator, then report what broke', 'Eden Code has the session use what it built in the browser or Simulator, then report what broke'));
    qa.addEventListener('click', () => { const t = F.currentTask(); if (t) F.send({ type: 'code_qa', id: t.id }); qa.disabled = true; });
    li.append(qa);
    if (guards) {
      const fired = el('details', 'rc-guards');
      fired.append(el('summary', '', F.t('Guardrails')));
      for (const g of r.guardrails.slice(0, 10)) {
        const row = el('div', `rc-guard-${g.action}`);
        row.append(el('span', 'rc-guard-act', F.t(GUARD_WORDS[g.action] || g.action)), document.createTextNode(' '));
        const rule = el('span', '', `${g.rule}${g.what ? ` (${g.what})` : ''}${g.count > 1 ? ` ×${g.count}` : ''}`);
        rule.setAttribute('data-no-i18n', '');
        row.append(rule);
        fired.append(row);
      }
      li.append(fired);
    }
    if (r.files && r.files.length) {
      const more = el('details', 'rc-files');
      more.append(el('summary', '', F.t('Files')), ...r.files.map((f) => el('div', '', f)));
      li.append(more);
    }
  }
  F.registerEntryDecorator(card);
})(typeof window === 'object' ? window : globalThis);
