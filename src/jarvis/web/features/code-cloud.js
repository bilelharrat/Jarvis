// Eden Code in the cloud (features/code_cloud.py): the composer's "Cloud" switch starts a new
// session on the owner's cloud machine, where it keeps working while the Mac sleeps; /away
// (or "I'm heading out" by voice) moves every working session there after one card.
// helpers is exported for node --test (tests/web/code-cloud.test.mjs).
(function (root) {
  'use strict';

  const helpers = {
    // The switch's tooltip for the cloud machine's state.
    tip(state) {
      if (!state || !state.machine) return 'Add a cloud machine in Eden Code settings › Machines to start sessions there.';
      if (!state.ready) return `${state.machine} isn't ready: ${state.problem || 'test it in Machines.'}`;
      return `Runs on ${state.machine}: it keeps working while your Mac sleeps or is shut.`;
    },
    // How the switch shows. "on" is the owner's choice and is kept as it was until a session
    // starts: a start that failed, or the machine going not-ready for a moment, no longer
    // forgets it. It's only pressed (and sent) while the machine can take the session. When
    // it can't, the switch stays focusable (aria-disabled, not disabled) and the why is a
    // visible note it's described by, not only a tooltip a screen reader can't reach.
    view(state, on, starting) {
      const usable = !!(state && state.machine && state.ready);
      return {
        hidden: !starting || !(state && state.machine),
        usable,
        pressed: on && usable,
        note: usable ? '' : helpers.tip(state),
      };
    },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  let state = null;
  let on = false;

  const pill = el('button', 'jc-pill jcx-cloud-switch');
  pill.type = 'button';
  pill.id = 'jcx-cloud-switch';
  pill.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5h7a2.75 2.75 0 0 0 .4-5.47A4 4 0 0 0 4.2 7.1 2.7 2.7 0 0 0 4.5 12.5z"/></svg>';
  pill.append(el('span', '', 'Cloud'));
  pill.setAttribute('aria-describedby', 'jcx-cloud-note');
  const note = el('span', 'jcx-cloud-note');
  note.id = 'jcx-cloud-note';
  note.hidden = true;
  pill.addEventListener('click', () => {
    if (pill.getAttribute('aria-disabled') === 'true') return;  // (the note says why)
    on = !on;
    draw();
  });
  let sent = false;  // a session was asked for with the switch on: it's turned off once it starts

  function draw() {
    const row = document.querySelector('#deck-composer .jc-composer-row');
    if (row && !pill.isConnected) row.insertBefore(pill, row.querySelector('.jc-spacer'));
    if (row && !note.isConnected) pill.after(note);
    const starting = !F.currentTask() && typeof deckProject === 'string' && !!deckProject;
    if (sent && !starting) { sent = false; on = false; }  // it started: the next one starts here
    const v = helpers.view(state, on, starting);
    pill.hidden = v.hidden;
    pill.setAttribute('aria-disabled', String(!v.usable));
    pill.setAttribute('aria-pressed', String(v.pressed));
    pill.classList.toggle('on', v.pressed);
    pill.title = t(helpers.tip(state));
    note.hidden = v.hidden || !v.note;
    note.textContent = v.note ? t(v.note) : '';
  }

  /* global deckProject */
  F.registerSessionOption(() => {
    if (pill.hidden || !helpers.view(state, on, true).pressed) return {};
    sent = true;  // (kept on if the start fails; off once the session is open)
    return { cloud: true, isolated: true };
  });

  F.registerSlash({
    name: 'away',
    help: 'Heading out: move every working session to the cloud machine',
    withoutSession: true,
    run() { send({ type: 'code_cloud_away' }); return true; },
  });

  F.on('code_cloud', (ev) => { state = ev; draw(); });
  F.on('code_handoffs', () => send({ type: 'code_cloud_state' }));
  F.on('hello', () => send({ type: 'code_cloud_state' }), { replay: true });
  F.on('tasks', () => draw());
  const title = document.getElementById('jc-title');
  if (title) new MutationObserver(draw).observe(title, { childList: true, characterData: true, subtree: true });
})(typeof window !== 'undefined' ? window : globalThis);
