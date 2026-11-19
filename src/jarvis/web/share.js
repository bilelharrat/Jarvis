// Eden Code's Share live viewer (features/code_share.py): the session's transcript, its
// changes and its status, polled from the Mac. Read-only, unless this is a driver's personal
// link (features/code_share_drive.py): then a box asks the owner to send a message, and a
// question the session has can get a suggested answer; the owner's tap does either. The
// drawing is web/share-view.js, the same as askeden.com's page. Everything shown is text put
// in with textContent: nothing from the session is ever read as HTML. Pure helpers are
// exported for node --test (tests/web/code-share.test.mjs).
(function (root) {
  'use strict';

  const view = (typeof module === 'object' && module.exports) ? require('./share-view.js') : root.edenShareView;
  const POLL_MS = 2000;
  const MORE_MS = 200;  // the next page soon, when the Mac said there's more
  const { KEPT, ROLE_NAMES, leftText, placeEntries } = view;

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

  const STOPPED = 'The owner stopped your view of this share.';
  const api = { viewerId, stateUrl, leftText, placeEntries, ROLE_NAMES, KEPT, STOPPED };
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

  let role = 'viewer';
  const entry = (e) => view.entryNode(doc, e);
  const drawChanges = (c) => view.drawChanges(doc, { files: $('files'), empty: $('changes-empty'), count: $('changes-count') }, c);

  // A driver's request to the owner (kind: message | approve): "" when it went, else why not.
  async function ask(body) {
    try {
      const reply = await fetch(`${root.location.pathname.replace(/\/+$/, '')}/act`, {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: viewer, ...body }),
      });
      if (reply.ok) return '';
      return (await reply.json().catch(() => ({}))).error || 'Couldn’t send that.';
    } catch (_) { return 'Couldn’t send that.'; }
  }

  // A 403 is the owner's Stop on this viewer, not the share's end: said so (round 3, U3-12),
  // as the Mac's own answer words it (code_share's stopped()).
  function ended(why) {
    clearTimeout(timer);
    if (why) $('ended').textContent = why;
    $('ended').hidden = false;
    $('status').textContent = 'ended';
    $('suggest').hidden = true;
    $('drive').hidden = true;
    $('asks').hidden = true;
  }

  async function poll() {
    let data;
    try {
      const reply = await fetch(stateUrl(root.location.pathname, viewer, since, key, seen), { cache: 'no-store', credentials: 'omit' });
      if (reply.status === 403) { ended(STOPPED); return; }  // (the owner stopped this view)
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
    role = data.role || 'viewer';
    $('seat').textContent = view.seatText(data.you, role);
    $('drive').hidden = role !== 'driver';
    // (the name is the owner's for this link: a driver's or commenter's box doesn't ask for one)
    $('suggest-name-row').hidden = Boolean(data.you);
    view.drawApprovals(doc, $('asks'), data.approvals, role === 'driver' ? async (approval, choice, b) => {
      const said = await ask({ kind: 'approve', approval, choice });
      b.textContent = said || 'Suggested to the owner';
    } : null);
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

  function driving() {
    $('drive-send').addEventListener('click', async () => {
      const text = $('drive-text').value.trim();
      const said = $('drive-said');
      if (!text) { said.textContent = 'Write something first.'; return; }
      const why = await ask({ kind: 'message', text });
      if (!why) { $('drive-text').value = ''; said.textContent = 'Sent to the owner to send.'; } else said.textContent = why;
    });
  }

  tabs();
  suggestions();
  driving();
  poll();
})(typeof window === 'object' ? window : globalThis);
