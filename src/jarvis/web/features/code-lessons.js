// After a change is undone in the Changes pane (features/code_lessons.py): one optional
// line, "Why? Eden Secretary will remember", kept as a lesson in Eden Secretary memory for this project (or
// every project, when it says "always", "from now on" or "every project"). Dismissed, nothing is kept.
(function (root) {
  'use strict';
  const F = root.jarvisFeatures;
  if (!F) return;
  const own = F.own || ((secretary) => secretary);  // the app's own words (app.js, jarvisFeatures.own)
  const t = (s) => F.t(s);
  let box = null;

  function close() { if (box) { box.remove(); box = null; } }

  F.on('code_lesson_ask', (ev) => {
    close();
    box = F.el('form', 'cl-ask');
    const label = F.el('label', 'cl-label', t(own('Why undo it? Eden Secretary will remember for next time.', 'Why undo it? Eden Code will remember for next time.')));
    const input = F.el('input', 'cl-input');
    input.type = 'text';
    input.maxLength = 240;
    input.placeholder = t('e.g. Never change the public API without asking');
    const skip = F.el('button', 'jc-mini', t('Skip'));
    skip.type = 'button';
    skip.addEventListener('click', close);
    const keep = F.el('button', 'jc-mini primary', t('Remember'));
    keep.type = 'submit';
    box.append(label, input, keep, skip);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) F.send({ type: 'code_lesson_add', id: ev.id, text: input.value.trim() });
      close();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.append(box);
    input.focus();
    setTimeout(() => { if (box && document.activeElement !== input) close(); }, 30000);
  });
})(typeof window === 'object' ? window : globalThis);
