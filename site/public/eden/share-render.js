// A shared chat's snapshot drawn as the shared page shows it (ROADMAP Q3): the same function
// for the public page (share-view.js) and the owner's preview before sharing (share.js), so the
// preview is exactly what will be shared. Every message is rendered as untrusted Markdown
// (markdown.js with untrusted: text only, never HTML; links say where they go; images not loaded).

import { el, ico } from './util.js';
import { renderMarkdown } from './markdown.js';

const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function providerOf(model = '') {
  const s = String(model || '').toLowerCase();
  if (/claude|anthropic|sonnet|opus|haiku/.test(s)) return 'claude';
  if (/gpt|openai|o1|o3|o4/.test(s)) return 'gpt';
  if (/gemini|google/.test(s)) return 'gemini';
  if (/kimi|moonshot/.test(s)) return 'kimi';
  return '';
}

/** One message card in a shared chat (snapshot message or collaborator reply). */
export function renderSharedMessage(m, idx = 0) {
  const isUser = m.role === 'user';
  const prov = !isUser && m.model ? providerOf(m.model) : '';
  const chipLabel = isUser
    ? (m.author ? `${m.author}` : 'Prompt')
    : m.model ? `Reply · ${m.model}` : 'Reply';
  const who = el('div', 'shr-who',
    !isUser ? el('span', `pdot${prov ? ` ${prov}` : ''}`) : (m.author ? el('span', 'shr-collab-dot') : null),
    el('span', { class: 'shr-who-text', ...(m.author ? { 'data-no-i18n': '' } : {}) }, chipLabel),
    m.author && m.at ? el('span', 'shr-who-time', ` · ${when(m.at)}`) : null);
  const md = el('div', 'md');
  md.append(renderMarkdown(m.text, { untrusted: true, noCanvas: true }));
  const bubble = el('div', 'shr-bubble', md);
  const copyBtn = el('button', {
    type: 'button',
    class: 'shr-copy-msg',
    'data-act': 'copy-msg',
    'data-idx': String(idx),
    title: isUser ? 'Copy message' : 'Copy reply',
    'aria-label': isUser ? 'Copy message' : 'Copy reply',
  }, ico('copy', 13), el('span', '', 'Copy'));
  copyBtn._rawText = m.text || '';
  const bar = el('div', 'shr-msg-head', who, copyBtn);
  return el('article', { class: `shr-msg ${m.role}${m.author ? ' collab' : ''}`, 'aria-label': isUser ? (m.author ? `Message from ${m.author}` : 'Message') : 'Reply' }, bar, bubble);
}

/** The snapshot as nodes: a header (title, when it was shared, mode) and the messages. */
export function renderSnapshot(snap, { preview = false, collaborative = false } = {}) {
  const isCollab = collaborative || snap.mode === 'collaborate';
  const modeLabel = isCollab ? 'collaborative' : 'read-only';
  const head = el('header', 'shr-head',
    el('div', 'shr-head-top',
      el('div', 'shr-head-titles',
        el('h1', { class: 'shr-title', 'data-no-i18n': '' }, snap.title),
        el('div', 'shr-sub', `${snap.messages.length} message${snap.messages.length === 1 ? '' : 's'}${snap.shared ? ` · shared ${when(snap.shared)}` : ''} · ${modeLabel}`))),
  );
  const list = el('div', 'shr-msgs');
  snap.messages.forEach((m, idx) => {
    list.append(renderSharedMessage(m, idx));
  });
  if (!snap.messages.length) list.append(el('p', 'shr-empty', 'No messages picked.'));
  return el('div', { class: `shr${preview ? ' preview' : ''}${isCollab ? ' collab-on' : ''}` }, head, list);
}

/** Clicks inside a rendered share: Copy on code blocks or messages; a held image shows where it is (never loads it). */
export function wireSnapshot(root, copy) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.dataset.act === 'copy-code') {
      const blk = b.closest('.cblock');
      if (blk && blk._code !== undefined) copy(blk._code);
    } else if (b.dataset.act === 'copy-msg') {
      if (typeof b._rawText === 'string') copy(b._rawText);
    } else if (b.classList.contains('g-img')) {
      const open = b.getAttribute('aria-expanded') === 'true';
      b.setAttribute('aria-expanded', String(!open));
      const next = b.nextElementSibling;
      if (open && next && next.classList.contains('g-dest')) next.remove();
      else if (!open) b.after(el('span', 'g-dest', `(${b.dataset.url})`));
    }
  });
}
