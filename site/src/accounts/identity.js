// One sign-in identity (an Apple ID, a Google account) and the Eden account it opens
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

import { ApiError, json, validAccountId } from './util.js';

export const PROVIDERS = ['apple', 'google'];

export const takenWords = (provider) =>
  `This ${provider === 'google' ? 'Google account' : 'Apple ID'} is already used by another Eden account.`;

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
        await this.storage.put('identity', { account_id: body.proposed, provider: body.provider || null, email, added: this.now() });
        return json({ account_id: body.proposed, created: true });
      }
      if (op === 'claim') {
        if (!validAccountId(body.account_id)) throw new ApiError(400, 'bad_request', 'account_id must be an account id');
        if (record && record.account_id && record.account_id !== body.account_id) {
          throw new ApiError(409, 'identity_taken', takenWords(body.provider));
        }
        const created = !(record && record.account_id);
        await this.storage.put('identity', { account_id: body.account_id, provider: body.provider || null, email: email ?? record?.email ?? null, added: created ? this.now() : record.added });
        return json({ account_id: body.account_id, created });
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
