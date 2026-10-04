// A turn's proof (features/code_receipts.py): the transcript's "Proof · …" entry drawn as one
// card: what changed, the tests, the check after the turn with its picture, and the risk,
// in a colour and in words. The entry's text stays the same everywhere else (the phone, voice).
(function (root) {
  'use strict';
  const F = root.jarvisFeatures;
  if (!F) return;
  const el = F.el;
  const RISK = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

  function card(e, li) {
    const r = e && e.receipt;
    if (!r || !li) return;
    li.className = `jc-note rc-card rc-${r.risk}`;
    const head = el('div', 'rc-head');
    head.append(el('span', `rc-risk rc-${r.risk}`, F.t(RISK[r.risk] || r.risk)), el('span', 'rc-why', r.why));
    const facts = el('ul', 'rc-facts');
    facts.append(el('li', '', `${r.file_count} ${r.file_count === 1 ? F.t('file changed') : F.t('files changed')}`));
    const t = r.tests;
    facts.append(el('li', t ? (t.passed ? 'rc-ok' : 'rc-bad') : 'rc-none',
      t ? (t.passed ? `${F.t('Tests passed')} (${t.passed_count})` : `${F.t('Tests failed')} (${t.failed_count})`) : F.t('No tests run')));
    if (r.check) facts.append(el('li', r.check.status === 'problems' ? 'rc-bad' : 'rc-ok', r.check.text || r.check.status));
    li.replaceChildren(head, facts);
    const thumb = r.check && r.check.thumb;
    if (typeof thumb === 'string' && (thumb.startsWith('/') || thumb.startsWith('data:image/'))) {
      const img = el('img', 'rc-thumb');
      img.src = thumb;
      img.alt = F.t('The page after this turn');
      li.append(img);
    }
    const qa = el('button', 'rc-qa', F.t('Try it like a user'));
    qa.type = 'button';
    qa.title = F.t('Jarvis has the session use what it built in the browser or Simulator, then report what broke');
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
