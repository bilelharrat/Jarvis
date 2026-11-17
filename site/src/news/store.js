// Eden News storage: a Durable Object of its own (binding NEWS, class NewsDesk), not the account's, so News never
// touches accounts/account.js. One object per signed-in reader (`reader:<account id>`) keeps their profile; one
// shared object (`stories`) keeps the clustered stories for STORIES_TTL_MS, so the source is asked and the
// stories clustered once for everyone, not per reader.
//
//   POST https://news/profile-get   {}                 → { profile | null }
//   POST https://news/profile-put   { profile }        → { ok }
//   POST https://news/stories-get   { now }            → { stories, provider, sample, fetchedAt } | { stale: true }
//   POST https://news/stories-put   { stories, … }     → { ok }   (kept in chunks of CHUNK stories)
//   POST https://news/search-get    { query, now }     → { articles, at } | { stale: true }   (SEARCH_TTL_MS)
//   POST https://news/search-put    { query, articles } → { ok }
//   POST https://news/erase         {}                 → { ok }   (the reader's own object: Delete account, "Reset News")

export const STORIES_TTL_MS = 10 * 60e3;
export const SEARCH_TTL_MS = 20 * 60e3; // a reader's follow or city, searched
const CHUNK = 40; // stories per stored value
const MAX_PROFILE_BYTES = 64 * 1024;

export class NewsDesk {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env;
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const body = await request.json().catch(() => ({}));
    // the vault through its in-memory index (VAULT_INDEX=off: the storage.list code below)
    if (VAULT_OPS.has(op) && vaultIndexOn(this.env)) {
      try {
        return await this.vaultOp(op, body);
      } catch (error) {
        this.vault = null; // reload from storage next time
        throw error;
      }
    }
    if (op === 'erase') this.vault = null;
    switch (op) {
      case 'profile-get':
        return Response.json({ profile: (await this.storage.get('profile')) ?? null });
      case 'profile-put': {
        const text = JSON.stringify(body.profile ?? null);
        if (!body.profile || text.length > MAX_PROFILE_BYTES) return Response.json({ error: 'Profile missing or too big.' }, { status: 400 });
        await this.storage.put('profile', body.profile);
        return Response.json({ ok: true });
      }
      case 'stories-get': {
        const meta = await this.storage.get('stories');
        const now = Number(body.now) || Date.now();
        if (!meta || now - meta.fetchedAt > STORIES_TTL_MS) return Response.json({ stale: true });
        const parts = await this.storage.get(Array.from({ length: meta.chunks || 0 }, (_, i) => `stories:${i}`));
        const stories = Array.from({ length: meta.chunks || 0 }, (_, i) => parts.get(`stories:${i}`) || []).flat();
        return Response.json({ stories, provider: meta.provider, sample: meta.sample, fetchedAt: meta.fetchedAt });
      }
      case 'stories-put': {
        // in chunks: a day of real stories is more than one stored value may hold
        const stories = body.stories || [];
        const chunks = Math.ceil(stories.length / CHUNK);
        const put = {};
        for (let i = 0; i < chunks; i++) put[`stories:${i}`] = stories.slice(i * CHUNK, (i + 1) * CHUNK);
        put.stories = { chunks, provider: body.provider, sample: Boolean(body.sample), fetchedAt: Number(body.fetchedAt) || Date.now() };
        await this.storage.put(put);
        return Response.json({ ok: true });
      }
      case 'search-get': {
        const hit = await this.storage.get(`q:${String(body.query || '').toLowerCase()}`);
        const now = Number(body.now) || Date.now();
        return Response.json(hit && now - hit.at <= SEARCH_TTL_MS ? hit : { stale: true });
      }
      case 'search-put': {
        const at = Number(body.at) || Date.now();
        await this.storage.put(`q:${String(body.query || '').toLowerCase()}`, { articles: (body.articles || []).slice(0, 20), at });
        // what readers follow isn't kept past its cache time
        const stale = [...(await this.storage.list({ prefix: 'q:' }))].filter(([, v]) => at - v.at > SEARCH_TTL_MS).map(([k]) => k);
        for (let i = 0; i < stale.length; i += 128) await this.storage.delete(stale.slice(i, i + 128));
        return Response.json({ ok: true });
      }
      case 'vault-lookup': {
        const hash = String(body.canonicalHash || '');
        if (hash) {
          const exact = await this.storage.get(`v:${hash}`);
          if (exact) return Response.json({ entries: [exact] });
        }
        const map = await this.storage.list({ prefix: 'v:', limit: 25000 });
        return Response.json({ entries: [...map.values()] });
      }
      case 'vault-put': {
        const entry = body.entry;
        if (!entry || typeof entry.canonicalHash !== 'string' || !entry.canonicalHash) {
          return Response.json({ error: 'Invalid vault entry.' }, { status: 400 });
        }
        await this.storage.put(`v:${entry.canonicalHash}`, entry);
        const map = await this.storage.list({ prefix: 'v:' });
        if (map.size > 25000) {
          const sorted = [...map.entries()].sort((a, b) => (a[1]?.createdAt || 0) - (b[1]?.createdAt || 0));
          const toDelete = sorted.slice(0, map.size - 25000).map(([k]) => k);
          for (let i = 0; i < toDelete.length; i += 128) await this.storage.delete(toDelete.slice(i, i + 128));
        }
        return Response.json({ ok: true });
      }
      case 'vault-seed': {
        const seeded = await this.storage.get('vault:seeded_v3');
        if (seeded && !body.force) return Response.json({ ok: true, alreadySeeded: true });
        const entries = Array.isArray(body.entries) ? body.entries : [];
        for (let i = 0; i < entries.length; i += 120) {
          const batch = {};
          for (const e of entries.slice(i, i + 120)) {
            if (e && typeof e.canonicalHash === 'string' && e.canonicalHash) {
              batch[`v:${e.canonicalHash}`] = e;
            }
          }
          if (Object.keys(batch).length > 0) await this.storage.put(batch);
        }
        await this.storage.put('vault:seeded_v3', { at: Date.now(), count: entries.length });
        return Response.json({ ok: true, count: entries.length });
      }
      case 'flag-put': {
        const flag = body.flag;
        if (!flag || typeof flag.id !== 'string' || !flag.id) {
          return Response.json({ error: 'Invalid flag entry.' }, { status: 400 });
        }
        await this.storage.put(`f:${flag.id}`, flag);
        const map = await this.storage.list({ prefix: 'f:' });
        if (map.size > 2000) {
          const sorted = [...map.entries()].sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
          const toDelete = sorted.slice(0, map.size - 2000).map(([k]) => k);
          for (let i = 0; i < toDelete.length; i += 128) await this.storage.delete(toDelete.slice(i, i + 128));
        }
        return Response.json({ ok: true });
      }
      case 'flag-list': {
        const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
        const map = await this.storage.list({ prefix: 'f:' });
        const flags = [...map.values()].sort((a, b) => (b?.at || 0) - (a?.at || 0)).slice(0, limit);
        return Response.json({ flags });
      }
      case 'erase':
        await this.storage.deleteAll();
        return Response.json({ ok: true });
      default:
        return Response.json({ error: 'No such thing.' }, { status: 404 });
    }
  }

  /** The index, loaded from storage once per object life. */
  async vaultIndex() {
    if (this.vault) return this.vault;
    const map = await this.storage.list({ prefix: 'v:' });
    const ix = { keys: [], rank: new Map(), json: new Map(), chars: 0, body: null };
    for (const [key, value] of map) {
      ix.keys.push(key);
      remember(ix, key, value);
    }
    ix.keys.sort(byStorageKey); // already in this order; kept exact whatever storage hands back
    this.vault = ix;
    return ix;
  }

  // vault-lookup, vault-put, vault-seed: the same answers and the same stored data as the code in fetch(), without
  // listing every entry on each call
  async vaultOp(op, body) {
    if (op === 'vault-lookup') {
      const ix = await this.vaultIndex();
      const hash = String(body.canonicalHash || '');
      if (hash && ix.rank.has(`v:${hash}`)) {
        const text = ix.json ? ix.json.get(`v:${hash}`) : undefined;
        if (typeof text === 'string') return jsonText(`{"entries":[${text}]}`);
        const exact = await this.storage.get(`v:${hash}`);
        if (exact) return Response.json({ entries: [exact] });
      }
      if (!ix.json) { // too big to keep in memory: list, as before
        const map = await this.storage.list({ prefix: 'v:', limit: VAULT_MAX });
        return Response.json({ entries: [...map.values()] });
      }
      if (ix.body !== null) return jsonText(ix.body);
      const whole = `{"entries":[${ix.keys.slice(0, VAULT_MAX).map((k) => ix.json.get(k)).join(',')}]}`;
      if (ix.chars <= VAULT_BODY_CHARS) ix.body = whole; // kept only while small (a second copy of the JSON)
      return jsonText(whole);
    }
    if (op === 'vault-put') {
      const entry = body.entry;
      if (!entry || typeof entry.canonicalHash !== 'string' || !entry.canonicalHash) {
        return Response.json({ error: 'Invalid vault entry.' }, { status: 400 });
      }
      const ix = await this.vaultIndex();
      const key = `v:${entry.canonicalHash}`;
      await this.storage.put(key, entry);
      add(ix, key, entry);
      if (ix.keys.length > VAULT_MAX) {
        const toDelete = oldest(ix, ix.keys.length - VAULT_MAX);
        for (let i = 0; i < toDelete.length; i += 128) {
          const batch = toDelete.slice(i, i + 128);
          await this.storage.delete(batch);
          for (const k of batch) drop(ix, k);
        }
      }
      return Response.json({ ok: true });
    }
    // vault-seed: as in fetch(), and the index (when loaded) kept in step
    const seeded = await this.storage.get('vault:seeded_v3');
    if (seeded && !body.force) return Response.json({ ok: true, alreadySeeded: true });
    const entries = Array.isArray(body.entries) ? body.entries : [];
    for (let i = 0; i < entries.length; i += 120) {
      const batch = {};
      for (const e of entries.slice(i, i + 120)) {
        if (e && typeof e.canonicalHash === 'string' && e.canonicalHash) {
          batch[`v:${e.canonicalHash}`] = e;
        }
      }
      if (Object.keys(batch).length > 0) {
        await this.storage.put(batch);
        if (this.vault) for (const [k, v] of Object.entries(batch)) add(this.vault, k, v);
      }
    }
    await this.storage.put('vault:seeded_v3', { at: Date.now(), count: entries.length });
    return Response.json({ ok: true, count: entries.length });
  }
}

// ── the 'eves-vault' index (docs/load-balancing.md item 3) ──
// keys: every v: key in storage.list's order; rank: each entry's createdAt as the trim sorts it; json: each entry
// as JSON (dropped for the object's life once past VAULT_CACHE_CHARS; lookups then list as before); body: the
// whole-vault answer, built once per change and kept only up to VAULT_BODY_CHARS (else built per lookup, as before).
// Limits are in chars; a string with any non-Latin-1 char (curly quote, dash) takes 2 bytes a char, and the
// object shares its 128 MB isolate with the other NewsDesk objects: at most ~24 MB kept (json) or ~16 MB (both).

export const VAULT_MAX = 25000;
export const VAULT_CACHE_CHARS = 12 * 1024 * 1024;
export const VAULT_BODY_CHARS = 4 * 1024 * 1024;
const VAULT_OPS = new Set(['vault-lookup', 'vault-put', 'vault-seed']);
export const vaultIndexOn = (env) => String((env && env.VAULT_INDEX) || '').trim().toLowerCase() !== 'off';

const jsonText = (text) => new Response(text, { headers: { 'content-type': 'application/json' } });

// storage.list sorts keys by their UTF-8 bytes, i.e. by code point; JS `<` compares UTF-16 units, which differs
// past U+E000. Mapping the units this way gives code point order.
const unit = (c) => (c >= 0xd800 && c <= 0xdfff ? c + 0x2000 : c >= 0xe000 ? c - 0x800 : c);
export function byStorageKey(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return unit(x) - unit(y);
  }
  return a.length - b.length;
}

function find(keys, key) {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byStorageKey(keys[mid], key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function remember(ix, key, value) {
  ix.rank.set(key, value?.createdAt || 0);
  ix.body = null;
  if (!ix.json) return;
  const old = ix.json.get(key);
  if (typeof old === 'string') ix.chars -= old.length;
  const text = JSON.stringify(value);
  if (typeof text !== 'string') {
    ix.json = null;
    return;
  }
  ix.json.set(key, text);
  ix.chars += text.length;
  if (ix.chars > VAULT_CACHE_CHARS) ix.json = null;
}

function add(ix, key, value) {
  if (!ix.rank.has(key)) ix.keys.splice(find(ix.keys, key), 0, key);
  remember(ix, key, value);
}

function drop(ix, key) {
  if (!ix.rank.has(key)) return;
  ix.keys.splice(find(ix.keys, key), 1);
  ix.rank.delete(key);
  ix.body = null;
  if (!ix.json) return;
  const old = ix.json.get(key);
  if (typeof old === 'string') ix.chars -= old.length;
  ix.json.delete(key);
}

// The `count` oldest keys, as the storage.list code picks them: a stable sort by createdAt over key order. One key
// (the usual case once full): the first smallest, found without sorting, when every rank is a plain number.
function oldest(ix, count) {
  if (count === 1) {
    let best = null;
    let low = 0;
    let plain = true;
    for (const k of ix.keys) {
      const r = ix.rank.get(k);
      if (typeof r !== 'number' || !Number.isFinite(r)) {
        plain = false;
        break;
      }
      if (best === null || r < low) {
        best = k;
        low = r;
      }
    }
    if (plain && best !== null) return [best];
  }
  return [...ix.keys].sort((a, b) => ix.rank.get(a) - ix.rank.get(b)).slice(0, count);
}

const stub = (env, name) => env.NEWS.get(env.NEWS.idFromName(name));
async function call(env, name, op, body = {}) {
  const r = await stub(env, name).fetch(`https://news/${op}`, { method: 'POST', body: JSON.stringify(body) });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `news ${op} failed`);
  return out;
}

export const readerKey = (account) => `reader:${account}`;
export const getProfile = async (env, account) => (await call(env, readerKey(account), 'profile-get')).profile;
export const putProfile = (env, account, profile) => call(env, readerKey(account), 'profile-put', { profile });
export const eraseReader = (env, account) => call(env, readerKey(account), 'erase');
export const getStories = async (env, now) => {
  const key = newsEdgeKey('stories');
  const kept = await edgeGet(env, key);
  if (kept && !kept.stale && (Number(now) || Date.now()) - kept.fetchedAt <= STORIES_TTL_MS) return kept;
  const out = await call(env, 'stories', 'stories-get', { now });
  if (!out.stale) await edgePut(env, key, out);
  return out;
};
export const putStories = async (env, value) => {
  const out = await call(env, 'stories', 'stories-put', value);
  await edgeDrop(env, newsEdgeKey('stories'));
  return out;
};
export const getSearch = async (env, query, now) => {
  const key = newsEdgeKey('search', query);
  const kept = await edgeGet(env, key);
  if (kept && !kept.stale && (Number(now) || Date.now()) - kept.at <= SEARCH_TTL_MS) return kept;
  const out = await call(env, 'stories', 'search-get', { query, now });
  if (!out.stale) await edgePut(env, key, out);
  return out;
};
export const putSearch = async (env, query, articles) => {
  const out = await call(env, 'stories', 'search-put', { query, articles, at: Date.now() });
  await edgeDrop(env, newsEdgeKey('search', query));
  return out;
};

// ── the shared News at the edge (docs/load-balancing.md item 3) ──
// The stories and a query's search are the same for every reader (the feed's personal part is built from them in
// news/api.js and never cached), so each Cloudflare location keeps the 'stories' object's answer EDGE_TTL_S seconds
// (caches.default) instead of asking the one object on every feed. Only a fresh answer is kept, and a kept one is used
// only while the object would still call it fresh. NEWS_EDGE_CACHE=off: always the object.
const EDGE_TTL_S = 45;
const EDGE_BASE = 'https://askeden.com/__edge-cache/news/v1';
export const newsEdgeOn = (env) => String((env && env.NEWS_EDGE_CACHE) || '').trim().toLowerCase() !== 'off' && typeof caches !== 'undefined' && Boolean(caches && caches.default);
/** The cache key: one for the stories, one per search (lower-cased, as the object keys it). */
export const newsEdgeKey = (what, query = '') => (what === 'stories' ? `${EDGE_BASE}/stories` : `${EDGE_BASE}/search?q=${encodeURIComponent(String(query || '').toLowerCase())}`);

async function edgeGet(env, key) {
  if (!newsEdgeOn(env)) return null;
  try {
    const hit = await caches.default.match(key);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}
async function edgePut(env, key, value) {
  if (!newsEdgeOn(env)) return;
  try {
    await caches.default.put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${EDGE_TTL_S}` } }));
  } catch {
    // not kept: the object answers next time
  }
}
async function edgeDrop(env, key) {
  if (!newsEdgeOn(env)) return;
  try {
    await caches.default.delete(key);
  } catch {
    // expires on its own
  }
}

/** D1 vault reads through the Sessions API, so read replicas answer once replication is on. D1_SESSIONS=off, or no withSession: the database as before. */
export function vaultReader(env) {
  const db = env.EVES_VAULT_DB;
  if (String(env.D1_SESSIONS || '').trim().toLowerCase() === 'off' || typeof db.withSession !== 'function') return db;
  try {
    return db.withSession('first-unconstrained');
  } catch {
    return db;
  }
}
export const lookupEvesVault = async (env, canonicalHash, fingerprint = null) => {
  const results = [];
  const seen = new Set();
  const push = (e) => {
    if (e && typeof e.canonicalHash === 'string' && e.canonicalHash && !seen.has(e.canonicalHash)) {
      seen.add(e.canonicalHash);
      results.push(e);
    }
  };

  // Tier B.1 — Cloudflare D1 Edge SQLite Index (`env.EVES_VAULT_DB`, 51,000+ verified rows, ~1–2 ms)
  if (env?.EVES_VAULT_DB) {
    try {
      const db = vaultReader(env);
      if (canonicalHash) {
        const exactRow = await db.prepare('SELECT entry_json FROM eves_vault WHERE canonical_hash = ? LIMIT 1')
          .bind(String(canonicalHash))
          .first();
        if (exactRow?.entry_json) {
          const parsed = JSON.parse(exactRow.entry_json);
          if (parsed && parsed.canonicalHash) return [parsed];
        }
      }
      if (fingerprint && typeof fingerprint === 'object') {
        const interrogative = String(fingerprint.interrogative || 'what');
        const entities = Array.isArray(fingerprint.entities) ? fingerprint.entities.filter(Boolean).slice(0, 4) : [];
        const primaryEntity = String(entities[0] || '');
        const primaryNumber = String((fingerprint.numbers && fingerprint.numbers[0]) || '');
        const stmts = [];
        if (primaryEntity && primaryNumber) {
          if (entities.length >= 2) {
            const placeholders = entities.map(() => '?').join(', ');
            stmts.push(
              db.prepare(
                `SELECT entry_json FROM eves_vault WHERE interrogative = ? AND primary_entity IN (${placeholders}) AND primary_number = ? LIMIT 80`,
              ).bind(interrogative, ...entities, primaryNumber),
            );
          } else {
            stmts.push(
              db.prepare(
                'SELECT entry_json FROM eves_vault WHERE interrogative = ? AND primary_entity = ? AND primary_number = ? LIMIT 60',
              ).bind(interrogative, primaryEntity, primaryNumber),
            );
          }
        }
        if (entities.length >= 2) {
          const placeholders = entities.map(() => '?').join(', ');
          stmts.push(
            db.prepare(
              `SELECT entry_json FROM eves_vault WHERE primary_entity IN (${placeholders}) AND interrogative = ? LIMIT 80`,
            ).bind(...entities, interrogative),
          );
        } else if (primaryEntity) {
          stmts.push(
            db.prepare('SELECT entry_json FROM eves_vault WHERE primary_entity = ? AND interrogative = ? LIMIT 60').bind(
              primaryEntity,
              interrogative,
            ),
          );
        } else if (primaryNumber) {
          stmts.push(
            db.prepare('SELECT entry_json FROM eves_vault WHERE interrogative = ? AND primary_number = ? LIMIT 60').bind(
              interrogative,
              primaryNumber,
            ),
          );
        }
        for (const stmt of stmts) {
          const { results: rows } = await stmt.all();
          for (const r of rows || []) {
            if (r?.entry_json) {
              try {
                push(JSON.parse(r.entry_json));
              } catch {
                // ignore malformed row
              }
            }
          }
          if (results.length >= 40) break;
        }
      }
    } catch {
      // fall through to Durable Object store if D1 is unavailable
    }
  }

  // Tier B.2 — Durable Object `NewsDesk` fallback
  if (env?.NEWS) {
    try {
      const doEntries = (await call(env, 'eves-vault', 'vault-lookup', { canonicalHash })).entries || [];
      for (const e of doEntries) push(e);
    } catch {
      // ignore DO lookup failure
    }
  }
  return results;
};

export const putEvesVault = async (env, entry) => {
  const tasks = [];
  if (env?.EVES_VAULT_DB && entry && typeof entry.canonicalHash === 'string' && entry.canonicalHash) {
    const fp = entry.fingerprint || {};
    const interrogative = String(fp.interrogative || 'what');
    const primaryEntity = String((fp.entities && fp.entities[0]) || '');
    const primaryNumber = String((fp.numbers && fp.numbers[0]) || '');
    tasks.push(
      env.EVES_VAULT_DB.prepare(
        'INSERT OR REPLACE INTO eves_vault (canonical_hash, interrogative, primary_entity, primary_number, question, answer_text, entry_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(
          entry.canonicalHash,
          interrogative,
          primaryEntity,
          primaryNumber,
          String(entry.question || ''),
          String(entry.answerText || ''),
          JSON.stringify(entry),
          Number(entry.createdAt) || Date.now(),
        )
        .run()
        .catch(() => ({ ok: false })),
    );
  }
  if (env?.NEWS) {
    tasks.push(call(env, 'eves-vault', 'vault-put', { entry }).catch(() => ({ ok: false })));
  }
  if (!tasks.length) return { ok: false };
  await Promise.all(tasks);
  return { ok: true };
};

export const seedEvesVault = (env, entries, force = false) => (env.NEWS ? call(env, 'eves-vault', 'vault-seed', { entries, force }) : Promise.resolve({ ok: false }));
export const putEvesFlag = (env, flag) => (env?.NEWS ? call(env, 'eves-vault', 'flag-put', { flag }).catch(() => ({ ok: false })) : Promise.resolve({ ok: false }));
export const listEvesFlags = async (env, limit = 50) => (env?.NEWS ? ((await call(env, 'eves-vault', 'flag-list', { limit }).catch(() => ({})))?.flags || []) : []);
