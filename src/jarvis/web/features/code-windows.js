// Eden Code on Windows (item 49): on a PC, Eden Code settings › General lists what works
// another way there and what's the Mac's alone, each with why ("On this PC"), so a feature
// that isn't there explains itself instead of seeming broken. The list is the backend's
// (features/code_windows.py, codeparity.REPORT: code_parity {} -> code_parity {os, features});
// on a Mac it's empty and nothing shows. The whole table: docs/eden-code-windows-parity.md.
(function codeWindows(root) {
  'use strict';

  const STATE = { another: 'Works another way', mac: 'Mac only' };

  // The rows to show, from a code_parity event: [{ id, name, state, why }], only on Windows.
  function rows(ev) {
    if (!ev || ev.os !== 'windows' || !Array.isArray(ev.features)) return [];
    return ev.features
      .filter((f) => f && typeof f.name === 'string' && STATE[f.state])
      .map((f) => ({ id: String(f.id || ''), name: f.name, state: f.state, label: STATE[f.state], why: String(f.why || '') }));
  }

  const api = { rows, STATE };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;

  function build(ev) {
    const general = document.getElementById('jcs-general');
    const list = rows(ev);
    for (const old of document.querySelectorAll('#cw-parity, .cw-parity-label')) old.remove();  // (asked again: drawn anew)
    if (!general || !list.length) return;
    const label = el('p', 'jcs-label cw-parity-label', 'On this PC');
    const group = el('div', 'jcs-group cw-parity');
    group.id = 'cw-parity';
    for (const f of list) {
      const row = el('div', 'jcs-row');
      row.dataset.feature = f.id;
      const text = el('span');
      text.append(document.createTextNode(t(f.name)), el('small', '', f.why));
      row.append(text, el('span', `cw-state cw-${f.state}`, f.label));
      group.append(row);
    }
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
  }

  F.on('code_parity', build, { replay: true });
  F.on('hello', () => F.send({ type: 'code_parity' }), { replay: true });
})(typeof window === 'object' ? window : globalThis);
