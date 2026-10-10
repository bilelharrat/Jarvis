// Share a conversation as a read-only link (ROADMAP Q3), from the chat's ••• menu. Nothing is
// shared until the owner makes a link: they pick the messages, see a preview of exactly what will
// be public (share-render.js, the same drawing as the public page) with warnings where it looks
// like personal data, choose when it expires, and confirm. The snapshot is encrypted here with a
// new key (share-model.js explains the key-in-the-#fragment design): askeden.com, or the Mac's
// server, keeps only ciphertext; the key lives in the link and in the chat's own `shares` list,
// which syncs end-to-end encrypted with the chat (H1), so the owner can copy or revoke the link
// from any of their devices. Revoking deletes the ciphertext at once.
//
//   POST /api/chat/share          { blob, expires } → { id, url: "/s/<id>", created, expires, bytes }
//   GET  /api/chat/shares         → { shares: [{ id, url, created, expires, bytes }], max }
//   POST /api/chat/shares/revoke  { id } → { id, revoked: true }
//   GET  /s/<id>                  the read-only page (share.html); /s/<id>/data its ciphertext

import { el, ico, toast, copyText } from './util.js';
import { state, saveConversation } from './state.js';
import { getJSON, postJSON, apiUrl } from './api.js';
import { EXPIRY, SHARE_LIMITS, buildSnapshot, expiresAt, personalData, personalIn, sealSnapshot, shareLink, shareRecord, shareable } from './share-model.js';
import { renderSnapshot, wireSnapshot } from './share-render.js';

let H = {};
export function initShare(handlers = {}) {
  H = handlers;
  if (!document.querySelector('link[data-share]')) {
    const l = el('link', { rel: 'stylesheet', href: new URL('./share.css', import.meta.url).href });
    l.dataset.share = '1';
    document.head.append(l);
  }
}

/** Sharing needs a server that keeps shares: askeden.com, or the Mac's Eden server (which says so in meta.share). */
export const shareAvailable = () => !!(state.meta && (state.meta.hosted || (state.meta.share && state.meta.share.available)));
const onMac = () => !!(state.meta && !state.meta.hosted && state.meta.share && state.meta.share.where === 'mac');
const linkFor = (rec) => shareLink(new URL(apiUrl('/'), location.href).href, rec.id, rec.key);
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const live = (c) => (c && Array.isArray(c.shares) ? c.shares.filter((s) => !s.revoked && !(s.expires && s.expires < Date.now())) : []);

function touch(c) { c.metaAt = Date.now(); saveConversation(c, { now: true }); } // a share list change syncs like a folder move

/** Opens the share dialog for chat `c`. */
export function openShare(c) {
  if (!H.openDialog) return;
  const items = shareable(c);
  if (!c || c.temp || !items.length) { toast(c && c.temp ? 'Temporary chats can’t be shared' : 'Nothing to share yet'); return; }
  if (!shareAvailable()) {
    H.openDialog('Sharing needs askeden.com', el('div', 'share',
      el('p', 'share-lead', 'A shared link keeps an encrypted, read-only copy of the messages you pick at askeden.com. Sign in to Eden there to share this chat.'),
      el('p', 'share-lead', 'Here you can export it as Markdown instead (••• › Export as Markdown).'),
      el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => H.closeDialog() }, 'Close'))));
    return;
  }
  paintPick(c, items, { title: c.title, picked: null, expiry: 'never' });
}

function paintPick(c, items, st) {
  const flagged = new Map(items.map((x) => [x.id, personalIn(x.text).map((h) => h.label)]));
  // Off until picked: everything is ticked except messages that look like they hold personal data.
  const picked = st.picked || new Set(items.filter((x) => !flagged.get(x.id).length).map((x) => x.id));
  const title = el('input', { type: 'text', maxlength: SHARE_LIMITS.title, 'aria-label': 'Title of the shared page' });
  title.value = st.title || c.title || 'Shared chat';
  const expiry = el('select', { 'aria-label': 'Link expires' }, ...EXPIRY.map((e) => { const o = el('option', { value: e.k }, e.label); if (e.k === st.expiry) o.selected = true; return o; }));
  const count = el('span', 'muted');
  const next = el('button', { type: 'button', class: 'btn primary' }, 'Preview…');
  const refresh = () => { count.textContent = `${picked.size} of ${items.length} picked`; next.disabled = !picked.size; };
  const rows = items.map((x, i) => {
    const cb = el('input', { type: 'checkbox', 'aria-label': `${x.role === 'user' ? 'Prompt' : 'Reply'} ${i + 1}` });
    cb.checked = picked.has(x.id);
    cb.addEventListener('change', () => { if (cb.checked) picked.add(x.id); else picked.delete(x.id); refresh(); });
    const pd = flagged.get(x.id);
    return { cb, row: el('label', 'share-row', cb, el('span', 'sr-t',
      el('span', 'sr-who', `${x.role === 'user' ? 'You' : x.model ? `Reply · ${x.model}` : 'Reply'}${x.files ? ` · ${x.files} attachment${x.files === 1 ? '' : 's'} left out` : ''}`),
      el('span', 'sr-x', x.text.replace(/\s+/g, ' ').slice(0, 220)),
      pd.length ? el('span', 'sr-pd', `Looks like it has ${pd.join(', ')}: not picked`) : null)) };
  });
  const all = el('button', { type: 'button', class: 'btn' }, 'Select all');
  all.addEventListener('click', () => { const on = picked.size < items.length; rows.forEach((r, i) => { r.cb.checked = on; if (on) picked.add(items[i].id); else picked.delete(items[i].id); }); refresh(); });
  next.addEventListener('click', () => paintPreview(c, items, { title: title.value, picked, expiry: expiry.value }));
  refresh();
  H.openDialog('Share a read-only link', el('div', 'share',
    el('p', 'share-lead', 'Pick the messages to share. Nothing is shared until you create the link, and only what you pick goes in it: not the rest of this chat, not attachments, not your other chats. It’s encrypted in this browser; the key is only in the link.'),
    el('div', 'share-opts', el('label', 'field', 'Title', title), el('label', 'field', 'Link expires', expiry)),
    el('div', 'share-pick', ...rows.map((r) => r.row)),
    el('div', 'share-bar', all, count, el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: () => H.closeDialog() }, 'Cancel'), next),
    sharedList(c)));
}

function paintPreview(c, items, st) {
  const snap = buildSnapshot({ title: st.title, items, picked: st.picked });
  const warn = personalData(snap);
  const preview = el('div', 'share-preview');
  const drawn = renderSnapshot(snap, { preview: true });
  preview.append(drawn);
  wireSnapshot(preview, (t) => copyText(t));
  const ok = el('input', { type: 'checkbox' });
  const go = el('button', { type: 'button', class: 'btn primary', disabled: true }, 'Create link');
  ok.addEventListener('change', () => { go.disabled = !ok.checked; });
  const err = el('div', { class: 'sp-warn', hidden: true, role: 'alert' });
  const size = new TextEncoder().encode(JSON.stringify(snap)).length;
  const tooBig = size * 1.4 > SHARE_LIMITS.bytes;
  const exp = expiresAt(st.expiry);
  const where = onMac()
    ? 'This Eden runs on your Mac, so the link opens only on this Mac. Share from askeden.com for a link others can open.'
    : `Anyone with the link can read exactly this, with no sign-in${exp ? `, until ${day(exp)}` : ' until you revoke it'}. askeden.com keeps only an encrypted copy it can’t read.`;
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Creating…'; err.hidden = true;
    try {
      const { key, blob } = await sealSnapshot(snap);
      const made = await postJSON('/api/chat/share', { blob, expires: exp });
      const rec = shareRecord({ id: made.id, key, title: snap.title, created: made.created || Date.now(), expires: made.expires || exp, count: snap.messages.length });
      c.shares = [...(Array.isArray(c.shares) ? c.shares : []), rec];
      touch(c);
      paintMade(c, rec);
    } catch (e) {
      err.replaceChildren(el('b', '', 'Couldn’t create the link'), ' ', e.message || String(e));
      err.hidden = false; go.disabled = !ok.checked; go.textContent = 'Create link';
    }
  });
  H.openDialog('Preview: this is what will be public', el('div', 'share',
    el('p', 'share-lead', where),
    warn.length ? el('div', 'sp-warn share-pd', el('b', '', 'This may include personal data'),
      el('ul', '', ...warn.map((w) => el('li', '', `${w.index < 0 ? 'The title' : `${w.role === 'user' ? 'Your message' : 'A reply'} (${w.index + 1})`}: ${w.labels.join(', ')}`))),
      'Go back and untick those messages, or edit the title, unless you mean to share them.') : null,
    el('p', 'sp-note', 'Also check for names, places and details about other people: the automatic check can miss them.'),
    preview,
    tooBig ? el('div', 'sp-warn', el('b', '', 'Too long to share'), 'A shared chat is at most about 1.4 MB of text. Untick some messages.') : null,
    el('label', 'share-ok', ok, el('span', '', 'I’ve read the preview. Anyone with the link can see exactly this.')),
    err,
    el('div', 'share-bar', el('button', { type: 'button', class: 'btn', onclick: () => paintPick(c, items, st) }, 'Back'), el('span', 'grow'),
      el('button', { type: 'button', class: 'btn', onclick: () => H.closeDialog() }, 'Cancel'), tooBig ? null : go)));
}

function linkRow(rec) {
  const url = linkFor(rec);
  const input = el('input', { type: 'text', readonly: true, 'aria-label': 'The shared link' });
  input.value = url;
  input.addEventListener('focus', () => input.select());
  return el('div', 'share-link', input,
    el('button', { type: 'button', class: 'btn', onclick: () => copyText(url) }, ico('copy', 14), 'Copy'),
    el('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 14), 'Open'));
}

function paintMade(c, rec) {
  H.openDialog('Link created', el('div', 'share',
    el('p', 'share-lead', el('b', '', rec.title), ` is shared: ${rec.count} message${rec.count === 1 ? '' : 's'}, read-only${rec.expires ? `, until ${day(rec.expires)}` : ''}.`),
    linkRow(rec),
    el('p', 'sp-note', 'The part after # is the key: whoever has the whole link can read it, and the server never sees the key. Revoke it here or from this chat’s ••• › Share whenever you like; it stops working at once.'),
    el('div', 'share-bar', el('button', { type: 'button', class: 'btn', onclick: () => revoke(c, rec).then((ok) => { if (ok) H.closeDialog(); }) }, 'Revoke'), el('span', 'grow'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => H.closeDialog() }, 'Done'))));
}

/** Revokes a share (the server deletes its ciphertext) and marks it on its chat. */
export async function revoke(c, rec) {
  try { await postJSON('/api/chat/shares/revoke', { id: rec.id }); }
  catch (e) { if (e.status !== 404) { toast(`Couldn’t revoke it: ${e.message}`); return false; } } // 404: already gone (expired)
  const owner = c || state.convs.find((x) => Array.isArray(x.shares) && x.shares.some((s) => s.id === rec.id));
  if (owner) { owner.shares = owner.shares.map((s) => (s.id === rec.id ? { ...s, revoked: true } : s)); touch(owner); }
  toast('Link revoked: it no longer opens');
  return true;
}

/** This chat's live links, and (folded) every shared link on the account, each with Copy and Revoke. */
function sharedList(c) {
  const mine = live(c);
  const box = el('div', 'share-list');
  const row = (rec, chat, gone = false) => {
    const rv = el('button', { type: 'button', class: 'cap rev' }, 'Revoke');
    rv.addEventListener('click', async () => {
      if (rv.dataset.sure !== '1') { rv.dataset.sure = '1'; rv.textContent = 'Revoke?'; setTimeout(() => { rv.dataset.sure = ''; rv.textContent = 'Revoke'; }, 4000); return; }
      if (await revoke(chat, rec)) rv.closest('.share-item').classList.add('gone');
    });
    return el('div', `share-item${gone ? ' gone' : ''}`,
      el('div', 'si-t', el('b', '', rec.title || 'Shared chat'), el('span', 'si-c', `${rec.count ? `${rec.count} messages · ` : ''}${rec.created ? `made ${day(rec.created)}` : ''}${rec.expires ? ` · until ${day(rec.expires)}` : ''}`)),
      rec.key ? el('button', { type: 'button', class: 'iconbtn', title: 'Copy link', 'aria-label': `Copy the link to ${rec.title}`, onclick: () => copyText(linkFor(rec)) }, ico('copy', 15)) : null,
      rv);
  };
  if (mine.length) box.append(el('b', '', 'Links to this chat'), ...mine.map((r) => row(r, c)));
  const all = el('details', 'share-all', el('summary', '', 'All your shared links'));
  all.addEventListener('toggle', () => {
    if (!all.open || all.dataset.loaded) return;
    all.dataset.loaded = '1';
    const list = el('div', 'share-list', el('div', 'muted', 'Loading…'));
    all.append(list);
    getJSON('/api/chat/shares').then((d) => {
      const known = new Map();
      for (const x of state.convs) for (const s of Array.isArray(x.shares) ? x.shares : []) known.set(s.id, { s, x });
      const shares = d.shares || [];
      if (!shares.length) { list.replaceChildren(el('div', 'muted', 'No shared links.')); return; }
      list.replaceChildren(el('div', 'muted', `${shares.length} of ${d.max || SHARE_LIMITS.max}`), ...shares.map((s) => {
        const k = known.get(s.id);
        return row(k ? { ...k.s, created: s.created, expires: s.expires } : { id: s.id, title: 'A chat not on this device', created: s.created, expires: s.expires }, k ? k.x : null);
      }));
    }, (e) => list.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t load your shared links'), ' ', e.message)));
  });
  box.append(all);
  return box;
}
