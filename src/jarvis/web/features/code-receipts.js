// A turn's proof (features/code_receipts.py): the transcript's "Proof · …" entry drawn as one
// card: what changed, the tests, the check after the turn with its picture, and the risk,
// in a colour and in words; for a Spec mode task, which requirements it met (code-spec.js).
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

  if (typeof module === 'object' && module.exports) { module.exports = { testsLine }; return; }
  const F = root.jarvisFeatures;
  if (!F) return;
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
    facts.append(testsFact(r.tests));
    if (r.check) facts.append(el('li', r.check.status === 'problems' ? 'rc-bad' : 'rc-ok', r.check.text || r.check.status));
    li.replaceChildren(head, facts);
    const thumb = picture(r.check && r.check.thumb);
    if (thumb) {
      const img = el('img', 'rc-thumb');
      img.src = thumb;
      img.alt = F.t('The page after this turn');
      li.append(img);
    }
    const v = r.video;
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
    qa.title = F.t('Eden Secretary has the session use what it built in the browser or Simulator, then report what broke');
    qa.addEventListener('click', () => { const t = F.currentTask(); if (t) F.send({ type: 'code_qa', id: t.id }); qa.disabled = true; });
    li.append(qa);
    if (r.files && r.files.length) {
      const more = el('details', 'rc-files');
      more.append(el('summary', '', F.t('Files')), ...r.files.map((f) => el('div', '', f)));
      li.append(more);
    }
  }
  F.registerEntryDecorator(card);
})(typeof window === 'object' ? window : globalThis);
