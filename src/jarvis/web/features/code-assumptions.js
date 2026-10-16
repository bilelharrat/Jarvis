// Eden Code's assumption ledger (features/code_assumptions.py): every guess made instead of
// asking the owner — Eden's own auto-answers, a session choosing for itself while they were
// busy, and the session's own notes (its note_assumption tool) — with its evidence, its risk
// and an Undo. Drawn as the "Assumptions" section of a turn's proof card (code-receipts.js
// calls jarvisAssumptions.section), or as a card of its own for a turn that changed no files.
// Undo puts the files back as they were before that turn (the session's checkpoints), tells
// the session, and stops Eden giving that same auto-answer again; Keep (in the Needs
// attention inbox, code-attention.js) takes a high-risk one off the list.
// Settings › General › Assumptions: what a high-risk guess does (code_assume_high) and the
// optional model rating (code_assume_model, off). Pure logic exported for node's tests
// (tests/web/code-assumptions.test.mjs).
(function codeAssumptions(root) {
  'use strict';

  const RISK = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };
  const SOURCE = { auto_answer: 'Eden answered', own_choice: 'Chose while you were busy', agent: 'The session assumed' };
  const STATE = { kept: 'Kept', undone: 'Undone', refused: 'You decide' };
  const HIGH_MODES = [['inbox', 'Needs attention'], ['block', 'Ask me first']];

  // The rows worth drawing, high risk first (in the order they were made within a level).
  function rowsOf(list) {
    const rank = { high: 0, medium: 1, low: 2 };
    return (Array.isArray(list) ? list : [])
      .filter((r) => r && typeof r.id === 'string' && r.question && r.answer && r.risk in RISK)
      .map((r, i) => [r, i])
      .sort((a, b) => rank[a[0].risk] - rank[b[0].risk] || a[1] - b[1])
      .map(([r]) => r);
  }

  // The section's heading: "Assumptions (3)", "Assumptions (3, 1 high risk)".
  function heading(rows) {
    const high = rows.filter((r) => r.risk === 'high').length;
    return high ? `Assumptions (${rows.length}, ${high} high risk)` : `Assumptions (${rows.length})`;
  }

  // An entry can be undone while it's open or kept; one undone or refused is history.
  function canUndo(state) {
    return state === 'open' || state === 'kept' || !state;
  }

  // One line for a screen reader.
  function spoken(r) {
    const why = r.why ? `: ${r.why}` : '';
    const ev = r.evidence ? ` Evidence: ${r.evidence}.` : ' No evidence given.';
    return `${SOURCE[r.source] || SOURCE.agent}: ${r.question} → ${r.answer}. ${RISK[r.risk]}${why}.${ev}`;
  }

  const api = { RISK, SOURCE, STATE, HIGH_MODES, rowsOf, heading, canUndo, spoken };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;
  const el = F.el;
  const t = (text) => F.t(text);
  const states = new Map();  // entry id -> its state now (code_assumptions, code_assume_result)

  function stateOf(r) { return states.get(r.id) || r.state || 'open'; }

  function setRow(li, r, note) {
    const state = stateOf(r);
    li.classList.toggle('asm-done', !canUndo(state));
    const tag = li.querySelector('.asm-state');
    if (tag) { tag.textContent = STATE[state] ? t(STATE[state]) : ''; tag.hidden = !STATE[state]; }
    const undo = li.querySelector('.asm-undo');
    if (undo) undo.hidden = !canUndo(state);
    const said = li.querySelector('.asm-said');
    if (said && note != null) said.textContent = note;
  }

  function row(r) {
    const li = el('li', `asm-row asm-${r.risk}`);
    li.dataset.asm = r.id;
    li.setAttribute('aria-label', spoken(r));
    const top = el('div', 'asm-top');
    top.append(el('span', `rc-risk rc-${r.risk}`, t(RISK[r.risk])), el('span', 'asm-source', t(SOURCE[r.source] || SOURCE.agent)));
    const tag = el('span', 'asm-state');
    tag.hidden = true;
    top.append(tag);
    const qa = el('p', 'asm-qa');
    qa.dataset.noI18n = '';  // (the session's own words)
    qa.append(el('span', 'asm-q', r.question), document.createTextNode(' → '), el('strong', 'asm-a', r.answer));
    const ev = el('p', 'asm-ev', r.evidence ? `${t('Evidence')}: ${r.evidence}` : t('No evidence given'));
    ev.dataset.noI18n = '';
    const why = el('p', 'asm-why', r.why || '');
    why.dataset.noI18n = '';
    const undo = el('button', 'jc-btn small asm-undo', t('Undo'));
    undo.type = 'button';
    undo.title = t('Put the files back as they were before this turn (and every later turn), and tell the session to ask next time');
    undo.setAttribute('aria-label', `${t('Undo')}: ${r.question} → ${r.answer}`);
    undo.addEventListener('click', () => { undo.disabled = true; F.send({ type: 'code_assume_undo', id: r.id }); });
    const said = el('p', 'asm-said');
    said.setAttribute('role', 'status');
    said.dataset.noI18n = '';
    li.append(top, qa, ev, why, undo, said);
    setRow(li, r);
    return li;
  }

  // The section a receipt card (or a card of its own) gets.
  function section(list) {
    const rows = rowsOf(list);
    if (!rows.length) return null;
    const box = el('section', 'asm-box');
    const title = heading(rows);
    box.setAttribute('aria-label', title);
    box.append(el('h4', '', title));
    const ul = el('ul', 'asm-list');
    ul.append(...rows.slice(0, 20).map(row));
    box.append(ul);
    return box;
  }
  root.jarvisAssumptions = { section };

  // A turn that changed no files: its guesses as a card of their own.
  F.registerEntryDecorator((e, li) => {
    if (!e || e.receipt || !Array.isArray(e.assumptions) || !li) return;
    const box = section(e.assumptions);
    if (!box) return;
    li.className = 'jc-note asm-card';
    li.replaceChildren(box);
  });

  function refresh(id, note) {
    for (const li of document.querySelectorAll('.asm-row')) {
      if (li.dataset.asm !== id) continue;
      const undo = li.querySelector('.asm-undo');
      if (undo) undo.disabled = false;
      setRow(li, { id, state: states.get(id) }, note);
    }
  }
  F.on('code_assume_result', (ev) => {
    if (!ev || typeof ev.id !== 'string') return;
    if (ev.state) states.set(ev.id, ev.state);
    refresh(ev.id, ev.text || '');
  });
  F.on('code_assumptions', (ev) => {
    for (const e of (ev && Array.isArray(ev.entries) ? ev.entries : [])) {
      if (e && typeof e.id === 'string' && typeof e.state === 'string' && states.get(e.id) !== e.state) {
        states.set(e.id, e.state);
        refresh(e.id);
      }
    }
  }, { replay: true });

  // ── Eden Code settings › General › Assumptions ──
  let pick = null;
  let sw = null;
  let model = false;
  function build() {
    const general = typeof document !== 'undefined' && document.getElementById('jcs-general');
    if (!general || document.getElementById('asm-high')) return;
    const label = el('p', 'jcs-label', t('Assumptions'));
    const group = el('div', 'jcs-group');
    const first = el('label', 'jcs-row');
    const words = el('span');
    words.append(document.createTextNode(t('High-risk guesses')),
      el('small', '', t('Every guess a session makes instead of asking you is on its turn’s receipt, with an Undo. A high-risk one (pushing, deleting, auth, money…) also waits for you.')));
    pick = el('select', 'jcs-select');
    pick.id = 'asm-high';
    for (const [value, words2] of HIGH_MODES) {
      const o = el('option', '', t(words2));
      o.value = value;
      pick.append(o);
    }
    pick.addEventListener('change', () => F.send({ type: 'feature_prefs', changes: { code_assume_high: pick.value } }));
    first.append(words, pick);
    const second = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t('Rate guesses with a model too')),
      el('small', '', t('One Haiku call for each guess the rules rate low or medium, up to 100 a day; it can only raise the risk. Off: rules only, no cost.')));
    sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = 'asm-model';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t('Rate guesses with a model too'));
    sw.setAttribute('aria-checked', 'false');
    sw.addEventListener('click', () => {
      model = !model;
      sw.setAttribute('aria-checked', String(model));
      F.send({ type: 'feature_prefs', changes: { code_assume_model: model } });
    });
    second.append(text, sw);
    group.append(first, second);
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
  }
  const take = (features) => {
    const f = features || {};
    if (pick) pick.value = f.code_assume_high === 'block' ? 'block' : 'inbox';
    model = f.code_assume_model === true;
    if (sw) sw.setAttribute('aria-checked', String(model));
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
