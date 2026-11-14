// Eden Mail's extra mailboxes (askeden ROADMAP Y, behind MAIL_MULTI): more Gmail accounts beside the
// one hosted Eden already has. The Worker side is src/eden/mailboxes.js; this file is the storage in
// the account's Durable Object (account.js dispatches every `mbox-*` op here) and the sealing.
//
//   mbox:index     [{ id, provider, email, sub, label, color, added, status }]: no secrets (the page
//                  is shown the id, provider, email, label, colour and status; `sub` stays here)
//   mbox:key:<id>  { v, gen, iv, ct }: AES-256-GCM of { refresh, access, access_exp, scopes, email,
//                  sub, connected } under a key derived from EDEN_TOKEN_KEY, this account AND this
//                  mailbox, with both as associated data: a record copied to another mailbox or
//                  account can't be opened. The object stores ciphertext only; the Worker seals.
//   mbox:prefs     { primary: { label, color } }: the first Gmail's (tokens.js `google_data`) name
//                  and colour in Mail; its key stays where it is, so nothing has to reconnect.
//
// - `gen` changes on every connect, so a refreshed access token saved late (mbox-touch) never brings
//   back a grant that was removed or replaced (as tokens.js does for google_data).
// - Deleting the Eden account revokes every mailbox's grant at Google (forgetMailboxesOnDelete).

import { ApiError, b64url, randomBytes, sameText } from './util.js';
import { caller, checkSealed, openWith, sealWith } from './tokens.js';

export const MBOX_INDEX = 'mbox:index';
export const MBOX_PREFS = 'mbox:prefs';
export const mboxKey = (id) => `mbox:key:${id}`;
/** An extra mailbox's id: 'm' and 12 hex digits. The first Gmail is 'primary'. */
export const MBOX_ID = /^m[0-9a-f]{12}$/;
export const MBOX_PRIMARY = 'primary';
/** The colours Mail offers (web/chat/mail-accounts.js maps them to its palette). */
export const MBOX_COLORS = ['indigo', 'teal', 'pink', 'purple', 'brown', 'green', 'orange', 'blue'];
export const MBOX_PROVIDERS = ['gmail', 'imap', 'outlook'];
const MBOX_KIND_RE = /^[a-z]{2,12}$/;
const FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'junk'];
const ATTEMPTS = 'mbox:attempts';
const ATTEMPT_MAX = 5; // failed sign-ins (adding an IMAP mailbox) per hour, per Eden account
const ATTEMPT_WINDOW = 3600_000;
const LABEL_MAX = 40;
const MBOX_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const newMailboxId = () => `m${[...randomBytes(6)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

// ── sealing (Worker and Durable Object) ──

export const sealMailbox = (env, accountId, boxId, value) => sealWith(env, `mailbox:${accountId}:${boxId}`, `mbox:${accountId}:${boxId}`, value);
export const openMailbox = (env, accountId, boxId, sealed) => openWith(env, `mailbox:${accountId}:${boxId}`, `mbox:${accountId}:${boxId}`, sealed);

// ── checks ──

const mboxBad = (message) => new ApiError(400, 'bad_request', message);

function cleanLabel(v) {
  if (v === undefined) return undefined;
  if (v === null) return '';
  if (typeof v !== 'string') throw mboxBad('label must be text.');
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > LABEL_MAX) throw mboxBad(`A mailbox's name is at most ${LABEL_MAX} characters.`);
  return t;
}
function cleanColor(v) {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !MBOX_COLORS.includes(v)) throw mboxBad(`color must be one of ${MBOX_COLORS.join(', ')}.`);
  return v;
}
/** An IMAP mailbox's folder names (from LIST; no secrets): { inbox, sent, drafts, archive, trash, junk }. */
function cleanFolders(f) {
  if (f === undefined || f === null) return undefined;
  if (typeof f !== 'object') throw mboxBad('folders must be an object.');
  const out = {};
  for (const role of FOLDER_ROLES) {
    const v = f[role];
    if (v === undefined || v === null) { out[role] = null; continue; }
    if (typeof v !== 'string' || !v || v.length > 200 || /[\r\n\0]/.test(v)) throw mboxBad('A folder name is too long or odd.');
    out[role] = v;
  }
  return out;
}
function cleanBox(b) {
  if (!b || typeof b !== 'object') throw mboxBad('A mailbox is needed.');
  if (!MBOX_PROVIDERS.includes(b.provider)) throw mboxBad('provider must be gmail, imap or outlook.');
  if (typeof b.sub !== 'string' || !b.sub || b.sub.length > 255) throw mboxBad('A mailbox needs its account id.');
  if (b.email !== null && b.email !== undefined && (typeof b.email !== 'string' || b.email.length > 254 || !b.email.includes('@'))) throw mboxBad('email must be an address.');
  if (b.kind !== undefined && (typeof b.kind !== 'string' || !MBOX_KIND_RE.test(b.kind))) throw mboxBad('kind must be a provider name.');
  return { provider: b.provider, sub: b.sub, email: b.email || null, ...(b.kind ? { kind: b.kind } : {}), ...(b.folders !== undefined ? { folders: cleanFolders(b.folders) } : {}) };
}
const mboxValidId = (id) => typeof id === 'string' && MBOX_ID.test(id);

/** The next colour nobody uses yet (the first Gmail takes the first). */
export function nextColor(used) {
  const taken = new Set(used);
  return MBOX_COLORS.find((c) => !taken.has(c)) || MBOX_COLORS[used.length % MBOX_COLORS.length];
}

// ── the Account object's ops ──

/** account.js: `if (op.startsWith('mbox-')) return json(await mailboxOp(this, op, body, request));` */
export async function mailboxOp(account, op, body, request) {
  await caller(account, request, body); // a device of this account, or (the consent callback) the browser device its state names
  const index = (await account.storage.get(MBOX_INDEX)) || [];
  const prefs = (await account.storage.get(MBOX_PREFS)) || {};
  const find = (id) => index.find((b) => b.id === id);
  switch (op) {
    case 'mbox-list':
      return { boxes: index, prefs };
    case 'mbox-get': {
      if (!mboxValidId(body.id)) throw mboxBad('id must be a mailbox id.');
      const box = find(body.id);
      return { box: box || null, record: box ? (await account.storage.get(mboxKey(body.id))) || null : null };
    }
    case 'mbox-save': {
      // A grant from the consent callback: the same Google account again refreshes its mailbox; a new one adds one.
      if (!mboxValidId(body.id)) throw mboxBad('id must be a mailbox id.');
      const box = cleanBox(body.box);
      const max = Number.isInteger(body.max) && body.max > 0 ? body.max : 10;
      const sameSub = index.find((b) => b.provider === box.provider && sameText(b.sub, box.sub));
      const here = find(body.id);
      if (here && !sameText(here.sub, box.sub)) throw new ApiError(409, 'conflict', 'That mailbox belongs to another account. Try adding it again.');
      if (sameSub && sameSub.id !== body.id) throw new ApiError(409, 'conflict', 'That account is already in Mail. Try adding it again.');
      if (!here && index.length + 1 >= max) throw new ApiError(409, 'too_many', `Mail holds ${max} accounts at most.`); // +1: the first Gmail counts
      const gen = b64url(randomBytes(9));
      const record = { v: 1, gen, ...checkSealed(body.record), at: account.now() };
      const extra = { ...(box.kind ? { kind: box.kind } : {}), ...(box.folders ? { folders: box.folders } : {}) };
      const next = here
        ? index.map((b) => (b.id === body.id ? { ...b, ...extra, email: box.email || b.email, status: 'ok' } : b))
        : [...index, { id: body.id, provider: box.provider, sub: box.sub, email: box.email, ...extra, label: '', color: nextColor([(prefs.primary && prefs.primary.color) || MBOX_COLORS[0], ...index.map((b) => b.color)]), added: new Date(account.now()).toISOString(), status: 'ok' }];
      await account.storage.put(mboxKey(body.id), record);
      await account.storage.put(MBOX_INDEX, next);
      return { id: body.id, gen, created: !here };
    }
    case 'mbox-touch': {
      // A refreshed access token: only onto the grant it was refreshed from.
      if (!mboxValidId(body.id)) throw mboxBad('id must be a mailbox id.');
      const stored = await account.storage.get(mboxKey(body.id));
      if (!stored || !sameText(stored.gen, String(body.gen || ''))) return { saved: false };
      await account.storage.put(mboxKey(body.id), { ...stored, ...checkSealed(body.record), at: account.now() });
      return { saved: true };
    }
    case 'mbox-broken': {
      // Google refused the refresh token: the key goes; the mailbox stays in the list, marked for reconnecting.
      if (!mboxValidId(body.id)) throw mboxBad('id must be a mailbox id.');
      const stored = await account.storage.get(mboxKey(body.id));
      if (stored && !sameText(stored.gen, String(body.gen || ''))) return { marked: false };
      if (stored) await account.storage.delete(mboxKey(body.id));
      if (find(body.id)) await account.storage.put(MBOX_INDEX, index.map((b) => (b.id === body.id ? { ...b, status: 'reconnect' } : b)));
      return { marked: true };
    }
    case 'mbox-edit': {
      const label = cleanLabel(body.label);
      const color = cleanColor(body.color);
      if (body.id === MBOX_PRIMARY) {
        const primary = { ...(prefs.primary || {}), ...(label !== undefined ? { label } : {}), ...(color !== undefined ? { color } : {}) };
        await account.storage.put(MBOX_PREFS, { ...prefs, primary });
        return { boxes: index, prefs: { ...prefs, primary } };
      }
      if (!mboxValidId(body.id) || !find(body.id)) throw new ApiError(404, 'not_found', 'That mailbox isn’t in Mail any more.');
      const next = index.map((b) => (b.id === body.id ? { ...b, ...(label !== undefined ? { label } : {}), ...(color !== undefined ? { color } : {}) } : b));
      await account.storage.put(MBOX_INDEX, next);
      return { boxes: next, prefs };
    }
    case 'mbox-folders': {
      // an IMAP mailbox's folder made since (Archive, the first Done): kept for the next request
      if (!mboxValidId(body.id) || !find(body.id)) return { saved: false };
      const folders = cleanFolders(body.folders);
      await account.storage.put(MBOX_INDEX, index.map((b) => (b.id === body.id ? { ...b, folders } : b)));
      return { saved: true };
    }
    case 'mbox-attempt': {
      // adding an IMAP mailbox: at most ATTEMPT_MAX wrong passwords an hour (so Eden can't be used to try passwords)
      const now = account.now();
      const recent = ((await account.storage.get(ATTEMPTS)) || []).filter((t) => now - t < ATTEMPT_WINDOW);
      if (body.failed === true) { recent.push(now); await account.storage.put(ATTEMPTS, recent.slice(-50)); return { left: Math.max(0, ATTEMPT_MAX - recent.length) }; }
      if (recent.length >= ATTEMPT_MAX) throw new ApiError(429, 'slow_down', 'Too many wrong passwords in the last hour. Make a new app password and try again later.', { 'retry-after': String(Math.ceil((ATTEMPT_WINDOW - (now - recent[0])) / 1000)) });
      return { left: ATTEMPT_MAX - recent.length };
    }
    case 'mbox-delete': {
      // Removed: gone here at once; the Worker revokes what this returns.
      if (!mboxValidId(body.id)) throw mboxBad('id must be a mailbox id.');
      const record = (await account.storage.get(mboxKey(body.id))) || null;
      await account.storage.delete(mboxKey(body.id));
      const next = index.filter((b) => b.id !== body.id);
      await account.storage.put(MBOX_INDEX, next);
      return { record, boxes: next, prefs };
    }
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

/**
 * account.js deleteAll(), before storage.deleteAll(): revokes every extra mailbox's grant at Google,
 * as forgetGoogleOnDelete does for the first Gmail. Never throws.
 */
export async function forgetMailboxesOnDelete(account, { fetch: f = (url, init) => fetch(url, init) } = {}) {
  try {
    const index = (await account.storage.get(MBOX_INDEX)) || [];
    const id = ((await account.storage.get('account')) || {}).id;
    if (!id || !index.length) return;
    await Promise.all(index.map(async (b) => {
      try {
        const tokens = await openMailbox(account.env, id, b.id, await account.storage.get(mboxKey(b.id)));
        const token = tokens && (tokens.refresh || tokens.access);
        if (!token) return;
        await f(MBOX_REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
          signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
        });
      } catch {
        // the record goes with the account anyway; the owner can remove Eden at myaccount.google.com
      }
    }));
  } catch {
    // as above
  }
}
