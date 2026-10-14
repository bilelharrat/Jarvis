// Eden Code's Spec mode (features/code_spec.py): the composer's "Spec" switch starts a new
// session that writes specs/<name>/requirements.md, design.md and tasks.md, a card between
// each; /spec <request> does the same. A receipt's "Requirements met" (code-receipts.js) is
// drawn with the words here (window.jarvisSpec). helpers is exported for node --test
// (tests/web/code-spec.test.mjs).
(function (root) {
  'use strict';

  const WORDS = { met: 'Met', unmet: 'Not met', partly: 'Partly met', unchecked: 'Not checked' };
  const helpers = {
    // "Requirements met: 2 of 3" for a receipt's rows.
    summary(rows) {
      const list = Array.isArray(rows) ? rows : [];
      const met = list.filter((r) => r && r.status === 'met').length;
      return { met, total: list.length };
    },
    // One requirement as a screen reader hears it: "R1 Sign in: met. R1.1: test_r1_1 passed".
    spoken(row) {
      if (!row) return '';
      const head = `${row.id}${row.title ? ` ${row.title}` : ''}: ${(WORDS[row.status] || row.status || '').toLowerCase()}`;
      const ev = (row.evidence || []).slice(0, 4).join('; ');
      return ev ? `${head}. ${ev}` : head;
    },
    words: WORDS,
    tip(on) {
      return on
        ? 'Spec mode: the session writes the requirements, then the design, then the tasks, and asks you after each.'
        : 'Spec mode: requirements, design and tasks first, each OK\'d by you, then each task checked against them.';
    },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }
  root.jarvisSpec = helpers;

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  let on = false;

  const pill = el('button', 'jc-pill jcx-spec-switch');
  pill.type = 'button';
  pill.id = 'jcx-spec-switch';
  pill.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h6l2.5 2.5v8.5h-8.5z"/><path d="M6 7h4.5M6 9.5h4.5M6 12h2.5"/></svg>';
  pill.append(el('span', '', t('Spec')));
  pill.addEventListener('click', () => { on = !on; draw(); });

  /* global deckProject */
  const project = () => (typeof deckProject === 'string' ? deckProject : '');

  function draw() {
    const row = document.querySelector('#deck-composer .jc-composer-row');
    if (row && !pill.isConnected) row.insertBefore(pill, row.querySelector('.jc-spacer'));
    pill.hidden = !(!F.currentTask() && project());
    if (pill.hidden) on = false;
    pill.setAttribute('aria-pressed', String(on));
    pill.classList.toggle('on', on);
    pill.title = t(helpers.tip(on));
    pill.setAttribute('aria-label', t(helpers.tip(on)));
  }

  F.registerSessionOption(() => {
    if (pill.hidden || !on) return {};
    setTimeout(() => { on = false; draw(); });  // the next session is an ordinary one unless switched again
    return { spec: true, cloud: false };  // (a spec stays in the project folder, here)
  });

  F.registerSlash({
    name: 'spec',
    help: 'Spec mode: requirements, design and tasks first, then each task checked',
    withoutSession: true,
    run(arg) {
      if (!arg) { on = true; draw(); pill.focus(); return true; }
      if (!project()) return false;
      send({ type: 'code_spec_start', directory: project(), prompt: arg });
      return true;
    },
  });

  F.on('tasks', () => draw());
  F.on('hello', () => draw(), { replay: true });
  const title = document.getElementById('jc-title');
  if (title) new MutationObserver(draw).observe(title, { childList: true, characterData: true, subtree: true });
})(typeof window !== 'undefined' ? window : globalThis);
