// Eden Slides share links (web only): View, Comment or Edit links to a deck, each with its own expiry, for anyone
// with the link or kept by the first Eden account that opens it, and revoked one by one. Each link is a seat on the
// deck's room share (deck-room.js; the room is askeden.com's DeckRoom, behind `eden.collab.room`): the server checks
// the role, the expiry and the account (askeden src/chat/shares.ts seatAccess, site src/accounts/shared-chats.js), and
// a "can comment" seat sends comments but never edits. Everything in the link after # stays out of every server.

import { el, toast } from './util.js';
import { t as tx } from './i18n.js';
import { state, saveConversation } from './state.js';
import { postJSON } from './api.js';
import { roomEnabled, roomLink, seal, ROOM_ID } from './deck-room.js';
import { EXPIRY, expiresAt } from './share-model.js';
import { registerContextMenu } from './deck-shell.js';
import { IN_APP } from './native.js';

export const LINK_ROLES = [
  { k: 'viewer', label: 'Can view', detail: 'See the deck and follow changes' },
  { k: 'commenter', label: 'Can comment', detail: 'Add comments and replies; no edits' },
  { k: 'collaborator', label: 'Can edit', detail: 'Edit the slides with you' },
];
const roleLabel = (k) => (LINK_ROLES.find((r) => r.k === k) || LINK_ROLES[0]).label;
const hosted = () => !!(state.meta && state.meta.hosted);
const b64u = (bytes) => { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const random = (n) => b64u(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const live = (s) => !s.expires || s.expires > Date.now();

/** The seats as the server takes them (tokens are hashed there; the label stays a note for the owner). */
const serverSeats = (seats) => seats.map((s) => ({ id: s.id, role: s.role, token: s.token, ...(s.expires ? { expires: s.expires } : {}), ...(s.people ? { people: true } : {}), ...(s.label ? { label: s.label } : {}) }));

/** The deck's room share, made the first time (no links yet: seats come one by one). */
async function roomShare(c, post = postJSON) {
  if (c.deckRoom && c.deckRoom.owner && ROOM_ID.test(c.deckRoom.id || '')) { c.deckRoom.seats ||= []; return c.deckRoom; }
  const key = random(32);
  const title = String((c.deckVersions || []).at(-1)?.deck?.title || c.title || 'Slides').slice(0, 160);
  const res = await post('/api/chat/share', { blob: await seal({ kind: 'deck-room', title }, key, 'share'), expires: null, mode: 'collaborate', access: 'seat', collaborators: [] });
  if (!res || !ROOM_ID.test(res.id || '')) throw new Error(tx('Eden couldn’t make a link for this deck.'));
  c.deckRoom = { id: res.id, key, owner: true, seats: [], links: {} };
  saveConversation(c);
  return c.deckRoom;
}
async function saveSeats(c, seats, post = postJSON) {
  await post('/api/chat/shares/update', { id: c.deckRoom.id, access: 'seat', collaborators: serverSeats(seats) });
  c.deckRoom.seats = seats;
  saveConversation(c);
}
export const seatLink = (c, s, origin = location.origin) => roomLink(origin, { id: c.deckRoom.id, key: c.deckRoom.key, token: s.token });

/** Add a link: { role, expiry ('never' | '1d' | '7d' | '30d'), people, label } → the seat. */
export async function addLink(c, { role, expiry = 'never', people = false, label = '' }, post = postJSON) {
  if (!LINK_ROLES.some((r) => r.k === role)) throw new Error('Pick view, comment or edit.');
  const room = await roomShare(c, post);
  const seat = { id: random(6), role, token: random(24), created: Date.now(), ...(expiresAt(expiry) ? { expires: expiresAt(expiry) } : {}), ...(people ? { people: true } : {}), ...(label.trim() ? { label: label.trim().slice(0, 40) } : {}) };
  await saveSeats(c, [...room.seats.filter(live), seat], post);
  return seat;
}
export async function revokeLink(c, id, post = postJSON) { await saveSeats(c, c.deckRoom.seats.filter((s) => s.id !== id && live(s)), post); }
export async function changeRole(c, id, role, post = postJSON) { await saveSeats(c, c.deckRoom.seats.filter(live).map((s) => (s.id === id ? { ...s, role } : s)), post); }
/** Stop sharing: every link stops (the share is revoked; the room closes and forgets). */
export async function stopSharing(c, post = postJSON) {
  if (!c.deckRoom) return;
  await post('/api/chat/shares/revoke', { id: c.deckRoom.id });
  delete c.deckRoom;
  saveConversation(c);
}

// ── the dialog ──

let dialog = null;
export function openShareLinks(c, { publish } = {}) {
  if (!c || IN_APP) return;
  if (dialog && dialog.open) dialog.close();
  cssOnce();
  const ret = document.activeElement;
  const d = el('dialog', { class: 'dpr-sheet dsl', 'aria-label': tx('Share this deck') });
  dialog = d;
  const close = () => { if (d.open) d.close(); };
  d.addEventListener('close', () => { d.remove(); if (ret && ret.isConnected && ret.focus) ret.focus(); });
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  const body = el('div', { class: 'dpr-sheet-body' });
  d.append(el('header', { class: 'dpr-sheet-head' }, el('h2', '', tx('Share this deck')), el('button', { type: 'button', class: 'dpr-x', 'aria-label': tx('Close'), onclick: close }, '✕')), body);
  const status = el('p', { class: 'dpr-note', role: 'status' });
  const draw = (focusKey = '') => {
    const kids = [];
    if (!roomEnabled()) {
      kids.push(el('p', { class: 'dpr-sum' }, tx('View, comment and edit links share the live deck through askeden.com’s deck room, which is still being tested. Until it’s on, you can publish a view-only copy.')),
        el('div', { class: 'dpr-row' }, publish ? el('button', { type: 'button', class: 'dpr-btn primary', onclick: () => { close(); publish(); } }, tx('Publish a view-only copy…')) : null));
      body.replaceChildren(...kids);
      return;
    }
    const seats = (c.deckRoom && c.deckRoom.seats) || [];
    // the new link
    const role = el('select', { class: 'dpr-field', 'aria-label': tx('Access'), 'data-k': 'role' }, LINK_ROLES.map((r) => el('option', { value: r.k }, tx(r.label))));
    const expiry = el('select', { class: 'dpr-field', 'aria-label': tx('Expires'), 'data-k': 'expiry' }, EXPIRY.map((x) => el('option', { value: x.k }, x.k === 'never' ? tx('Never expires') : `${tx('Expires in')} ${tx(x.label)}`)));
    const canPeople = hosted();
    const who = el('div', { class: 'dpr-row', role: 'radiogroup', 'aria-label': tx('Who can open it') },
      el('label', { class: 'dpr-check' }, el('input', { type: 'radio', name: 'dsl-who', value: 'anyone', checked: true }), tx('Anyone with the link')),
      el('label', { class: 'dpr-check' }, el('input', { type: 'radio', name: 'dsl-who', value: 'people', disabled: !canPeople || null }), tx('One Eden account')));
    const label = el('input', { type: 'text', class: 'dpr-field', maxlength: '40', placeholder: tx('Who is it for? (only you see this)'), 'aria-label': tx('Note for yourself'), 'data-k': 'label' });
    const make = el('button', { type: 'button', class: 'dpr-btn primary', 'data-k': 'make', onclick: async () => {
      make.disabled = true;
      try {
        const people = d.querySelector('input[name="dsl-who"]:checked').value === 'people';
        const s = await addLink(c, { role: role.value, expiry: expiry.value, people, label: label.value });
        await copy(seatLink(c, s), tx('Link made and copied'));
        draw(`copy:${s.id}`);
      } catch (e) { status.textContent = e.message || tx('Couldn’t make the link'); make.disabled = false; }
    } }, tx('Create link'));
    kids.push(el('div', { class: 'dsl-new' },
      el('div', { class: 'dpr-row' }, role, expiry), who,
      el('p', { class: 'dpr-note' }, canPeople ? tx('“One Eden account”: the first person signed in to Eden who opens the link keeps it; if it’s forwarded, it won’t open for anyone else.') : tx('Links made on this Mac open only on this Mac. Invitations for one Eden account need askeden.com.')),
      label, el('div', { class: 'dpr-row' }, make)));
    // the links so far
    kids.push(el('h3', { class: 'dsl-h' }, tx('Links')));
    if (!seats.length) kids.push(el('p', { class: 'dpr-note' }, tx('No links yet.')));
    else {
      const list = el('ul', { class: 'dsl-list' });
      for (const s of seats) {
        const gone = !live(s);
        const sel = el('select', { class: 'dpr-field', 'aria-label': `${tx('Access for')} ${s.label || tx('this link')}`, disabled: gone || null, 'data-k': `role:${s.id}`, onchange: async () => { try { await changeRole(c, s.id, sel.value); status.textContent = tx('Changed. People already in see it the next time they join.'); draw(`role:${s.id}`); } catch (e) { status.textContent = e.message; } } },
          LINK_ROLES.map((r) => el('option', { value: r.k, selected: r.k === s.role || null }, tx(r.label))));
        list.append(el('li', { class: gone ? 'gone' : '' },
          el('div', { class: 'dsl-who' }, el('strong', '', s.label || (s.people ? tx('One Eden account') : tx('Anyone with the link'))),
            el('span', { class: 'dpr-note' }, [s.people ? tx('one Eden account') : tx('anyone with the link'), s.expires ? (gone ? `${tx('expired')} ${day(s.expires)}` : `${tx('until')} ${day(s.expires)}`) : tx('no expiry')].join(' · '))),
          sel,
          el('button', { type: 'button', class: 'dpr-btn small', disabled: gone || null, 'data-k': `copy:${s.id}`, onclick: () => copy(seatLink(c, s), tx('Link copied')) }, tx('Copy')),
          el('button', { type: 'button', class: 'dpr-btn small danger', 'data-k': `revoke:${s.id}`, 'aria-label': `${tx('Revoke')} ${s.label || roleLabel(s.role)}`, onclick: async () => { try { await revokeLink(c, s.id); status.textContent = tx('Revoked: that link stops working now.'); draw('make'); } catch (e) { status.textContent = e.message; } } }, tx('Revoke'))));
      }
      kids.push(list);
    }
    kids.push(status);
    if (c.deckRoom) kids.push(el('div', { class: 'dpr-row dsl-stop' }, el('button', { type: 'button', class: 'dpr-btn danger', onclick: async () => {
      if (!confirm(tx('Stop sharing this deck? Every link stops working.'))) return;
      try { await stopSharing(c); status.textContent = tx('Sharing stopped.'); draw('make'); } catch (e) { status.textContent = e.message; }
    } }, tx('Stop sharing'))));
    if (publish) kids.push(el('p', { class: 'dpr-note' }, tx('Or '), el('button', { type: 'button', class: 'dsl-linkbtn', onclick: () => { close(); publish(); } }, tx('publish a view-only copy')), tx(' anyone can open without Eden.')));
    body.replaceChildren(...kids);
    const f = focusKey && body.querySelector(`[data-k="${focusKey}"]`);
    (f || body.querySelector('[data-k="role"]') || body.querySelector('button')).focus();
  };
  (document.fullscreenElement || document.body).append(d);
  d.showModal();
  draw();
}
async function copy(text, said) {
  try { await navigator.clipboard.writeText(text); toast(said); } catch { prompt(tx('Copy this link'), text); }
}
function cssOnce() {
  for (const [file, attr] of [['deck-present.css', 'data-deck-present'], ['deck-share.css', 'data-deck-share']]) {
    if (document.querySelector(`link[${attr}]`)) continue;
    document.head.append(el('link', { rel: 'stylesheet', href: new URL(`./${file}`, import.meta.url).href, [attr]: '' }));
  }
}

if (!IN_APP) {
  registerContextMenu({ id: 'share-links', target: 'file', order: 5, items: (ctx) => [{ label: tx('Share links…'), icon: 'share', run: () => openShareLinks(ctx.conv, { publish: ctx.actions && ctx.actions.share }) }] });
  registerContextMenu({ id: 'share-links-collab', target: 'share', order: 5, items: (ctx) => [{ label: tx('Share links…'), icon: 'share', detail: tx('View, comment or edit; expiry; revoke'), run: () => openShareLinks(ctx.conv, { publish: ctx.actions && ctx.actions.share }) }] });
}
