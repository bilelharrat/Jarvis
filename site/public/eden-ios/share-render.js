// A shared chat's snapshot drawn as the read-only page shows it (ROADMAP Q3): the same function
// for the public page (share-view.js) and the owner's preview before sharing (share.js), so the
// preview is exactly what will be public. Every message is rendered as untrusted Markdown
// (markdown.js with untrusted: text only, never HTML; links say where they go; images not loaded).

import { el } from './util.js';
import { renderMarkdown } from './markdown.js';

const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** The snapshot as nodes: a header (title, when it was shared) and the messages. */
export function renderSnapshot(snap, { preview = false } = {}) {
  const head = el('header', 'shr-head',
    el('h1', 'shr-title', snap.title),
    el('div', 'shr-sub', `${snap.messages.length} message${snap.messages.length === 1 ? '' : 's'}${snap.shared ? ` · shared ${when(snap.shared)}` : ''} · read-only`));
  const list = el('div', 'shr-msgs');
  for (const m of snap.messages) {
    const md = el('div', 'md');
    md.append(renderMarkdown(m.text, { untrusted: true, noCanvas: true }));
    list.append(el('article', { class: `shr-msg ${m.role}`, 'aria-label': m.role === 'user' ? 'Message' : 'Reply' },
      el('div', 'shr-who', m.role === 'user' ? 'Prompt' : m.model ? `Reply · ${m.model}` : 'Reply'),
      md));
  }
  if (!snap.messages.length) list.append(el('p', 'shr-empty', 'No messages picked.'));
  return el('div', { class: `shr${preview ? ' preview' : ''}` }, head, list);
}

/** Clicks inside a rendered share: Copy on code blocks; a held image shows where it is (never loads it). */
export function wireSnapshot(root, copy) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.dataset.act === 'copy-code') {
      const blk = b.closest('.cblock');
      if (blk && blk._code !== undefined) copy(blk._code);
    } else if (b.classList.contains('g-img')) {
      const open = b.getAttribute('aria-expanded') === 'true';
      b.setAttribute('aria-expanded', String(!open));
      const next = b.nextElementSibling;
      if (open && next && next.classList.contains('g-dest')) next.remove();
      else if (!open) b.after(el('span', 'g-dest', `(${b.dataset.url})`));
    }
  });
}
