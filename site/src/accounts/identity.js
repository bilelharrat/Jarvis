// One sign-in identity (an Apple ID, a Google account, a passkey) and the Eden account it opens
// (docs/web-auth.md): a Durable Object named `<provider>:<sub hash>` (index.js subHashOf: the
// SHA-256 hex of "<provider>:<sub>", so no raw sub is kept anywhere), binding IDENTITIES. It holds
// `{ account_id, provider, email, added }`, or, once unlinked, a tombstone `{ account_id: null,
// released }` so an Apple ID taken off an account no longer falls back to the account its id
// derives from (util.js accountIdFor).
//
// Every check-and-set happens inside the object, so two sign-ins at once with a new Google
// account make one Eden account, and two accounts linking the same identity can't both win.
//
//   get                          → { state: 'none' | 'linked' | 'released', account_id, email }
//   resolve { proposed, email }  → the account it opens: the linked one, else `proposed` (kept)
//   claim { account_id, email }  → linked to that account; 409 identity_taken when another has it
//   release { account_id }       → a tombstone, if it was linked to that account
//   forget { account_id }        → gone entirely (the account was deleted)
//   passkey                      → { state, account_id, cred }: a passkey's public key (webauthn.js)
//   passkey-count { count }      → the signature counter moved on; 409 passkey_cloned if it didn't go up
//
// A passkey (`passkey:<SHA-256 of "passkey:<credential id>">`) also keeps `cred: { alg, jwk, count }`,
// given with resolve or claim. Its public key only: nothing secret is ever held for a passkey.

import { ApiError, json, validAccountId } from './util.js';

export const PROVIDERS = ['apple', 'google', 'passkey'];

const THING = { google: 'Google account', apple: 'Apple ID', passkey: 'passkey' };
export const takenWords = (provider) => `This ${THING[provider] || 'Apple ID'} is already used by another Eden account.`;

/** A passkey's stored key, only in the shape webauthn.js makes: { alg, jwk, count }. */
const credOf = (c) => (c && typeof c === 'object' && [-7, -257].includes(c.alg) && c.jwk && typeof c.jwk === 'object' && Number.isInteger(c.count) ? { alg: c.alg, jwk: c.jwk, count: c.count } : null);

export class Identity {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.now = () => Date.now();
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const body = await request.json().catch(() => ({}));
    try {
      const record = (await this.storage.get('identity')) || null;
      const email = typeof body.email === 'string' && body.email ? body.email.slice(0, 200) : null;
      if (op === 'get') return json(this.view(record));
      if (op === 'resolve') {
        if (record && record.account_id) return json({ account_id: record.account_id, created: false });
        if (!validAccountId(body.proposed)) throw new ApiError(400, 'bad_request', 'proposed must be an account id');
        await this.storage.put('identity', { account_id: body.proposed, provider: body.provider || null, email, added: this.now(), ...(credOf(body.cred) ? { cred: credOf(body.cred) } : {}) });
        return json({ account_id: body.proposed, created: true });
      }
      if (op === 'claim') {
        if (!validAccountId(body.account_id)) throw new ApiError(400, 'bad_request', 'account_id must be an account id');
        if (record && record.account_id && record.account_id !== body.account_id) {
          throw new ApiError(409, 'identity_taken', takenWords(body.provider));
        }
        const created = !(record && record.account_id);
        const cred = credOf(body.cred) || (record && record.cred) || null;
        await this.storage.put('identity', { account_id: body.account_id, provider: body.provider || null, email: email ?? record?.email ?? null, added: created ? this.now() : record.added, ...(cred ? { cred } : {}) });
        return json({ account_id: body.account_id, created });
      }
      if (op === 'passkey') return json({ ...this.view(record), cred: record && record.account_id ? record.cred || null : null });
      if (op === 'passkey-count') {
        // Checked and set here, in one place: two sign-ins with one counter value can't both pass.
        if (!record || !record.account_id || !record.cred) throw new ApiError(404, 'not_found', 'That passkey isn’t on an Eden account.');
        const count = Number(body.count);
        const before = record.cred.count || 0;
        if (!Number.isInteger(count) || count < 0 || ((count !== 0 || before !== 0) && count <= before)) {
          throw new ApiError(409, 'passkey_cloned', 'This passkey looks copied (its counter didn’t go up). Sign in another way.');
        }
        await this.storage.put('identity', { ...record, cred: { ...record.cred, count }, used: this.now() });
        return json({ count });
      }
      if (op === 'release') {
        if (record && record.account_id === body.account_id) await this.storage.put('identity', { account_id: null, released: this.now() });
        return json({});
      }
      if (op === 'forget') {
        if (record && (record.account_id === body.account_id || !record.account_id)) await this.storage.deleteAll();
        return json({});
      }
      throw new ApiError(404, 'not_found', 'No such thing.');
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  view(record) {
    if (!record) return { state: 'none', account_id: null, email: null };
    if (!record.account_id) return { state: 'released', account_id: null, email: null };
    return { state: 'linked', account_id: record.account_id, email: record.email || null };
  }
}
