// Jarvis Code's full export (features/code_export.py), from the More menu: the whole
// session (every message, each step's input and output, the thinking) as a page or a PDF,
// share-safe (keys and tokens blanked out, pictures left out) if asked, and with where
// things are on this Mac hidden if asked.
(function (root) {
  'use strict';

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const choice = { safe: false, anonymize: false, format: 'html' };
  let pending = '';  // the ref of the export being made
  let result = null;  // { ok, path, name } | { error }
  let refN = 0;

  function shown() { return typeof currentPane !== 'undefined' && currentPane === 'cw-export' && !F.$('jc-pane').hidden; }

  function option(name, value, label, note) {
    const row = el('label', 'cx-option');
    const input = el('input');
    input.type = 'radio';
    input.name = `cx-${name}`;
    input.checked = choice[name] === value;
    input.addEventListener('change', () => { choice[name] = value; drawn = keyNow(); });  // (drawn as it is)
    const words = el('span', 'cx-words');
    words.append(el('strong', '', label));
    if (note) words.append(el('small', '', note));
    row.append(input, words);
    return row;
  }

  // (The pane is drawn again on every session change: only what changed is redrawn, so a
  // choice being made keeps its focus.)
  let drawn = '';
  function keyNow() {
    const t = F.currentTask();
    return JSON.stringify([t ? t.id : 0, choice, pending, result && (result.path || result.error)]);
  }
  function draw(body, again = false) {
    const t = F.currentTask();
    const key = keyNow();
    if (!again && key === drawn && body.querySelector(':scope > .cx-root, :scope > .jc-empty')) return;
    drawn = key;
    if (!t) { body.replaceChildren(el('p', 'jc-empty', 'Open a session to export it.')); return; }
    const what = el('fieldset', 'cx-group');
    what.append(el('legend', '', 'What'),
      option('safe', false, 'Everything', 'Every message, each step’s input and output, the thinking and pictures'),
      option('safe', true, 'Share-safe', 'The same, with keys, tokens and passwords blanked out, and no pictures'));
    const hide = el('label', 'cx-option cx-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = choice.anonymize;
    box.addEventListener('change', () => { choice.anonymize = box.checked; drawn = keyNow(); });  // (drawn as it is)
    const hideWords = el('span', 'cx-words');
    hideWords.append(el('strong', '', 'Hide where things are on this Mac'), el('small', '', 'Your home folder, the project’s folder and your user name'));
    hide.append(box, hideWords);
    const format = el('fieldset', 'cx-group');
    format.append(el('legend', '', 'As'), option('format', 'html', 'A page (HTML)', 'Opens in any browser'), option('format', 'pdf', 'A PDF', 'Laid out for printing, steps opened'));
    const go = el('button', 'jc-btn cx-go', pending ? 'Exporting…' : 'Export');
    go.type = 'button';
    go.disabled = !!pending;
    go.addEventListener('click', () => {
      pending = `x${++refN}`;
      result = null;
      F.send({ type: 'cw_export', id: t.id, safe: choice.safe, anonymize: choice.anonymize, format: choice.format, ref: pending });
      draw(body, true);
    });
    const parts = [what, hide, format, go];
    if (result && result.error) parts.push(el('p', 'cx-result bad', result.error));
    if (result && result.ok) {
      const done = el('div', 'cx-result');
      done.append(el('span', '', 'Saved in Documents › Jarvis › Jarvis Code:'), mine(el('code', '', result.name)));
      const reveal = el('button', 'jc-mini', 'Show in Finder');
      reveal.type = 'button';
      reveal.addEventListener('click', () => F.send({ type: 'cw_export_reveal', path: result.path }));
      done.append(reveal);
      parts.push(done);
    }
    const box2 = el('div', 'cx-root');
    box2.append(...parts);
    body.replaceChildren(box2);
  }

  F.registerPane('cw-export', { title: 'Export', render: (body) => draw(body) });
  if (F.registerMoreItem) F.registerMoreItem({ label: 'Export the whole session…', run: () => F.openPane('cw-export'), when: (t) => !!t });

  F.on('cw_export', (ev) => {
    if (!ev.ref || ev.ref !== pending) return;
    pending = '';
    result = ev;
    if (shown()) draw(F.$('jc-pane-body'), true);
  });
})(typeof window === 'object' ? window : globalThis);
