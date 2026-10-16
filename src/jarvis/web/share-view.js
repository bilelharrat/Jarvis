// Share live's drawing, shared by both viewer pages: the one the Mac serves on its network
// (web/share.js) and the one askeden.com serves for links that work anywhere
// (site/public/live/live.js, which decrypts first). The two pages' copies of this file are
// the same byte for byte (tests/web/code-share-live.test.mjs). Everything from the session is
// put in with textContent: nothing is ever read as HTML.
(function (root) {
  'use strict';

  const KEPT = 1000;  // entries shown at most: the oldest go (a long session stays light)
  const ROLE_NAMES = { user: 'Request', assistant: 'Eden', tool: 'Step', system: 'Note', note: 'Note', plan: 'Plan', turn: '' };
  const SEAT_NAMES = { viewer: 'watching', commenter: 'watching, can suggest', driver: 'driver: can ask for messages and answers' };

  // How long is left, in words.
  function leftText(expires, now) {
    const s = Math.max(0, Math.round(expires - now));
    if (s <= 0) return 'ended';
    if (s < 3600) return `ends in ${Math.max(1, Math.round(s / 60))} min`;
    return `ends in ${Math.round(s / 3600)} h`;
  }

  // Who this page is, in words: "Sam · driver: …" (name: the owner's words for them).
  function seatText(name, role) {
    const seat = SEAT_NAMES[role] || SEAT_NAMES.viewer;
    return name ? `${name} · ${seat}` : seat;
  }

  // Entries into the list: a new one at the end; one already shown (a step whose outcome
  // and output came in after it was sent) in its place; past KEPT, the oldest go. shown is a
  // Map n -> node; make(entry) a node or null; list has append/insertBefore/removeChild.
  function placeEntries(list, shown, entries, make, kept) {
    for (const e of entries || []) {
      const n = e.n || 0;
      const node = make(e);
      const old = shown.get(n);
      if (old) {
        if (node) list.replaceChild(node, old); else list.removeChild(old);
        if (node) shown.set(n, node); else shown.delete(n);
        continue;
      }
      if (!node) continue;
      list.appendChild(node);
      shown.set(n, node);
    }
    const most = kept || KEPT;
    while (shown.size > most) {
      const [n, node] = shown.entries().next().value;
      shown.delete(n);
      if (node.parentNode === list) list.removeChild(node);
    }
  }

  function maker(doc) {
    return (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  }

  // One transcript entry's node (null for what isn't shown).
  function entryNode(doc, e) {
    if (e.role === 'turn') return null;
    const make = maker(doc);
    const li = make('li', `entry ${e.role}`);
    const who = ROLE_NAMES[e.role] || e.role;
    li.append(make('div', 'who', e.role === 'tool' ? `${who}: ${e.tool || ''}` : who));
    const body = make('div', 'body', e.text || '');
    if (e.output) body.append(make('pre', '', e.output));
    li.append(body);
    return li;
  }

  // The session's changes into the page: files (its box), empty (its "No changes" line) and
  // count (the tab's number).
  function drawChanges(doc, where, c) {
    const make = maker(doc);
    const list = (c && c.files) || [];
    where.files.replaceChildren();
    where.empty.hidden = list.length > 0;
    where.count.textContent = list.length ? `(${list.length})` : '';
    for (const f of list) {
      const box = make('article', 'file');
      const head = make('h3', '', f.path);
      head.append(make('span', '', ` +${f.added} −${f.removed}${f.withheld ? ' · lines not shared' : ''}`));
      box.append(head);
      for (const h of f.hunks || []) {
        const pre = make('pre', 'hunk');
        pre.setAttribute('aria-label', `Change ${h.n}, line ${h.line}`);
        pre.append(make('span', 'head', `@@ change ${h.n}${h.where ? ` in ${h.where}` : ''}, line ${h.line}`));
        for (const [tag, text] of h.lines) {
          pre.append(make('span', `ln${tag === '+' ? ' add' : tag === '-' ? ' del' : ''}`, `${tag === ' ' ? ' ' : tag} ${text}`));
        }
        box.append(pre);
      }
      where.files.append(box);
    }
  }

  // The session's questions waiting on its owner. A driver gets a button per answer, which
  // only suggests it (answer(approval id, choice id)): the owner's own tap answers.
  function drawApprovals(doc, box, approvals, answer) {
    const make = maker(doc);
    box.replaceChildren();
    box.hidden = !(approvals && approvals.length);
    for (const a of approvals || []) {
      const card = make('article', 'ask');
      card.append(make('p', 'ask-q', a.question || 'The session has a question'));
      if (a.detail) card.append(make('pre', 'ask-detail', a.detail));
      if (answer) {
        const row = make('p', 'ask-row');
        for (const c of a.choices || []) {
          const b = make('button', '', `Suggest: ${c.label || c.id}`);
          b.type = 'button';
          b.addEventListener('click', () => answer(a.id, c.id, b));
          row.append(b);
        }
        card.append(row);
      } else {
        card.append(make('p', 'dim', 'Waiting on the owner.'));
      }
      box.append(card);
    }
  }

  const api = { KEPT, ROLE_NAMES, SEAT_NAMES, leftText, seatText, placeEntries, entryNode, drawChanges, drawApprovals };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.edenShareView = api;
})(typeof window === 'object' ? window : globalThis);
