// Eden Mail's Outlook mailboxes: Outlook.com, Hotmail, Live and Microsoft 365, signed in with Microsoft
// (askeden ROADMAP Y3; registration: askeden/docs/outlook-registration.md). Microsoft turned off password
// sign-in for outside mail apps, so these use OAuth and Microsoft Graph, never IMAP.
//
// The same trick as mail-imap.js: an Outlook mailbox answers *Gmail's REST API* (the requests Eden's Gmail
// core makes), served from Microsoft Graph. createGmailApi + runGmailAction (vendor/google.js) run unchanged
// on top, and Eden Mail on the page needs nothing new beyond the mailbox id.
//
//   ids        Graph's immutable message id (Prefer: IdType="ImmutableId", so Done and undo keep it), its
//              "=" padding dropped (Gmail's id characters)
//   threads    'c' + the conversationId (padding dropped); found again with $filter=conversationId eq …
//   labels     INBOX/SENT/DRAFT/SPAM/TRASH by folder, UNREAD = !isRead, STARRED = flagged
//   Done       moves to Archive; undo (or a snooze waking) moves back to Inbox
//   reading    the list from Graph's fields; an opened message as its MIME ($value), read like IMAP's
//   send       the message Eden built (MIME) made a draft, then sent (Outlook files it in Sent Items)
//   drafts     MIME drafts; an update replaces the draft (new id, mapped within a request)
//   history    a number from the inbox's counts and the newest change anywhere
//   search     Gmail's words as Graph $search (KQL) or $filter; what neither can say is checked here
// Tokens: the access token is the caller's (mailboxes.js refreshes and seals it; Microsoft rotates the
// refresh token on every refresh, and the new one is saved). Nothing here is sent to the browser.

import { GoogleError } from './vendor/google.js';
import { gmailPayload, mimeB64url, mimeBinary, parseMessage, partAt, pathOfAttachmentId, snippetOf } from './mime.js';
import { GMAIL_UPLOAD_BASE, prepareOutgoing } from './mail-imap.js';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const MS_LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
/** Least scopes for mail: read and change mail, send it, and the address (User.Read). No calendar, no files. */
export const MS_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send'];
/** Graph takes requests up to 4 MB; a MIME message goes as base64 (a third bigger). */
export const GRAPH_MIME_MAX = 2_900_000;
const GRAPH_SELECT = 'id,conversationId,subject,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,sentDateTime,lastModifiedDateTime,bodyPreview,isRead,isDraft,flag,hasAttachments,internetMessageId,parentFolderId';
const GRAPH_PREFER = 'IdType="ImmutableId"';
const GRAPH_FOLDERS = { inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', archive: 'archive', trash: 'deleteditems', junk: 'junkemail' };

// ── Microsoft sign-in ──

export const msReady = (env = {}) => Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);
export const msClient = (env) => ({ clientId: String(env.MICROSOFT_CLIENT_ID), clientSecret: String(env.MICROSOFT_CLIENT_SECRET) });
/** Graph's and Microsoft sign-in's fetch (tests pass their own as env.MS_FETCH). */
export const msFetch = (env) => (env && typeof env.MS_FETCH === 'function' ? env.MS_FETCH : (u, i) => fetch(u, i));

/** Microsoft's account chooser and consent, back to `redirectUri` with ?code&state (PKCE S256). */
export function msAuthUrl(client, { redirectUri, state, challenge, loginHint = '' }) {
  const q = new URLSearchParams({ client_id: client.clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: MS_SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
  if (loginHint) q.set('login_hint', loginHint);
  return `${MS_LOGIN}/authorize?${q}`;
}

async function msToken(client, f, form) {
  let res;
  try {
    res = await f(`${MS_LOGIN}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, scope: MS_SCOPES.join(' '), ...form }).toString() });
  } catch {
    throw new GoogleError('Eden couldn’t reach Microsoft to sign in. Try again in a minute.', 'unavailable', 503);
  }
  let j = {};
  try { j = await res.json(); } catch { /* not JSON */ }
  if (res.ok && typeof j.access_token === 'string') return j;
  if (['invalid_grant', 'interaction_required', 'consent_required', 'unauthorized_client'].includes(j.error)) throw new GoogleError('Microsoft wants you to sign in to this mailbox again: press Reconnect in Mail.', 'reconnect', 401);
  throw new GoogleError(`Microsoft sign-in answered ${res.status}.`, 'upstream', 502);
}
/** The consent's code for tokens: { access_token, refresh_token, id_token, expires_in, scope }. */
export const msExchange = (client, f, { code, verifier, redirectUri }) => msToken(client, f, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
/** A fresh access token; Microsoft also sends a new refresh token, which replaces the old one. */
export async function msRefresh(client, refresh, f) {
  const j = await msToken(client, f, { grant_type: 'refresh_token', refresh_token: refresh });
  return { accessToken: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600) * 1000, refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : null };
}

/** The id_token Microsoft's token endpoint just sent (over TLS: no signature check needed): who signed in. */
export function msIdClaims(idToken, clientId) {
  try {
    const part = String(idToken).split('.')[1] || '';
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4)), (ch) => ch.charCodeAt(0))));
    const aud = Array.isArray(c.aud) ? c.aud.includes(clientId) : c.aud === clientId;
    if (!aud || typeof c.tid !== 'string' || !/^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(String(c.iss || ''))) return null;
    const oid = typeof c.oid === 'string' && c.oid ? c.oid : typeof c.sub === 'string' && c.sub ? c.sub : null;
    if (!oid) return null;
    const mail = [c.email, c.preferred_username].find((v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+$/.test(v)) || null;
    return { sub: `ms:${c.tid}:${oid}`, email: mail, name: typeof c.name === 'string' ? c.name.slice(0, 120) : '' };
  } catch {
    return null;
  }
}

/** Mail.ReadWrite and Mail.Send both granted (Microsoft lists them with or without Graph's address). */
export function hasOutlookScopes(scopes) {
  const s = new Set((scopes || []).map((x) => String(x).replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase()));
  return s.has('mail.readwrite') && s.has('mail.send');
}

/** The mailbox's address and name from Graph (/me): `mail`, else the sign-in name when it's an address. */
export async function graphMe(f, access) {
  const res = await f(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, { headers: { authorization: `Bearer ${access}` } });
  if (!res.ok) throw new GoogleError('Microsoft didn’t say which mailbox this is.', 'upstream', 502);
  const j = await res.json();
  const upn = typeof j.userPrincipalName === 'string' && !j.userPrincipalName.includes('#EXT#') ? j.userPrincipalName : null;
  const email = [j.mail, upn].find((v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+$/.test(v)) || null;
  return { email, name: typeof j.displayName === 'string' ? j.displayName.slice(0, 120) : '' };
}

// ── ids ──

const GRAPH_ID_CHARS = /^[A-Za-z0-9_-]{1,128}$/;
/** A Graph id as a Gmail-style id ('=' padding dropped); null when it can't be one. */
export const edenIdOf = (gid) => {
  const s = String(gid || '').replace(/=+$/, '');
  return GRAPH_ID_CHARS.test(s) ? s : null;
};
/** Back to Graph's id (its padding restored). */
export const graphIdOf = (id) => `${id}${'='.repeat((4 - (id.length % 4)) % 4)}`;
export const threadIdOfConversation = (conv) => {
  const s = String(conv || '').replace(/=+$/, '');
  return s && /^[A-Za-z0-9_-]{1,126}$/.test(s) ? `c${s}` : null;
};

// ── Gmail's search words → Graph ──

/**
 * A Gmail search (what Eden's Mail and Ask your inbox write) for Graph: { folder, search (KQL for
 * $search, or null), filter ($filter terms, used when there's no search), keep (a check on each row,
 * for what $search can't say) }. $search and $filter can't be used together on mail, so with words to
 * search, read/starred/dates are checked here instead.
 */
export function toGraphQuery(q, now = Date.now()) {
  let folder = null;
  const kql = [];
  const filter = [];
  const checks = [];
  const re = /(-?)(?:([a-z_]+):)?("(?:[^"\\]|\\.)*"|[^\s"(){}]+)|\b(OR)\b/g;
  const text = String(q || '').replace(/[(){}]/g, ' ');
  const word = (v) => (/[\s:"\\]/.test(v) ? `\\"${v.replace(/["\\]/g, ' ').trim()}\\"` : v);
  const day = (s) => { const d = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s); return d ? new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])) : null; };
  let m;
  while ((m = re.exec(text))) {
    if (m[4]) { if (kql.length && kql[kql.length - 1] !== 'OR') kql.push('OR'); continue; }
    const neg = m[1] === '-';
    const key = (m[2] || '').toLowerCase();
    let val = m[3] || '';
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!val) continue;
    if (val === 'OR' && !key) { if (kql.length && kql[kql.length - 1] !== 'OR') kql.push('OR'); continue; }
    const v = val.toLowerCase();
    const not = (s) => (neg ? `NOT ${s}` : s);
    switch (key) {
      case 'from': case 'to': case 'cc': case 'bcc': case 'subject':
        kql.push(not(`${key}:${word(val)}`));
        break;
      case '':
        kql.push(not(word(val)));
        break;
      case 'is':
        if (v === 'unread' || v === 'read') {
          const read = (v === 'read') !== neg; // is:unread → isRead false; -is:unread → true
          filter.push(`isRead eq ${read}`);
          checks.push((r) => Boolean(r.isRead) === read);
        } else if (v === 'starred') {
          filter.push(`flag/flagStatus ${neg ? 'ne' : 'eq'} 'flagged'`);
          checks.push((r) => ((r.flag && r.flag.flagStatus) === 'flagged') !== neg);
        }
        break;
      case 'has':
        if (v === 'attachment') { filter.push(`hasAttachments eq ${!neg}`); checks.push((r) => Boolean(r.hasAttachments) !== neg); }
        break;
      case 'newer_than': case 'older_than': case 'after': case 'since': case 'before': {
        const ago = /^(\d{1,4})([dmy])$/.exec(v);
        const d = ago ? new Date(now - Number(ago[1]) * (ago[2] === 'y' ? 365 : ago[2] === 'm' ? 30 : 1) * 86_400_000) : key.endsWith('_than') ? null : day(v);
        if (!d) break;
        const before = (key === 'older_than' || key === 'before') !== neg;
        filter.push(`receivedDateTime ${before ? 'lt' : 'ge'} ${d.toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
        checks.push((r) => { const t = Date.parse(r.receivedDateTime || r.sentDateTime || ''); return before ? t < d.getTime() : t >= d.getTime(); });
        break;
      }
      case 'in':
        if (!neg && ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam', 'anywhere', 'all'].includes(v)) folder = v === 'anywhere' || v === 'all' ? 'any' : v === 'spam' ? 'junk' : v;
        break;
      default: // category:, label:, filename:, … left out rather than guessed
    }
  }
  while (kql[0] === 'OR') kql.shift();
  while (kql[kql.length - 1] === 'OR') kql.pop();
  return { folder, search: kql.length ? kql.join(' ') : null, filter, keep: checks.length ? (r) => checks.every((c) => c(r)) : null };
}

// ── addresses and headers from Graph's fields ──

const GRAPH_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GRAPH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const graphDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${GRAPH_DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${GRAPH_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};
const graphAddress = (r) => {
  const e = r && r.emailAddress;
  if (!e || !e.address) return '';
  const name = String(e.name || '').trim();
  if (!name || name.toLowerCase() === String(e.address).toLowerCase()) return e.address;
  return `${/[",;<>@()[\]:\\]/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : name} <${e.address}>`;
};
const graphAddresses = (list) => (Array.isArray(list) ? list.map(graphAddress).filter(Boolean).join(', ') : '');

const graphJson = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const graphMissing = () => graphJson({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }, 404);
const graphB64Bytes = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const graphMark = (parts) => {
  // FNV-1a over the inbox counts and the newest change, as a decimal Gmail-style history id (≤ 16 digits)
  let h = 0xcbf29ce4n;
  for (const ch of parts.join('|')) h = ((h ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n) & 0x1fffffffffffffn;
  return String(h);
};

class GraphError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// ── the Gmail-shaped API over Microsoft Graph ──

/**
 * A Gmail REST API (as the core calls it) for one Outlook mailbox: { fetch, close, error }.
 * `token(fresh)` gives an access token (fresh = the last one was refused); `folders` the well-known
 * folders' ids from before (saved with the mailbox); `onFolders(folders)` when they were looked up;
 * `onAuthFail()` when Microsoft refuses the mailbox's sign-in.
 */
export function createGraphGmail({ fetch: f, token, email, name = '', folders: known, onFolders, onAuthFail, now = () => Date.now() }) {
  let folders = known && known.inbox ? { ...known } : null;
  const meta = new Map(); // id → Graph's message fields
  const full = new Map(); // id → { node, raw }
  const replaced = new Map(); // a draft's old id → its new id (drafts.update), for this request
  const uploads = new Map();
  let nUpload = 0;
  const shim = { error: null };

  async function g(path, { method = 'GET', json, body, headers = {}, raw = false } = {}, retried = false) {
    const access = await token(retried);
    let res;
    try {
      res = await f(`${GRAPH}${path}`, {
        method,
        headers: { authorization: `Bearer ${access}`, prefer: GRAPH_PREFER, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(json !== undefined ? { body: JSON.stringify(json) } : body !== undefined ? { body } : {}),
      });
    } catch {
      throw new GraphError(503, 'unavailable', 'Outlook couldn’t be reached right now. Try again in a minute.');
    }
    if (res.status === 401 && !retried) return g(path, { method, json, body, headers, raw }, true);
    if (!res.ok) {
      let e = {};
      try { e = ((await res.json()) || {}).error || {}; } catch { /* not JSON */ }
      throw new GraphError(res.status, String(e.code || ''), String(e.message || '').slice(0, 300), Number(res.headers.get('retry-after')) || 0);
    }
    if (raw) return new Uint8Array(await res.arrayBuffer());
    const text = res.status === 204 || res.status === 202 ? '' : await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Up to 20 Graph requests in one ($batch): their answers in order; a refused sign-in throws. */
  async function batch(reqs) {
    const out = [];
    for (let i = 0; i < reqs.length; i += 20) {
      const chunk = reqs.slice(i, i + 20).map((r, j) => ({ id: String(i + j), method: r.method || 'GET', url: r.url, headers: { prefer: GRAPH_PREFER, ...(r.body ? { 'content-type': 'application/json' } : {}) }, ...(r.body ? { body: r.body } : {}) }));
      const got = await g('/$batch', { method: 'POST', json: { requests: chunk } });
      for (const r of (got && got.responses) || []) out[Number(r.id)] = r;
    }
    for (const r of out) if (r && r.status === 401) throw new GraphError(401, 'InvalidAuthenticationToken', 'signed out');
    return out;
  }

  async function folderIds() {
    if (folders) return folders;
    const roles = Object.keys(GRAPH_FOLDERS);
    const got = await batch(roles.map((role) => ({ url: `/me/mailFolders/${GRAPH_FOLDERS[role]}?$select=id` })));
    folders = Object.fromEntries(roles.map((role, i) => [role, got[i] && got[i].status === 200 && got[i].body && typeof got[i].body.id === 'string' ? got[i].body.id : null]));
    if (!folders.inbox) throw new GraphError(404, 'MailboxNotEnabledForRESTAPI', 'This Microsoft account has no Outlook mailbox.');
    if (onFolders) await onFolders(folders).catch(() => undefined);
    return folders;
  }
  const roleOf = (r, fl) => Object.keys(GRAPH_FOLDERS).find((role) => fl[role] && fl[role] === r.parentFolderId) || 'other';

  /** A Graph message as the core's message resource (metadata; `payload` for a full one). */
  function resource(id, r, fl, payload) {
    const role = roleOf(r, fl);
    const when = Date.parse(role === 'drafts' ? r.lastModifiedDateTime || r.receivedDateTime : role === 'sent' ? r.sentDateTime || r.receivedDateTime : r.receivedDateTime || r.sentDateTime) || 0;
    const headers = [
      { name: 'From', value: graphAddress(r.from || r.sender) },
      { name: 'To', value: graphAddresses(r.toRecipients) },
      ...(r.ccRecipients && r.ccRecipients.length ? [{ name: 'Cc', value: graphAddresses(r.ccRecipients) }] : []),
      ...(role === 'drafts' && r.bccRecipients && r.bccRecipients.length ? [{ name: 'Bcc', value: graphAddresses(r.bccRecipients) }] : []),
      ...(r.replyTo && r.replyTo.length ? [{ name: 'Reply-To', value: graphAddresses(r.replyTo) }] : []),
      { name: 'Subject', value: String(r.subject || '') },
      { name: 'Date', value: graphDate(new Date(Date.parse(r.sentDateTime || r.receivedDateTime) || when)) },
      ...(r.internetMessageId ? [{ name: 'Message-ID', value: r.internetMessageId }] : []),
    ];
    const labelIds = [
      ...(role === 'inbox' ? ['INBOX'] : role === 'sent' ? ['SENT'] : role === 'drafts' ? ['DRAFT'] : role === 'junk' ? ['SPAM'] : role === 'trash' ? ['TRASH'] : []),
      ...(!r.isRead && role !== 'drafts' && role !== 'sent' ? ['UNREAD'] : []),
      ...((r.flag && r.flag.flagStatus) === 'flagged' ? ['STARRED'] : []),
    ];
    return {
      id,
      threadId: threadIdOfConversation(r.conversationId) || id,
      labelIds,
      snippet: String(r.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      internalDate: String(when),
      sizeEstimate: 0,
      payload: payload || { mimeType: r.hasAttachments ? 'multipart/mixed' : 'text/html', headers },
    };
  }

  const gidOf = (id) => graphIdOf(replaced.get(id) || id);
  function remember(rows) {
    const out = [];
    for (const r of rows || []) {
      const id = edenIdOf(r.id);
      if (!id) continue; // an id too long to carry: left out rather than broken
      meta.set(id, r);
      out.push({ id, r });
    }
    if (!out.length && rows && rows.length) throw new GoogleError('Outlook’s message ids are longer than Eden can keep. This is Eden’s problem: tell us.', 'upstream', 502);
    return out;
  }
  async function metaOf(id) {
    const key = replaced.get(id) || id;
    if (meta.has(key)) return meta.get(key);
    if (!edenIdOf(key)) return null;
    try {
      const r = await g(`/me/messages/${encodeURIComponent(gidOf(key))}?$select=${GRAPH_SELECT}`);
      meta.set(key, r);
      return r;
    } catch (e) {
      if (e instanceof GraphError && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }
  async function fullOf(id) {
    const key = replaced.get(id) || id;
    if (full.has(key)) return full.get(key);
    const [r, raw] = await Promise.all([metaOf(key), g(`/me/messages/${encodeURIComponent(gidOf(key))}/$value`, { raw: true }).catch((e) => { if (e instanceof GraphError && e.status === 404) return null; throw e; })]);
    if (!r || !raw) return null;
    const got = { r, raw, node: parseMessage(raw) };
    full.set(key, got);
    return got;
  }

  /** One page of a folder (or every folder) for a Gmail search. */
  async function list({ role, query, max, pageToken }) {
    const fl = await folderIds();
    const where = role === 'any' ? '/me/messages' : `/me/mailFolders/${GRAPH_FOLDERS[role] || 'inbox'}/messages`;
    const qs = [`$top=${max}`, `$select=${GRAPH_SELECT}`];
    if (query.search) qs.push(`$search=${encodeURIComponent(`"${query.search}"`)}`);
    else {
      // $orderby needs its field first in $filter (Graph refuses it otherwise)
      qs.push(`$filter=${encodeURIComponent(['receivedDateTime ge 1900-01-01T00:00:00Z', ...query.filter].join(' and '))}`, '$orderby=receivedDateTime%20desc');
    }
    // the next page: the same search again (as Gmail's pageToken), from where Graph's nextLink said
    const pm = /^(s)(\d{1,6})$|^k([A-Za-z0-9_-]{1,190})$/.exec(String(pageToken || ''));
    if (pm && pm[1]) qs.push(`$skip=${pm[2]}`);
    else if (pm) qs.push(`$skiptoken=${encodeURIComponent(new TextDecoder().decode(graphB64Bytes(pm[3])))}`);
    const got = await g(`${where}?${qs.join('&')}`);
    let rows = remember(got && got.value);
    if (role === 'any') rows = rows.filter((x) => !['trash', 'junk'].includes(roleOf(x.r, fl))); // as Gmail: not spam or trash
    if (query.search && query.keep) rows = rows.filter((x) => query.keep(x.r));
    let next = null;
    try {
      const link = got && typeof got['@odata.nextLink'] === 'string' ? new URL(got['@odata.nextLink']).searchParams : null;
      const skip = link && (link.get('$skip') || link.get('%24skip'));
      const token = link && (link.get('$skiptoken') || link.get('%24skiptoken'));
      if (skip && /^\d{1,6}$/.test(skip)) next = `s${skip}`;
      else if (token) { const k = mimeB64url(new TextEncoder().encode(token)); if (k.length <= 190) next = `k${k}`; }
    } catch { /* no next page */ }
    return { rows, fl, next };
  }

  // ── the routes ──

  async function route(url, init) {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const bodyJson = () => { try { return init.body ? JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) : {}; } catch { return {}; } };
    const rawOf = (s) => graphB64Bytes(String(s || ''));

    // the resumable upload of a big message: collected here, then sent or filed like a small one
    if (url.startsWith(GMAIL_UPLOAD_BASE)) {
      const path = u.pathname.replace('/upload/gmail/v1/users/me', '');
      const uid = u.searchParams.get('upload_id');
      if (!uid && method !== 'PUT') {
        const n = `graph${++nUpload}`;
        const size = Number((init.headers || {})['x-upload-content-length'] || 0);
        if (size > GRAPH_MIME_MAX) throw new GoogleError(tooBig(), 'bad_request', 413);
        uploads.set(n, { method, path, size, chunks: [], got: 0 });
        return graphJson({}, 200, { location: `${GMAIL_UPLOAD_BASE}${path}?uploadType=resumable&upload_id=${n}` });
      }
      const up = uploads.get(uid || '');
      if (!up) return graphMissing();
      const bytes = init.body instanceof Uint8Array ? init.body : typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(await new Response(init.body).arrayBuffer());
      up.chunks.push(bytes);
      up.got += bytes.length;
      if (up.got > GRAPH_MIME_MAX) throw new GoogleError(tooBig(), 'bad_request', 413);
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec((init.headers || {})['content-range'] || '');
      if (range && up.got < Number(range[3])) return new Response(null, { status: 308, headers: { range: `bytes=0-${up.got - 1}` } });
      const raw = new Uint8Array(up.got);
      let at = 0;
      for (const c of up.chunks) { raw.set(c, at); at += c.length; }
      uploads.delete(uid);
      return deliver(up.path, raw);
    }

    const path = u.pathname.replace('/gmail/v1/users/me', '');
    const q = u.searchParams;
    let m;
    if (path === '/profile') {
      const st = await marks();
      return graphJson({ emailAddress: email, messagesTotal: st.total, threadsTotal: st.total, historyId: st.mark });
    }
    if (path === '/history') {
      const st = await marks();
      return graphJson({ historyId: st.mark, history: st.mark !== q.get('startHistoryId') ? [{ messagesAdded: [{ message: { id: 'changed' } }] }] : [] });
    }
    if (path === '/settings/sendAs') return graphJson({ sendAs: [{ sendAsEmail: email, displayName: name || '', isPrimary: true, isDefault: true, verificationStatus: 'accepted' }] });
    if (path === '/messages' && method === 'GET') {
      const query = toGraphQuery(q.get('q') || '', now());
      const label = q.get('labelIds');
      const role = label === 'INBOX' ? 'inbox' : label === 'SENT' ? 'sent' : label === 'DRAFT' ? 'drafts' : label === 'SPAM' ? 'junk' : label === 'TRASH' ? 'trash' : query.folder || 'any';
      const got = await list({ role, query, max: Math.min(Number(q.get('maxResults')) || 20, 100), pageToken: q.get('pageToken') });
      return graphJson({ messages: got.rows.map((x) => ({ id: x.id, threadId: threadIdOfConversation(x.r.conversationId) || x.id })), ...(got.next ? { nextPageToken: got.next } : {}), resultSizeEstimate: got.rows.length });
    }
    if (path === '/messages/batchModify' && method === 'POST') {
      const b = bodyJson();
      await modify(Array.isArray(b.ids) ? b.ids : [], b.addLabelIds || [], b.removeLabelIds || []);
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path))) {
      const got = await fullOf(m[1]);
      const at = pathOfAttachmentId(m[2]);
      const part = got && at !== null ? partAt(got.node, at) : null;
      if (!part) return graphMissing();
      return graphJson(q.get('fields') === 'size' ? { size: part.body.length } : { size: part.body.length, data: mimeB64url(part.body) });
    }
    if ((m = /^\/messages\/([^/]+)$/.exec(path)) && method === 'GET') {
      const fl = await folderIds();
      if ((q.get('format') || 'full') === 'full') {
        const got = await fullOf(m[1]);
        if (!got) return graphMissing();
        const res = resource(replaced.get(m[1]) || m[1], got.r, fl, gmailPayload(got.node));
        return graphJson({ ...res, snippet: res.snippet || snippetOf(got.node) });
      }
      const r = await metaOf(m[1]);
      return r ? graphJson(resource(replaced.get(m[1]) || m[1], r, fl)) : graphMissing();
    }
    if (path === '/messages/send' && method === 'POST') return deliver('/messages/send', rawOf(bodyJson().raw));
    if ((m = /^\/threads\/([^/]+)$/.exec(path))) {
      if (!/^c[A-Za-z0-9_-]{1,126}$/.test(m[1])) return graphMissing();
      const fl = await folderIds();
      const conv = graphIdOf(m[1].slice(1));
      const got = await g(`/me/messages?$filter=${encodeURIComponent(`conversationId eq '${conv.replace(/'/g, "''")}'`)}&$select=${GRAPH_SELECT}&$top=50`);
      const rows = remember(got && got.value).filter((x) => !['trash', 'junk'].includes(roleOf(x.r, fl)));
      if (!rows.length) return graphMissing();
      rows.sort((a, b) => (Date.parse(a.r.receivedDateTime || a.r.sentDateTime) || 0) - (Date.parse(b.r.receivedDateTime || b.r.sentDateTime) || 0));
      return graphJson({ id: m[1], messages: rows.map((x) => ({ ...resource(x.id, x.r, fl), threadId: m[1] })) });
    }
    if (path === '/drafts' && method === 'GET') {
      const query = toGraphQuery(q.get('q') || '', now());
      const got = await list({ role: 'drafts', query, max: Math.min(Number(q.get('maxResults')) || 20, 100), pageToken: q.get('pageToken') });
      return graphJson({ drafts: got.rows.map((x) => ({ id: x.id, message: { id: x.id, threadId: threadIdOfConversation(x.r.conversationId) || x.id } })), ...(got.next ? { nextPageToken: got.next } : {}) });
    }
    if (path === '/drafts' && method === 'POST') return deliver('/drafts', rawOf((bodyJson().message || {}).raw));
    if (path === '/drafts/send' && method === 'POST') {
      const id = String(bodyJson().id || '');
      const fl = await folderIds();
      const r = await metaOf(id);
      if (!r || roleOf(r, fl) !== 'drafts') return graphMissing();
      await g(`/me/messages/${encodeURIComponent(gidOf(id))}/send`, { method: 'POST' });
      return graphJson({ id: replaced.get(id) || id, threadId: threadIdOfConversation(r.conversationId) || id, labelIds: ['SENT'] });
    }
    if ((m = /^\/drafts\/([^/]+)$/.exec(path))) {
      if (method === 'GET') {
        const fl = await folderIds();
        const got = await fullOf(m[1]);
        if (!got || roleOf(got.r, fl) !== 'drafts') return graphMissing();
        const res = resource(replaced.get(m[1]) || m[1], got.r, fl, gmailPayload(got.node));
        return graphJson({ id: res.id, message: { ...res, snippet: res.snippet || snippetOf(got.node) } });
      }
      if (method === 'DELETE') return (await removeDraft(m[1])) ? new Response(null, { status: 204 }) : graphMissing();
      if (method === 'PUT') return deliver(`/drafts/${m[1]}`, rawOf((bodyJson().message || {}).raw));
    }
    return graphJson({ error: { code: 400, message: `Eden’s Outlook mailboxes don’t do ${method} ${path}.`, status: 'INVALID_ARGUMENT' } }, 400);
  }

  const tooBig = () => 'Outlook mailboxes in Eden send emails up to about 3 MB for now. Share bigger files as a link.';

  /** A message the core built: sent (messages.send), or filed as a draft (drafts.create / drafts.update). */
  async function deliver(path, raw) {
    const prepared = prepareOutgoing(raw, email);
    if (prepared.full.length > GRAPH_MIME_MAX) throw new GoogleError(tooBig(), 'bad_request', 413);
    // Graph takes a MIME message as base64 text and keeps it as a draft (Bcc kept, not shown to the others)
    const made = await g('/me/messages', { method: 'POST', body: btoa(mimeBinary(prepared.full)), headers: { 'content-type': 'text/plain' } });
    const id = made && edenIdOf(made.id);
    if (!id) throw new GoogleError('Outlook didn’t keep the email. Try again.', 'upstream', 502);
    meta.set(id, made);
    const threadId = threadIdOfConversation(made.conversationId) || id;
    if (path === '/messages/send') {
      try {
        await g(`/me/messages/${encodeURIComponent(graphIdOf(id))}/send`, { method: 'POST' });
      } catch (e) {
        await removeDraft(id).catch(() => undefined); // not sent: not left behind in Drafts either
        throw e;
      }
      return graphJson({ id, threadId, labelIds: ['SENT'] });
    }
    const old = /^\/drafts\/([^/]+)$/.exec(path);
    if (old) {
      await removeDraft(old[1]).catch(() => undefined);
      replaced.set(old[1], id);
    }
    return graphJson({ id, message: { id, threadId } });
  }

  async function removeDraft(id) {
    const gid = encodeURIComponent(gidOf(id));
    try {
      await g(`/me/messages/${gid}/permanentDelete`, { method: 'POST' }); // not left in Deleted Items
    } catch (e) {
      if (!(e instanceof GraphError) || e.status === 404) return false;
      if (e.status !== 400 && e.status !== 405) throw e;
      await g(`/me/messages/${gid}`, { method: 'DELETE' });
    }
    meta.delete(replaced.get(id) || id);
    return true;
  }

  async function modify(ids, add, rem) {
    const fl = await folderIds();
    const patch = {
      ...(rem.includes('UNREAD') ? { isRead: true } : add.includes('UNREAD') ? { isRead: false } : {}),
      ...(add.includes('STARRED') ? { flag: { flagStatus: 'flagged' } } : rem.includes('STARRED') ? { flag: { flagStatus: 'notFlagged' } } : {}),
    };
    const moving = rem.includes('INBOX') || add.includes('INBOX');
    if (rem.includes('INBOX') && !fl.archive) throw new GoogleError('This Outlook mailbox has no Archive folder, so Done can’t move mail out of the inbox.', 'bad_request', 400);
    const todo = [...new Set(ids.slice(0, 1000).map((x) => replaced.get(String(x)) || String(x)))].filter((id) => edenIdOf(id));
    const at = (id) => `/me/messages/${encodeURIComponent(graphIdOf(id))}`;
    // where each one is now (one $batch), so Done moves only what's in the inbox and undo only what isn't
    const where = new Map();
    if (moving) {
      const unknown = todo.filter((id) => !meta.has(id));
      const got = await batch(unknown.map((id) => ({ url: `${at(id)}?$select=id,parentFolderId` })));
      unknown.forEach((id, i) => { if (got[i] && got[i].status === 200 && got[i].body) meta.set(id, got[i].body); });
      for (const id of todo) where.set(id, meta.has(id) ? roleOf(meta.get(id), fl) : null);
    }
    const reqs = [];
    for (const id of todo) {
      if (Object.keys(patch).length) reqs.push({ method: 'PATCH', url: at(id), body: patch });
      const role = where.get(id);
      if (rem.includes('INBOX') && role === 'inbox') reqs.push({ method: 'POST', url: `${at(id)}/move`, body: { destinationId: 'archive' } }); // Done
      else if (add.includes('INBOX') && role && role !== 'inbox') reqs.push({ method: 'POST', url: `${at(id)}/move`, body: { destinationId: 'inbox' } }); // undo Done, a snooze waking
      meta.delete(id);
    }
    const got = await batch(reqs);
    const bad = got.find((r) => r && r.status >= 400 && r.status !== 404);
    if (bad) throw new GraphError(bad.status, String((bad.body && bad.body.error && bad.body.error.code) || ''), String((bad.body && bad.body.error && bad.body.error.message) || '').slice(0, 300));
  }

  async function marks() {
    const got = await batch([
      { url: '/me/mailFolders/inbox?$select=totalItemCount,unreadItemCount' },
      { url: '/me/messages?$top=1&$select=id,lastModifiedDateTime&$orderby=lastModifiedDateTime%20desc' },
    ]);
    const inbox = got[0] && got[0].status === 200 ? got[0].body || {} : null;
    if (!inbox) throw new GraphError(got[0] ? got[0].status : 502, String((got[0] && got[0].body && got[0].body.error && got[0].body.error.code) || ''), 'Outlook didn’t answer.');
    const last = got[1] && got[1].status === 200 && got[1].body && got[1].body.value && got[1].body.value[0] ? got[1].body.value[0] : {};
    return { total: Number(inbox.totalItemCount) || 0, mark: graphMark([inbox.totalItemCount, inbox.unreadItemCount, last.id || '', last.lastModifiedDateTime || ''].map(String)) };
  }

  shim.fetch = async (url, init = {}) => {
    try {
      return await route(String(url), init);
    } catch (e) {
      if (e instanceof GraphError && e.status === 401) {
        shim.error = new GoogleError(`${email || 'This Outlook mailbox'} needs signing in again: press Reconnect in Mail.`, 'reconnect', 401);
        if (onAuthFail) await onAuthFail().catch(() => undefined);
        return graphJson({ error: { code: 401, message: 'Unauthorized' } }, 401);
      }
      if (e instanceof GoogleError) { shim.error = e; return graphJson({ error: { code: e.status, message: e.message } }, e.status); }
      if (e instanceof GraphError) {
        const busy = e.status === 429 || e.status === 503 || e.status === 504;
        shim.error = e.code === 'MailboxNotEnabledForRESTAPI' || e.code === 'ResourceNotFound' && /mailbox/i.test(e.message)
          ? new GoogleError(`${email || 'This Microsoft account'} has no Outlook mailbox Eden can open (an on-premises or unlicensed mailbox).`, 'forbidden', 403)
          : e.status === 403
            ? new GoogleError(`Outlook didn’t let Eden do that${e.message ? `: ${e.message}` : '.'}`, 'forbidden', 403)
            : e.status === 413
              ? new GoogleError(tooBig(), 'bad_request', 413)
              : busy
                ? new GoogleError(`Outlook is busy right now. Try again${e.retryAfter ? ` in ${Math.min(e.retryAfter, 300)} seconds` : ' in a minute'}.`, 'unavailable', 503)
                : new GoogleError(`Outlook couldn’t do that right now${e.message ? `: ${e.message}` : '.'}`, e.status === 400 ? 'bad_request' : 'upstream', e.status === 400 ? 400 : 502);
        return graphJson({ error: { code: shim.error.status, message: shim.error.message } }, shim.error.status);
      }
      shim.error = new GoogleError('Outlook couldn’t be read right now. Try again in a minute.', 'upstream', 502);
      return graphJson({ error: { code: 502, message: shim.error.message } }, 502);
    }
  };
  shim.close = async () => {};
  return shim;
}
