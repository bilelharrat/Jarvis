// Jarvis Code in the cloud (features/code_cloud.py): the composer's "Cloud" switch starts a new
// session on the owner's cloud machine, where it keeps working while the Mac sleeps; /away
// (or "I'm heading out" by voice) moves every working session there after one card.
// helpers is exported for node --test (tests/web/code-cloud.test.mjs).
(function (root) {
  'use strict';

  const helpers = {
    // The switch's tooltip for the cloud machine's state.
    tip(state) {
      if (!state || !state.machine) return 'Add a cloud machine in Jarvis Code settings › Machines to start sessions there.';
      if (!state.ready) return `${state.machine} isn't ready: ${state.problem || 'test it in Machines.'}`;
      return `Runs on ${state.machine}: it keeps working while your Mac sleeps or is shut.`;
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
  pill.addEventListener('click', () => { on = !on; draw(); });

  function draw() {
    const row = document.querySelector('#deck-composer .jc-composer-row');
    if (row && !pill.isConnected) row.insertBefore(pill, row.querySelector('.jc-spacer'));
    const starting = !F.currentTask() && typeof deckProject === 'string' && !!deckProject;
    const usable = !!(state && state.machine && state.ready);
    pill.hidden = !starting || !(state && state.machine);
    pill.disabled = !usable;
    if (!usable) on = false;
    pill.setAttribute('aria-pressed', String(on));
    pill.classList.toggle('on', on);
    pill.title = t(helpers.tip(state));
  }

  /* global deckProject */
  F.registerSessionOption(() => {
    if (pill.hidden || !on) return {};
    setTimeout(() => { on = false; draw(); });  // the next session starts here unless switched again
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
