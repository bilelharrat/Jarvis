// Share a conversation as a read-only or collaborative link (ROADMAP Q3), from the chat's ••• menu.
// Nothing is shared until the owner makes a link: they pick the messages, choose whether the link is
// read-only or collaborative (and optionally invite named collaborators with personal links & roles),
// see a preview of what will be shared (share-render.js, the same drawing as the public page) with
// warnings where it looks like personal data, choose when it expires, and confirm. The snapshot and
// any collaborator replies are encrypted in the browser with the share's key (kept only in the link's
// #fragment and on the owner's chat record, never sent to the server).
//
//   POST /api/chat/share          { blob, expires, mode?, collaborators? } → { id, url: "/s/<id>", created, expires, bytes }
//   POST /api/chat/shares/update  { id, blob?, mode?, collaborators? }     → { id, url, ... }
//   GET  /api/chat/shares         → { shares: [{ id, url, created, expires, bytes, mode?, replies? }], max }
//   POST /api/chat/shares/revoke  { id } → { id, revoked: true }
//   GET  /s/<id>                  the shared chat page (share.html); /s/<id>/data its ciphertext + encrypted replies
//   POST /s/<id>/reply            { blob, token? } → { reply }

import { el, ico, toast, copyText, addStylesheet } from './util.js';
import { state, path, addNode, saveConversation, ui } from './state.js';
import { getJSON, postJSON, apiUrl } from './api.js';
import {
  EXPIRY, SHARE_LIMITS, SHARE_ROLES,
  buildSnapshot, cleanCollaborators, expiresAt, newCollaboratorToken, newSeatId,
  openReply, personalData, personalIn, sealSnapshot, shareLink, shareRecord, shareable,
} from './share-model.js';
import { renderSnapshot, wireSnapshot } from './share-render.js';

let H = {};
export function initShare(handlers = {}) {
  H = handlers;
  addStylesheet(new URL('./share.css', import.meta.url).href, 'share');
}

/** Sharing needs a server that keeps shares: askeden.com, or the Mac's Eden server (which says so in meta.share). */
export const shareAvailable = () => !!(state.meta && (state.meta.hosted || (state.meta.share && state.meta.share.available)));
const onMac = () => !!(state.meta && !state.meta.hosted && state.meta.share && state.meta.share.where === 'mac');
const originUrl = () => new URL(apiUrl('/'), location.href).href;
const linkFor = (rec, collab = null) => shareLink(originUrl(), rec.id, rec.key, collab);
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const live = (c) => (c && Array.isArray(c.shares) ? c.shares.filter((s) => !s.revoked && !(s.expires && s.expires < Date.now())) : []);

function touch(c) { c.metaAt = Date.now(); saveConversation(c, { now: true }); } // a share list change syncs like a folder move

function updateRec(c, rec) {
  if (!c) return;
  c.shares = (Array.isArray(c.shares) ? c.shares : []).map((s) => (s.id === rec.id ? rec : s));
  touch(c);
}

const serverSeats = (collaborators) => cleanCollaborators(collaborators).map((x) => ({ id: x.id, role: x.role, token: x.token, ...(x.expires ? { expires: x.expires } : {}), ...(x.people ? { people: true } : {}) }));

/** Opens the share dialog for chat `c`. */
export function openShare(c) {
  if (!H.openDialog) return;
  const items = shareable(c);
  if (!c || c.temp || !items.length) { toast(c && c.temp ? 'Temporary chats can’t be shared' : 'Nothing to share yet'); return; }
  if (!shareAvailable()) {
    H.openDialog('Sharing needs askeden.com', el('div', 'share',
      el('p', 'share-lead', 'A shared link keeps an encrypted copy of the messages you pick at askeden.com. Sign in to Eden there to share this chat.'),
      el('p', 'share-lead', 'Here you can export it as Markdown instead (••• › Export as Markdown).'),
      el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => H.closeDialog() }, 'Close'))));
    return;
  }
  paintPick(c, items, { title: c.title, picked: null, expiry: 'never', mode: 'readonly', collaborators: [] });
}

function collaboratorsEditor(list, onChange) {
  const wrap = el('div', 'share-collabs');
  const rowsBox = el('div', 'share-collab-list');
  const nameIn = el('input', {
    type: 'text',
    maxlength: SHARE_LIMITS.name,
    placeholder: 'Collaborator’s name (e.g. Alex)',
    'aria-label': 'Collaborator name',
  });
  const roleSel = el('select', { 'aria-label': 'Collaborator role' },
    ...SHARE_ROLES.map((r) => {
      const o = el('option', { value: r.k }, r.label);
      if (r.k === 'collaborator') o.selected = true;
      return o;
    }));
  const addBtn = el('button', { type: 'button', class: 'btn' }, 'Add collaborator');

  const drawRows = () => {
    if (!list.length) {
      rowsBox.replaceChildren(el('div', 'muted share-collab-empty', 'No individual collaborators added yet. Add someone above to give them a personal link with their own role and revocable seat.'));
      return;
    }
    rowsBox.replaceChildren(...list.map((col, idx) => {
      const rSel = el('select', { class: 'sc-role', 'aria-label': `Role for ${col.name}` },
        ...SHARE_ROLES.map((r) => {
          const o = el('option', { value: r.k }, r.k === 'collaborator' ? 'Can reply' : 'Viewer');
          if (r.k === col.role) o.selected = true;
          return o;
        }));
      rSel.addEventListener('change', () => {
        col.role = rSel.value === 'viewer' ? 'viewer' : 'collaborator';
        if (onChange) onChange(list);
      });
      const rm = el('button', { type: 'button', class: 'cap rev', title: `Remove ${col.name}` }, 'Remove');
      rm.addEventListener('click', () => {
        list.splice(idx, 1);
        drawRows();
        if (onChange) onChange(list);
      });
      return el('div', 'share-collab-row',
        el('span', 'sc-avatar', (col.name || '?').slice(0, 1).toUpperCase()),
        el('div', 'sc-info', el('b', { 'data-no-i18n': '' }, col.name), el('span', 'sc-sub', col.role === 'collaborator' ? 'Collaborator · can add messages' : 'Viewer · read-only')),
        rSel,
        rm);
    }));
  };

  const addOne = () => {
    const name = nameIn.value.trim();
    if (!name) { toast('Enter a collaborator’s name first'); nameIn.focus(); return; }
    if (list.length >= SHARE_LIMITS.collaborators) { toast(`Up to ${SHARE_LIMITS.collaborators} collaborators per share`); return; }
    list.push({
      id: newSeatId(),
      name,
      role: roleSel.value === 'viewer' ? 'viewer' : 'collaborator',
      token: newCollaboratorToken(),
      created: Date.now(),
    });
    nameIn.value = '';
    drawRows();
    if (onChange) onChange(list);
  };
  addBtn.addEventListener('click', addOne);
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addOne(); }
  });

  drawRows();
  wrap.append(
    el('div', 'share-collab-head', el('b', '', 'Collaborators'), el('span', 'muted', 'Personal links with individual roles you can revoke anytime')),
    el('div', 'share-collab-add', nameIn, roleSel, addBtn),
    rowsBox,
  );
  return wrap;
}

function paintPick(c, items, st) {
  const flagged = new Map(items.map((x) => [x.id, personalIn(x.text).map((h) => h.label)]));
  // Off until picked: everything is ticked except messages that look like they hold personal data.
  const picked = st.picked || new Set(items.filter((x) => !flagged.get(x.id).length).map((x) => x.id));
  const collaborators = Array.isArray(st.collaborators) ? [...st.collaborators] : [];
  const title = el('input', { type: 'text', maxlength: SHARE_LIMITS.title, 'aria-label': 'Title of the shared page' });
  title.value = st.title || c.title || 'Shared chat';
  const accessSel = el('select', { 'aria-label': 'Link access' },
    el('option', { value: 'readonly', ...(st.mode !== 'collaborate' ? { selected: true } : {}) }, 'Read-only · anyone with link can view'),
    el('option', { value: 'collaborate', ...(st.mode === 'collaborate' ? { selected: true } : {}) }, 'Collaborative · collaborators can reply & add messages'));
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
      el('span', 'sr-who', `${x.role === 'user' ? (x.author ? `${x.author}` : 'You') : x.model ? `Reply · ${x.model}` : 'Reply'}${x.files ? ` · ${x.files} attachment${x.files === 1 ? '' : 's'} left out` : ''}`),
      el('span', 'sr-x', x.text.replace(/\s+/g, ' ').slice(0, 220)),
      pd.length ? el('span', 'sr-pd', `Looks like it has ${pd.join(', ')}: not picked`) : null)) };
  });
  const all = el('button', { type: 'button', class: 'btn' }, 'Select all');
  all.addEventListener('click', () => { const on = picked.size < items.length; rows.forEach((r, i) => { r.cb.checked = on; if (on) picked.add(items[i].id); else picked.delete(items[i].id); }); refresh(); });
  next.addEventListener('click', () => paintPreview(c, items, {
    title: title.value,
    picked,
    expiry: expiry.value,
    mode: accessSel.value === 'collaborate' ? 'collaborate' : 'readonly',
    collaborators,
  }));
  refresh();
  H.openDialog('Share this chat', el('div', 'share',
    el('p', 'share-lead', 'Pick the messages to share, choose read-only or collaborative access, and optionally invite collaborators. Everything is encrypted in this browser; the key stays in the link after #.'),
    el('div', 'share-opts',
      el('label', 'field', 'Title', title),
      el('label', 'field', 'Access', accessSel),
      el('label', 'field', 'Link expires', expiry)),
    collaboratorsEditor(collaborators),
    el('div', 'share-pick', ...rows.map((r) => r.row)),
    el('div', 'share-bar', all, count, el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: () => H.closeDialog() }, 'Cancel'), next),
    sharedList(c)));
}

function paintPreview(c, items, st) {
  const isCollab = st.mode === 'collaborate' || (st.collaborators && st.collaborators.some((x) => x.role === 'collaborator'));
  const snap = buildSnapshot({ title: st.title, items, picked: st.picked, mode: st.mode === 'collaborate' ? 'collaborate' : undefined });
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
  const modeDesc = st.mode === 'collaborate'
    ? 'Anyone with the main link (or a collaborator link) can read and post encrypted replies'
    : isCollab
      ? `Anyone with the main link can read; your ${st.collaborators.length} invited collaborator${st.collaborators.length === 1 ? ' gets their' : 's get their'} own link`
      : 'Anyone with the link can read this';
  const where = onMac()
    ? 'This Eden runs on your Mac, so the link opens only on this Mac. Share from askeden.com for a link others can open.'
    : `${modeDesc}, with no sign-in${exp ? `, until ${day(exp)}` : ' until you revoke it'}. askeden.com keeps only an encrypted copy it can’t read.`;
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Creating…'; err.hidden = true;
    try {
      const { key, blob } = await sealSnapshot(snap);
      const made = await postJSON('/api/chat/share', {
        blob,
        expires: exp,
        ...(st.mode === 'collaborate' ? { mode: 'collaborate' } : {}),
        ...(st.collaborators && st.collaborators.length ? { collaborators: serverSeats(st.collaborators) } : {}),
      });
      const rec = shareRecord({
        id: made.id,
        key,
        title: snap.title,
        created: made.created || Date.now(),
        expires: made.expires || exp,
        count: snap.messages.length,
        mode: st.mode === 'collaborate' ? 'collaborate' : undefined,
        collaborators: st.collaborators,
      });
      c.shares = [...(Array.isArray(c.shares) ? c.shares : []), rec];
      touch(c);
      paintMade(c, rec);
    } catch (e) {
      err.replaceChildren(el('b', '', 'Couldn’t create the link'), ' ', e.message || String(e));
      err.hidden = false; go.disabled = !ok.checked; go.textContent = 'Create link';
    }
  });
  H.openDialog('Preview: this is what will be shared', el('div', 'share',
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

function linkRow(rec, collab = null) {
  const url = linkFor(rec, collab);
  const input = el('input', { type: 'text', readonly: true, 'aria-label': collab ? `Collaborator link for ${collab.name}` : 'The shared link' });
  input.value = url;
  input.addEventListener('focus', () => input.select());
  return el('div', 'share-link', input,
    el('button', { type: 'button', class: 'btn', onclick: () => copyText(url) }, ico('copy', 14), 'Copy'),
    el('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 14), 'Open'));
}

function manageCollaboratorsBox(c, rec) {
  const box = el('div', 'share-manage');
  const collabs = cleanCollaborators(rec.collaborators || []);
  rec.collaborators = collabs;

  const modeToggle = el('select', { 'aria-label': 'Anyone with the main link' },
    el('option', { value: 'readonly', ...(rec.mode !== 'collaborate' ? { selected: true } : {}) }, 'Read-only · viewers read; personal links below can reply'),
    el('option', { value: 'collaborate', ...(rec.mode === 'collaborate' ? { selected: true } : {}) }, 'Collaborative · anyone with the main link can reply'));

  const syncToServer = async () => {
    try {
      await postJSON('/api/chat/shares/update', {
        id: rec.id,
        mode: rec.mode === 'collaborate' ? 'collaborate' : null,
        collaborators: serverSeats(rec.collaborators),
      });
      updateRec(c, rec);
      toast('Share settings updated');
    } catch (e) {
      toast(`Couldn’t update share: ${e.message}`);
    }
  };

  modeToggle.addEventListener('change', async () => {
    if (modeToggle.value === 'collaborate') rec.mode = 'collaborate';
    else delete rec.mode;
    await syncToServer();
  });

  const listWrap = el('div', 'share-collab-list');
  const drawSeats = () => {
    if (!rec.collaborators || !rec.collaborators.length) {
      listWrap.replaceChildren(el('div', 'muted share-collab-empty', 'No personal collaborator links yet. Add a collaborator below to create a dedicated link for them.'));
      return;
    }
    listWrap.replaceChildren(...rec.collaborators.map((col, idx) => {
      const url = linkFor(rec, col);
      const roleSel = el('select', { class: 'sc-role', 'aria-label': `Role for ${col.name}` },
        ...SHARE_ROLES.map((r) => {
          const o = el('option', { value: r.k }, r.k === 'collaborator' ? 'Can reply' : 'Viewer');
          if (r.k === col.role) o.selected = true;
          return o;
        }));
      roleSel.addEventListener('change', async () => {
        col.role = roleSel.value === 'viewer' ? 'viewer' : 'collaborator';
        await syncToServer();
        drawSeats();
      });
      const copyBtn = el('button', { type: 'button', class: 'cap primary', onclick: () => copyText(url) }, ico('copy', 13), 'Copy link');
      const rvBtn = el('button', { type: 'button', class: 'cap rev', onclick: async () => {
        rec.collaborators.splice(idx, 1);
        await syncToServer();
        drawSeats();
      } }, 'Revoke');
      return el('div', 'share-collab-row',
        el('span', 'sc-avatar', (col.name || '?').slice(0, 1).toUpperCase()),
        el('div', 'sc-info',
          el('b', { 'data-no-i18n': '' }, col.name),
          el('span', 'sc-sub', col.role === 'collaborator' ? 'Collaborator · can reply & add messages' : 'Viewer · read-only')),
        roleSel,
        copyBtn,
        rvBtn);
    }));
  };

  const nameIn = el('input', { type: 'text', maxlength: SHARE_LIMITS.name, placeholder: 'Collaborator’s name', 'aria-label': 'Collaborator name' });
  const roleIn = el('select', { 'aria-label': 'Role' },
    ...SHARE_ROLES.map((r) => {
      const o = el('option', { value: r.k }, r.label);
      if (r.k === 'collaborator') o.selected = true;
      return o;
    }));
  const addBtn = el('button', { type: 'button', class: 'btn' }, 'Invite collaborator');
  const addSeat = async () => {
    const name = nameIn.value.trim();
    if (!name) { toast('Enter their name first'); nameIn.focus(); return; }
    if ((rec.collaborators || []).length >= SHARE_LIMITS.collaborators) { toast(`Up to ${SHARE_LIMITS.collaborators} collaborators per share`); return; }
    const seat = { id: newSeatId(), name, role: roleIn.value === 'viewer' ? 'viewer' : 'collaborator', token: newCollaboratorToken(), created: Date.now() };
    rec.collaborators = [...(rec.collaborators || []), seat];
    nameIn.value = '';
    await syncToServer();
    drawSeats();
  };
  addBtn.addEventListener('click', addSeat);
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSeat(); } });

  // Replies section: fetch and decrypt any collaborator replies from /s/<id>/data
  const repliesBox = el('div', 'share-replies-box');
  if (rec.key) {
    fetch(apiUrl(`/s/${rec.id}/data`), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data) => {
        if (!data || !Array.isArray(data.replies) || !data.replies.length) return;
        const opened = [];
        for (const item of data.replies) {
          try {
            const dec = await openReply(item.blob, rec.key);
            opened.push({ ...dec, id: item.id, at: item.at || dec.at });
          } catch { /* ignore damaged reply */ }
        }
        if (!opened.length) return;
        const syncRepliesBtn = c ? el('button', {
          type: 'button',
          class: 'cap primary',
          onclick: () => importRepliesToChat(c, rec, opened),
        }, 'Add replies to this chat') : null;
        repliesBox.replaceChildren(
          el('div', 'share-collab-head',
            el('b', '', `Collaborator replies (${opened.length})`),
            syncRepliesBtn),
          el('div', 'share-reply-list', ...opened.map((r) => el('div', 'share-reply-item',
            el('div', 'sri-head', el('b', { 'data-no-i18n': '' }, r.author), el('span', 'muted', r.at ? day(r.at) : '')),
            el('div', { class: 'sri-text', 'data-no-i18n': '' }, r.text)))),
        );
      })
      .catch(() => {});
  }

  drawSeats();
  box.append(
    el('label', 'field', 'Main link access', modeToggle),
    el('div', 'share-collab-head', el('b', '', 'Personal collaborator links'), el('span', 'muted', 'Each collaborator gets their own link and role')),
    el('div', 'share-collab-add', nameIn, roleIn, addBtn),
    listWrap,
    repliesBox,
  );
  return box;
}

function importRepliesToChat(c, rec, replies) {
  if (!c || !replies.length) return;
  const imported = new Set(Array.isArray(rec.importedReplies) ? rec.importedReplies : []);
  let added = 0;
  for (const r of replies) {
    if (r.id && imported.has(r.id)) continue;
    const tail = path(c).at(-1);
    const parentId = tail ? tail.id : null;
    addNode(c, parentId, {
      role: 'user',
      content: `[${r.author}]: ${r.text}`,
      author: r.author,
      created: r.at || Date.now(),
    });
    if (r.id) imported.add(r.id);
    added += 1;
  }
  rec.importedReplies = [...imported];
  updateRec(c, rec);
  if (state.current === c && ui.render) ui.render();
  if (ui.renderSidebar) ui.renderSidebar();
  toast(added ? `Added ${added} collaborator ${added === 1 ? 'reply' : 'replies'} to this chat` : 'All replies are already in this chat');
}

export function paintMade(c, rec) {
  const modeLabel = rec.mode === 'collaborate' ? 'collaborative' : (rec.collaborators && rec.collaborators.length ? `with ${rec.collaborators.length} collaborator${rec.collaborators.length === 1 ? '' : 's'}` : 'read-only');
  H.openDialog('Shared link & collaborators', el('div', 'share',
    el('p', 'share-lead', el('b', '', rec.title), ` is shared: ${rec.count || 0} message${rec.count === 1 ? '' : 's'}, ${modeLabel}${rec.expires ? `, until ${day(rec.expires)}` : ''}.`),
    linkRow(rec),
    manageCollaboratorsBox(c, rec),
    el('p', 'sp-note', 'The part after # is the key: whoever has the link can open it, and the server never sees the key. Revoke a collaborator or the whole link whenever you like.'),
    el('div', 'share-bar', el('button', { type: 'button', class: 'btn', onclick: () => revoke(c, rec).then((ok) => { if (ok) H.closeDialog(); }) }, 'Revoke link'), el('span', 'grow'),
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

/** This chat's live links, and (folded) every shared link on the account, each with Copy, Manage and Revoke. */
function sharedList(c) {
  const mine = live(c);
  const box = el('div', 'share-list');
  const row = (rec, chat, gone = false) => {
    const rv = el('button', { type: 'button', class: 'cap rev' }, 'Revoke');
    rv.addEventListener('click', async () => {
      if (rv.dataset.sure !== '1') { rv.dataset.sure = '1'; rv.textContent = 'Revoke?'; setTimeout(() => { rv.dataset.sure = ''; rv.textContent = 'Revoke'; }, 4000); return; }
      if (await revoke(chat, rec)) rv.closest('.share-item').classList.add('gone');
    });
    const collabCount = Array.isArray(rec.collaborators) ? rec.collaborators.length : 0;
    const badge = rec.mode === 'collaborate'
      ? ' · collaborative'
      : collabCount
        ? ` · ${collabCount} collaborator${collabCount === 1 ? '' : 's'}`
        : '';
    return el('div', `share-item${gone ? ' gone' : ''}`,
      el('div', 'si-t', el('b', '', rec.title || 'Shared chat'), el('span', 'si-c', `${rec.count ? `${rec.count} messages · ` : ''}${rec.created ? `made ${day(rec.created)}` : ''}${rec.expires ? ` · until ${day(rec.expires)}` : ''}${badge}`)),
      rec.key ? el('button', { type: 'button', class: 'cap', title: 'Manage collaborators & replies', onclick: () => paintMade(chat, rec) }, 'Collaborators') : null,
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
        return row(k ? { ...k.s, created: s.created, expires: s.expires, mode: s.mode || k.s.mode } : { id: s.id, title: 'A chat not on this device', created: s.created, expires: s.expires, mode: s.mode }, k ? k.x : null);
      }));
    }, (e) => list.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t load your shared links'), ' ', e.message)));
  });
  box.append(all);
  return box;
}
