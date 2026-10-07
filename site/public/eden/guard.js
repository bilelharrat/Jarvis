// Protection against hidden instructions, on the page (ROADMAP H8, docs/prompt-injection.md).
// The server decides (src/chat/provenance.ts marks what a turn read; src/chat/guard.ts holds
// any side effect proposed after it read something untrusted). This file only shows it:
//   - the source strip on a reply that read content from outside, with a "possible hidden
//     instructions" badge on each flagged source;
//   - the approval card for a held action: what will happen, what was read before it, and a
//     warning when an address or link came from that content rather than from the owner. Its
//     buttons send only { id, approve } (POST /api/chat/guard/answer): the server runs exactly
//     what it holds, so nothing on the page can change it;
//   - click-to-load for images in such replies (markdown.js draws them as .g-img).
// proposeAction() is for page features that act on a reply (meeting actions, a reply's
// suggestions): it asks the gate first and attaches the card when the action is held.

import { el, ico, toast } from './util.js';
import { postJSON } from './api.js';
import { ui, saveConversation } from './state.js';

const SOURCE_LABELS = {
  mail: 'Email', web: 'Web page', search: 'Web search', file: 'File', attachment: 'Attached file', image: 'Image',
  screen: 'Screen text', meeting: 'Meeting transcript', calendar: 'Calendar event', note: 'Note', memory: 'Memory',
  brief: 'Brief', browser: 'Browser page', tool: 'Tool output', reply: 'Earlier reply', context: 'Attached context',
};
const STATE_TEXT = {
  done: 'Done', approved: 'Approved', denied: 'Denied — nothing was done', expired: 'Expired — nothing was done (approvals last 15 minutes)', failed: 'Approved, but it failed',
};

/** Whether this reply was written after reading content from outside (its links and images are held). */
export function isTainted(node) {
  return !!(node && node.provenance && node.provenance.tainted);
}

const flagged = (sources) => (sources || []).filter((s) => s.flags && s.flags.length);
/** "Email: Invoice #4471" — the kind once, whether or not the title already starts with it. */
function sourceName(s) {
  const kind = SOURCE_LABELS[s.kind] || 'Content';
  const t = String(s.title || '').trim();
  if (!t || t.toLowerCase() === kind.toLowerCase()) return kind;
  return t.toLowerCase().startsWith(`${kind.toLowerCase()}:`) ? t : `${kind}: ${t}`;
}
/** The title without a leading "Email:" (the row shows the kind beside it). */
const bareTitle = (s) => { const kind = SOURCE_LABELS[s.kind] || ''; const t = String(s.title || '').trim(); return kind && t.toLowerCase().startsWith(`${kind.toLowerCase()}:`) ? t.slice(kind.length + 1).trim() : t === kind ? '' : t; };

function badge(n) {
  return el('span', { class: 'g-badge', title: 'Rules spotted text that looks like instructions for an AI. Eden treats it as data either way.' },
    ico('bell', 11), n > 1 ? `possible hidden instructions · ${n}` : 'possible hidden instructions');
}

function sourceRow(s) {
  const kind = SOURCE_LABELS[s.kind] || 'Content';
  const title = bareTitle(s);
  return el('li', 'g-src',
    el('div', 'g-src-h', el('span', 'g-kind', kind), title ? el('span', 'g-title', title) : null, s.flags && s.flags.length ? badge(s.flags.length) : null),
    s.origin ? el('div', 'g-origin', s.origin) : null,
    s.hidden ? el('div', 'g-hidden', `${s.hidden} hidden part${s.hidden === 1 ? '' : 's'} of its HTML left out`) : null,
    s.flags && s.flags.length ? el('ul', 'g-flags', ...s.flags.map((f) => el('li', '', el('b', '', f.label), f.excerpt ? el('q', '', f.excerpt) : null))) : null);
}

/** Strips the owner opened (a reply re-renders while it streams and after). */
const openStrips = new Set();

/**
 * "Read content from outside" on a reply: the sources, and a badge when the rules flagged any.
 * A <details>, so it opens with the keyboard and keeps no state of its own.
 */
export function sourceStrip(node) {
  if (!isTainted(node)) return null;
  const sources = node.provenance.sources || [];
  const hits = flagged(sources);
  const kinds = [...new Set(sources.map((s) => SOURCE_LABELS[s.kind] || 'content'))];
  const what = sources.length === 1 ? sourceName(sources[0]) : `${sources.length} sources: ${kinds.slice(0, 3).join(', ')}${kinds.length > 3 ? '…' : ''}`;
  return el('details', { class: `g-strip${hits.length ? ' flagged' : ''}`, open: openStrips.has(node.id), ontoggle: (e) => { if (e.target.open) openStrips.add(node.id); else openStrips.delete(node.id); } },
    el('summary', { title: 'This reply read content from outside. Eden treats it as data, and asks you before acting on anything after it.' },
      ico('lock', 12), el('span', 'g-strip-t', `Read from outside: ${what}`),
      hits.length ? badge(hits.reduce((n, s) => n + s.flags.length, 0)) : null, ico('chevr', 11, 'g-chev')),
    el('div', 'g-strip-body',
      el('p', 'g-note', 'Eden gave this to the model as data, never as instructions, and anything it proposes after reading it waits for your OK. Links in this reply show where they go; images don’t load until you ask.'),
      el('ul', 'g-srcs', ...sources.map(sourceRow))));
}

/** The approval card for one held action. `perm`: the Code permission part it stands in for. */
export function approvalCard(c, node, a, { perm } = {}) {
  const state = a.state || 'pending';
  const open = state === 'pending';
  const warn = (a.warnings || []).length > 0;
  const card = el('div', { class: `g-card glass${open ? '' : ' answered'}${warn ? ' warned' : ''}`, role: 'group', 'aria-label': `Eden asks: ${a.label}` });
  card.append(el('div', 'g-head', el('span', 'g-shield', ico('lock', 15)), el('div', 'g-head-t', el('b', '', open ? `Eden wants to: ${a.label}` : a.label), el('span', '', a.summary || ''))));
  if (!open) {
    card.append(el('div', { class: `g-state ${state}`, role: 'status' },
      ico(state === 'done' || state === 'approved' ? 'check' : 'x', 13), STATE_TEXT[state] || state, a.error ? `: ${a.error}` : ''));
    return card;
  }
  card.append(el('p', 'g-reason', a.reason || 'This turn read content from outside, so Eden needs your OK before it acts.'));
  if ((a.details || []).length) {
    card.append(el('dl', 'g-details', ...a.details.flatMap((d) => [el('dt', '', d.label), el('dd', '', d.value)])));
  }
  if (warn) {
    card.append(el('ul', { class: 'g-warns', role: 'list' }, ...a.warnings.map((w) => el('li', '', ico('bell', 12), el('span', '', el('code', '', w.value), ' — ', w.message)))));
  }
  if ((a.sources || []).length) {
    card.append(el('div', 'g-after', el('span', 'g-after-t', 'Read before this:'),
      ...a.sources.slice(0, 6).map((s) => el('span', 'g-after-s', sourceName(s), s.flags && s.flags.length ? badge(s.flags.length) : null))));
  }
  const deny = el('button', { type: 'button', class: 'btn', onclick: () => answer(c, node, a, false, perm) }, 'Deny');
  const ok = el('button', { type: 'button', class: `btn ${warn ? 'g-risky' : 'primary'}`, onclick: () => answer(c, node, a, true, perm) }, warn ? 'Approve anyway' : 'Approve');
  card.append(el('div', 'g-acts', deny, ok), el('div', 'g-foot', `Nothing happens until you choose. Expires ${new Date(a.expiresAt || Date.now() + 9e5).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`));
  return card;
}

/** Sends the owner's answer; the server runs what it holds (or, for Code, lets the next `continue` carry the tools). */
async function answer(c, node, a, approve, perm) {
  if (a.busy) return;
  a.busy = true;
  let r;
  try {
    r = await postJSON('/api/chat/guard/answer', { id: a.id, approve });
  } catch (e) {
    a.busy = false;
    // Gone on the server (it restarted, or 15 minutes passed): nothing was done, and nothing can be now.
    if (e.status === 404) { a.state = 'expired'; saveConversation(c); ui.updateMessage(c, node, { final: true }); }
    toast(`Couldn’t answer: ${e.message}`);
    return;
  }
  Object.assign(a, r.approval || {}, { busy: false });
  saveConversation(c);
  ui.updateMessage(c, node, { final: true });
  if (perm !== undefined) {
    // A Code permission: continue with those tools (approved) or record the denial.
    const { answerPermission } = await import('./chat.js');
    answerPermission(c, node, perm, approve && a.state === 'approved' ? 'once' : 'deny', { approval: a.id });
    return;
  }
  if (a.state === 'done') toast('Done');
  else if (a.state === 'failed') toast(`It failed: ${a.error || 'unknown error'}`);
  else if (a.state === 'denied') toast('Denied — nothing was done');
}

/**
 * For page features that act on a reply: asks the server's gate. Clear → { status: 'clear' }
 * (the feature goes on its usual way, with its own review); held → the card is added under the
 * reply and { status: 'held', approval } comes back; `run: true` lets the server run a clear one.
 */
export async function proposeAction(c, node, { tool, args = {}, summary, run = false }) {
  if (!node || !node.turnId) throw new Error('That reply has no turn id (send it again).');
  const r = await postJSON('/api/chat/guard/propose', { turn: node.turnId, tool, args, ...(summary ? { summary } : {}), ...(run ? { run: true } : {}) });
  if (r.status === 'held') {
    (node.approvals = node.approvals || []).push(r.approval);
    saveConversation(c);
    ui.updateMessage(c, node, { final: true });
  }
  return r;
}

/* ---------- click-to-load images (markdown.js draws them as button.g-img) ---------- */

function hostOf(u) { try { return new URL(u).hostname; } catch { return u; } }

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button.g-img');
  if (!b || b.dataset.open) return;
  e.preventDefault();
  const url = b.dataset.url || '';
  b.dataset.open = '1';
  b.setAttribute('aria-expanded', 'true');
  const box = el('span', { class: 'g-img-open', role: 'note' },
    el('span', '', `This image is at ${hostOf(url)}. Loading it tells that site you read this reply, along with anything in its address:`),
    el('code', '', url),
    el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer', class: 'cap' }, ico('ext', 11), 'Open in a new tab'));
  b.after(box);
});
