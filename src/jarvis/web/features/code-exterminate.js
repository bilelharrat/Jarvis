// Eden Code's bug fixes go to Exterminator Mode first (features/code_exterminate.py): the
// composer's own messages (a new session's first, task_new; one to a session, task_send) carry
// bugfix_offer, so the backend may hold a bug hunt on its card ("This looks like a bug fix. Run
// Exterminator Mode on <project>?") before it goes; messages any other part of the app sends
// never carry it, so a queue, an issue's or a routine's run is never asked. The empty session's
// "Exterminate bugs" starter opens Exterminator Mode's own start card for the project in front
// (code_bugfix_start, as its composer switch does). Eden Code settings › General › Exterminator
// Mode: "Offer Exterminator Mode for bug fixes" (feature pref code_bugfix_offer, on by
// default). When Exterminator Mode's start card is turned down, the words come back to the
// composer they were typed in (code_exterminate_draft). No model is called here; detection is
// the backend's local word rules. Pure helpers are exported for node --test
// (tests/web/code-exterminate.test.mjs).
(function (root) {
  'use strict';

  const LABEL = 'Offer Exterminator Mode for bug fixes';
  const NOTE = 'When a message looks like a bug hunt (“fix the bugs”, “debug this”), Eden Code asks first whether to run Exterminator Mode on the project instead. Once a session, and never for a specific small change.';

  // What a composer's message carries: the mark, only when there are words to read.
  const sessionFields = (prompt) => (String(prompt || '').trim() ? { bugfix_offer: true } : {});
  const sendFields = (task, text) => (task && String(text || '').trim() ? { bugfix_offer: true } : {});
  // The starter's command: Exterminator Mode's start card for the project (null with none).
  const startMessage = (project) => (project ? { type: 'code_bugfix_start', project } : null);
  // Whether words handed back are for the composer showing now: the same session, or (for a
  // new session's first message) no session open, in the same project.
  function draftFits(ev, task, project) {
    if (!ev || typeof ev.text !== 'string' || !ev.text) return false;
    if (ev.id != null) return !!task && task.id === ev.id;
    return !task && !!project && project === ev.directory;
  }

  const api = { sessionFields, sendFields, startMessage, draftFits, LABEL, NOTE };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t, send } = F;
  const project = () => (typeof deckProject === 'string' ? deckProject : '');
  let on = true;  // prefs.features.code_bugfix_offer

  F.registerSessionOption((prompt) => sessionFields(prompt));
  F.registerSendOption((task, text) => sendFields(task, text));

  // ── the empty session's starter ──
  const starter = document.getElementById('jc-starter-exterminate');
  if (starter) {
    starter.addEventListener('click', () => {
      const msg = startMessage(project());
      if (msg) send(msg);  // its card, with the rounds, models and ceiling, comes first
      // With no project there's nothing to sweep: said, not a press that does nothing (round 3, U3-11).
      else if (typeof jcNote === 'function') jcNote(t('Pick a project first.'));
    });
  }

  // ── the words back, when Exterminator Mode didn't start ──
  F.on('code_exterminate_draft', (ev) => {
    const input = document.getElementById('deck-input');
    if (!input || !draftFits(ev, F.currentTask(), project())) return;
    try { if (typeof awaitingNewSession !== 'undefined') awaitingNewSession = false; } catch (_) { /* (not this window's) */ }
    if (input.value.trim()) return;  // (something new typed meanwhile: left as it is)
    input.value = ev.text;
    input.dispatchEvent(new Event('input'));
    input.focus();
  });

  // ── Eden Code settings › General ──
  let sw = null;
  function build() {
    const general = document.getElementById('jcs-general');
    if (!general || document.getElementById('cx-offer')) return;
    const label = el('p', 'jcs-label', 'Exterminator Mode');
    const group = el('div', 'jcs-group');
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t(LABEL)), el('small', '', NOTE));
    sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = 'cx-offer';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t(LABEL));
    sw.setAttribute('aria-checked', String(on));
    sw.addEventListener('click', () => {
      on = !on;
      sw.setAttribute('aria-checked', String(on));
      send({ type: 'feature_prefs', changes: { code_bugfix_offer: on } });
    });
    row.append(text, sw);
    group.append(row);
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
  }
  const take = (features) => {
    on = !features || features.code_bugfix_offer !== false;
    if (sw) sw.setAttribute('aria-checked', String(on));
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
