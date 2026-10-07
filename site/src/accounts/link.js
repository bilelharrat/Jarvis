// Linking a Mac to an account (docs/accounts.md): one Durable Object per code, named by it.
// The Mac starts it with its name and public key and polls with a secret only it has; the
// signed-in iPhone reads it, then approves (the Worker makes the Mac's device on the account
// and leaves its token here, with the sync key sealed to the Mac) or denies. The first poll
// after that takes the answer and the link is gone; ten minutes after starting it's gone
// anyway (an alarm).
//
// The same class keeps the web sign-in's short-lived one-time values (eden/session.js), each
// in an object of its own named `handoff:<code>` or `oauth:<state>`: `stash { value, seconds }`
// keeps one, `take` hands it over once and forgets it (404 unknown or already taken, 410 late).

import { ApiError, json, sameText, sha256Hex } from './util.js';

export const LINK_SECONDS = 600;
// Crockford's base32 without I, L, O and U: nothing to misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = [...bytes].map((b) => ALPHABET[b & 31]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// What a person typed or a QR code said, as the code; null if it can't be one.
export function cleanCode(text) {
  let raw = String(text || '').trim().toUpperCase();
  raw = raw.replace(/^JARVIS-LINK:\/\//, '').replace(/[\s-]/g, '');
  raw = raw.replace(/[IL]/g, '1').replace(/O/g, '0');
  if (raw.length !== 8 || [...raw].some((c) => !ALPHABET.includes(c))) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export class Link {
  constructor(ctx) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.now = () => Date.now();
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const body = await request.json().catch(() => ({}));
    try {
      if (op === 'stash') return json(await this.stash(body));
      if (op === 'take') return json(await this.take());
      const link = await this.storage.get('link');
      if (op === 'start') return json(await this.start(link, body));
      if (!link || link.expires <= this.now()) {
        if (link) await this.storage.deleteAll();
        throw new ApiError(link ? 410 : 404, link ? 'expired' : 'not_found', link ? 'That code expired. Make a new one on the Mac.' : "That code isn't one we know. Check it on the Mac.");
      }
      if (op === 'peek') return json(this.peek(link));
      if (op === 'approve') return json(await this.settle(link, 'approved', body.result));
      if (op === 'deny') return json(await this.settle(link, 'denied', null));
      if (op === 'poll') return await this.poll(link, body.poll);
      throw new ApiError(404, 'not_found', 'No such thing.');
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  async start(existing, { name, kind, public_key, app_version, poll }) {
    if (existing && existing.expires > this.now()) throw new ApiError(409, 'conflict', 'That code is taken.');
    const expires = this.now() + LINK_SECONDS * 1000;
    await this.storage.put('link', {
      name,
      kind,
      public_key,
      app_version,
      poll_hash: await sha256Hex(poll),
      expires,
      status: 'waiting',
      result: null,
    });
    if (this.storage.setAlarm) await this.storage.setAlarm(expires + 1000);
    return { expires_in: LINK_SECONDS };
  }

  peek(link) {
    if (link.status !== 'waiting') throw new ApiError(410, link.status === 'denied' ? 'denied' : 'expired', 'That code was already used. Make a new one on the Mac.');
    return {
      name: link.name,
      kind: link.kind,
      public_key: link.public_key,
      app_version: link.app_version || '',
      expires_in: Math.max(0, Math.round((link.expires - this.now()) / 1000)),
    };
  }

  async settle(link, status, result) {
    if (link.status !== 'waiting') throw new ApiError(410, 'expired', 'That code was already used. Make a new one on the Mac.');
    link.status = status;
    link.result = result;
    await this.storage.put('link', link);
    return {};
  }

  async poll(link, poll) {
    if (!poll || !sameText(link.poll_hash, await sha256Hex(String(poll)))) throw new ApiError(403, 'forbidden', "That isn't this link's secret.");
    if (link.status === 'waiting') return json({ status: 'waiting' }, 202);
    await this.storage.deleteAll();
    if (link.status === 'denied') throw new ApiError(410, 'denied', 'The link was turned down on the iPhone.');
    return json(link.result);
  }

  async stash({ value, seconds }) {
    if (await this.storage.get('stash')) throw new ApiError(409, 'conflict', 'That one is taken.');
    const expires = this.now() + Math.min(600, Math.max(1, Number(seconds) || 60)) * 1000;
    await this.storage.put('stash', { value, expires });
    if (this.storage.setAlarm) await this.storage.setAlarm(expires + 1000);
    return { expires_in: Math.round((expires - this.now()) / 1000) };
  }

  async take() {
    const kept = await this.storage.get('stash');
    if (!kept) throw new ApiError(404, 'not_found', 'That sign-in is gone. Try again.');
    await this.storage.deleteAll(); // once, whatever happens next
    if (kept.expires <= this.now()) throw new ApiError(410, 'expired', 'That sign-in took too long. Try again.');
    return { value: kept.value };
  }

  async alarm() {
    await this.storage.deleteAll();
  }
}
