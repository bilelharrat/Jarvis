// Read receipts for Eden Mail (askeden ROADMAP O5), as Superhuman has them: an email sent with
// "Read receipts" on carries a 1×1 image at https://askeden.com/r/<token>.gif. When the
// recipient's mail app loads it, the Worker answers the image and tells the sender's account
// object, which logs the open. Only askeden.com can do this: a recipient's mail app can't reach
// Eden's server on the owner's Mac.
//
// - The token is { a: account id, r: receipt id } sealed with AES-256-GCM under a key derived
//   from the Worker secret EDEN_TOKEN_KEY (tokens.js sealWith, info 'eden-receipts-v1'): it says
//   nothing about who sent it, and can't be forged or pointed at another account.
// - rc:<id> → { id, subject, to (addresses only), sent, opens: [{ at, via }] }. No message text.
//   At most RECEIPTS.max kept (the oldest go first), RECEIPTS.opens opens each, RECEIPTS.days old.
// - `via` is a coarse guess from the request, never the IP or the full user agent:
//   'gmail' (Google's image proxy: a real open in Gmail), 'apple' (Apple Mail Privacy
//   Protection fetches images ahead, so it may not be a real open), 'outlook', 'other'.
// - The first SELF_MS after sending are ignored: that's the sender's own mail app showing Sent.
// - Deleting the account deletes these with everything else (storage.deleteAll).

import { ApiError } from './util.js';
import { openWith, sealWith } from './tokens.js';

export const RECEIPTS = { max: 500, opens: 30, days: 90, selfMs: 20_000, subject: 200, to: 10 };
const ID = /^[A-Za-z0-9_-]{12}$/;
const INFO = 'eden-receipts-v1';
const AAD = 'receipt';
const TOKEN = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{40,400})$/;

/** A transparent 1×1 GIF. */
export const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));

export async function receiptToken(env, account, id) {
  const { iv, ct } = await sealWith(env, INFO, AAD, { a: account, r: id });
  return `${iv}.${ct}`;
}

/** { account, id } from a token, or null (malformed, forged, or sealed under another key). */
export async function readReceiptToken(env, token) {
  const m = TOKEN.exec(String(token || ''));
  if (!m) return null;
  const v = await openWith(env, INFO, AAD, { iv: m[1], ct: m[2] });
  return v && typeof v.a === 'string' && typeof v.r === 'string' && ID.test(v.r) ? { account: v.a, id: v.r } : null;
}

/** Where an open came from, coarsely (see above). */
export function openVia(userAgent = '') {
  const ua = String(userAgent);
  if (/GoogleImageProxy|ggpht\.com/i.test(ua)) return 'gmail';
  if (/Microsoft Outlook|ms-office|Outlook-iOS|Outlook-Android/i.test(ua)) return 'outlook';
  // Apple's privacy proxy uses a plain Mozilla UA without "Safari" or a version: a likely prefetch
  if (/^Mozilla\/5\.0$/.test(ua.trim()) || /AppleWebKit\/605\.1\.15 \(KHTML, like Gecko\)$/.test(ua.trim())) return 'apple';
  return 'other';
}

const view = (r) => ({ id: r.id, subject: r.subject, to: r.to, sent: r.sent, opens: r.opens, thread: r.thread || null });

async function prune(account, now) {
  const all = await account.storage.list({ prefix: 'rc:' });
  const old = now - RECEIPTS.days * 86_400_000;
  const keys = [...all.entries()].sort((a, b) => a[1].sent - b[1].sent);
  const drop = keys.filter(([, r], i) => r.sent < old || keys.length - i > RECEIPTS.max).map(([k]) => k);
  if (drop.length) await account.storage.delete(drop);
}

/** The account object's `rcpt-*` ops. `rcpt-open` comes from the Worker's pixel route (no device). */
export async function receiptOp(account, op, body) {
  const now = account.now();
  switch (op) {
    case 'rcpt-new': {
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12).replace(/[^A-Za-z0-9]/g, 'x');
      const to = (Array.isArray(body.to) ? body.to : []).filter((a) => typeof a === 'string').map((a) => a.slice(0, 254)).slice(0, RECEIPTS.to);
      const r = { id, subject: String(body.subject || '').slice(0, RECEIPTS.subject), to, sent: now, opens: [], thread: null };
      await account.storage.put(`rc:${id}`, r);
      await prune(account, now);
      return { id };
    }
    case 'rcpt-sent': { // the send went: its Gmail thread (to show opens beside it) and the real sending time
      const r = ID.test(String(body.id)) ? await account.storage.get(`rc:${body.id}`) : null;
      if (!r) throw new ApiError(404, 'not_found', 'No such receipt.');
      r.sent = now;
      if (typeof body.thread === 'string' && /^[0-9A-Za-z_-]{1,128}$/.test(body.thread)) r.thread = body.thread;
      await account.storage.put(`rc:${r.id}`, r);
      return view(r);
    }
    case 'rcpt-open': {
      const r = ID.test(String(body.id)) ? await account.storage.get(`rc:${body.id}`) : null;
      if (!r) return { ok: false };
      if (now - r.sent < RECEIPTS.selfMs) return { ok: true, ignored: 'self' };
      if (r.opens.length >= RECEIPTS.opens) r.opens.shift();
      r.opens.push({ at: now, via: ['gmail', 'apple', 'outlook', 'other'].includes(body.via) ? body.via : 'other' });
      await account.storage.put(`rc:${r.id}`, r);
      return { ok: true };
    }
    case 'rcpt-list': {
      const all = await account.storage.list({ prefix: 'rc:' });
      return { receipts: [...all.values()].sort((a, b) => b.sent - a.sent).slice(0, 200).map(view) };
    }
    case 'rcpt-delete': {
      if (!ID.test(String(body.id))) throw new ApiError(400, 'bad_request', 'id must be a receipt id.');
      await account.storage.delete(`rc:${body.id}`);
      return { deleted: true };
    }
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}
