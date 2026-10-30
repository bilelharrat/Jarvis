// The shared chat page (ROADMAP Q3), at /s/<id>#<key> on askeden.com and on the Mac's Eden server:
// fetches the encrypted snapshot (/s/<id>/data), opens it with the key in the link's #fragment
// (never sent to the server; share-model.js says why), and draws it as untrusted Markdown
// (share-render.js). When shared in collaborative mode or opened with a collaborator link
// (#<key>&c=<token>&n=<name>), collaborators can post end-to-end encrypted replies (/s/<id>/reply)
// that appear live on the thread and sync back to the owner.

import { el, copyText, toast } from './util.js';
import { openSnapshot, openReply, sealReply, parseShareHash, idFromPath, SHARE_LIMITS } from './share-model.js';
import { renderSnapshot, renderSharedMessage, wireSnapshot } from './share-render.js';

const main = document.getElementById('shr');
const pill = document.querySelector('.shr-pill span');
// "Report this chat" (App Store 1.2): an email to support naming this page. The link's key (after the #) is not
// added: the server can't read the chat, and the reporter decides whether to send the full link.
const report = document.getElementById('shrReport');
if (report) report.href = `mailto:support@askeden.com?subject=${encodeURIComponent('Report a shared Eden chat')}&body=${encodeURIComponent(`${location.origin}${location.pathname}\n\nWhat is wrong with it:\n`)}`;
// Report and hide (App Store 1.2): a Report button at the top as well as the footer link, and "Hide this chat", which
// blocks this shared chat on this device (kept in localStorage; "Show it again" undoes it).
const HIDDEN = 'eden:hidden-shares';
const NAME_STORE = 'eden:collab-name';
const hiddenIds = () => { try { const v = JSON.parse(localStorage.getItem(HIDDEN) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const setHidden = (id, on) => { try { const ids = hiddenIds().filter((x) => x !== id); if (on) ids.push(id); localStorage.setItem(HIDDEN, JSON.stringify(ids.slice(-500))); } catch { /* storage blocked: nothing kept */ } };
const actions = (id) => el('div', 'shr-actions',
  el('a', { class: 'shr-act', href: report ? report.href : 'mailto:support@askeden.com', text: 'Report' }),
  el('button', { type: 'button', class: 'shr-act', text: 'Hide this chat', onclick: () => { setHidden(id, true); hiddenView(id); } }));
function hiddenView(id) {
  main.replaceChildren(el('div', 'shr-note-box', el('h1', 'shr-title', 'You hid this shared chat'),
    el('p', 'shr-note', 'It stays hidden on this device. To report it, email support@askeden.com with the link.'),
    el('div', 'shr-actions shr-actions-center', el('button', { type: 'button', class: 'shr-act', text: 'Show it again', onclick: () => { setHidden(id, false); show(); } }))));
  document.title = 'Hidden shared chat · Eden';
}
const say = (title, words) => { main.replaceChildren(el('div', 'shr-note-box', el('h1', 'shr-title', title), el('p', 'shr-note', words))); document.title = `${title} · Eden`; };

const b64u = (bytes) => { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
async function sha256B64u(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return b64u(buf);
}

let pollTimer = 0;
function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
}

async function decryptReplies(rawReplies, key) {
  const out = [];
  for (const r of Array.isArray(rawReplies) ? rawReplies : []) {
    if (!r || !r.blob) continue;
    try {
      const dec = await openReply(r.blob, key);
      out.push({ ...dec, id: r.id, at: r.at || dec.at });
    } catch { /* skip damaged */ }
  }
  return out;
}

function buildComposer({ id, key, token, defaultName, onSent }) {
  let savedName = defaultName || '';
  if (!savedName) {
    try { savedName = localStorage.getItem(NAME_STORE) || ''; } catch { /* ignore */ }
  }
  const nameIn = el('input', {
    type: 'text',
    class: 'shr-collab-name',
    maxlength: String(SHARE_LIMITS.name),
    placeholder: 'Your name',
    'aria-label': 'Your name',
    value: savedName,
  });
  const textIn = el('textarea', {
    class: 'shr-collab-input',
    rows: '2',
    maxlength: String(SHARE_LIMITS.replyText),
    placeholder: 'Add a message or reply to this shared chat…',
    'aria-label': 'Message to add to this shared chat',
  });
  const sendBtn = el('button', { type: 'submit', class: 'shr-collab-send' }, 'Send');
  const errBox = el('div', { class: 'shr-collab-err', hidden: true, role: 'alert' });

  textIn.addEventListener('input', () => {
    textIn.style.height = 'auto';
    textIn.style.height = `${Math.min(180, textIn.scrollHeight)}px`;
  });
  textIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  const form = el('form', { class: 'shr-collab-form glass', autocomplete: 'off' },
    el('div', 'shr-collab-top',
      el('span', 'shr-collab-badge', defaultName ? `Collaborating as ${defaultName}` : 'Collaborator'),
      nameIn,
    ),
    el('div', 'shr-collab-row', textIn, sendBtn),
    errBox,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const author = (nameIn.value || defaultName || 'Collaborator').trim();
    const text = textIn.value.trim();
    if (!text) return;
    try { localStorage.setItem(NAME_STORE, author); } catch { /* ignore */ }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    errBox.hidden = true;
    try {
      const now = Date.now();
      const blob = await sealReply({ author, role: 'user', text, at: now }, key);
      const res = await fetch(`/s/${id}/reply`, {
        method: 'POST',
        credentials: token ? 'same-origin' : 'omit', // an invitation for one Eden account checks who's signed in
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blob, ...(token ? { token } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Couldn’t send your message.');
      textIn.value = '';
      textIn.style.height = 'auto';
      if (onSent) onSent({ id: data.reply && data.reply.id, author, role: 'user', text, at: (data.reply && data.reply.at) || now });
      toast('Message added to shared chat');
    } catch (err) {
      errBox.textContent = err.message || String(err);
      errBox.hidden = false;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  });
  return form;
}

async function show() {
  stopPoll();
  const id = idFromPath(location.pathname);
  const { key, token, name: hashName, role: hashRole } = parseShareHash(location.hash);
  if (!id) { say('This link isn’t right', 'Ask whoever shared it for the link again.'); return; }
  if (hiddenIds().includes(id)) { hiddenView(id); return; }
  if (!key) { say('This link is missing its key', 'A shared chat’s link ends with # and a key. Ask for the whole link: it may have been cut off when it was copied.'); return; }
  let r;
  try { r = await fetch(`/s/${id}/data`, { credentials: token ? 'same-origin' : 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: token ? { 'x-seat': token } : {} }); } catch { say('Couldn’t load this chat', 'Check your connection and reload.'); return; }
  if (r.status === 404 || r.status === 410) { say('This shared chat isn’t here', 'It was revoked, it expired, or the link is wrong. Ask whoever shared it for a new one.'); return; }
  if (r.status === 401 || r.status === 403) { const e = await r.json().catch(() => ({})); say('This link doesn’t open here', e.error || 'Ask whoever shared it for a new link.'); return; }
  if (r.status === 429) { say('Slow down', 'Too many shared chats from this network in a minute. Wait a moment, then reload.'); return; }
  if (!r.ok) { say('Couldn’t load this chat', 'Something went wrong. Reload to try again.'); return; }
  try {
    const { blob, expires, mode, seats, me, replies: rawReplies } = await r.json();
    const snap = await openSnapshot(blob, key);
    let canReply = mode === 'collaborate' || snap.mode === 'collaborate';
    let seatRole = hashRole || '';
    if (token && me && me.role) { // the server named this link's seat (role, its own expiry)
      seatRole = me.role;
      canReply = me.role === 'collaborator' || me.role === 'commenter';
    } else if (token && Array.isArray(seats)) {
      const th = await sha256B64u(token);
      const matched = seats.find((s) => s && s.tokenHash === th);
      if (matched) {
        seatRole = matched.role;
        canReply = matched.role === 'collaborator' || matched.role === 'commenter';
      } else {
        canReply = false;
      }
    }
    const isCollab = canReply || Boolean(seatRole) || (Array.isArray(rawReplies) && rawReplies.length > 0);
    if (pill) {
      pill.textContent = canReply
        ? seatRole === 'commenter' ? (hashName ? `Can comment · ${hashName}` : 'Can comment') : (hashName ? `Collaborator · ${hashName}` : 'Collaborative chat')
        : seatRole === 'viewer'
          ? (hashName ? `Viewer · ${hashName}` : 'Viewer snapshot')
          : 'Read-only snapshot';
    }
    const view = renderSnapshot(snap, { collaborative: isCollab });
    if (expires) view.querySelector('.shr-sub').append(` · until ${new Date(expires).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`);
    const head = view.querySelector('.shr-head');
    if (head) head.append(actions(id));

    const msgsBox = view.querySelector('.shr-msgs');
    const seenReplyIds = new Set();
    const appendReply = (rep) => {
      if (rep.id && seenReplyIds.has(rep.id)) return;
      if (rep.id) seenReplyIds.add(rep.id);
      if (msgsBox) {
        const empty = msgsBox.querySelector('.shr-empty');
        if (empty) empty.remove();
        msgsBox.append(renderSharedMessage(rep, msgsBox.children.length));
      }
    };

    const initialReplies = await decryptReplies(rawReplies, key);
    for (const rep of initialReplies) appendReply(rep);

    if (canReply) {
      view.append(buildComposer({
        id,
        key,
        token,
        defaultName: hashName,
        onSent: (rep) => appendReply(rep),
      }));
    }

    main.replaceChildren(view);
    wireSnapshot(main, (t) => copyText(t));
    document.title = `${snap.title} · Eden`;

    if (isCollab) {
      pollTimer = setInterval(async () => {
        try {
          const pr = await fetch(`/s/${id}/data`, { credentials: token ? 'same-origin' : 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: token ? { 'x-seat': token } : {} });
          if (!pr.ok) return;
          const pdata = await pr.json();
          const fresh = await decryptReplies(pdata.replies, key);
          for (const rep of fresh) appendReply(rep);
        } catch { /* ignore poll errors */ }
      }, 6000);
    }
  } catch (e) { say('Couldn’t open this chat', e.message || 'The link’s key doesn’t open it.'); }
}

addEventListener('hashchange', show);
show();
