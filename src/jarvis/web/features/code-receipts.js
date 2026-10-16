// A turn's proof (features/code_receipts.py): the transcript's "Proof · …" entry drawn as one
// card: what changed, the tests, whether its tests still test (code_test_integrity: a test
// weakened, mutants caught), the check after the turn with its picture, and the risk, in a
// colour and in words; for a Spec mode task, which requirements it met (code-spec.js); the
// guardrails that fired (code_guardrails: blocked, asked, flagged); what the security
// scanners found (features/code_security.py), and the ones not installed. The entry's text
// stays the same everywhere else (the phone, voice). Its settings (Settings › Eden Code ›
// Receipts): the integrity check (on) and the quick mutation pass (off).
// Another agent's turn (over ACP: features/code_acp.py) also says what it used: tokens (≈:
// an estimate, when the agent reports none) and its cost when the agent says it.
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

  // The integrity lines (code_test_integrity) as [class, text]: the backend's own words.
  const TONE = { ok: 'rc-ok', warn: 'rc-warn', bad: 'rc-bad', none: 'rc-none' };
  function integrityLines(r) {
    const lines = (r && r.integrity && Array.isArray(r.integrity.lines)) ? r.integrity.lines : [];
    return lines.filter((x) => x && x.text).slice(0, 4).map((x) => [TONE[x.tone] || 'rc-none', String(x.text)]);
  }

  // The model lines (code_receipts: fallbacks, router): each move to a fallback model in the
  // turn, and Model Router's Shadow pick with what it would have saved. [class, words].
  function modelLines(r) {
    const out = [];
    for (const m of (r && Array.isArray(r.fallbacks) ? r.fallbacks : [])) {
      if (m && m.to) out.push(['rc-warn rc-fallback', `Fell back from ${m.from || 'its model'} to ${m.to}${m.why ? ` (${m.why})` : ''}`]);
    }
    const s = r && r.router;
    if (s && (s.label || s.model)) {
      const save = Number(s.saveUSD);
      const money = Number.isFinite(save) && Math.abs(save) >= 0.005 ? ` (about $${Math.abs(save).toFixed(2)} ${save > 0 ? 'less' : 'more'})` : '';
      out.push(['rc-none rc-shadow', `Model Router would pick ${s.label || s.model}${money}`]);
    }
    // A message from the phone or the local API Model Router couldn't route (no window
    // open, no Node.js on the Mac: features/code_router_backend.py): where it went instead.
    const u = r && r.router_note;
    if (u && (u.label || u.model)) {
      const where = { phone: 'from your phone', api: 'from the local API' }[u.from] || 'from outside Eden Code';
      out.push(['rc-warn rc-unrouted', `Model Router couldn’t pick for this message ${where}: it went to ${u.label || u.model}`]);
    }
    return out;
  }

  // 12, 4.2k, 1.3M (≈ in front: an estimate), as the backend's code_acp.tokens_text.
  function tokenCount(n, estimated) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    const shown = v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v);
    return `${estimated ? '≈' : ''}${shown.replace('.0M', 'M').replace('.0k', 'k')}`;
  }

  // An agent's turn's usage as [count, cost] ('' for a cost it didn't say).
  function usageLine(u) {
    if (!u) return null;
    const cost = typeof u.cost === 'number' && u.cost >= 0 ? `$${u.cost.toFixed(2)}` : '';
    return [tokenCount(u.tokens, !!u.estimated), cost];
  }

  if (typeof module === 'object' && module.exports) { module.exports = { testsLine, guardsLine, securityLine, integrityLines, modelLines, tokenCount, usageLine }; return; }
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
    if (r.stopped) facts.append(el('li', 'rc-warn', F.t('Stopped before it finished')));
    facts.append(testsFact(r.tests));
    for (const [cls, text] of integrityLines(r)) facts.append(el('li', `${cls} rc-integrity`, text));
    if (r.check) facts.append(el('li', r.check.status === 'problems' ? 'rc-bad' : 'rc-ok', r.check.text || r.check.status));
    // The session's own check of its work (code_selfcheck: "Check it yourself").
    const selfCheck = r.selfcheck;
    if (selfCheck && selfCheck.headline) facts.append(el('li', selfCheck.verdict === 'pass' ? 'rc-ok' : 'rc-bad', selfCheck.headline));
    const guards = guardsLine(r.guardrails);  // the owner's rules that held (code-guardrails.js)
    if (guards) facts.append(el('li', guards[0], guards[1]));
    const scan = securityLine(r.security);
    if (scan) facts.append(el('li', scan[0], scan[2] > 0 ? `${F.t(scan[1])} (${scan[2]})` : F.t(scan[1])));
    for (const [cls, words] of modelLines(r)) {
      const line = el('li', cls, words);
      line.dataset.noI18n = '';  // (model names; the words are built here)
      facts.append(line);
    }
    const used = usageLine(r.usage);
    if (used) {
      const fact = el('li', 'rc-usage');
      fact.setAttribute('data-no-i18n', '');
      fact.title = F.t(r.usage.estimated ? 'Estimated: the agent didn’t report its tokens' : 'As the agent reported it');
      fact.textContent = `${r.usage.name || ''} · ${used[0]} ${F.t('tokens')}${used[1] ? ` · ${used[1]}` : ''}`;
      facts.append(fact);
    }
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
