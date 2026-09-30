// Jarvis Code's memory files (features/code_memory.py): where a "# note" goes. The note
// waits in the transcript with the three places it can go (the last one chosen first):
// the project's CLAUDE.md, its CLAUDE.local.md, or the owner's ~/.claude/CLAUDE.md. Not
// saved, it goes back in the composer.
(function (root) {
  'use strict';

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const PLACES = {
    project: ['Project', 'CLAUDE.md: shared with whoever works on it'],
    local: ['Just me, here', 'CLAUDE.local.md: yours, this project only'],
    user: ['Just me, everywhere', '~/.claude/CLAUDE.md: yours, every project'],
  };

  F.on('cw_memory_ask', (ev) => {
    const timeline = F.$('deck-timeline');
    if (!timeline || !ev.ref) return;
    const li = el('li', 'cm-ask');
    const head = el('div', 'cm-head');
    head.append(el('span', '', 'Save this note to'), mine(el('q', 'cm-note', ev.text || '')));
    const row = el('div', 'cm-choices');
    let chosen = false;
    const choose = (target) => {
      if (chosen) return;
      chosen = true;
      F.send({ type: 'cw_memory_save', ref: ev.ref, target });
      li.remove();
      const input = F.$('deck-input');
      if (!target && input && !input.value.trim()) {  // not saved: it's the owner's to keep
        input.value = `# ${ev.text || ''}`;
        input.dispatchEvent(new Event('input'));
        input.focus();
      }
    };
    const order = (ev.choices || []).slice().sort((a, b) => (b.target === ev.last) - (a.target === ev.last));
    let first = null;
    for (const c of order) {
      const place = PLACES[c.target];
      if (!place) continue;
      const b = el('button', `jc-mini cm-choice${c.target === ev.last ? ' last' : ''}`, place[0]);
      b.type = 'button';
      b.title = place[1];
      b.dataset.target = c.target;
      b.addEventListener('click', () => choose(c.target));
      row.append(b);
      first = first || b;
    }
    const cancel = el('button', 'jc-mini cm-cancel', 'Don’t save');
    cancel.type = 'button';
    cancel.addEventListener('click', () => choose(null));
    row.append(cancel);
    li.append(head, row);
    li.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); choose(null); } });
    timeline.append(li);
    const scroll = F.$('cc-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    if (first) first.focus();
  });
})(typeof window === 'object' ? window : globalThis);
