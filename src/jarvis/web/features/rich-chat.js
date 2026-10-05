// The main chat the way the Claude, ChatGPT and Gemini apps show it:
// - The reply in full Markdown (headings, lists, tables, links, code blocks with Copy), drawn
//   by app.js's richText with code-markdown.js's renderer (DOM calls only: nothing the model
//   writes becomes markup).
//   app.js still writes the plain reply into #reply; this draws it beside, in #reply-rich.
// - Under a finished reply: Copy, Read Aloud (chat_say), Try Again ("Give me a different
//   answer.", which conversation_branch answers in a new branch), Good and Bad Response
//   (chat_feedback; a bad one asks what was wrong, kept as a correction).
// - The console transcript's replies (#history) in Markdown too.
// helpers is exported for node --test (tests/web/rich-chat.test.mjs).
(function (root) {
  'use strict';

  const TRY_AGAIN = 'Give me a different answer.';

  // A [label](target) somewhere in s, in one pass: as a regex, /\[[^\]]+\]\([^)]+\)/ scans
  // to the end from every "[" (or "[a](") that doesn't close, quadratic in a long reply, and
  // this runs again on every streamed word.
  function hasLink(s) {
    const lastClose = s.lastIndexOf(')');
    let open = -1;  // the first "[" since the last "]"
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '[') {
        if (open < 0) open = i;
      } else if (c === ']') {
        if (open >= 0 && open < i - 1 && s[i + 1] === '(' && i + 2 < s.length && s[i + 2] !== ')' && lastClose > i + 2) return true;
        open = -1;
      }
    }
    return false;
  }

  const helpers = {
    // Worth drawing as Markdown: anything with a mark Markdown uses (plain sentences stay text).
    looksMarked(text) {
      const s = String(text || '');
      return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|.*\|)|\*\*|__|`[^`]+`/.test(s) || hasLink(s);
    },
    // The buttons a reply gets: none while it's being written or empty.
    actionsFor(text, state) {
      if (!String(text || '').trim()) return [];
      if (state === 'thinking' || state === 'listening') return [];
      return ['copy', 'read', 'again', 'good', 'bad'];
    },
    TRY_AGAIN,
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const t = (s) => F.t(s);
  // app.js's richText: code-markdown.js's full renderer once it registered, else its own lite one.
  // eslint-disable-next-line no-undef
  const md = () => (typeof richText === 'function' ? { render: richText } : null);

  let state = 'idle';
  let reply = null;
  let rich = null;
  let bar = null;
  let note = null;

  function button(cls, label, icon, run) {
    const b = F.el('button', `rc-btn ${cls}`);
    b.type = 'button';
    b.title = t(label);
    b.setAttribute('aria-label', t(label));
    b.append(F.el('span', 'rc-icon', icon), F.el('span', 'rc-label', t(label)));
    b.addEventListener('click', run);
    return b;
  }

  function text() { return reply ? reply.textContent || '' : ''; }

  function draw() {
    if (!reply || !rich) return;
    const words = text();
    const renderer = md();
    const marked = renderer && helpers.looksMarked(words);
    reply.classList.toggle('rc-hidden', Boolean(marked));
    rich.hidden = !marked;
    if (marked) rich.replaceChildren(renderer.render(words));
    drawBar();
  }

  function drawBar() {
    if (!bar) return;
    const actions = helpers.actionsFor(text(), state);
    bar.hidden = !actions.length;
    if (!actions.length) { closeNote(); return; }
  }

  function copy(btn) {
    const words = text();
    const done = () => {
      btn.querySelector('.rc-label').textContent = t('Copied');
      setTimeout(() => { btn.querySelector('.rc-label').textContent = t('Copy'); }, 1500);
    };
    try {
      navigator.clipboard.writeText(words).then(done, done);
    } catch (_) { done(); }
  }

  function openNote() {
    if (note) return;
    note = F.el('form', 'rc-note');
    const input = F.el('input', 'rc-note-input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = t('What was wrong? (optional)');
    const save = F.el('button', 'btn rc-note-save', t('Save'));
    save.type = 'submit';
    const cancel = F.el('button', 'btn ghost rc-note-cancel', t('Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', closeNote);
    note.append(input, save, cancel);
    note.addEventListener('submit', (e) => {
      e.preventDefault();
      F.send({ type: 'chat_feedback', good: false, note: input.value });
      closeNote();
    });
    bar.after(note);
    input.focus();
  }

  function closeNote() {
    if (note) { note.remove(); note = null; }
  }

  function mount() {
    reply = F.$('reply');
    if (!reply || F.$('reply-rich')) return;
    rich = F.el('div', 'reply reply-rich');
    rich.id = 'reply-rich';
    rich.hidden = true;
    rich.setAttribute('data-no-i18n', '');
    reply.after(rich);
    bar = F.el('div', 'rc-bar');
    bar.id = 'reply-actions';
    bar.hidden = true;
    let copyBtn = null;
    copyBtn = button('rc-copy', 'Copy', '⧉', () => copy(copyBtn));
    bar.append(
      copyBtn,
      button('rc-read', 'Read Aloud', '🔊', () => F.send({ type: 'chat_say', text: text() })),
      button('rc-again', 'Try Again', '↻', () => F.send({ type: 'ask', text: TRY_AGAIN })),
      button('rc-good', 'Good Response', '👍', () => F.send({ type: 'chat_feedback', good: true })),
      button('rc-bad', 'Bad Response', '👎', openNote),
    );
    rich.after(bar);
    new MutationObserver(draw).observe(reply, { childList: true, characterData: true, subtree: true });
    draw();

    const history = F.$('history');
    if (history) {
      const drawHistory = () => {
        const renderer = md();
        if (!renderer) return;
        for (const li of history.querySelectorAll('li.assistant:not([data-rc])')) {
          const node = li.firstChild;
          const words = node && node.nodeType === 3 ? node.textContent : '';
          li.setAttribute('data-rc', '1');
          if (words && helpers.looksMarked(words)) node.replaceWith(renderer.render(words));
        }
      };
      new MutationObserver(drawHistory).observe(history, { childList: true });
      drawHistory();
    }
  }

  F.on('state', (ev) => { state = (ev && (ev.value || ev.state)) || state; drawBar(); }, { replay: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})(typeof window !== 'undefined' ? window : globalThis);
