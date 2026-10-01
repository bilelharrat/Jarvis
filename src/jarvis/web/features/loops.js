// Loop detection in a Jarvis Code session (the backend is jarvis.features.loops): a step
// repeated, or a few steps going round, puts a "loop" entry in the session's timeline. It
// shows what was repeated (the session's own step names, as data) with Stop, which
// interrupts the session, and Let it carry on. The session is never stopped without the
// owner pressing Stop.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function button(label, cls, run) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  function loopEntry(e) {
    const li = el('li', 'jc-loop');
    li.setAttribute('role', 'status');
    const head = el('p', 'jc-loop-head', e.kind === 'cycle'
      ? 'Jarvis Code seems stuck: it went round the same few steps three times without getting anywhere.'
      : 'Jarvis Code seems stuck: it did the same step three times in a row without getting anywhere.');
    li.append(head);
    const steps = Array.isArray(e.steps) ? e.steps.filter((s) => typeof s === 'string' && s) : [];
    if (steps.length) {
      const list = el('ul', 'jc-loop-steps');
      for (const s of steps.slice(0, 3)) list.append(mine(el('li', '', s.slice(0, 200))));
      li.append(list);
    }
    const actions = el('div', 'jc-loop-actions');
    const id = Number(e.task_id) || 0;
    actions.append(
      button('Stop', 'btn primary', () => {
        if (id) send({ type: 'task_interrupt', id });
        actions.replaceChildren(el('span', 'jc-loop-done', 'Stopped.'));
      }),
      button('Let it carry on', 'btn', () => {
        actions.replaceChildren(el('span', 'jc-loop-done', 'Carrying on.'));
      }),
    );
    li.append(actions);
    return li;
  }

  F.registerEntry('loop', loopEntry);
})();
