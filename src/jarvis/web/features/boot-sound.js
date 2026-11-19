// Eden Code's start-up sound switch: Settings › General › "Play the start-up sound", in Eden Code's
// own window only (app/flavor.js; server.eden_code_page marks the body data-app="eden-code").
//
// The sound itself is played by the app, not this page (app/features/boot-sound.js: macOS's own
// player, once per launch, as the window first shows), so the choice is kept in Eden Code's own
// folder, where the app reads it before any page has loaded: this switch asks and sets it through
// the window's bridge (jarvisApp.feature, 'feature:boot-sound'; true/false sets it, nothing asks).
// In Eden Code's window it takes the place of Eden Secretary's "Boot-up sound" row (boot_sound in
// the backend's prefs, which Eden Secretary's own loading page plays by), so there is one switch,
// and the one that counts. It lives in Eden Code's own settings (the sheet ⌘, opens there),
// General › "When it opens", above the shortcuts line (round 2, U8: it was only in the shared
// Settings sheet, which ⌘, no longer opens in Eden Code); with no such sheet, in the shared one. In a browser tab, Eden Secretary's window or the split pane there's no
// such bridge or no Eden Code body, and nothing changes. No model is called; nothing is sent.
// Window commands/events: none (the app's IPC only).
(function (root) {
  'use strict';

  const LABEL = 'Play the start-up sound';
  const NOTE = 'A short sound as Eden Code opens. It follows your volume and mute.';

  // The row, put in place of the shared one; returns the switch (or null when there's nothing to do).
  function mount(doc, bridge) {
    if (!doc || !doc.body || doc.body.dataset.app !== 'eden-code') return null;
    if (!bridge || typeof bridge.invoke !== 'function') return null;
    if (doc.getElementById('sw-code-boot-sound')) return null;
    const shared = doc.getElementById('sw-boot-sound');
    const sharedRow = shared && shared.closest ? shared.closest('.row') : null;

    // Eden Code's settings sheet (#jcs-general) when there is one: its own row and switch look.
    const general = doc.getElementById('jcs-general');
    const row = doc.createElement('div');
    row.className = general ? 'jcs-row' : 'row';
    const text = doc.createElement('span');
    const strong = doc.createElement(general ? 'span' : 'strong');
    strong.textContent = LABEL;
    const small = doc.createElement('small');
    small.textContent = NOTE;
    text.append(strong, small);
    const sw = doc.createElement('button');
    sw.type = 'button';
    sw.className = general ? 'jcs-switch' : 'switch';
    sw.id = 'sw-code-boot-sound';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'true'); // on by default, until the app says otherwise
    sw.setAttribute('aria-label', LABEL);
    row.append(text, sw);

    const show = (on) => { if (typeof on === 'boolean') sw.setAttribute('aria-checked', String(on)); };
    sw.addEventListener('click', () => {
      const want = sw.getAttribute('aria-checked') !== 'true';
      show(want); // at once; the app's answer (what it kept) follows
      Promise.resolve(bridge.invoke('feature:boot-sound', want)).then(show, () => show(!want));
    });
    Promise.resolve(bridge.invoke('feature:boot-sound')).then(show, () => {});

    if (general) {
      const label = doc.createElement('p');
      label.className = 'jcs-label';
      label.textContent = 'When it opens';
      const group = doc.createElement('div');
      group.className = 'jcs-group';
      group.append(row);
      const foot = general.querySelector('.jcs-foot');
      if (foot) { general.insertBefore(label, foot); general.insertBefore(group, foot); } else general.append(label, group);
      if (sharedRow) sharedRow.hidden = true;
    } else if (sharedRow && sharedRow.parentNode) {
      sharedRow.parentNode.insertBefore(row, sharedRow);
      sharedRow.hidden = true;
    } else {
      const general = doc.querySelector('#settings > section.group[data-settings-pane="general"]');
      if (!general) return null;
      general.append(row);
    }
    return sw;
  }

  if (typeof module === 'object' && module.exports) { module.exports = { mount, LABEL, NOTE }; return; }
  const app = root.jarvisApp;
  mount(root.document, app && app.feature);
})(typeof window !== 'undefined' ? window : globalThis);
