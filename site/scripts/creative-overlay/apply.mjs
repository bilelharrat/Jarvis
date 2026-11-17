#!/usr/bin/env node
// Lays the Eden Creative Suite (its door and its rooms) over a copy of the live askeden.com site, and nothing else:
//   node scripts/creative-overlay/apply.mjs <target site/> [<this branch's site/>]
// scripts/deploy-creative-overlay.sh runs it on a fresh copy; never point it at a working copy someone else uses.
//
// 1. Copies the suite's own files (FILES), which the live site doesn't have, with eves-live.js as src/creative/eves.js
//    (the live site runs hosted EVES; main's eves.js says EVES isn't there).
// 2. Makes the few edits the shared files need (EDITS), each found exactly once by its exact text, or the script stops
//    and says which: the live site changed under it, so look before deploying. Nothing else in a shared file changes.
// 3. Checks what must already be true live (EDEN_VIDEOS on) and refuses rather than change it.
// It prints every file it wrote; that list is the deploy's "only my files".

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] || '');
const branch = resolve(process.argv[3] || join(here, '..', '..'));
if (!process.argv[2] || !existsSync(join(target, 'src/worker.js')) || !existsSync(join(target, 'wrangler.toml'))) {
  console.error('usage: apply.mjs <target site/> [<branch site/>]  (the target needs src/worker.js and wrangler.toml)');
  process.exit(2);
}
if (target === branch) {
  console.error('The target is this branch itself: lay the overlay over a copy of the live site, not here.');
  process.exit(2);
}

// [path in the target, path in the branch]
const FILES = [
  ['src/creative/api.js', 'src/creative/api.js'],
  ['src/creative/media.js', 'src/creative/media.js'],
  ['src/creative/ops.js', 'src/creative/ops.js'],
  ['src/creative/turn.js', 'src/creative/turn.js'],
  ['src/creative/rooms.js', 'src/creative/rooms.js'],
  ['src/creative/rooms-auth.js', 'src/creative/rooms-auth.js'],
  ['src/creative/eves.js', 'scripts/creative-overlay/eves-live.js'],
  ['test/creative.test.js', 'test/creative.test.js'],
  ['test/creative-rooms.test.js', 'test/creative-rooms.test.js'],
];

const HOLD_MEDIA = `  // A generated clip's hold (creative/ops.js; never an op of its own): its quote on the same allowance, kept until the
  // clip is made or fails. It isn't a reply being written, so it never takes one of the EDEN_TURNS (the suite's own
  // MEDIA.running caps how many are made at once).
  async holdMedia({ usd }) {
    const want = Number(usd);
    if (!(want >= 0)) throw new ApiError(400, 'bad_request', 'usd must be a number');
    this.held(''); // drop expired holds
    const allow = await this.allowAi();
    if (!allow.ok) return allow;
    if (want > allow.left) return { ok: false, why: 'Not enough of your included AI is left for this.' };
    const id = crypto.randomUUID();
    this.holds.set(id, { usd: want, bucket: allow.bucket, until: this.now() + HOLD_MS, pool: null, media: true });
    return { ok: true, bucket: allow.bucket, hold: id, left: allow.left };
  }

`;

// [file, exact text found once, its replacement, why]
const EDITS = [
  // ── the Account object: the suite's ops, its alarm kind, a clip's hold, and what account deletion hands the rooms ──
  ['src/accounts/account.js', "import { scopedOp } from './scoped.js';\n", "import { scopedOp } from './scoped.js';\nimport { creativeDue, creativeOp } from '../creative/ops.js';\n", 'the suite’s ops'],
  ['src/accounts/account.js',
    "      if (op.startsWith('scoped-')) return json(await scopedOp(this, op, body, request)); // other apps' scoped tokens, @Eden (scoped.js checks the caller)\n",
    "      if (op.startsWith('scoped-')) return json(await scopedOp(this, op, body, request)); // other apps' scoped tokens, @Eden (scoped.js checks the caller)\n      if (op.startsWith('creative-')) { const out = await creativeOp(this, op, body); return out instanceof Response ? out : json(out); } // the Creative Suite's apps, on their scoped token (src/creative/ops.js checks it; a result is streamed)\n",
    'creative-* ops, before the device check (they take the app’s token)'],
  ['src/accounts/account.js', '.filter((h) => !h.proxy && !h.edu).length >= EDEN_TURNS)', '.filter((h) => !h.proxy && !h.edu && !h.media).length >= EDEN_TURNS)', 'a clip being made isn’t one of the replies at once'],
  ['src/accounts/account.js', "  // One request of the apps' proxy (index.js anthropic)", `${HOLD_MEDIA}  // One request of the apps' proxy (index.js anthropic)`, 'holdMedia'],
  ['src/accounts/account.js',
    '      uploads: () => uploadsDue(this), // Gmail attachments uploaded ahead, unused for hours (mail-uploads.js)\n',
    "      uploads: () => uploadsDue(this), // Gmail attachments uploaded ahead, unused for hours (mail-uploads.js)\n      creative: (job) => creativeDue(this, job), // the Creative Suite's generated media: a job's next step, or its expiry (src/creative/ops.js)\n",
    'the alarm kind `creative`'],
  ['src/accounts/account.js',
    '    const identities = (await this.identities()).filter((i) => i.sub_hash).map(({ provider, sub_hash }) => ({ provider, sub_hash }));\n',
    "    const all = await this.identities();\n    const identities = all.filter((i) => i.sub_hash).map(({ provider, sub_hash }) => ({ provider, sub_hash }));\n    const emails = [...new Set(all.map((i) => i.email).filter((e) => typeof e === 'string' && e))]; // the Worker takes them out of shared projects (creative/rooms.js)\n",
    'deletion: the person’s emails, for the rooms'],
  ['src/accounts/account.js', 'return { apple_grant: grant || null, apple_grants: grants, identities, stripe_subscription', 'return { apple_grant: grant || null, apple_grants: grants, identities, emails, stripe_subscription', 'deletion: hand the emails on'],
  ['src/accounts/index.js', 'const { apple_grant: grant, apple_grants: grants = {}, identities = [], stripe_subscription: stripeSub,', 'const { apple_grant: grant, apple_grants: grants = {}, identities = [], emails = [], stripe_subscription: stripeSub,', 'deletion: read the emails'],
  ['src/accounts/index.js',
    "  for (const id of shared) await call(env, `shr:${id}`, 'share-index-drop', { account: accountId }).catch(() => {});\n",
    "  for (const id of shared) await call(env, `shr:${id}`, 'share-index-drop', { account: accountId }).catch(() => {});\n  // Creative Suite shared projects: the rooms it owns are deleted, it leaves the others, its room indexes go.\n  await import('../creative/rooms.js').then((m) => m.forgetAccount(env, accountId, emails)).catch((e) => console.error('creative rooms cleanup failed', e && e.message));\n",
    'deletion: the person’s rooms (review M4)'],

  // ── scoped tokens: the suite's client, its token checked by its ops, one cap per app (review L3) ──
  ['src/accounts/scoped.js', '/** A scoped token, checked: its record (an expired one goes). */\nasync function tokenCaller(', '/** A scoped token, checked: its record (an expired one goes). Also the Creative Suite\'s ops (src/creative/ops.js). */\nexport async function tokenCaller(', 'creative/ops.js checks the token'],
  ['src/accounts/scoped.js', '\n};\n\nconst ID = /^[0-9a-f]{16}$/;',
    "\n  // The Creative Suite's Mac apps (src/creative/api.js has the flow): a native scheme per app, never a web page; a year\n  // long. No /api/eden/* route takes its token (`routes` empty, and its scope isn't `ask`).\n  creative: { name: 'Eden Creative Suite', scope: 'creative', callback: 'edenstudio-<app>://link', days: 365, routes: [] }, // per app: creative/api.js callbackFor\n};\n\nconst ID = /^[0-9a-f]{16}$/;",
    'the `creative` client'],
  ['src/accounts/scoped.js',
    'function publicConnection({ id, client, scope, created, expires, last_used }) {\n  return { id, client, name: CLIENTS[client]?.name || client, scope, created, expires, last_used: last_used || null };\n}',
    'function publicConnection({ id, client, scope, created, expires, last_used, label, app }) {\n  const name = CLIENTS[client]?.name || client;\n  return { id, client, ...(app ? { app, label: label || null } : {}), name: label ? `${name}: ${label}` : name, scope, created, expires, last_used: last_used || null };\n}',
    'the account page names the suite app and Mac'],
  ['src/accounts/scoped.js', 'async function makeCode(account, device, { client, redirect_uri, challenge, scope }) {', 'async function makeCode(account, device, { client, redirect_uri, challenge, scope, app: suiteApp = null, label = null }) {', 'a ticket made for one suite app'],
  ['src/accounts/scoped.js',
    '  await account.storage.put(`sccode:${await sha256Hex(secret)}`, { client, scope, redirect_uri, challenge, device: device.id, expires });',
    "  const extra = {\n    ...(typeof suiteApp === 'string' && /^[a-z]{1,20}$/.test(suiteApp) ? { app: suiteApp } : {}),\n    ...(typeof label === 'string' && label ? { label: label.slice(0, 120) } : {}),\n  };\n  await account.storage.put(`sccode:${await sha256Hex(secret)}`, { client, scope, redirect_uri, challenge, device: device.id, expires, ...extra });",
    'the ticket keeps its app and label'],
  ['src/accounts/scoped.js',
    '  const tokens = await live(account);\n  for (const old of tokens.slice(0, Math.max(0, tokens.length - (SCOPED.max - 1)))) await account.storage.delete(`scoped:${old.id}`);',
    '  // each app\'s own room: a suite app\'s links are its own (an 11th Scorsese retires the oldest Scorsese, never an Ansel\n  // or a Messenger), and whatever goes is said in the answer, so the app can tell the person\n  const tokens = (await live(account)).filter((t) => t.client === client && (t.app || null) === (held.app || null));\n  const retired = tokens.slice(0, Math.max(0, tokens.length - (SCOPED.max - 1)));\n  for (const old of retired) await account.storage.delete(`scoped:${old.id}`);',
    'ten links per app, the retired ones named'],
  ['src/accounts/scoped.js',
    '    expires: now + SCOPED.days * 86400_000,\n    last_used: null,\n    by: held.device,\n  };\n  await account.storage.put(`scoped:${id}`, token);\n  return { id, secret, scope: token.scope, expires: token.expires };\n}',
    "    expires: now + (CLIENTS[client]?.days || SCOPED.days) * 86400_000,\n    last_used: null,\n    by: held.device,\n    ...(held.app ? { app: held.app } : {}),\n    ...(held.label ? { label: held.label } : {}),\n  };\n  await account.storage.put(`scoped:${id}`, token);\n  return { id, secret, scope: token.scope, expires: token.expires, created: now, ...(held.app ? { app: held.app } : {}), unlinked: retired.map(publicConnection) };\n}\n\n/** The links one more approval of this app would retire (oldest first): what the approval page says before Link. */\nexport const retiredBy = (connections, client, app = null) => {\n  const mine = connections.filter((c) => c.client === client && (c.app || null) === (app || null));\n  return mine.slice(0, Math.max(0, mine.length - (SCOPED.max - 1)));\n};",
    'a year-long token bound to its app; retiredBy'],

  // ── the Worker: the suite's routes, its rooms' object and the approval page ──
  ['src/worker.js', "export { Course } from './edu/course.js';\n", "export { Course } from './edu/course.js';\nexport { CreativeRoom } from './creative/rooms.js'; // Creative Suite projects, editing together (wrangler.toml CREATIVE_ROOMS)\nimport { roomsApi } from './creative/rooms.js';\nimport { creativeApi, creativeLinkPage } from './creative/api.js';\n", 'CreativeRoom and the suite’s modules'],
  ['src/worker.js', "    if (path.startsWith('/api/eden/')) return edenApi(request, env, ctx, path);\n",
    "    if (path.startsWith('/api/eden/')) return edenApi(request, env, ctx, path);\n    // Editing a Creative Suite project together: the same token and no-browser rule, its own rooms (creative/rooms.js).\n    if (path === '/api/creative/rooms' || path.startsWith('/api/creative/rooms/')) return roomsApi(request, env, ctx, path);\n    // The Eden Creative Suite's Mac apps: their scoped token, no browsers at all (creative/api.js, docs/creative-api.md).\n    if (path.startsWith('/api/creative/')) return creativeApi(request, env, ctx, path);\n",
    '/api/creative/* before the Origin rule'],
  ['src/worker.js', '  if (path === \'/eden/connect\') return connectPage(request, env, url); // "Connect Eden Messenger?" (eden/ask.js)\n',
    '  if (path === \'/eden/connect\') return connectPage(request, env, url); // "Connect Eden Messenger?" (eden/ask.js)\n  if (path === \'/creative/link\') return creativeLinkPage(request, env, url); // "Link Scorsese to Eden?" (creative/api.js)\n',
    'the approval page'],

  // ── hosted EVES's helpers, exported for the suite's EVES (eves-live.js), unchanged otherwise ──
  ['src/eden/chat.js', '\nfunction routeSettings(settings) {', '\nexport function routeSettings(settings) {', 'export for EVES'],
  ['src/eden/chat.js', '\nfunction routed(cfg, prompt, extras, only = null) {', '\nexport function routed(cfg, prompt, extras, only = null) {', 'export for EVES'],
  ['src/eden/chat.js', '\nasync function readBody(request, cap) {', '\nexport async function readBody(request, cap) {', 'export for EVES'],
  ['src/eden/chat.js', '\nfunction compareModels(raw, cfg) {', '\nexport function compareModels(raw, cfg) {', 'export for EVES'],
  ['src/eden/chat.js', '\nfunction compareLanes(cfg, prompt, extras, models) {', '\nexport function compareLanes(cfg, prompt, extras, models) {', 'export for EVES'],
];

const ROOMS_TOML = `
# Editing a Creative Suite project together (src/creative/rooms.js, docs/creative-rooms.md): one object per shared
# project, plus its index objects (an account's rooms, an email's invites).
[[durable_objects.bindings]]
name = "CREATIVE_ROOMS"
class_name = "CreativeRoom"

[[migrations]]
tag = "creative-rooms-v1"
new_sqlite_classes = ["CreativeRoom"]
`;

const wrote = [];
const fail = (why) => {
  console.error(`creative overlay: ${why}`);
  process.exit(1);
};

for (const [to, from] of FILES) {
  const src = join(branch, from);
  const dst = join(target, to);
  if (!existsSync(src)) fail(`missing in the branch: ${from}`);
  if (existsSync(dst) && to.startsWith('src/')) fail(`${to} already exists in the target: is the overlay laid already, or did the live site gain it?`);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  wrote.push(`${to} (new)`);
}

const byFile = new Map();
for (const [file, find, replace, why] of EDITS) {
  if (!byFile.has(file)) byFile.set(file, readFileSync(join(target, file), 'utf8'));
  const text = byFile.get(file);
  const n = text.split(find).length - 1;
  if (n !== 1) fail(`${file}: the text for "${why}" is there ${n} times, not once. The live site changed here: look before deploying.`);
  byFile.set(file, text.replace(find, () => replace));
}

// wrangler.toml: the rooms' binding and migration after the last migration; EDEN_VIDEOS must already be on.
const tomlPath = join(target, 'wrangler.toml');
let toml = readFileSync(tomlPath, 'utf8');
if (/CREATIVE_ROOMS|CreativeRoom|creative-rooms-v1/.test(toml)) fail('wrangler.toml already names the creative rooms: is the overlay laid already?');
if (!/^EDEN_VIDEOS\s*=\s*"on"/m.test(toml)) fail('wrangler.toml: EDEN_VIDEOS isn’t "on" live. The suite needs it on (owner decision 2026-11-16), but it also switches chat’s videos: turn it on with the owner, not here.');
const lastMigration = toml.lastIndexOf('[[migrations]]');
if (lastMigration < 0) fail('wrangler.toml has no [[migrations]]');
const blockEnd = toml.indexOf('\n\n', lastMigration);
const at = blockEnd < 0 ? toml.length : blockEnd + 1;
toml = `${toml.slice(0, at)}${ROOMS_TOML}${toml.slice(at)}`;
byFile.set('wrangler.toml', toml);

for (const [file, text] of byFile) {
  writeFileSync(join(target, file), text);
  wrote.push(`${file} (edited)`);
}
console.log(`creative overlay: ${wrote.length} files\n${wrote.map((f) => `  ${f}`).join('\n')}`);
