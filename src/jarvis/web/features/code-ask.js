// Claude Code's questions (AskUserQuestion) in Eden Code, drawn by this feature
// (jarvisFeatures.registerApprovalView): each option with what it means, several options
// ticked at once when the question takes them (multiSelect), and an answer of the owner's
// own ("Other"), as Claude Code's own question sheet has. The answer goes back through the
// approval: an option ("opt2"), several ("pick" with {picked, other}), or words of the
// owner's own ("other"); tasks.py turns it into Claude Code's answer.
//
// The question and its options are Claude's words: text only, marked data-no-i18n. Pure
// helpers are exported for node --test (tests/web/code-ask.test.mjs).
(function (root) {
  'use strict';

  const MAX = 2000;  // what hub.resolve keeps of an answer's words

  // What a question sheet sends: [choice, feedback], or null when there's nothing to send.
  function answerFor(multi, picked, other) {
    const own = String(other || '').replace(/\s+/g, ' ').trim().slice(0, MAX);
    const chosen = [...new Set((picked || []).filter((n) => Number.isInteger(n) && n >= 0))].sort((x, y) => x - y);
    if (!multi) {
      if (own) return ['other', own];
      return chosen.length ? [`opt${chosen[0]}`, ''] : null;
    }
    if (!chosen.length && !own) return null;
    if (!chosen.length) return ['other', own];
    // Several options and words of the owner's own, all within MAX: the words give way.
    const body = (words) => JSON.stringify(words ? { picked: chosen, other: words } : { picked: chosen });
    let words = own;
    while (words && body(words).length > MAX) words = words.slice(0, Math.max(0, words.length - (body(words).length - MAX))).trim();
    return ['pick', body(words)];
  }

  // Whether an approval is a question this sheet draws (tasks.py's, with its options).
  function isQuestion(a) {
    return !!a && a.ask_kind === 'question' && Array.isArray(a.options) && a.options.length > 0
      && Array.isArray(a.free_choices) && a.free_choices.includes('pick') && a.free_choices.includes('other');
  }

  const api = { answerFor, isQuestion };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || !F.registerApprovalView) return;
  const { el } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  function view(a, where, answer) {
    if (!isQuestion(a)) return null;
    const multi = !!a.multi;
    const box = el(where === 'sheet' ? 'li' : 'div', `cq cq-${where}${multi ? ' cq-multi' : ''}`);
    if (where === 'sheet') {
      const head = el('p', 'jc-ask-head');
      head.append(el('span', 'jc-ticon', '?'));
      const title = el('span', 'cq-title');
      if (a.header) title.append(mine(el('span', 'cq-header', a.header)));
      title.append(mine(el('span', '', a.question)));
      head.append(title);
      box.append(head);
    }
    // (A card outside Eden Code is in the app's own look: its buttons and fields.)
    const plain = where === 'card' ? 'btn' : 'jc-btn small';
    const ticked = new Set();
    const options = el('div', multi ? 'cq-options' : 'cq-options jc-choices');
    const send = el('button', `${where === 'card' ? 'btn primary' : 'jc-btn small filled'} cq-send`, multi ? 'Answer' : 'Send');
    send.type = 'button';
    const other = el('input', where === 'card' ? 'cq-other-input' : 'jc-field cq-other-input');
    if (where === 'card') other.type = 'text';  // (the app's own field; in the sheet, the workbench's)
    other.placeholder = multi ? 'Something else too (optional)' : 'Or answer in your own words';
    other.setAttribute('aria-label', 'Your own answer');
    other.maxLength = 2000;
    const refresh = () => { send.disabled = !answerFor(multi, [...ticked], other.value); };
    a.options.forEach((o, i) => {
      if (multi) {
        const row = el('label', 'cq-option');
        const tick = el('input', 'cq-tick');
        tick.type = 'checkbox';
        tick.dataset.index = String(i);
        tick.addEventListener('change', () => { if (tick.checked) ticked.add(i); else ticked.delete(i); refresh(); });
        tick.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
        const text = el('span', 'cq-text');
        text.append(mine(el('span', 'cq-label', o.label)));
        if (o.description) text.append(mine(el('small', '', o.description)));
        row.append(tick, el('kbd', '', String(i + 1)), text);
        options.append(row);
      } else {
        const b = el('button', `${plain} cq-choice`);
        b.type = 'button';
        const text = el('span', 'cq-text');
        text.append(mine(el('span', 'cq-label', o.label)));
        if (o.description) text.append(mine(el('small', '', o.description)));
        b.append(el('kbd', '', String(i + 1)), text);
        b.addEventListener('click', () => answer(`opt${i}`, ''));
        options.append(b);
      }
    });
    const go = () => {
      const out = answerFor(multi, [...ticked], other.value);
      if (out) answer(out[0], out[1]);
    };
    send.addEventListener('click', go);
    other.addEventListener('input', refresh);
    other.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    const own = el('div', 'cq-other');
    own.append(other, send);
    const skip = el('button', `${plain} cq-skip`, 'Skip');
    skip.type = 'button';
    skip.addEventListener('click', () => answer('skip', ''));
    own.append(skip);
    box.append(options, own);
    if (where === 'sheet') {
      box.append(el('p', 'jc-ask-hint', multi
        ? 'Tick with a number key, then press Answer. Or write your own answer.'
        : 'Press a number, say “option two”, or write your own answer.'));
    }
    refresh();
    return box;
  }

  F.registerApprovalView(view);

  // Several at once: a number key ticks that option on the sheet on show (app.js leaves
  // these sheets' number keys to it), unless something's being typed.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const n = Number(e.key);
    if (!(n >= 1 && n <= 9)) return;
    const focus = document.activeElement;
    const typing = focus && (focus.tagName === 'TEXTAREA' || focus.isContentEditable || (focus.tagName === 'INPUT' && focus.type !== 'checkbox'));
    if (typing) return;
    const sheet = document.querySelector('#deck-timeline > .jc-ask.cq-multi');
    const tick = sheet && sheet.querySelector(`.cq-tick[data-index="${n - 1}"]`);
    if (!tick) return;
    e.preventDefault();
    tick.checked = !tick.checked;
    tick.dispatchEvent(new Event('change'));
    tick.focus();
  });
})(typeof window === 'object' ? window : globalThis);
