// Server-side proof that a person pressed Send / Add / Save: a short-lived, single-use token for
// ONE exact action. The page mints it (POST /api/chat/approve, eden/google-data.js) as part of
// the user's click; the Gmail and Calendar write routes take it before they touch Google.
//
//   approve-mint { hash }         → { token, expires_in }   bound to the calling device (session)
//   approve-take { token, hash }  → { ok: true }            403 approval_required otherwise
//
// `hash` is SHA-256 hex of "<kind>\n<canonical JSON of {action,args}>" (eden/google-data.js
// approvalHash; the page computes the same in web/chat/api.js). A token is deleted the first time
// it is looked at, right or wrong, so it can never be tried twice. Stored in the account object.

import { ApiError, b64url, randomBytes } from './util.js';

export const APPROVAL_SECONDS = 120;
const MAX_OUTSTANDING = 40;
const PREFIX = 'appr:';
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

const needed = () => new ApiError(403, 'approval_required', 'That needs your approval first. Press the button again.');

export async function approvalOp(account, op, body, device) {
  const now = account.now();
  switch (op) {
    case 'approve-mint': {
      if (!HASH.test(String(body.hash || ''))) throw new ApiError(400, 'bad_request', 'hash must be 64 hex characters');
      const all = await account.storage.list({ prefix: PREFIX });
      const live = [];
      for (const [key, v] of all) {
        if (!v || v.exp <= now) await account.storage.delete(key);
        else live.push(key);
      }
      if (live.length >= MAX_OUTSTANDING) throw new ApiError(429, 'too_many', 'Too many approvals waiting. Try again in a moment.');
      const token = b64url(randomBytes(24));
      await account.storage.put(PREFIX + token, { hash: body.hash, device: device.id, exp: now + APPROVAL_SECONDS * 1000 });
      return { token, expires_in: APPROVAL_SECONDS };
    }
    case 'approve-take': {
      const token = String(body.token || '');
      if (!TOKEN.test(token)) throw needed();
      const key = PREFIX + token;
      const v = await account.storage.get(key);
      if (!v) throw needed();
      await account.storage.delete(key); // single use, whatever follows
      if (v.exp <= now || v.device !== device.id || v.hash !== body.hash) throw needed();
      return { ok: true };
    }
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}
