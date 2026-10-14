// Eden Code's Share live viewer (features/code_share.py): the session's transcript, its
// changes and its status, polled from the Mac, read-only. Everything shown is text put in
// with textContent: nothing from the session is ever read as HTML. Pure helpers are
// exported for node --test (tests/web/share.test.mjs).
(function (root) {
  'use strict';

  const POLL_MS = 2000;
  const MORE_MS = 200;  // the next page soon, when the Mac said there's more
  const KEPT = 1000;  // entries shown at most: the oldest go (a long session stays light)
  const ROLE_NAMES = { user: 'Request', assistant: 'Eden', tool: 'Step', system: 'Note', note: 'Note', plan: 'Plan', turn: '' };

  // A viewer's own id for this tab (the owner sees how many are watching): random, never a name.
  function viewerId(random) {
    const bytes = new Uint8Array(12);
    (random || root.crypto).getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // The state's address for the page's own path (/share/<token>): the entries it has (up
  // to since), the update it has seen of them (u), and the changes it has (key).
  function stateUrl(path, viewer, since, key, seen) {
    const base = String(path || '').replace(/\/+$/, '');
    const q = new URLSearchParams({ v: viewer, since: String(since || 0), ck: key || '' });
    if (seen) q.set('u', String(seen));
    return `${base}/state?${q}`;
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

  // How long is left, in words.
  function leftText(expires, now) {
    const s = Math.max(0, Math.round(expires - now));
    if (s <= 0) return 'ended';
    if (s < 3600) return `ends in ${Math.max(1, Math.round(s / 60))} min`;
    return `ends in ${Math.round(s / 3600)} h`;
  }

  const api = { viewerId, stateUrl, leftText, placeEntries, ROLE_NAMES, KEPT };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const doc = root.document;
  const $ = (id) => doc.getElementById(id);
  const make = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  let viewer = '';
  try { viewer = root.sessionStorage.getItem('eden-share-viewer') || ''; } catch (_) { /* private mode */ }
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(viewer)) {
    viewer = viewerId();
    try { root.sessionStorage.setItem('eden-share-viewer', viewer); } catch (_) { /* private mode */ }
  }
  let since = 0;
  let seen = 0;
  const shown = new Map();
  let key = '';
  let expires = 0;
  let timer = null;

  function entry(e) {
    if (e.role === 'turn') return null;
    const li = make('li', `entry ${e.role}`);
    const who = ROLE_NAMES[e.role] || e.role;
    li.append(make('div', 'who', e.role === 'tool' ? `${who}: ${e.tool || ''}` : who));
    const body = make('div', 'body', e.text || '');
    if (e.output) body.append(make('pre', '', e.output));
    li.append(body);
    return li;
  }

  function drawChanges(c) {
    const files = $('files');
    files.replaceChildren();
    const list = (c && c.files) || [];
    $('changes-empty').hidden = list.length > 0;
    $('changes-count').textContent = list.length ? `(${list.length})` : '';
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
      files.append(box);
    }
  }

  function ended() {
    clearTimeout(timer);
    $('ended').hidden = false;
    $('status').textContent = 'ended';
    $('suggest').hidden = true;
  }

  async function poll() {
    let data;
    try {
      const reply = await fetch(stateUrl(root.location.pathname, viewer, since, key, seen), { cache: 'no-store', credentials: 'omit' });
      if (reply.status === 404) { ended(); return; }
      if (!reply.ok) { timer = setTimeout(poll, POLL_MS * 2); return; }
      data = await reply.json();
    } catch (_) {
      timer = setTimeout(poll, POLL_MS * 2);
      return;
    }
    $('title').textContent = data.title || 'Eden Code session';
    doc.title = `${data.title || 'Session'} · Eden Code (live)`;
    const status = $('status');
    if (status.textContent !== data.status) status.textContent = data.status;
    status.className = `chip ${data.status}`;
    $('doing').textContent = data.doing || '';
    expires = data.expires || 0;
    $('expires').textContent = `· ${leftText(expires, Date.now() / 1000)}`;
    for (const e of data.entries || []) since = Math.max(since, e.n || 0);
    seen = Math.max(seen, data.u || 0);
    placeEntries($('entries'), shown, data.entries, entry);
    if (data.changes) { key = data.changes_key || ''; drawChanges(data.changes); }
    $('suggest').hidden = !data.comments;
    timer = setTimeout(poll, data.more ? MORE_MS : POLL_MS);
  }

  function tabs() {
    const pairs = [['tab-talk', 'talk'], ['tab-changes', 'changes']];
    const pick = (which) => {
      for (const [tab, panel] of pairs) {
        const on = tab === which;
        $(tab).setAttribute('aria-selected', String(on));
        $(tab).tabIndex = on ? 0 : -1;
        $(panel).hidden = !on;
      }
      $(which).focus();
    };
    for (const [tab] of pairs) {
      $(tab).addEventListener('click', () => pick(tab));
      $(tab).addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); pick(tab === 'tab-talk' ? 'tab-changes' : 'tab-talk'); }
      });
    }
  }

  function suggestions() {
    $('suggest-send').addEventListener('click', async () => {
      const text = $('suggest-text').value.trim();
      const said = $('suggest-said');
      if (!text) { said.textContent = 'Write something first.'; return; }
      try {
        const reply = await fetch(`${root.location.pathname.replace(/\/+$/, '')}/comment`, {
          method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ v: viewer, name: $('suggest-name').value, text }),
        });
        if (reply.ok) { $('suggest-text').value = ''; said.textContent = 'Sent to the owner.'; }
        else said.textContent = (await reply.json().catch(() => ({}))).error || 'Couldn’t send that.';
      } catch (_) { said.textContent = 'Couldn’t send that.'; }
    });
  }

  tabs();
  suggestions();
  poll();
})(typeof window === 'object' ? window : globalThis);
