// Pairing mode (features/code_pairing.py): the Pairing pane mirrors this session's isolated
// copy into a folder of the owner's, live both ways, for their own editor. It has the
// on/off switch, the folder, Open in (Finder or an editor on this Mac), the files changed
// on both sides with Keep mine / Keep Eden's, and the held files (ones that run by
// themselves) with Bring them over.
// helpers is exported for node --test (tests/web/code-pairing.test.mjs).
(function (root) {
  'use strict';

  const helpers = {
    // The status line under the switch.
    status(ev) {
      if (!ev || !ev.copy) return 'Pairing is for a session in an isolated copy.';
      if (ev.error) return `The last sync failed: ${ev.error}`;
      if (!ev.on) return 'Off. Turn it on to mirror this copy into a folder you open in your own editor.';
      const extra = [];
      if (ev.conflicts && ev.conflicts.length) extra.push(`${ev.conflicts.length} changed on both sides`);
      if (ev.held && ev.held.length) extra.push(`${ev.held.length} held for you`);
      return extra.length ? `On: ${extra.join(', ')}.` : 'On: changes go both ways.';
    },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  // Drawn anew with the keyboard kept in its place (code-focus.js): after this pane's own
  // buttons the focus would otherwise fall to the page (round 2, U5).
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const state = { last: null, body: null, editors: [] };
  const taskId = () => { const task = F.currentTask(); return task && task.kind === 'code' ? task.id : 0; };

  function button(label, cls, run) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  // Whether the Pairing pane is the one showing: the pane's body is shared by every pane
  // (#jc-pane-body), so being on the page isn't enough, and an event drawn into it while
  // another pane is open would draw over that pane.
  /* global currentPane */
  const paneShown = () => state.body && state.body.isConnected && typeof currentPane !== 'undefined' && currentPane === 'pairing';

  function render() {
    const body = state.body;
    if (!paneShown()) return;
    const ev = state.last;
    const id = taskId();
    const wrap = el('div', 'jcx-pair');
    wrap.append(el('p', 'jc-dim', 'Pairing mirrors this session’s isolated copy into a folder you open in your own editor: its changes appear there and yours come back, about every second. When you both change the same file, neither is overwritten: it’s listed below until you keep one.'));
    const status = el('p', 'jcx-pair-status', helpers.status(ev));
    status.setAttribute('role', 'status');
    const group = el('div', 'jcs-group');
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(el('strong', '', 'Pairing'), status);
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!(ev && ev.on)));
    sw.setAttribute('aria-label', t('Pairing'));
    sw.disabled = !(ev && ev.copy);
    const input = el('input', 'jcs-input jcx-pair-folder');
    input.id = 'jcx-pair-folder';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = (ev && ev.folder) || '';
    input.placeholder = (ev && ev.suggested) || '~/Eden Pairing/…';
    input.disabled = !!(ev && ev.on);
    sw.addEventListener('click', () => send({ type: 'code_pair', id, on: !(ev && ev.on), folder: input.value.trim() }));
    row.append(text, sw);
    const folderRow = el('div', 'jcs-row jcx-pair-where');
    const label = el('label', '', 'Folder');
    label.htmlFor = input.id;
    folderRow.append(label, input);
    group.append(row, folderRow);
    if (ev && ev.on) {
      const open = el('div', 'jcx-pair-open');
      open.append(button('Show in Finder', '', () => send({ type: 'code_pair_open', id, editor: 'finder' })));
      for (const editor of state.editors.slice(0, 4)) {
        const b = button(`Open in ${editor.name}`, '', () => send({ type: 'code_pair_open', id, editor: editor.id }));
        open.append(b);
      }
      group.append(open);
    }
    wrap.append(group);
    if (ev && ev.conflicts && ev.conflicts.length) {
      wrap.append(el('p', 'jcs-label', 'Changed on both sides'));
      const list = el('ul', 'jcx-pair-list');
      for (const path of ev.conflicts) {
        const li = el('li');
        const name = el('code', '', path);
        name.dataset.noI18n = '';
        const keep = el('span', 'jcx-pair-keep');
        // Each button says which file it keeps (a name on the span around them is never read).
        const mineBtn = button('Keep mine', '', () => send({ type: 'code_pair_keep', id, path, side: 'mine' }));
        mineBtn.setAttribute('aria-label', `${t('Keep mine')}: ${path}`);
        const edenBtn = button('Keep Eden’s', '', () => send({ type: 'code_pair_keep', id, path, side: 'eden' }));
        edenBtn.setAttribute('aria-label', `${t('Keep Eden’s')}: ${path}`);
        keep.append(mineBtn, edenBtn);
        li.append(name, keep);
        list.append(li);
      }
      wrap.append(list);
    }
    if (ev && ev.held && ev.held.length) {
      wrap.append(el('p', 'jcs-label', 'Held for you'));
      wrap.append(el('p', 'jc-dim', 'The session changed files that run by themselves (git hooks, Eden’s .jarvis, your editor’s settings). They reach your folder only when you bring them over.'));
      const list = el('ul', 'jcx-pair-list');
      for (const path of ev.held) {
        const li = el('li');
        const name = el('code', '', path);
        name.dataset.noI18n = '';
        li.append(name);
        list.append(li);
      }
      wrap.append(list, button('Bring them over', 'tinted', () => send({ type: 'code_pair_release', id })));
    }
    keepFocus(body, () => body.replaceChildren(wrap));
  }

  F.registerPane('pairing', {
    title: 'Pairing',
    render(body) {
      state.body = body;
      state.last = null;
      render();
      const id = taskId();
      if (id) send({ type: 'code_pair_state', id });
      send({ type: 'cw_editors' });
    },
  });
  F.registerMoreItem({ label: 'Pairing', run: () => F.openPane('pairing') });

  F.on('code_pair', (ev) => { if (ev.id === taskId()) { state.last = ev; render(); } });
  F.on('cw_editors', (ev) => { state.editors = ev.items || []; render(); });
})(typeof window !== 'undefined' ? window : globalThis);
