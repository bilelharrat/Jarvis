// Settings › About: the app's version and, in the J.A.R.V.I.S. people download, Check for
// updates; when an update has downloaded, a card offers to restart into it now (app/features/
// updates.js is the app's side, which otherwise installs it by itself at a quiet moment). In a plain browser, where
// there's no app, there's nothing to show.
(() => {
  // What the group says for the app's state (English; i18n.js translates it as it appears).
  function lineFor(s) {
    if (!s || !s.enabled) return 'This copy doesn’t check for updates.';
    switch (s.state) {
      case 'checking': return 'Checking for updates…';
      case 'current': return 'Up to date.';
      case 'downloading': return `Downloading ${s.available}…`;
      case 'ready': return `${s.available} is ready to install.`;
      case 'move': case 'error': return s.error || 'Couldn’t check for updates.';
      default: return 'Checks for updates every 6 hours.';
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { lineFor };
  if (typeof window === 'undefined' || !window.jarvisFeatures) return;
  const F = window.jarvisFeatures;
  const bridge = window.jarvisApp && window.jarvisApp.feature ? window.jarvisApp.feature : null;
  if (!bridge) return;
  const CH = 'feature:updates:';

  let state = null;
  let dismissed = ''; // the version whose card was put off with Later
  let group = null;

  function buildGroup() {
    group = F.el('section', 'group updates-group');
    group.id = 'updates-group';
    const row = F.el('div', 'row');
    const text = F.el('span');
    const version = F.el('strong', '', 'J.A.R.V.I.S.');
    version.id = 'updates-version';
    version.setAttribute('data-no-i18n', ''); // the name and its version number, as they are
    const line = F.el('small', '', '');
    line.id = 'updates-line';
    line.setAttribute('aria-live', 'polite');
    text.append(version, line);
    const check = F.el('button', 'btn', 'Check for updates');
    check.type = 'button';
    check.id = 'updates-check';
    check.hidden = true;
    check.addEventListener('click', () => {
      check.disabled = true;
      bridge.invoke(`${CH}check`).then(show).catch(() => {}).finally(() => { check.disabled = false; });
    });
    const restart = F.el('button', 'btn primary', 'Restart to update');
    restart.type = 'button';
    restart.id = 'updates-restart';
    restart.hidden = true;
    restart.addEventListener('click', () => bridge.invoke(`${CH}restart`));
    row.append(text, check, restart);
    group.append(F.el('h3', '', 'About'), row);
    F.$('settings').append(group);
  }

  function card() {
    let box = F.$('updates-card');
    if (box) return box;
    box = F.el('div', 'card updates-card');
    box.id = 'updates-card';
    box.setAttribute('role', 'status');
    box.hidden = true;
    const words = F.el('p', '', '');
    words.id = 'updates-card-text';
    const now = F.el('button', 'btn primary', 'Restart now');
    now.type = 'button';
    now.addEventListener('click', () => bridge.invoke(`${CH}restart`));
    const later = F.el('button', 'btn', 'Later');
    later.type = 'button';
    later.addEventListener('click', () => { dismissed = state && state.available; box.hidden = true; });
    const actions = F.el('div', 'updates-card-actions');
    actions.append(later, now);
    box.append(words, actions);
    document.body.append(box);
    return box;
  }

  function show(next) {
    if (!next) return;
    state = next;
    if (!group) buildGroup();
    F.$('updates-version').textContent = `J.A.R.V.I.S. ${state.version}`;
    F.$('updates-line').textContent = lineFor(state);
    F.$('updates-check').hidden = !state.enabled || ['downloading', 'ready'].includes(state.state);
    F.$('updates-restart').hidden = state.state !== 'ready';
    const box = card();
    const ready = state.state === 'ready' && state.available !== dismissed;
    if (ready) F.$('updates-card-text').textContent = `J.A.R.V.I.S. ${state.available} is ready. Restart to install it.`;
    box.hidden = !ready;
  }

  bridge.on(`${CH}state`, show);
  bridge.invoke(`${CH}state`).then(show).catch(() => {});
})();
