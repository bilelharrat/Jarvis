// Eden Code's Spec mode (features/code_spec.py): the "Spec mode" switch in the toolbar's More
// menu (shown before a session starts, in a project) makes the next session one that writes
// specs/<name>/requirements.md, design.md and tasks.md, a card between each; /spec turns the
// switch on and /spec <request> starts one at once. It adds nothing to the composer (the
// owner wants the composer as it is). A receipt's "Requirements met" (code-receipts.js) is
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
    // The More menu's switch: shown only where a session is about to start in a project.
    moreItem(on) {
      return {
        label: 'Spec mode',
        note: on ? 'The next session starts with a spec' : 'Requirements, design and tasks first',
        switch: !!on,
      };
    },
    canStart(task, project) { return !task && !!project; },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }
  root.jarvisSpec = helpers;

  const F = root.jarvisFeatures;
  if (!F) return;
  const { send, t } = F;
  let on = false;

  /* global deckProject */
  const project = () => (typeof deckProject === 'string' ? deckProject : '');
  const can = () => helpers.canStart(F.currentTask(), project());

  // Off again whenever a session is open or there's no project: it only ever names the next one.
  function draw() { if (!can()) on = false; }

  F.registerMoreItem({
    when: (task) => helpers.canStart(task, project()),
    get label() { return helpers.moreItem(on).label; },
    get note() { return helpers.moreItem(on).note; },
    get switch() { return on; },
    run() { on = !on; },
  });

  F.registerSessionOption(() => {
    if (!can() || !on) return {};
    setTimeout(() => { on = false; draw(); });  // the next session is an ordinary one unless switched again
    return { spec: true, cloud: false };  // (a spec stays in the project folder, here)
  });

  F.registerSlash({
    name: 'spec',
    help: 'Spec mode: requirements, design and tasks first, then each task checked',
    withoutSession: true,
    run(arg) {
      if (!arg) {  // the switch on, said (the More menu shows it, and turns it off)
        if (!can()) return false;
        on = true;
        if (typeof root.notice === 'function') root.notice('Eden Code', t('Spec mode is on'), t('The next session starts with a spec. Turn it off in More.'), 5000);
        return true;
      }
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
