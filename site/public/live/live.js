// Eden Code's Share live, anywhere (src/accounts/live.js; the Mac's side is JARVIS V1
// src/jarvis/features/code_share_live.py): a session someone shared from their Mac, watched
// through askeden.com. The link is /live/<id>#k=<key>[&i=<invite id>.<secret>]: the key, and a
// personal link's secret, are in the part after #, which the browser never sends to a server.
// Everything the Mac pushes is sealed with that key (AES-256-GCM, WebCrypto here), and opened
// only on this page; what this page sends back (a suggestion, a driver's request) is sealed the
// same way, with the personal link's secret inside, and askeden.com passes it on unread. The
// drawing is share-view.js, the same file the Mac's own page uses. Everything from the session
// is put in with textContent. Pure helpers are exported for node --test (site/test/live-share.test.js).
(function (root) {
  'use strict';

  const LABEL = 'eden-live-v1';
  const NONCE = 12;
  const encoder = new TextEncoder();

  // The link's fragment: its key (32 bytes) and, on a personal link, "<invite id>.<secret>".
  function parseFragment(hash) {
    const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const key = fromB64url(q.get('k') || '');
    const invite = /^[0-9a-f]{8}\.[A-Za-z0-9_-]{20,64}$/.test(q.get('i') || '') ? q.get('i') : '';
    return key && key.length === 32 ? { key, invite } : null;
  }

  function fromB64url(text) {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    try {
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch (_) { return null; }
  }

  const toB64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  const aad = (share, direction, seq) => encoder.encode(`${LABEL}|${share}|${direction}|${seq}`);

  function importKey(raw, subtle) {
    return (subtle || root.crypto.subtle).importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  // A sealed blob opened for exactly this place (share, direction, seq), or null.
  async function openBlob(key, share, direction, seq, blob, subtle) {
    let raw;
    try { raw = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0)); } catch (_) { return null; }
    if (raw.length < NONCE + 16) return null;
    try {
      const plain = await (subtle || root.crypto.subtle).decrypt({ name: 'AES-GCM', iv: raw.slice(0, NONCE), additionalData: aad(share, direction, seq) }, key, raw.slice(NONCE));
      return new TextDecoder().decode(plain);
    } catch (_) { return null; }
  }

  async function sealBlob(key, share, direction, seq, text, subtle, nonce) {
    const iv = nonce || (root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(NONCE));
    const sealed = new Uint8Array(await (subtle || root.crypto.subtle).encrypt({ name: 'AES-GCM', iv, additionalData: aad(share, direction, seq) }, key, encoder.encode(text)));
    const out = new Uint8Array(iv.length + sealed.length);
    out.set(iv);
    out.set(sealed, iv.length);
    return toB64(out);
  }

  // A message for the owner's Mac, sealed: { type: "up", id, blob } (id: its own random 16 hex).
  async function upMessage(key, share, invite, payload, subtle, random) {
    const bytes = (random || (root.crypto || globalThis.crypto)).getRandomValues(new Uint8Array(8));
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const body = JSON.stringify({ ...payload, invite: invite || '', at: Date.now() });
    return { type: 'up', id, blob: await sealBlob(key, share, 'up', id, body, subtle) };
  }

  // Parts of pushes back together, by seq (share_seal.Joiner's twin).
  function joiner() {
    let seq = 0;
    let parts = new Map();
    let count = 0;
    return (f) => {
      if (!(f.parts > 0 && f.parts <= 64 && f.part >= 0 && f.part < f.parts) || f.seq < seq) return null;
      if (f.seq !== seq) { seq = f.seq; parts = new Map(); count = f.parts; }
      if (f.parts !== count) return null;
      parts.set(f.part, f.blob);
      if (parts.size < count) return null;
      const whole = Array.from({ length: count }, (_, i) => parts.get(i)).join('');
      parts = new Map();
      seq += 1;
      return { seq: seq - 1, kind: f.kind, blob: whole };
    };
  }

  // What this page may do (data: an opened push): its role from the roles the Mac sends.
  function roleOf(data, invite) {
    if (!invite) return data && data.comments ? 'commenter' : 'viewer';
    const id = invite.split('.')[0];
    return (data && data.roles && data.roles[id]) || '';
  }

  const api = { parseFragment, fromB64url, aad, importKey, openBlob, sealBlob, upMessage, joiner, roleOf };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const doc = root.document;
  const view = root.edenShareView;
  const $ = (id) => doc.getElementById(id);
  const share = (root.location.pathname.match(/^\/live\/([0-9a-f]{32})\/?$/) || [])[1] || '';
  const link = parseFragment(root.location.hash);
  const shown = new Map();
  let key = null;
  let ws = null;
  let join = joiner();
  let latest = null;
  let role = 'viewer';
  let over = false;
  let wait = 1000;

  function ended(why) {
    over = true;
    $('ended').textContent = why || 'This share has ended.';
    $('ended').hidden = false;
    $('status').textContent = 'ended';
    for (const id of ['suggest', 'drive', 'asks']) $(id).hidden = true;
    if (ws) try { ws.close(); } catch (_) { /* closed */ }
  }

  function draw(data) {
    if (data.kind === 'full') { $('entries').replaceChildren(); shown.clear(); }
    latest = data;
    $('title').textContent = data.title || 'Eden Code session';
    doc.title = `${data.title || 'Session'} · Eden Code (live)`;
    $('status').textContent = data.status || '';
    $('status').className = `chip ${data.status || ''}`;
    $('doing').textContent = data.doing || '';
    $('expires').textContent = `· ${view.leftText(data.expires || 0, Date.now() / 1000)}`;
    view.placeEntries($('entries'), shown, data.entries, (e) => view.entryNode(doc, e));
    if (data.changes) view.drawChanges(doc, { files: $('files'), empty: $('changes-empty'), count: $('changes-count') }, data.changes);
    role = roleOf(data, link.invite);
    if (link.invite && !role) { ended('This link was revoked.'); return; }
    $('seat').textContent = view.seatText('', role);
    $('suggest').hidden = !(role === 'commenter' || role === 'driver');
    $('suggest-name-row').hidden = Boolean(link.invite);
    $('drive').hidden = role !== 'driver';
    view.drawApprovals(doc, $('asks'), data.approvals, role === 'driver' ? (approval, choice, b) => {
      send({ kind: 'approve', approval, choice }).then((ok) => { b.textContent = ok ? 'Suggested to the owner' : 'Couldn’t send that.'; });
    } : null);
  }

  async function send(payload) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(await upMessage(key, share, link.invite, payload)));
    return true;
  }

  function connect() {
    if (over) return;
    join = joiner();
    const scheme = root.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new root.WebSocket(`${scheme}://${root.location.host}/api/live/${share}/watch`);
    ws.addEventListener('open', () => { wait = 1000; $('status').textContent = 'connected'; if (link.invite) send({ kind: 'hello' }); });
    ws.addEventListener('message', async (event) => {
      let m;
      try { m = JSON.parse(event.data); } catch (_) { return; }
      if (m.type === 'ended') { ended(); return; }
      if (m.type === 'slow_down') { $('suggest-said').textContent = 'Too many at once. Try again in a moment.'; return; }
      if (m.type !== 'frame') return;
      const whole = join(m);
      if (!whole) return;
      const text = await openBlob(key, share, 'down', whole.seq, whole.blob);
      if (text === null) return;  // (not sealed with this link's key: never shown)
      let data;
      try { data = JSON.parse(text); } catch (_) { return; }
      if (data.kind !== whole.kind) return;
      draw(data);
    });
    ws.addEventListener('close', (event) => {
      if (over) return;
      if (event.code === 4004) { ended(); return; }
      $('status').textContent = 'reconnecting';
      setTimeout(connect, wait);
      wait = Math.min(30000, wait * 2);
    });
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

  function boxes() {
    $('suggest-send').addEventListener('click', async () => {
      const text = $('suggest-text').value.trim();
      if (!text) { $('suggest-said').textContent = 'Write something first.'; return; }
      const ok = await send({ kind: 'comment', name: $('suggest-name').value, text });
      if (ok) $('suggest-text').value = '';
      $('suggest-said').textContent = ok ? 'Sent to the owner.' : 'Couldn’t send that.';
    });
    $('drive-send').addEventListener('click', async () => {
      const text = $('drive-text').value.trim();
      if (!text) { $('drive-said').textContent = 'Write something first.'; return; }
      const ok = await send({ kind: 'message', text });
      if (ok) $('drive-text').value = '';
      $('drive-said').textContent = ok ? 'Sent to the owner to send.' : 'Couldn’t send that.';
    });
  }

  tabs();
  boxes();
  if (!share || !link) { ended('This link is missing its key: copy the whole link, with the part after #.'); return; }
  importKey(link.key).then((k) => { key = k; connect(); }, () => ended('This browser can’t open sealed shares.'));
  setInterval(() => { if (latest && !over) $('expires').textContent = `· ${view.leftText(latest.expires || 0, Date.now() / 1000)}`; }, 30000);
})(typeof window === 'object' ? window : globalThis);
