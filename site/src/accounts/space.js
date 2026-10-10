// Team spaces (ROADMAP G8; docs/accounts.md "Team spaces"): a shared project across Eden
// accounts. One Durable Object per space (`Space`, binding SPACES, migration v4), named by its
// id (16 random bytes, base64url). It keeps:
//
//   space                 { id, name, owner (account id), level (the router level members
//                           start from), budget_usd (a month, out of the owner's Plus), created }
//   m:<member>            { member, account, role 'owner' | 'member', label, joined }
//                         (member: the first 16 hex of SHA-256("<space>:<account>"); pages see
//                         only that, never an account id)
//   inv:<hash>            an open invitation (single use, 7 days): { expires }
//   keymeta               { gen, proof_hash, created }: the space key's generation and the hash
//                         of its proof (eden-crypto.js proofOf, label eden-space-v1)
//   k:<member>:<device>   a member browser's public key, and once a key holder has sealed it
//                         there, the space key sealed to it: { public_key, alg, sealed_key?, sender_key? }
//   c:<id>                a shared conversation, or a shared workflow (H9: kind 'workflow'), sealed
//                         with the space key in the browser (AES-256-GCM): { rev, data | null,
//                         deleted, by, updated, size, kind }
//
// The server never sees the space key or a conversation's text: it holds sealed blobs, and the
// space key itself only sealed to members' browsers (the same machinery as Eden sync, H1).
//
// The money is the owner's: members' turns in a space run as a grant on the owner's account
// (delegates.js), capped by the space's monthly budget (a pool there) and counted per member.
// Making a space needs Plus. Invitations are codes (XXXX-XXXX-XXXX) found through an index
// object of this same class, named `inv:<SHA-256 of the code>`, holding { space, expires }.

import { ApiError, cleanName, json, randomBytes, sameText, sha256Hex, validAccountId, validDeviceId } from './util.js';
import { actingCookie, ask, cleanInviteCode, endActing, newInviteCode, readBody, slowDown } from './delegates.js';

export const SPACES = { members: 20, convs: 200, convChars: 700_000, totalChars: 30_000_000, keys: 60, perOwner: 5, invites: 10, inviteDays: 7, maxBudget: 200 };
export const LEVELS = [1, 2, 3, 4, 5];
const ID = /^[A-Za-z0-9_-]{22}$/;
const CONV = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS = new Set(['conv', 'workflow', 'mail']); // what a sealed item is, so the page can list each apart
const B64 = /^[A-Za-z0-9+/=]+$/;
const PUBLIC_CHARS = { x25519: 44, p256: 88 };

const bad = (message) => new ApiError(400, 'bad_request', message);
const notMember = () => new ApiError(404, 'not_found', 'That space isn’t one you’re in.');
const ownerOnly = () => new ApiError(403, 'forbidden', 'Only the space’s owner can do that.');

function budget(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > SPACES.maxBudget) throw bad(`A space’s monthly budget is $0–$${SPACES.maxBudget}.`);
  return Math.round(n * 100) / 100;
}

function level(value) {
  const n = Number(value);
  if (!LEVELS.includes(n)) throw bad('The router level is 1–5.');
  return n;
}

const spaceName = (name) => cleanName(name, 'Team space').slice(0, 60);
const memberLabel = (label, fallback) => cleanName(label, fallback).slice(0, 40);

function checkPublic(alg, key) {
  if (!PUBLIC_CHARS[alg]) throw bad('alg must be "x25519" or "p256".');
  if (typeof key !== 'string' || key.length !== PUBLIC_CHARS[alg] || !B64.test(key)) throw bad('public_key must be the browser’s raw public key, base64.');
  return key;
}

const checkSealed = (text, what) => {
  if (typeof text !== 'string' || !text || text.length > 400 || !B64.test(text)) throw bad(`${what} must be base64.`);
  return text;
};

export const memberIdOf = async (space, account) => (await sha256Hex(`${space}:${account}`)).slice(0, 16);

export class Space {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env || {};
    this.now = () => Date.now();
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    try {
      const body = await request.json().catch(() => ({}));
      if (op.startsWith('index-')) return json(await this.index(op, body));
      if (op === 'create') return json(await this.create(body));
      const space = await this.storage.get('space');
      if (!space) throw notMember();
      if (op === 'join') return json(await this.join(space, body));
      const me = await this.member(space, body.account);
      const run = {
        view: () => this.view(space, me),
        update: () => this.update(space, me, body),
        invite: () => this.invite(space, me),
        leave: () => this.leave(space, me),
        remove: () => this.remove(space, me, body),
        delete: () => this.destroy(space, me),
        'erase-member': () => this.eraseMember(me),
        'key-register': () => this.keyRegister(space, me, body),
        'key-init': () => this.keyInit(space, me, body),
        'key-seal': () => this.keySeal(space, me, body),
        'key-mine': () => this.keyMine(me, body),
        'conv-get': () => this.convGet(body),
        'conv-put': () => this.convPut(me, body),
        'conv-delete': () => this.convDelete(me, body),
      }[op];
      if (!run) throw new ApiError(404, 'not_found', 'No such thing.');
      return json(await run());
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  async member(space, account) {
    if (!validAccountId(account)) throw notMember();
    const m = await this.storage.get(`m:${await memberIdOf(space.id, account)}`);
    if (!m) throw notMember();
    return m;
  }

  async members() {
    return [...(await this.storage.list({ prefix: 'm:' })).values()].sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.joined - b.joined));
  }

  // The invitation index: `inv:<hash>` objects, never a space.
  async index(op, body) {
    if (await this.storage.get('space')) throw bad('That is a space, not an invitation.');
    const entry = await this.storage.get('inv');
    if (op === 'index-get') {
      if (!entry || entry.expires <= this.now()) {
        if (entry) await this.storage.deleteAll();
        throw new ApiError(404, 'not_found', 'That invitation isn’t one we know, or it ran out. Ask for a new one.');
      }
      return { space: entry.space };
    }
    if (op === 'index-claim') {
      if (entry && entry.expires > this.now()) throw new ApiError(409, 'taken', 'That code is taken.');
      if (!ID.test(String(body.space))) throw bad('space is required');
      const expires = this.now() + SPACES.inviteDays * 86400_000;
      await this.storage.put('inv', { space: body.space, expires });
      if (this.storage.setAlarm) await this.storage.setAlarm(expires + 1000);
      return {};
    }
    if (op === 'index-drop') {
      if (entry && entry.space === body.space) await this.storage.deleteAll();
      return {};
    }
    throw new ApiError(404, 'not_found', 'No such thing.');
  }

  async alarm() {
    const entry = await this.storage.get('inv');
    if (entry && !(await this.storage.get('space')) && entry.expires <= this.now()) await this.storage.deleteAll();
  }

  async create({ id, name, owner, level: lv = 3, budget_usd: b = 10, label }) {
    if (!ID.test(String(id)) || !validAccountId(owner)) throw bad('A space needs its id and owner.');
    if (await this.storage.get('space')) throw new ApiError(409, 'taken', 'That space id is taken.');
    if (await this.storage.get('inv')) throw bad('That is an invitation, not a space.');
    const space = { id, name: spaceName(name), owner, level: level(lv), budget_usd: budget(b), created: this.now() };
    const member = await memberIdOf(id, owner);
    await this.storage.put({ space, [`m:${member}`]: { member, account: owner, role: 'owner', label: memberLabel(label, 'Owner'), joined: this.now() }, rev: 0, count: 0, bytes: 0 });
    return this.view(space, { member, role: 'owner', account: owner });
  }

  async view(space, me) {
    const members = await this.members();
    const meta = await this.storage.get('keymeta');
    const keys = [...(await this.storage.list({ prefix: 'k:' })).values()];
    const convs = [...(await this.storage.list({ prefix: 'c:' })).values()].filter((c) => !c.deleted).sort((a, b) => b.updated - a.updated);
    const mine = keys.filter((k) => k.member === me.member);
    return {
      space: { id: space.id, name: space.name, level: space.level, budget_usd: space.budget_usd, created: space.created },
      me: { member: me.member, role: me.role, has_key: mine.some((k) => k.sealed_key) },
      members: members.map((m) => ({ member: m.member, role: m.role, label: m.label, joined: m.joined, this: m.member === me.member })),
      key: meta ? { gen: meta.gen, created: meta.created } : null,
      // Browsers waiting for the space key (a key holder seals it to them), with their code.
      keys: keys.map((k) => ({ member: k.member, device: k.device, alg: k.alg, public_key: k.public_key, sealed: Boolean(k.sealed_key), added: k.added })),
      convs: convs.map((c) => ({ id: c.id, rev: c.rev, by: c.by, updated: c.updated, size: c.size, meta: c.meta || null, kind: c.kind || 'conv' })),
      used: { convs: convs.length, bytes: Math.floor(((await this.storage.get('bytes')) || 0) * 0.75) },
      caps: { members: SPACES.members, convs: SPACES.convs, item_bytes: Math.floor((SPACES.convChars * 3) / 4) },
    };
  }

  async update(space, me, { name, level: lv, budget_usd: b }) {
    if (me.role !== 'owner') throw ownerOnly();
    if (name !== undefined) space.name = spaceName(name);
    if (lv !== undefined) space.level = level(lv);
    if (b !== undefined) space.budget_usd = budget(b);
    await this.storage.put('space', space);
    return this.view(space, me);
  }

  async invite(space, me) {
    if (me.role !== 'owner') throw ownerOnly();
    const open = [...(await this.storage.list({ prefix: 'inv:' })).entries()];
    for (const [key, i] of open) if (i.expires <= this.now()) await this.storage.delete(key);
    if (open.length >= SPACES.invites) throw new ApiError(409, 'too_many', 'This space has enough open invitations. Wait for some to be used or run out.');
    if ((await this.members()).length >= SPACES.members) throw new ApiError(409, 'too_many', `A space has at most ${SPACES.members} members.`);
    const code = newInviteCode();
    const hash = await sha256Hex(code);
    await this.storage.put(`inv:${hash}`, { expires: this.now() + SPACES.inviteDays * 86400_000 });
    return { code, hash };
  }

  async join(space, { account, code, label }) {
    if (!validAccountId(account)) throw bad('account is required');
    const hash = await sha256Hex(String(code || ''));
    const invite = await this.storage.get(`inv:${hash}`);
    if (!invite || invite.expires <= this.now()) throw new ApiError(404, 'not_found', 'That invitation isn’t one we know, or it ran out. Ask for a new one.');
    const member = await memberIdOf(space.id, account);
    if (await this.storage.get(`m:${member}`)) {
      await this.storage.delete(`inv:${hash}`);
      return { space: { id: space.id, name: space.name }, member, already: true };
    }
    if ((await this.members()).length >= SPACES.members) throw new ApiError(409, 'too_many', `A space has at most ${SPACES.members} members.`);
    await this.storage.delete(`inv:${hash}`);
    await this.storage.put(`m:${member}`, { member, account, role: 'member', label: memberLabel(label, 'Member'), joined: this.now() });
    return { space: { id: space.id, name: space.name, owner: space.owner }, member, hash };
  }

  async dropMember(m) {
    const keys = [...(await this.storage.list({ prefix: `k:${m.member}:` })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
    await this.storage.delete(`m:${m.member}`);
  }

  async leave(space, me) {
    if (me.role === 'owner') throw new ApiError(409, 'owner', 'The owner can’t leave a space. Delete it instead.');
    await this.dropMember(me);
    return { left: true, owner: space.owner };
  }

  async remove(space, me, { member }) {
    if (me.role !== 'owner') throw ownerOnly();
    const m = await this.storage.get(`m:${String(member)}`);
    if (!m) throw new ApiError(404, 'not_found', 'That member already left.');
    if (m.role === 'owner') throw new ApiError(409, 'owner', 'The owner can’t be removed.');
    await this.dropMember(m);
    return { removed: m.member, account: m.account, owner: space.owner };
  }

  async destroy(space, me) {
    if (me.role !== 'owner') throw ownerOnly();
    const accounts = (await this.members()).map((m) => m.account);
    const invites = [...(await this.storage.list({ prefix: 'inv:' })).keys()].map((k) => k.slice(4)); // their index objects (inv:<hash>) go too
    await this.storage.deleteAll();
    return { deleted: space.id, accounts, owner: space.owner, invites };
  }

  // A member's account is being deleted: their membership, their keys and what they shared go
  // (the shared conversations they made are removed, as conv-delete would). The owner is not
  // handled here: an owner's account erases the whole space (destroy).
  async eraseMember(me) {
    if (me.role === 'owner') throw new ApiError(409, 'owner', 'The owner erases the space instead.');
    const rows = [...(await this.storage.list({ prefix: 'c:' })).values()].filter((c) => !c.deleted && c.by === me.member);
    if (rows.length) {
      let count = (await this.storage.get('count')) || 0;
      let bytes = (await this.storage.get('bytes')) || 0;
      let rev = (await this.storage.get('rev')) || 0;
      for (const c of rows) {
        rev += 1; count = Math.max(0, count - 1); bytes = Math.max(0, bytes - c.size);
        await this.storage.put(`c:${c.id}`, { id: c.id, rev, data: null, deleted: true, by: c.by, updated: this.now(), size: 0 });
      }
      await this.storage.put({ rev, count, bytes });
    }
    await this.dropMember(me);
    return { erased: me.member, removed_convs: rows.length, owner: (await this.storage.get('space')).owner };
  }

  // ── the space key ──

  async keyRegister(space, me, { device, public_key, alg }) {
    if (!validDeviceId(device)) throw bad('device is required');
    checkPublic(alg, public_key);
    const key = `k:${me.member}:${device}`;
    const had = await this.storage.get(key);
    if (had && had.public_key === public_key) return { registered: true, sealed: Boolean(had.sealed_key) };
    if ([...(await this.storage.list({ prefix: 'k:' })).keys()].length >= SPACES.keys) throw new ApiError(409, 'too_many', 'This space has too many browsers waiting for its key.');
    await this.storage.put(key, { member: me.member, device, public_key, alg, added: this.now() });
    return { registered: true, sealed: false };
  }

  async proofOk(proof) {
    const meta = await this.storage.get('keymeta');
    if (!meta) throw new ApiError(409, 'no_key', 'This space has no key yet.');
    if (typeof proof !== 'string' || !sameText(meta.proof_hash, await sha256Hex(proof))) throw new ApiError(403, 'wrong_key', 'That isn’t this space’s key.');
    return meta;
  }

  // The owner's browser makes the space key, and keeps it sealed to itself here.
  async keyInit(space, me, { device, gen, proof, sealed_key, sender_key }) {
    if (me.role !== 'owner') throw ownerOnly();
    if (await this.storage.get('keymeta')) throw new ApiError(409, 'key_exists', 'This space already has a key.');
    if (typeof gen !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(gen) || typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) throw bad('gen and proof are required');
    const k = await this.storage.get(`k:${me.member}:${device}`);
    if (!k) throw bad('Register this browser’s key first.');
    await this.storage.put({ keymeta: { gen, proof_hash: await sha256Hex(proof), created: this.now() }, [`k:${me.member}:${device}`]: { ...k, sealed_key: checkSealed(sealed_key, 'sealed_key'), sender_key: checkSealed(sender_key, 'sender_key'), gen } });
    return { gen };
  }

  // A browser that holds the key seals it to another member's browser (its key echoed back).
  async keySeal(space, me, { device, proof, target, public_key, sealed_key, sender_key }) {
    const meta = await this.proofOk(proof);
    const holder = await this.storage.get(`k:${me.member}:${device}`);
    if (!holder || !holder.sealed_key) throw new ApiError(403, 'not_trusted', 'This browser doesn’t hold the space key.');
    const [member, dev] = String(target || '').split(':');
    const k = await this.storage.get(`k:${member}:${dev}`);
    if (!k) throw new ApiError(404, 'not_found', 'That browser is gone.');
    if (!sameText(k.public_key, String(public_key || ''))) throw new ApiError(409, 'conflict', 'That browser’s key changed. Check the code again.');
    await this.storage.put(`k:${member}:${dev}`, { ...k, sealed_key: checkSealed(sealed_key, 'sealed_key'), sender_key: checkSealed(sender_key, 'sender_key'), gen: meta.gen, sealed_by: me.member });
    return { sealed: true };
  }

  async keyMine(me, { device }) {
    const k = await this.storage.get(`k:${me.member}:${device}`);
    if (!k || !k.sealed_key) return { sealed: null };
    return { sealed: { sealed_key: k.sealed_key, sender_key: k.sender_key, alg: k.alg, gen: k.gen } };
  }

  // ── shared conversations: sealed blobs only ──

  async convGet({ id }) {
    const c = CONV.test(String(id)) ? await this.storage.get(`c:${id}`) : null;
    if (!c || c.deleted) throw new ApiError(404, 'not_found', 'That shared conversation is gone.');
    return { id: c.id, rev: c.rev, data: c.data, by: c.by, updated: c.updated, kind: c.kind || 'conv' };
  }

  async convPut(me, { id, data, meta = null, base_rev, kind = 'conv' }) {
    if (!CONV.test(String(id))) throw bad('A shared conversation id is up to 40 of A–Z a–z 0–9 _ -');
    if (!KINDS.has(kind)) throw bad('kind is "conv", "workflow" or "mail".');
    if (typeof data !== 'string' || !data || !B64.test(data)) throw bad('data must be sealed base64.');
    // Its title, sealed too (so the list can show it without fetching every conversation).
    if (meta !== null && (typeof meta !== 'string' || meta.length > 2000 || !B64.test(meta))) throw bad('meta must be sealed base64 (at most 2000 characters).');
    if (data.length > SPACES.convChars) throw new ApiError(413, 'too_big', 'A shared conversation is at most 512 KB once sealed.');
    if (!(await this.storage.get('keymeta'))) throw new ApiError(409, 'no_key', 'This space has no key yet.');
    const current = await this.storage.get(`c:${id}`);
    const currentRev = current ? current.rev : 0;
    if (Number(base_rev ?? 0) !== currentRev) {
      throw new ApiError(409, 'conflict', 'Someone shared a newer copy; reload it first.', {}, { item: current && !current.deleted ? { id, rev: currentRev, data: current.data, by: current.by } : { id, rev: currentRev, data: null } });
    }
    if (current && !current.deleted && current.by !== me.member && me.role !== 'owner') throw ownerOnly();
    let count = (await this.storage.get('count')) || 0;
    let bytes = (await this.storage.get('bytes')) || 0;
    const was = current && !current.deleted ? current.size : 0;
    if (!current || current.deleted) {
      if (count >= SPACES.convs) throw new ApiError(413, 'too_many', `A space keeps at most ${SPACES.convs} shared conversations.`);
      count += 1;
    }
    if (bytes - was + data.length > SPACES.totalChars) throw new ApiError(413, 'too_big', 'This space’s shared conversations are at the most askeden.com keeps.');
    bytes += data.length - was;
    const rev = ((await this.storage.get('rev')) || 0) + 1;
    await this.storage.put({ [`c:${id}`]: { id, rev, data, meta, deleted: false, by: me.member, updated: this.now(), size: data.length, kind }, rev, count, bytes });
    return { id, rev };
  }

  async convDelete(me, { id, base_rev }) {
    const c = CONV.test(String(id)) ? await this.storage.get(`c:${id}`) : null;
    if (!c || c.deleted) return { id, deleted: true };
    if (c.by !== me.member && me.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only who shared it, or the space’s owner, can remove it.');
    if (base_rev !== undefined && Number(base_rev) !== c.rev) throw new ApiError(409, 'conflict', 'Someone shared a newer copy; reload it first.');
    const rev = ((await this.storage.get('rev')) || 0) + 1;
    await this.storage.put({ [`c:${id}`]: { id, rev, data: null, deleted: true, by: c.by, updated: this.now(), size: 0 }, rev, count: Math.max(0, ((await this.storage.get('count')) || 1) - 1), bytes: Math.max(0, ((await this.storage.get('bytes')) || 0) - c.size) });
    return { id, deleted: true, rev };
  }
}

// ── the Worker's side ──

async function askSpace(env, name, op, body = {}) {
  if (!env.SPACES) throw new ApiError(503, 'not_set_up', 'Team spaces are not set up here yet.');
  const stub = env.SPACES.get(env.SPACES.idFromName(name));
  const response = await stub.fetch(`https://space/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await response.json().catch(() => ({}));
  if (response.status >= 400) {
    const { error, code, ...extra } = out;
    throw new ApiError(response.status, code || 'error', error || 'Something went wrong.', {}, extra);
  }
  return out;
}

const respond = (body, ...setCookies) => {
  const r = json(body);
  for (const c of setCookies) r.headers.append('set-cookie', c);
  return r;
};

const spaceId = (id) => {
  if (!ID.test(String(id))) throw notMember();
  return String(id);
};

/** A space's view with its budget as the owner's account counts it (spent, and by whom). */
async function fullView(env, view, owner) {
  const pool = await ask(env, owner, 'deleg-pool-get', { type: 'space', id: view.space.id }).catch(() => ({ spent: 0, by: {} }));
  view.space.spent_usd = pool.spent || 0;
  view.space.left_usd = Math.max(0, Math.round((view.space.budget_usd - (pool.spent || 0)) * 100) / 100);
  for (const m of view.members) m.spent_usd = (pool.by || {})[m.member] || 0;
  return view;
}

/**
 * /api/web/space[/<op>] for a signed-in browser (`who`: its own session, never an acting one;
 * `acting`: the acting session it holds, if any).
 */
export async function spacesApi(request, env, who, op, { acting = null, origin = '' } = {}) {
  if (!env.SPACES) throw new ApiError(503, 'not_set_up', 'Team spaces are not set up here yet.');
  await slowDown(env, 'API_RATE', who.account);
  if (!op) {
    if (request.method !== 'GET') throw new ApiError(405, 'bad_request', 'GET it.');
    const [{ grants }, account] = await Promise.all([ask(env, who.account, 'deleg-mine', {}, who.token), ask(env, who.account, 'get', {}, who.token)]);
    const spaces = grants.filter((g) => g.type === 'space').map((g) => ({ id: g.id, name: g.label, owned: g.owner === who.account, added: g.added }));
    return json({ spaces, can_create: Boolean(account.plan && account.plan.active), max_owned: SPACES.perOwner, levels: LEVELS, max_budget: SPACES.maxBudget, acting: acting && acting.grant.type === 'space' ? { id: acting.grant.id, label: acting.grant.label } : null });
  }
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST it.');
  const body = await readBody(request, SPACES.convChars + 16_000);
  const as = { account: who.account };
  switch (op) {
    case 'create': {
      await slowDown(env, 'LINK_RATE', `space:${who.account}`);
      const account = await ask(env, who.account, 'get', {}, who.token);
      if (!(account.plan && account.plan.active)) throw new ApiError(402, 'needs_plus', 'Making a team space needs Plus (in the J.A.R.V.I.S. app on your iPhone). Its AI budget comes out of your Plus allowance.');
      const { grants } = await ask(env, who.account, 'deleg-mine', {}, who.token);
      if (grants.filter((g) => g.type === 'space' && g.owner === who.account).length >= SPACES.perOwner) throw new ApiError(409, 'too_many', `You can own at most ${SPACES.perOwner} spaces.`);
      const id = btoa(String.fromCharCode(...randomBytes(16))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const view = await askSpace(env, id, 'create', { id, name: body.name, owner: who.account, level: body.level ?? 3, budget_usd: body.budget_usd ?? 10, label: body.label });
      await ask(env, who.account, 'deleg-pool-set', { type: 'space', id, cap: view.space.budget_usd });
      await ask(env, who.account, 'deleg-mine-add', { type: 'space', id, owner: who.account, label: view.space.name });
      return json(await fullView(env, view, who.account));
    }
    case 'view': {
      const id = spaceId(body.id);
      const view = await askSpace(env, id, 'view', as);
      return json(await fullView(env, view, await spaceOwner(env, who, id)));
    }
    case 'update': {
      const id = spaceId(body.id);
      const view = await askSpace(env, id, 'update', { ...as, name: body.name, level: body.level, budget_usd: body.budget_usd });
      if (body.budget_usd !== undefined) await ask(env, who.account, 'deleg-pool-set', { type: 'space', id, cap: view.space.budget_usd });
      if (body.name !== undefined) await ask(env, who.account, 'deleg-mine-add', { type: 'space', id, owner: who.account, label: view.space.name });
      return json(await fullView(env, view, who.account));
    }
    case 'invite': {
      await slowDown(env, 'LINK_RATE', `space:${who.account}`);
      const id = spaceId(body.id);
      const { code, hash } = await askSpace(env, id, 'invite', as);
      await askSpace(env, `inv:${hash}`, 'index-claim', { space: id });
      return json({ code, link: `${origin}/#space=${code}` });
    }
    case 'join': {
      await slowDown(env, 'LINK_RATE', `space:${who.account}`);
      const code = cleanInviteCode(body.code);
      if (!code) throw new ApiError(404, 'not_found', 'That isn’t an invitation code. It looks like XXXX-XXXX-XXXX.');
      const hash = await sha256Hex(code);
      const { space } = await askSpace(env, `inv:${hash}`, 'index-get');
      const joined = await askSpace(env, space, 'join', { ...as, code, label: body.label });
      await ask(env, who.account, 'deleg-mine-add', { type: 'space', id: space, owner: joined.space.owner || '', label: joined.space.name });
      await askSpace(env, `inv:${hash}`, 'index-drop', { space }).catch(() => {});
      return json({ joined: { id: space, name: joined.space.name } });
    }
    case 'leave': {
      const id = spaceId(body.id);
      const left = await askSpace(env, id, 'leave', as);
      await ask(env, who.account, 'deleg-mine-drop', { type: 'space', id });
      await ask(env, left.owner, 'deleg-grant-drop', { type: 'space', id, account: who.account }).catch(() => {});
      const cookies = acting && acting.grant.type === 'space' && acting.grant.id === id ? [await endActing(request, env)] : [];
      return respond({ left: id }, ...cookies);
    }
    case 'remove': {
      const id = spaceId(body.id);
      const gone = await askSpace(env, id, 'remove', { ...as, member: body.member });
      await ask(env, gone.account, 'deleg-mine-drop', { type: 'space', id }).catch(() => {});
      await ask(env, gone.owner, 'deleg-grant-drop', { type: 'space', id, account: gone.account }).catch(() => {});
      return json({ removed: gone.removed });
    }
    case 'delete': {
      const id = spaceId(body.id);
      const gone = await askSpace(env, id, 'delete', as);
      for (const account of gone.accounts) await ask(env, account, 'deleg-mine-drop', { type: 'space', id }).catch(() => {});
      await ask(env, gone.owner, 'deleg-grant-drop', { type: 'space', id }).catch(() => {});
      const cookies = acting && acting.grant.type === 'space' && acting.grant.id === id ? [await endActing(request, env)] : [];
      return respond({ deleted: id }, ...cookies);
    }
    case 'use': {
      // Chat in the space: a grant on the owner's account, capped by the space's budget.
      const id = spaceId(body.id);
      const view = await askSpace(env, id, 'view', as);
      const owner = await spaceOwner(env, who, id);
      const made = await ask(env, owner, 'deleg-session', { type: 'space', id, account: who.account, member: view.me.member, label: view.space.name, cap: view.space.budget_usd });
      if (acting) await endActing(request, env);
      return respond({ acting: { type: 'space', id, label: made.grant.label, level: view.space.level, expires: made.expires } }, actingCookie(made.token, made.expires));
    }
    case 'key-register':
      return json(await askSpace(env, spaceId(body.id), 'key-register', { ...as, device: who.device.id, public_key: body.public_key, alg: body.alg }));
    case 'key-init':
      return json(await askSpace(env, spaceId(body.id), 'key-init', { ...as, device: who.device.id, gen: body.gen, proof: body.proof, sealed_key: body.sealed_key, sender_key: body.sender_key }));
    case 'key-seal':
      return json(await askSpace(env, spaceId(body.id), 'key-seal', { ...as, device: who.device.id, proof: body.proof, target: body.target, public_key: body.public_key, sealed_key: body.sealed_key, sender_key: body.sender_key }));
    case 'key-mine':
      return json(await askSpace(env, spaceId(body.id), 'key-mine', { ...as, device: who.device.id }));
    case 'conv-get':
      return json(await askSpace(env, spaceId(body.id), 'conv-get', { ...as, id: body.conv }));
    case 'conv-put':
      return json(await askSpace(env, spaceId(body.id), 'conv-put', { ...as, id: body.conv, data: body.data, meta: body.meta ?? null, base_rev: body.base_rev, kind: body.kind ?? 'conv' }));
    case 'conv-delete':
      return json(await askSpace(env, spaceId(body.id), 'conv-delete', { ...as, id: body.conv, base_rev: body.base_rev }));
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

// The space's owner (an account id), as this member's own account records it.
async function spaceOwner(env, who, id) {
  const { grants } = await ask(env, who.account, 'deleg-mine', {}, who.token);
  const g = grants.find((x) => x.type === 'space' && x.id === id);
  if (!g || !validAccountId(g.owner)) throw notMember();
  return g.owner;
}

/**
 * Account deletion (accounts/index.js eraseAccount), the team half. `snap` is read BEFORE the
 * account's own object is deleted ({ grants: deleg-mine, delegations: deleg-erase-info }).
 *   - Spaces the account OWNS are deleted for everyone: the owner can't leave, and the space's AI
 *     budget, pool and key authority live in the owner's account, so a space can't outlive it.
 *     Every member's `grant-in` row for it is dropped, and its invitation index objects.
 *   - Spaces it only belongs to: its membership and keys go, and so do the shared conversations
 *     it made; the others' conversations stay. The owner's pool/sessions for it end.
 *   - Delegations it owns: the delegate's `grant-in` row and any open invitation index go.
 *   - Delegations it holds on other accounts: the owner's record (and its sessions) is ended.
 * Best effort, each step on its own: one failing never stops the others.
 */
export async function teamSnapshot(env, accountId, auth) {
  const grants = await ask(env, accountId, 'deleg-mine', {}, auth).then((r) => r.grants || []).catch(() => []);
  const delegations = await ask(env, accountId, 'deleg-erase-info', {}, auth).then((r) => r.delegations || []).catch(() => []);
  return { grants, delegations };
}

export async function eraseTeamData(env, accountId, snap) {
  const quiet = (what) => (e) => console.error(`team cleanup failed (${what})`, e && e.message);
  for (const g of snap.grants || []) {
    if (g.type === 'space' && env.SPACES) {
      if (g.owner === accountId) {
        const gone = await askSpace(env, g.id, 'delete', { account: accountId }).catch(quiet('space delete'));
        if (!gone) continue;
        for (const account of gone.accounts) if (account !== accountId) await ask(env, account, 'deleg-mine-drop', { type: 'space', id: g.id }).catch(quiet('space member row'));
        for (const hash of gone.invites || []) await askSpace(env, `inv:${hash}`, 'index-drop', { space: g.id }).catch(quiet('space invite'));
      } else {
        const left = await askSpace(env, g.id, 'erase-member', { account: accountId }).catch(quiet('space member'));
        if (left && validAccountId(left.owner)) await ask(env, left.owner, 'deleg-grant-drop', { type: 'space', id: g.id, account: accountId }).catch(quiet('space grant'));
      }
    } else if (g.type === 'delegate') {
      const [owner, id] = String(g.id || '').split('.');
      if (validAccountId(owner)) await ask(env, owner, 'deleg-quit', { id, account: accountId }).catch(quiet('delegation quit'));
    }
  }
  for (const d of snap.delegations || []) {
    if (d.delegate) await ask(env, d.delegate, 'deleg-mine-drop', { type: 'delegate', id: `${accountId}.${d.id}` }).catch(quiet('delegate row'));
    if (d.invite_hash) await ask(env, `dinv:${d.invite_hash}`, 'deleg-index-drop', { account: accountId }).catch(quiet('delegate invite'));
  }
}
