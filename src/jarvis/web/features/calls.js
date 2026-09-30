// A call Jarvis placed for the owner, live in the window (the backend is jarvis.features.calls):
// the transcript as it goes, the question it's waiting on (answered here, on its card, on the
// phone or out loud), "Tell it…" (words that join the next turn), Take over (the owner's own
// phone is put through) and Hang up. What the other side says is their words: text only, marked
// data-no-i18n. Pure helpers are exported for node --test (tests/web/calls.test.mjs).
(function (root) {
  'use strict';

  const STATUS = {
    ringing: 'Ringing',
    talking: 'On the call',
    hold: 'On hold',
    asking: 'Needs you',
    done: 'Ending',
    yours: 'Putting you through',
  };
  const WHO = { them: 'Them', jarvis: 'Jarvis', owner: 'You' };

  function statusLabel(call) {
    if (call && call.yours) return STATUS.yours;
    return STATUS[call && call.status] || STATUS.talking;
  }

  // How long it's been going, as m:ss ("" without a start).
  function elapsed(at, now) {
    const began = Date.parse(at || '');
    if (Number.isNaN(began)) return '';
    const seconds = Math.max(0, Math.floor((now - began) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  // What to send for the panel's answer box: [choice, text], or null for nothing.
  function answerFor(choice, text) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (choice === 'answer') return words ? ['answer', words] : null;
    return ['allow', 'deny', 'later'].includes(choice) ? [choice, ''] : null;
  }

  const api = { statusLabel, elapsed, answerFor, STATUS, WHO };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  let calls = [];
  const notes = new Map(); // call id -> the latest word on something the owner did
  let panel = null;
  let ticker = 0;

  function button(label, cls, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function answerRow(call) {
    const box = el('div', 'cl-ask');
    box.append(el('p', 'cl-ask-title', 'They’re asking'), mine(el('p', 'cl-ask-q', call.asking)));
    const field = el('input', 'cl-field');
    field.type = 'text';
    field.maxLength = 500;
    field.placeholder = t('Your answer');
    field.setAttribute('aria-label', t('Your answer'));
    const go = (choice) => {
      const found = answerFor(choice, field.value);
      if (!found) return;
      send({ type: 'call_answer', id: call.id, choice: found[0], text: found[1] });
      field.value = '';
    };
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go('answer'); } });
    const row = el('div', 'cl-row');
    row.append(
      field,
      button('Send', 'btn primary', () => go('answer')),
    );
    const quick = el('div', 'cl-row cl-quick');
    quick.append(
      button('Yes', 'btn', () => go('allow')),
      button('No', 'btn', () => go('deny')),
      button('Call back later', 'btn', () => go('later')),
    );
    box.append(row, quick);
    return box;
  }

  function tellRow(call) {
    const form = el('form', 'cl-row cl-tell');
    const field = el('input', 'cl-field');
    field.type = 'text';
    field.maxLength = 500;
    field.placeholder = t('Tell it…');
    field.setAttribute('aria-label', t('Tell it…'));
    form.append(field, button('Send', 'btn', () => form.requestSubmit()));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const words = field.value.replace(/\s+/g, ' ').trim();
      if (!words) return;
      send({ type: 'call_tell', id: call.id, text: words });
      field.value = '';
    });
    return form;
  }

  function renderCall(call) {
    const box = el('article', `cl-call cl-${call.yours ? 'yours' : call.status}`);
    box.dataset.call = call.id;
    const head = el('header', 'cl-head');
    const title = el('div', 'cl-title');
    title.append(el('span', 'cl-dot'), mine(el('strong', '', call.who)));
    const status = el('span', 'cl-status', statusLabel(call));
    const clock = el('span', 'cl-clock');
    clock.dataset.at = call.at || '';
    clock.textContent = elapsed(call.at, Date.now());
    head.append(title, status, clock);
    box.append(head);
    if (call.goal) box.append(mine(el('p', 'cl-goal', call.goal)));
    if (call.asking && !call.yours) box.append(answerRow(call));
    const list = el('ol', 'cl-turns');
    list.setAttribute('aria-live', 'polite');
    for (const turn of call.turns || []) {
      const li = el('li', `cl-turn cl-${turn.who}`);
      li.append(el('span', 'cl-speaker', WHO[turn.who] || ''), mine(el('span', 'cl-words', turn.text)));
      list.append(li);
    }
    if (!(call.turns || []).length) list.append(el('li', 'cl-empty', 'Waiting for them to pick up…'));
    box.append(list);
    if (!call.yours && call.status !== 'done') box.append(tellRow(call));
    const actions = el('div', 'cl-actions');
    const take = button('Take over', 'btn', () => send({ type: 'call_takeover', id: call.id }));
    take.disabled = !call.can_take_over || call.yours || call.status === 'done';
    if (!call.can_take_over) take.title = t('Add your own number under Settings › Phone to take over calls.');
    actions.append(take, button('Hang up', 'btn cl-hangup', () => send({ type: 'call_hangup', id: call.id })));
    box.append(actions);
    const note = el('p', 'cl-note');
    note.setAttribute('aria-live', 'polite');
    note.textContent = notes.get(call.id) || '';
    box.append(note);
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    return box;
  }

  // Redrawn whole on each change (a call has at most forty turns); a field being typed in
  // keeps its words.
  function render() {
    if (!calls.length) {
      if (panel) { panel.remove(); panel = null; }
      clearInterval(ticker);
      ticker = 0;
      return;
    }
    const typed = new Map();
    if (panel) {
      for (const field of panel.querySelectorAll('.cl-field')) {
        const id = field.closest('.cl-call').dataset.call;
        typed.set(`${id}:${field.closest('.cl-ask') ? 'ask' : 'tell'}`, [field.value, field === document.activeElement]);
      }
    }
    if (!panel) {
      panel = el('aside', 'call-live');
      panel.id = 'call-live';
      panel.setAttribute('aria-label', t('Live call'));
      document.body.append(panel);
    }
    panel.replaceChildren(...calls.map(renderCall));
    for (const field of panel.querySelectorAll('.cl-field')) {
      const id = field.closest('.cl-call').dataset.call;
      const kept = typed.get(`${id}:${field.closest('.cl-ask') ? 'ask' : 'tell'}`);
      if (kept) { field.value = kept[0]; if (kept[1]) field.focus(); }
    }
    if (!ticker) {
      ticker = setInterval(() => {
        if (!panel) return;
        for (const clock of panel.querySelectorAll('.cl-clock')) clock.textContent = elapsed(clock.dataset.at, Date.now());
      }, 1000);
    }
  }

  F.on('call_live', (ev) => { calls = Array.isArray(ev.calls) ? ev.calls : []; render(); }, { replay: true });
  F.on('call_note', (ev) => {
    notes.set(ev.id, String(ev.note || ''));
    const note = panel && panel.querySelector(`[data-call="${CSS.escape(String(ev.id))}"] .cl-note`);
    if (note) note.textContent = ev.note || '';
  });

  // The card asking the owner in the main window: the question, Yes / No / Call back later,
  // and an answer in their own words.
  if (F.registerApprovalView) {
    F.registerApprovalView((a, where, answer) => {
      if (!a || a.ask_kind !== 'call_ask' || where !== 'card') return null;
      const box = el('div', 'cl-card');
      if (a.detail) box.append(mine(el('p', 'cl-card-detail', a.detail)));
      const field = el('input', 'cl-field');
      field.type = 'text';
      field.maxLength = 500;
      field.placeholder = t('Or answer in your own words');
      field.setAttribute('aria-label', t('Your answer'));
      const own = () => { const found = answerFor('answer', field.value); if (found) answer(found[0], found[1]); };
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); own(); } });
      const row = el('div', 'cl-row');
      row.append(field, button('Send', 'btn primary', own));
      const actions = el('div', 'card-actions');
      for (const c of a.choices || []) actions.append(button(c.label, 'btn', () => answer(c.id)));
      box.append(row, actions);
      return box;
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
