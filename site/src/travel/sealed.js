// Travel's personal lists sealed at rest in the account's object (security review L11, 2026-10-28): loyalty numbers
// (loyalty.js tloyal, tloyalh) and travellers' papers with their passport and visa dates (papers.js tpapers). The same
// sealing as a person's own API keys (accounts/user-keys.js): AES-GCM under the account's key derived from
// EDEN_TOKEN_KEY (accounts/tokens.js sealWith), bound to the account and the list's name. Without EDEN_TOKEN_KEY (a
// local setup) or before a list was sealed, it stays as it was and is read as it is; the next save seals it.
//
//   <key> → { sealed: { iv, ct }, v: 1 }   (or, unsealed, the list itself)

import { openWith, sealWith, tokenSecret } from '../accounts/tokens.js';

const accountOf = async (account) => { const a = await account.storage.get('account'); return a && typeof a.id === 'string' ? a.id : null; };
const aad = (id, key) => `travel:${key}:${id}`;

/** The list kept under `key` ([] when none, or when it can't be opened: logged, never shown half-read). */
export async function readSealed(account, key) {
  const raw = await account.storage.get(key);
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw; // kept before sealing
  if (!raw.sealed) return [];
  const id = await accountOf(account);
  const list = id && tokenSecret(account.env) ? await openWith(account.env, `account:${id}`, aad(id, key), raw.sealed) : null;
  if (!Array.isArray(list)) { console.error('travel sealed list unreadable', key); return []; }
  return list;
}

/** Keep `list` under `key`, sealed when the account has a key. */
export async function writeSealed(account, key, list) {
  const id = await accountOf(account);
  if (!id || !tokenSecret(account.env)) return account.storage.put(key, list);
  return account.storage.put(key, { sealed: await sealWith(account.env, `account:${id}`, aad(id, key), list), v: 1 });
}
