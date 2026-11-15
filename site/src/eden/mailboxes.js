// Eden Mail with several accounts (askeden ROADMAP Y, docs/mail-multi-account/plan.html), the Worker
// side. Off unless MAIL_MULTI = "on"; with it off nothing here answers and Mail is as before.
//
//   GET  /api/chat/mail/accounts  → { multi, max, accounts: [{ id, provider, email, label, color,
//                                     primary, status }] }: the first Gmail ('primary', the grant in
//                                     tokens.js `google_data`) and each extra mailbox (accounts/mailboxes.js)
//   POST /api/chat/mail/accounts  { action: 'add', provider: 'gmail' } → { url } (the consent below)
//                                 { action: 'edit', id, label?, color? } → the list
//                                 { action: 'remove', id } → the list (its grant is revoked at Google)
//   GET  /api/chat/google/connect?scope=gmail&add=1  (google-data.js): Google's account chooser and
//                                     consent every time, and the callback stores the grant as a new
//                                     mailbox instead of replacing the first Gmail
//   POST /api/chat/gmail { action, args, mailbox }  (google-data.js): the action on that mailbox; no
//                                     mailbox (or 'primary') is the first Gmail, as before. A send's
//                                     approval covers its mailbox too (approvalHash).
//
//   POST /api/chat/mail/accounts { action: 'detect', email } → the provider and servers for an address
//                                 { action: 'add', provider: 'imap', email, password, kind?, imap?, smtp?, user? }
//                                 → signs in to IMAP and SMTP first (nothing saved if that fails), then the list
//   IMAP mailboxes (iCloud, Yahoo, AOL, Fastmail, Zoho, GMX, any IMAP + SMTP server) answer the same Gmail
//   actions through mail-imap.js; their app password is sealed like a Google token.
//
//   POST /api/chat/mail/accounts  { action: 'add', provider: 'outlook' } → { url } (Microsoft sign-in, below)
//   GET  /api/chat/microsoft/connect, /api/chat/microsoft/callback (google-data.js): Microsoft's account
//                                     chooser and consent; the grant becomes an Outlook mailbox
//   Outlook mailboxes (Outlook.com, Hotmail, Microsoft 365) answer the same Gmail actions through
//   mail-graph.js (Microsoft Graph). Until MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are set, the
//   list says `outlook: false` and Mail shows Outlook as coming.
//
// Keys and tokens never reach the browser: the list carries no `sub`, no token, nothing sealed.
// In this first phase an extra mailbox does what the page does with Gmail (read, search, drafts,
// send, Done/snooze/star/read, attachments); what runs on the server without the page (scheduled
// send, background drafts, read receipts) stays on the first Gmail.
// Mail works without any Gmail: an account with only IMAP or Outlook mailboxes adds and uses them the
// same way; the page then defaults to its first mailbox and the Gmail-only extras say they need a Gmail.

import { call } from '../accounts/index.js';
import { MBOX_COLORS, MBOX_ID, MBOX_PRIMARY, newMailboxId, openMailbox, sealMailbox } from '../accounts/mailboxes.js';
import { ApiError } from '../accounts/util.js';
import { openWith, sealWith } from '../accounts/tokens.js';
import { GoogleError, createGmailApi, refreshAccessToken, revokeToken, runGmailAction } from './vendor/google.js';
import { IMAP_PRESETS, checkEmail, checkPassword, checkServers, createImapGmail, detectServers, presetForEmail, socketsFor, verifyImapAccount } from './mail-imap.js';
import { createGraphGmail, msClient, msFetch, msReady, msRefresh } from './mail-graph.js';
import { UPLOAD_ACTIONS, outgoingUploads, uploadAction } from './gmail-uploads.js';

const MBOX_EXPIRY_MARGIN_MS = 60_000;

// ── the iPhone app's "Add an account" (Gmail or Outlook sign-in in its web sheet) ──
// The sheet has no askeden.com cookie of the app's sign-in, so the link carries a ticket: the app's sign-in for this
// account, sealed under the server's key (only it can open it), good for 5 minutes, and only for starting a mailbox
// sign-in (google-data.js connect routes).
const MAIL_TICKET_MS = 5 * 60 * 1000;
/** A ticket for `who` (an iv.ct string). */
export async function mailAddTicket(env, who) {
  const s = await sealWith(env, 'mail-add-ticket', 'mail-add', { a: who.account, k: who.token, x: Date.now() + MAIL_TICKET_MS });
  return `${s.iv}.${s.ct}`;
}
/** A ticket's sign-in, as a gate's `who` ({ account, token, app: true }); null if bad or old. */
export async function openMailAddTicket(env, ticket) {
  const [iv = '', ct = ''] = String(ticket || '').split('.');
  if (!iv || !ct) return null;
  const t = await openWith(env, 'mail-add-ticket', 'mail-add', { iv, ct }).catch(() => null);
  if (!t || typeof t.a !== 'string' || !t.k || !t.k.device || !(t.x > Date.now())) return null;
  return { account: t.a, token: t.k, app: true };
}

export const mailMultiOn = (env = {}) => String(env.MAIL_MULTI || '').trim() === 'on';
/** How many mailboxes Mail holds, the first Gmail included (MAIL_MULTI_MAX, 2 to 25; 10 unless set). */
export function mailboxMax(env = {}) {
  const n = Number(env.MAIL_MULTI_MAX);
  return Number.isInteger(n) && n >= 2 && n <= 25 ? n : 10;
}
export { MBOX_ID, MBOX_PRIMARY };

/** The page's `mailbox`: null for the first Gmail, else a checked extra mailbox id. */
export function pickMailbox(env, value) {
  if (value === undefined || value === null || value === '' || value === MBOX_PRIMARY) return null;
  if (!mailMultiOn(env)) throw new GoogleError('Several mail accounts aren’t switched on here.', 'not_found', 404);
  if (typeof value !== 'string' || !MBOX_ID.test(value)) throw new GoogleError('mailbox must be one of your mailboxes.', 'bad_request', 400);
  return value;
}

/** One extra mailbox, opened: { gen, tokens, box } or null (removed, needs reconnecting, or sealed under an old key). */
export async function loadMailbox(env, who, id) {
  const { box, record } = await call(env, who.account, 'mbox-get', { id }, who.token);
  if (!box) return null;
  if (!record) return { gen: null, tokens: null, box };
  const tokens = await openMailbox(env, who.account, id, record);
  return tokens && (tokens.refresh || tokens.pass) ? { gen: record.gen, tokens, box } : { gen: null, tokens: null, box };
}

/**
 * As google-data.js tokenSource, for an extra mailbox: refreshed tokens saved back to that mailbox only.
 * `refresher(tokens)` refreshes another provider's grant (Outlook: msRefresh); Google's by default.
 */
export function mailboxTokenSource(env, ctx, who, id, found, client, f, refresher = (tk) => refreshAccessToken(client, tk.refresh, f)) {
  let refreshing = null;
  const t = found.tokens;
  return async (fresh) => {
    if (!fresh && t.access && t.access_exp - MBOX_EXPIRY_MARGIN_MS > Date.now()) return t.access;
    refreshing ??= (async () => {
      try {
        const r = await refresher(t);
        Object.assign(t, { access: r.accessToken, access_exp: r.expiresAt, refresh: r.refreshToken || t.refresh });
        const record = await sealMailbox(env, who.account, id, t);
        const save = call(env, who.account, 'mbox-touch', { id, gen: found.gen, record }, who.token).catch(() => undefined);
        if (ctx && ctx.waitUntil) ctx.waitUntil(save);
        else await save;
        return r.accessToken;
      } catch (e) {
        if (e instanceof GoogleError && e.code === 'reconnect') await call(env, who.account, 'mbox-broken', { id, gen: found.gen }, who.token).catch(() => undefined);
        throw e;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
}

/** The list the page sees: the first Gmail (when connected for mail) and every extra mailbox, without secrets. */
export async function mailboxList(env, who, primary) {
  const { boxes, prefs } = await call(env, who.account, 'mbox-list', {}, who.token);
  const p = (prefs && prefs.primary) || {};
  const out = [];
  if (primary) out.push({ id: MBOX_PRIMARY, provider: 'gmail', kind: 'gmail', email: primary.email || null, label: p.label || '', color: MBOX_COLORS.includes(p.color) ? p.color : MBOX_COLORS[0], primary: true, status: 'ok' });
  for (const b of boxes || []) out.push({ id: b.id, provider: b.provider, kind: b.kind || (b.provider === 'gmail' || b.provider === 'outlook' ? b.provider : 'imap'), email: b.email || null, label: b.label || '', color: MBOX_COLORS.includes(b.color) ? b.color : MBOX_COLORS[0], primary: false, status: b.status === 'reconnect' ? 'reconnect' : 'ok' });
  // the password providers the page offers, with how to make an app password (mail-imap.js)
  const providers = Object.entries(IMAP_PRESETS).map(([kind, x]) => ({ kind, name: x.name, help: x.help, domains: x.domains }));
  return { multi: true, max: mailboxMax(env), accounts: out, providers, outlook: msReady(env) };
}

/**
 * GET and POST /api/chat/mail/accounts (google-data.js calls this after its gate). `primary` is the
 * first Gmail's opened tokens or null; `f` Google's fetch.
 */
export async function mailboxRoute(request, env, who, { primary, body, f }) {
  if (!mailMultiOn(env)) throw new ApiError(404, 'not_found', 'Not found');
  if (request.method === 'GET') return mailboxList(env, who, primary);
  const action = body && body.action;
  if (action === 'detect') return detectFor(body, f);
  if (action === 'add') {
    if (body.provider !== undefined && !['gmail', 'imap', 'outlook'].includes(body.provider)) throw new ApiError(400, 'bad_request', 'provider must be gmail, outlook or imap.');
    if (body.provider === 'outlook' && !msReady(env)) throw new ApiError(400, 'not_ready', 'Outlook isn’t set up on askeden.com yet.');
    // No Gmail needed: an IMAP or Outlook mailbox can be the only one. A Gmail added with no first Gmail
    // becomes the first Gmail (google-data.js callback: no old grant, so it is saved as `google_data`).
    const list = await mailboxList(env, who, primary);
    // adding again (Reconnect) is never "too many"
    if (list.accounts.length >= list.max && !(body.provider === 'imap' && list.accounts.some((a) => a.email && body.email && a.email.toLowerCase() === String(body.email).trim().toLowerCase()))) {
      throw new ApiError(409, 'too_many', `Mail holds ${list.max} accounts at most. Remove one to add another.`);
    }
    if (body.provider === 'imap') return addImap(env, who, body, primary, f);
    // From the iPhone app (body.app): the link carries a ticket for the web sheet (mailAddTicket), and the sign-in ends
    // on the app's scheme (google-data.js), so the sheet closes by itself.
    const ticket = body.app === true ? `t=${encodeURIComponent(await mailAddTicket(env, who))}` : '';
    if (body.provider === 'outlook') return { url: `/api/chat/microsoft/connect${ticket ? `?${ticket}` : ''}` };
    return { url: `/api/chat/google/connect?scope=gmail&add=1${ticket ? `&${ticket}` : ''}` };
  }
  if (action === 'edit') {
    const id = body.id === MBOX_PRIMARY ? MBOX_PRIMARY : typeof body.id === 'string' && MBOX_ID.test(body.id) ? body.id : null;
    if (!id) throw new ApiError(400, 'bad_request', 'id must be one of your mailboxes.');
    await call(env, who.account, 'mbox-edit', { id, ...(body.label !== undefined ? { label: body.label } : {}), ...(body.color !== undefined ? { color: body.color } : {}) }, who.token);
    return mailboxList(env, who, primary);
  }
  if (action === 'remove') {
    if (body.id === MBOX_PRIMARY) throw new ApiError(400, 'bad_request', 'Your first Gmail is disconnected in Settings › Accounts (it also holds your calendar).');
    if (typeof body.id !== 'string' || !MBOX_ID.test(body.id)) throw new ApiError(400, 'bad_request', 'id must be one of your mailboxes.');
    const { record } = await call(env, who.account, 'mbox-delete', { id: body.id }, who.token);
    const tokens = record ? await openMailbox(env, who.account, body.id, record) : null;
    // Google's grant is revoked; Microsoft has no revoke for one app's grant (the remove sheet says where to end it)
    if (tokens && tokens.provider !== 'outlook' && !tokens.pass && (tokens.refresh || tokens.access)) await revokeToken(tokens.refresh || tokens.access, f).catch(() => undefined);
    return mailboxList(env, who, primary);
  }
  throw new ApiError(400, 'bad_request', 'action must be add, edit or remove.');
}

// ── IMAP mailboxes (mail-imap.js) ──

const apiError = (e) => (e instanceof GoogleError ? new ApiError(e.status, e.code, e.message) : e);

/** What an address needs: its provider and servers (no network for known ones), or that they must be entered. */
async function detectFor(body, f) {
  let email;
  try { email = checkEmail(body.email); } catch (e) { throw apiError(e); }
  let found;
  try { found = await detectServers(email, f); }
  catch (e) { if (e instanceof GoogleError && (e.code === 'use_google' || e.code === 'use_microsoft')) return { email, use: e.code === 'use_google' ? 'google' : 'microsoft', message: e.message }; throw apiError(e); }
  if (!found) return { email, need: 'servers', message: 'Eden couldn’t find this provider’s mail servers. Enter them below (your provider’s help pages list them).' };
  return { email, kind: found.kind, name: found.name, help: found.help, servers: { imap: found.imap, smtp: found.smtp } };
}

/**
 * Add an IMAP mailbox: the servers (a known provider by `kind` or the address, Thunderbird's list, or
 * the ones entered), then a sign-in to IMAP and to SMTP. Only then is anything stored: the app password
 * sealed for this account and mailbox, the folder names in the list. Wrong passwords are counted
 * (accounts/mailboxes.js mbox-attempt: 5 an hour).
 */
async function addImap(env, who, body, primary, f) {
  let email, pass, servers;
  try {
    email = checkEmail(body.email);
    pass = checkPassword(body.password);
    if (body.imap || body.smtp) {
      const checked = checkServers(body.imap, body.smtp);
      const user = typeof body.user === 'string' && body.user.trim() && body.user.length <= 254 && !/[\r\n\0]/.test(body.user) ? body.user.trim() : null;
      servers = { kind: 'imap', name: checked.imap.host, help: 'Check the password (or app password) and the server names with your provider.', ...checked, users: user ? [user] : ['email', 'local'] };
    } else if (typeof body.kind === 'string' && Object.hasOwn(IMAP_PRESETS, body.kind)) {
      servers = { kind: body.kind, ...IMAP_PRESETS[body.kind] }; // a custom domain on iCloud+ or Yahoo: the provider's servers
    } else {
      servers = presetForEmail(email) || (await detectServers(email, f));
    }
  } catch (e) { throw apiError(e); }
  if (!servers) throw new ApiError(400, 'need_servers', 'Eden couldn’t find this provider’s mail servers. Enter them under Server settings.');
  await call(env, who.account, 'mbox-attempt', {}, who.token); // 429 after too many wrong passwords
  const connect = await socketsFor(env);
  let v;
  try {
    v = await verifyImapAccount({ connect, email, pass, imap: servers.imap, smtp: servers.smtp, users: servers.users });
  } catch (e) {
    if (e && e.code === 'auth') {
      const { left } = await call(env, who.account, 'mbox-attempt', { failed: true }, who.token);
      throw new ApiError(400, 'signin_failed', `${servers.name || 'The mail server'} didn’t take that address and password. ${servers.help || ''}${left <= 2 ? ` ${left} more ${left === 1 ? 'try' : 'tries'} this hour.` : ''}`.trim());
    }
    throw new ApiError(502, 'unreachable', `Eden couldn’t finish signing in to ${servers.imap.host}: ${e && e.message ? e.message : 'no answer'}`);
  }
  const sub = `imap:${v.user.toLowerCase()}@${servers.imap.host}`;
  const { boxes } = await call(env, who.account, 'mbox-list', {}, who.token);
  const same = (boxes || []).find((b) => b.provider === 'imap' && b.sub === sub);
  const id = same ? same.id : newMailboxId();
  const record = await sealMailbox(env, who.account, id, { email, user: v.user, smtpUser: v.smtpUser, pass, imap: servers.imap, smtp: servers.smtp, kind: servers.kind, connected: new Date().toISOString() });
  await call(env, who.account, 'mbox-save', { id, box: { provider: 'imap', sub, email, kind: servers.kind, folders: v.folders }, record, max: mailboxMax(env) }, who.token);
  return mailboxList(env, who, primary);
}

const NO_UPLOADS = new Proxy({}, { get: () => () => { throw new GoogleError('That attachment is no longer on Eden’s server: it will be uploaded again.', 'upload_missing', 410); } });

/**
 * A Gmail action (the page's /api/chat/gmail) on an IMAP mailbox: Eden's Gmail core over mail-imap.js's
 * Gmail-shaped API. Uploads ahead work as for Gmail (gmail-uploads.js). A refused app password marks
 * the mailbox "sign in again" and stops (no retries that could lock the account).
 */
export async function runImapAction(env, ctx, who, id, found, action, args) {
  const t = found.tokens;
  const connect = await socketsFor(env);
  const shim = createImapGmail({
    connect,
    account: { email: t.email, user: t.user, smtpUser: t.smtpUser, pass: t.pass, imap: t.imap, smtp: t.smtp },
    folders: found.box.folders,
    onAuthFail: () => call(env, who.account, 'mbox-broken', { id, gen: found.gen }, who.token),
    onFolders: (folders) => call(env, who.account, 'mbox-folders', { id, folders }, who.token),
  });
  return runShimAction(env, who, shim, t.email, action, args);
}

/**
 * A Gmail action on an Outlook mailbox: Eden's Gmail core over mail-graph.js's Gmail-shaped API on
 * Microsoft Graph. Its access token is refreshed (and the rotated refresh token sealed) as a Gmail
 * mailbox's is; a refused grant marks the mailbox "sign in again".
 */
export async function runOutlookAction(env, ctx, who, id, found, action, args) {
  const t = found.tokens;
  const f = msFetch(env);
  const token = mailboxTokenSource(env, ctx, who, id, found, null, f, (tk) => msRefresh(msClient(env), tk.refresh, f));
  const shim = createGraphGmail({
    fetch: f,
    token,
    email: t.email,
    name: t.name || '',
    folders: found.box.folders,
    onAuthFail: () => call(env, who.account, 'mbox-broken', { id, gen: found.gen }, who.token),
    onFolders: (folders) => call(env, who.account, 'mbox-folders', { id, folders }, who.token),
  });
  return runShimAction(env, who, shim, t.email, action, args);
}

/** The Gmail core on a mailbox's Gmail-shaped shim (IMAP or Graph); uploads ahead work as for Gmail. */
async function runShimAction(env, who, shim, from, action, args) {
  const token = async () => 'shim';
  try {
    if (UPLOAD_ACTIONS.has(action)) return await uploadAction(env, who, action, args, { token, fetch: shim.fetch });
    const up = await outgoingUploads(env, who, action, args);
    const api = createGmailApi({ token, fetch: up ? up.fetch(shim.fetch, token) : shim.fetch });
    const out = await runGmailAction(api, action, args, { from, uploads: up ? up.store : NO_UPLOADS }).catch((e) => { throw shim.error || (up && up.error) || e; });
    if (up && action !== 'draft') await up.free();
    return out;
  } catch (e) {
    throw shim.error || e;
  } finally {
    await shim.close();
  }
}

/**
 * The consent callback's grant for "Add an account" (google-data.js): stored as an extra mailbox.
 * The same Google account as an existing mailbox refreshes that one. Returns true when saved.
 */
export async function saveAddedMailbox(env, accountId, device, tokens) {
  const { boxes } = await call(env, accountId, 'mbox-list', { device });
  const same = (boxes || []).find((b) => b.provider === 'gmail' && b.sub === tokens.sub);
  const id = same ? same.id : newMailboxId();
  const record = await sealMailbox(env, accountId, id, tokens);
  await call(env, accountId, 'mbox-save', { device, id, box: { provider: 'gmail', sub: tokens.sub, email: tokens.email }, record, max: mailboxMax(env) });
  return true;
}

/**
 * Microsoft's consent callback (google-data.js) for "Add an account": the grant stored as an Outlook
 * mailbox; the same Microsoft account again refreshes its mailbox. Returns true when saved.
 */
export async function saveOutlookMailbox(env, accountId, device, tokens) {
  const { boxes } = await call(env, accountId, 'mbox-list', { device });
  const same = (boxes || []).find((b) => b.provider === 'outlook' && b.sub === tokens.sub);
  const id = same ? same.id : newMailboxId();
  const record = await sealMailbox(env, accountId, id, { ...tokens, provider: 'outlook' });
  await call(env, accountId, 'mbox-save', { device, id, box: { provider: 'outlook', sub: tokens.sub, email: tokens.email, kind: 'outlook' }, record, max: mailboxMax(env) });
  return true;
}
