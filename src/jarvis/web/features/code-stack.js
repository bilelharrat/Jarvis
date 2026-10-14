// Eden Code's stacked pull requests (features/code_stack.py): the Stack pane (the More menu)
// for the session in front. "Propose a stack" splits its branch's changes into parts by
// folder, "Group by topic" asks Claude (Haiku) to; the owner renames parts, moves each change
// to another part (a select on its row, keyboard-reachable), reorders and adds parts, then
// "Open the stack…" (the backend asks on a card first). Below, the session's stacks and
// their pull requests.
//
// Paths and titles are the project's words: text only (textContent), marked data-no-i18n.
// Pure helpers are exported for node --test (tests/web/code-stack.test.mjs).
(function (root) {
  'use strict';

  // The parts as the backend takes them back: titles and hunk ids.
  function toMessage(parts) {
    return (parts || []).map((p) => ({ title: String(p.title || '').trim(), hunks: (p.hunks || []).map((h) => h.id) }));
  }

  // One hunk moved to part `to` (a new part when `to` is the parts' length).
  function moveHunk(parts, id, to) {
    const out = parts.map((p) => ({ title: p.title, hunks: p.hunks.filter((h) => h.id !== id) }));
    const hunk = parts.flatMap((p) => p.hunks).find((h) => h.id === id);
    if (!hunk) return parts;
    if (to >= out.length) out.push({ title: '', hunks: [] });
    out[Math.max(0, to)].hunks.push(hunk);
    return out;
  }

  // A part moved up (-1) or down (+1).
  function movePart(parts, i, by) {
    const j = i + by;
    if (j < 0 || j >= parts.length) return parts;
    const out = parts.slice();
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }

  // "src/a.py:12 (+3 −1)".
  function hunkLabel(h) {
    if (!h || !h.path) return '';
    return `${h.path}:${h.line || 1} (+${h.added || 0} −${h.removed || 0})${h.where ? ` ${h.where}` : ''}`;
  }

  const WHY = {
    binary: 'is a binary file: it can’t go in a stack.',
    credentials: 'holds credentials: it can’t go in a stack.',
    renamed: 'was renamed: commit the rename on the branch itself first.',
    'no lines': 'has no lines to split (a mode change).',
  };

  const api = { toMessage, moveHunk, movePart, hunkLabel, WHY };
  if (typeof module === 'object' && module.exports) module.exports = api;

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  const state = { data: new Map(), edits: new Map() }; // key -> the latest code_stack event; key -> parts being edited
  let paneBody = null;
  const keyOf = (task) => (task ? `id:${task.id}` : '');

  function mine(text, tag = 'span', cls = '') {
    const node = el(tag, cls, text);
    node.dataset.noI18n = '';
    return node;
  }

  function button(label, cls, run, aria) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); run(b); });
    return b;
  }

  function partsFor(key) {
    if (state.edits.has(key)) return state.edits.get(key);
    const data = state.data.get(key);
    return data && data.proposal ? data.proposal.parts : [];
  }

  function save(task, parts) {
    state.edits.set(keyOf(task), parts);
    send({ type: 'code_stack_set', id: task.id, parts: toMessage(parts) });
    render();
  }

  function partCard(task, parts, i) {
    const part = parts[i];
    const box = el('section', 'jcx-stack-part');
    box.setAttribute('aria-label', `${t('Part')} ${i + 1}`);
    const head = el('div', 'jcx-stack-head');
    head.append(el('span', 'jcx-stack-n', String(i + 1)));
    const title = el('input', 'jcs-input');
    title.value = part.title || '';
    title.placeholder = t('An imperative commit subject');
    title.setAttribute('aria-label', `${t('Title of part')} ${i + 1}`);
    title.dataset.noI18n = '';
    title.addEventListener('change', () => save(task, parts.map((p, k) => (k === i ? { ...p, title: title.value } : p))));
    head.append(title,
      button('↑', 'jc-mini', () => save(task, movePart(parts, i, -1)), `${t('Move part up')} ${i + 1}`),
      button('↓', 'jc-mini', () => save(task, movePart(parts, i, 1)), `${t('Move part down')} ${i + 1}`));
    box.append(head);
    const list = el('ul', 'jcx-stack-hunks');
    for (const h of part.hunks) {
      const li = el('li');
      li.append(mine(hunkLabel(h), 'code'));
      const pick = el('select', 'jcs-select');
      pick.setAttribute('aria-label', `${t('Part for')} ${hunkLabel(h)}`);
      parts.forEach((_p, k) => {
        const o = el('option', '', `${t('Part')} ${k + 1}`);
        o.value = String(k);
        o.selected = k === i;
        pick.append(o);
      });
      const fresh = el('option', '', 'A new part');
      fresh.value = String(parts.length);
      pick.append(fresh);
      pick.addEventListener('change', () => save(task, moveHunk(parts, h.id, Number(pick.value))));
      li.append(pick);
      list.append(li);
    }
    box.append(list);
    return box;
  }

  function stackRow(stack) {
    const box = el('div', `jcx-stack-done ${stack.state}`);
    box.append(mine(`${stack.repo} · ${stack.branch}`, 'strong'));
    const list = el('ol', 'jcx-stack-prs');
    for (const p of stack.parts || []) {
      const li = el('li');
      const a = el('a', 'jcx-pr-link');
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.append(mine(`#${p.number}`, 'code'), mine(` ${p.title}`));
      li.append(a, el('span', `jcx-chip ${p.state === 'merged' ? 'good' : ''}`.trim(), p.state === 'merged' ? 'Merged' : p.state === 'closed' ? 'Closed' : 'Open'));
      list.append(li);
    }
    box.append(list);
    return box;
  }

  function draw(target, task) {
    paneBody = target;
    const wrap = el('div', 'jcx-stack');
    if (!task) {
      wrap.append(el('p', 'jc-empty', 'Open a session to split its changes into a stack.'));
      target.replaceChildren(wrap);
      return;
    }
    const key = keyOf(task);
    const data = state.data.get(key) || {};
    wrap.append(el('p', 'jc-dim', 'Split this branch’s changes into small pull requests, each based on the one before. Its own branch and folder aren’t touched.'));
    const bar = el('div', 'jcx-stack-bar');
    bar.append(
      button('Propose a stack', '', () => { state.edits.delete(key); send({ type: 'code_stack_propose', id: task.id }); }),
      button('Group by topic', '', () => { state.edits.delete(key); send({ type: 'code_stack_propose', id: task.id, ai: true }); }),
    );
    wrap.append(bar);
    if (data.note) wrap.append(mine(data.note, 'p', 'jc-dim jcx-stack-note'));
    const parts = partsFor(key);
    if (parts.length) {
      parts.forEach((_p, i) => wrap.append(partCard(task, parts, i)));
      const go = el('div', 'jcx-stack-bar');
      go.append(el('span', 'jc-spacer'), button('Open the stack…', 'filled', () => send({ type: 'code_stack_create', id: task.id })));
      wrap.append(go);
    }
    for (const u of data.unsplittable || []) {
      const p = el('p', 'jcx-stack-warn');
      p.append(mine(u.path, 'code'), el('span', '', ` ${t(WHY[u.why] || WHY.binary)}`));
      wrap.append(p);
    }
    if ((data.stacks || []).length) {
      wrap.append(el('p', 'jcs-label', 'This session’s stacks'));
      wrap.append(...data.stacks.slice().reverse().map(stackRow));
    }
    target.replaceChildren(wrap);
  }

  const shown = () => paneBody && paneBody.isConnected && paneBody.querySelector('.jcx-stack');
  const render = () => { if (shown()) draw(paneBody, F.currentTask()); };

  F.registerPane('stack', {
    title: 'Stacked pull requests',
    render(target, task) { draw(target, task); if (task) send({ type: 'code_stack', id: task.id }); },
  });
  F.registerMoreItem({ label: 'Stacked pull requests', run: () => F.openPane('stack') });
  F.on('code_stack', (ev) => {
    state.data.set(ev.key, ev);
    if (ev.proposal) state.edits.delete(ev.key);
    if (keyOf(F.currentTask()) === ev.key) render();
  });
  root.JarvisStacks = { state, WHY };
})(typeof window === 'object' ? window : globalThis);
