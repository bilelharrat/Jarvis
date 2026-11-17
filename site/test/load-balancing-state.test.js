// docs/load-balancing.md item 3 (hot single objects) and the voice backup (item 4): sharded daily quotas, the
// 'eves-vault' in-memory index (same answers as the storage.list code), the News edge cache, D1 sessions.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import worker, { VoiceQuota } from '../src/worker.js';
import { quotaShard, quotaShards, shardIndex, shareOf } from '../src/eden/quota-shard.js';
import { NewsDesk, VAULT_BODY_CHARS, VAULT_CACHE_CHARS, byStorageKey, getSearch, getStories, newsEdgeKey, putStories, vaultReader } from '../src/news/store.js';
import { Storage, namespace } from './fakes.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.caches;
});

// ── sharded quotas ──

test('shards: defaults, the switch, and N = 1 is the old object name', () => {
  assert.equal(quotaShards({}, 'help-messages'), 1); // one object: sharding by account would let one network pass its cap N times
  assert.equal(quotaShards({ VOICE_QUOTA_SHARDS: '8' }, 'help-messages'), 8);
  assert.equal(quotaShards({}, 'daily'), 1); // the voice stays one object unless asked (see docs)
  assert.equal(quotaShards({ VOICE_QUOTA_SHARDS: '8' }, 'daily'), 8);
  assert.equal(quotaShards({ VOICE_QUOTA_SHARDS: '1' }, 'help-messages'), 1);
  assert.equal(quotaShards({ VOICE_QUOTA_SHARDS: '500' }, 'daily'), 64);
  for (const bad of ['', '0', '-3', '2.5', 'many']) assert.equal(quotaShards({ VOICE_QUOTA_SHARDS: bad }, 'help-messages'), 1, bad);
  assert.deepEqual(quotaShard({ VOICE_QUOTA_SHARDS: '1' }, 'daily', 'a:x'), { name: 'daily', n: 1, index: 0 });
  assert.deepEqual(quotaShard({ VOICE_QUOTA_SHARDS: '1' }, 'help-messages', 'a:x'), { name: 'help-messages', n: 1, index: 0 });
  assert.equal(quotaShard({}, 'daily', 'a:x').name, 'daily');
});

test('shards: an asker always lands on the same shard, and askers spread over all of them', () => {
  const counts = new Array(8).fill(0);
  for (let i = 0; i < 4000; i++) {
    const asker = `a:account-${i}`;
    const s = quotaShard({ VOICE_QUOTA_SHARDS: '8' }, 'help-messages', asker);
    assert.equal(s.index, shardIndex(asker, 8));
    assert.equal(s.name, `help-messages:${s.index}/8`);
    assert.deepEqual(quotaShard({ VOICE_QUOTA_SHARDS: '8' }, 'help-messages', asker), s);
    counts[s.index] += 1;
  }
  for (const c of counts) assert.ok(c > 350 && c < 650, `uneven spread ${counts}`);
  assert.equal(shardIndex('anything', 1), 0);
});

test('shards: ceil(limit / N) each, so all shards together stay within the total (+ N - 1)', async () => {
  for (const [limit, n] of [[1000, 8], [400000, 8], [7, 8], [1001, 3], [1e15, 8]]) {
    const share = shareOf(limit, n);
    assert.equal(share, Math.ceil(limit / n));
    assert.ok(share * n >= limit && share * n < limit + n);
  }
  assert.equal(shareOf(1000, 1), 1000);
  // fill every shard of a real VoiceQuota: what's granted in all never passes the total + N - 1
  const ns = namespace(VoiceQuota, {});
  const limit = 1000;
  const n = 8;
  let granted = 0;
  for (let i = 0; i < 2000; i++) {
    const s = quotaShard({ VOICE_QUOTA_SHARDS: String(n) }, 'daily', `n:${i}`);
    const v = await (await ns.get(s.name).fetch('https://quota/take', {
      method: 'POST',
      body: JSON.stringify({ install: `i:${i}`, network: `n:${i}`, chars: 3, limits: { install: 1e9, network: 1e9, everyone: shareOf(limit, n) } }),
    })).json();
    if (v.ok) granted += 3;
  }
  assert.ok(granted <= limit + n - 1, `granted ${granted}`);
  assert.ok(granted > limit - 3 * n, `granted ${granted}`);
  assert.equal(ns.objects.size, n);
});

const INSTALL = 'ab'.repeat(16);
function voiceEnv(extra = {}) {
  const names = [];
  const bodies = [];
  const real = namespace(VoiceQuota, {});
  return {
    names,
    bodies,
    env: {
      FISH_API_KEY: 'owner-secret',
      VOICE_DAILY_PER_INSTALL: '300',
      VOICE_DAILY_PER_NETWORK: '500',
      VOICE_DAILY_TOTAL: '1000',
      VOICE_QUOTA: {
        idFromName: (name) => { names.push(name); return name; },
        get: (name) => ({ fetch: async (u, init) => { bodies.push(JSON.parse(init.body)); return real.get(name).fetch(u, init); } }),
      },
      ...extra,
    },
  };
}
const say = (env, text = 'Good evening.', format = 'pcm') => worker.fetch(new Request('https://askeden.com/api/voice', {
  method: 'POST',
  headers: { 'x-jarvis-install': INSTALL, 'cf-connecting-ip': '1.2.3.4' },
  body: JSON.stringify({ text, format }),
}), env);

test('voice: unset = the one "daily" object with the whole total; VOICE_QUOTA_SHARDS=8 = the network\'s shard with an eighth', async () => {
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2]), { status: 200 });
  const one = voiceEnv();
  assert.equal((await say(one.env)).status, 200);
  assert.deepEqual(one.names, ['daily']);
  assert.equal(one.bodies[0].limits.everyone, 1000);
  assert.equal(one.bodies[0].limits.install, 300);
  const eight = voiceEnv({ VOICE_QUOTA_SHARDS: '8' });
  assert.equal((await say(eight.env)).status, 200);
  assert.deepEqual(eight.names, [`daily:${shardIndex('1.2.3.4', 8)}/8`]);
  assert.equal(eight.bodies[0].limits.everyone, 125);
  assert.equal(eight.bodies[0].limits.install, 300); // per-asker caps stay whole
  assert.equal(eight.bodies[0].limits.network, 500);
});

// ── the voice backup ──

function fakeAI(calls, out = () => new Response(new Uint8Array([9, 9, 9])).body) {
  return { run: async (model, input) => { calls.push({ model, input }); return out(); } };
}

test('voice backup: off by default, so a Fish 5xx is the old 502 and Workers AI is never asked', async () => {
  globalThis.fetch = async () => new Response('down', { status: 503 });
  const calls = [];
  const { env } = voiceEnv({ AI: fakeAI(calls) });
  const r = await say(env);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /said 503/);
  assert.equal(calls.length, 0);
  // a model that isn't a Deepgram Aura one: its output format isn't known, so no backup either
  const other = voiceEnv({ AI: fakeAI(calls), VOICE_FALLBACK: '@cf/myshell-ai/melotts' });
  assert.equal((await say(other.env)).status, 502);
  assert.equal(calls.length, 0);
});

test('voice backup: Fish 5xx, 429 or unreachable → the Aura model answers in the same format', async () => {
  for (const fish of [() => new Response('x', { status: 500 }), () => new Response('x', { status: 429 }), () => { throw new TypeError('network'); }]) {
    globalThis.fetch = async () => fish();
    for (const format of ['pcm', 'wav']) {
      const calls = [];
      const { env } = voiceEnv({ AI: fakeAI(calls), VOICE_FALLBACK: '@cf/deepgram/aura-1', VOICE_FALLBACK_SPEAKER: 'helios' });
      const r = await say(env, 'Good evening.', format);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-eden-voice'), 'backup');
      assert.equal(r.headers.get('content-type'), format === 'wav' ? 'audio/wav' : 'application/octet-stream');
      assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array([9, 9, 9]));
      assert.deepEqual(calls, [{ model: '@cf/deepgram/aura-1', input: { text: 'Good evening.', encoding: 'linear16', container: format === 'wav' ? 'wav' : 'none', sample_rate: 24000, speaker: 'helios' } }]);
    }
  }
});

test('voice backup: a Fish 4xx stays the old 502; a failing backup falls back to the 502', async () => {
  const calls = [];
  globalThis.fetch = async () => new Response('bad', { status: 400 });
  const { env } = voiceEnv({ AI: fakeAI(calls), VOICE_FALLBACK: '@cf/deepgram/aura-2-en' });
  assert.equal((await say(env)).status, 502);
  assert.equal(calls.length, 0);
  globalThis.fetch = async () => new Response('x', { status: 502 });
  const broken = voiceEnv({ AI: fakeAI(calls, () => { throw new Error('AI down'); }), VOICE_FALLBACK: '@cf/deepgram/aura-2-en' });
  const r = await say(broken.env);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /said 502/);
  globalThis.fetch = async () => { throw new TypeError('network'); };
  const unreachable = await say(voiceEnv({ AI: fakeAI(calls, () => null), VOICE_FALLBACK: '@cf/deepgram/aura-2-en' }).env);
  assert.equal(unreachable.status, 502);
});

test('voice: a failed Fish answer\'s body is cancelled, with or without the backup', async () => {
  for (const [status, extra] of [[503, { VOICE_FALLBACK: '@cf/deepgram/aura-1' }], [503, {}], [400, {}]]) {
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }), { status });
    await say(voiceEnv({ AI: fakeAI([]), ...extra }).env);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(cancelled, `${status} ${JSON.stringify(extra)}`);
  }
});

// ── the 'eves-vault' index ──

// storage.list as Cloudflare sorts it: by the keys' UTF-8 bytes
class Utf8Storage extends Storage {
  constructor() {
    super();
    this.lists = 0;
  }
  async list({ prefix = '', limit } = {}) {
    if (prefix === 'v:') this.lists += 1; // the vault's lists (flags list as before)
    let rows = [...this.map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    if (limit !== undefined) rows = rows.slice(0, limit);
    return new Map(rows.map(([k, v]) => [k, structuredClone(v)]));
  }
}

test('byStorageKey sorts as UTF-8 bytes do (past U+E000 and with surrogate pairs)', () => {
  const pool = ['a', 'z', 'é', '퟿', '', '￿', '😀', '𐀀', 'v:', '0'];
  const words = [];
  for (let i = 0; i < 400; i++) words.push(Array.from({ length: 1 + (i % 4) }, (_, j) => pool[(i * 7 + j * 3) % pool.length]).join(''));
  const want = [...words].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.deepEqual([...words].sort(byStorageKey), want);
});

function desk(env) {
  const storage = new Utf8Storage();
  return { storage, object: new NewsDesk({ storage }, env) };
}
const op = async (o, name, body) => {
  const r = await o.object.fetch(new Request(`https://news/${name}`, { method: 'POST', body: JSON.stringify(body) }));
  return `${r.status} ${r.headers.get('content-type')} ${await r.text()}`;
};
const entry = (hash, createdAt, extra = {}) => ({ canonicalHash: hash, question: `q ${hash}`, fingerprint: { interrogative: 'what', entities: [hash] }, answerText: `a ${hash} é😀`, createdAt, ...extra });

test('vault index: the same bytes as the storage.list code for lookups, puts, seeds, trims and erase; no list after the first', async () => {
  const off = desk({ VAULT_INDEX: 'off' });
  const on = desk({});
  const both = async (name, body) => {
    const a = await op(off, name, body);
    const b = await op(on, name, body);
    assert.equal(b, a, `${name} ${JSON.stringify(body).slice(0, 80)}`);
    return b;
  };
  await both('vault-lookup', { canonicalHash: 'nothing' });
  await both('vault-lookup', {});
  await both('vault-put', { entry: { canonicalHash: '' } });
  await both('vault-put', {});
  for (const [i, h] of ['b', 'a', 'x', '😀', 'c', 'B', '0'].entries()) await both('vault-put', { entry: entry(h, 1000 + i) });
  await both('vault-put', { entry: entry('a', 5, { answerText: 'changed' }) }); // overwrite
  await both('vault-lookup', { canonicalHash: 'a' });
  await both('vault-lookup', { canonicalHash: 'zz' });
  await both('vault-lookup', { canonicalHash: 'x' });
  await both('vault-seed', { entries: [entry('s1', 1), null, { canonicalHash: 3 }, entry('s2', 2)] });
  await both('vault-seed', { entries: [entry('s3', 3)] }); // already seeded
  await both('vault-lookup', { canonicalHash: 'missing' });
  await both('flag-put', { flag: { id: 'f1', at: 1 } });
  await both('erase', {});
  await both('vault-lookup', { canonicalHash: 'a' });
  await both('vault-put', { entry: entry('after', 1) });
  await both('vault-lookup', {});
  assert.ok(on.storage.lists <= 2, `the index listed ${on.storage.lists} times`); // one load, one reload after erase
  assert.ok(off.storage.lists > 8);
  assert.deepEqual([...on.storage.map.keys()].sort(), [...off.storage.map.keys()].sort());
});

test('vault index: past 25,000 the same oldest entries go (ties by key order), and the whole-vault answer is the same', async () => {
  const off = desk({ VAULT_INDEX: 'off' });
  const on = desk({});
  // 25,000 seeded with many ties in createdAt, so which one is "oldest" depends on key order
  const many = Array.from({ length: 25000 }, (_, i) => ({ canonicalHash: `h${(i * 7919) % 25000}`, createdAt: 100 + (i % 50) }));
  for (const o of [off, on]) await op(o, 'vault-seed', { entries: many });
  assert.equal(await op(on, 'vault-lookup', {}), await op(off, 'vault-lookup', {}));
  const listsBefore = on.storage.lists;
  for (const [i, e] of [entry('new1', 99), entry('new2', 100), entry('new3', 5000 + 1), entry('h1', 1)].entries()) {
    assert.equal(await op(on, 'vault-put', { entry: e }), await op(off, 'vault-put', { entry: e }), `put ${i}`);
    assert.deepEqual([...on.storage.map.keys()].sort(), [...off.storage.map.keys()].sort(), `after put ${i}`);
  }
  // several over at once (a seed past the cap, then one put): the sorted path
  const extra = Array.from({ length: 300 }, (_, i) => ({ canonicalHash: `x${i}`, createdAt: i % 3 }));
  for (const o of [off, on]) await op(o, 'vault-seed', { entries: extra, force: true });
  assert.equal(await op(on, 'vault-put', { entry: entry('last', 7) }), await op(off, 'vault-put', { entry: entry('last', 7) }));
  assert.deepEqual([...on.storage.map.keys()].sort(), [...off.storage.map.keys()].sort());
  assert.equal(await op(on, 'vault-lookup', { canonicalHash: 'nope' }), await op(off, 'vault-lookup', { canonicalHash: 'nope' }));
  assert.equal(on.storage.lists, listsBefore);
});

test('vault index: a big vault\'s whole answer is built per lookup (not kept), and is the same bytes', async () => {
  assert.ok(VAULT_BODY_CHARS < VAULT_CACHE_CHARS && VAULT_CACHE_CHARS <= 16 * 1024 * 1024);
  const off = desk({ VAULT_INDEX: 'off' });
  const on = desk({});
  const pad = '“—”'.repeat(Math.ceil(VAULT_BODY_CHARS / 3 / 40)); // two-byte text, as real answers have
  const big = Array.from({ length: 41 }, (_, i) => entry(`big${i}`, i, { answerText: pad }));
  for (const o of [off, on]) await op(o, 'vault-seed', { entries: big });
  assert.equal(await op(on, 'vault-lookup', {}), await op(off, 'vault-lookup', {}));
  assert.ok(on.object.vault.chars > VAULT_BODY_CHARS && on.object.vault.json);
  assert.equal(on.object.vault.body, null);
  assert.equal(await op(on, 'vault-lookup', {}), await op(off, 'vault-lookup', {}));
  // small again: kept
  const small = desk({});
  await op(small, 'vault-put', { entry: entry('s', 1) });
  await op(small, 'vault-lookup', {});
  assert.equal(typeof small.object.vault.body, 'string');
});

test('vault index: a new object (after eviction) loads from storage and answers the same', async () => {
  const shared = new Utf8Storage();
  const first = new NewsDesk({ storage: shared }, {});
  for (const h of ['k2', 'k1', 'k3']) await first.fetch(new Request('https://news/vault-put', { method: 'POST', body: JSON.stringify({ entry: entry(h, 1) }) }));
  const again = new NewsDesk({ storage: shared }, {});
  const plain = new NewsDesk({ storage: shared }, { VAULT_INDEX: 'off' });
  const read = async (o) => (await o.fetch(new Request('https://news/vault-lookup', { method: 'POST', body: '{}' }))).text();
  assert.equal(await read(again), await read(plain));
});

// ── the News edge cache ──

function fakeCache() {
  const store = new Map();
  const cache = {
    store,
    puts: 0,
    match: async (key) => (store.has(String(key)) ? new Response(store.get(String(key)).text, { headers: store.get(String(key)).headers }) : undefined),
    put: async (key, res) => { cache.puts += 1; store.set(String(key), { text: await res.text(), headers: Object.fromEntries(res.headers) }); },
    delete: async (key) => store.delete(String(key)),
  };
  return cache;
}

test('news edge cache: keys are one for the stories and one per lower-cased query', () => {
  assert.equal(newsEdgeKey('stories'), 'https://askeden.com/__edge-cache/news/v1/stories');
  assert.equal(newsEdgeKey('search', 'Paris Weather'), newsEdgeKey('search', 'paris weather'));
  assert.notEqual(newsEdgeKey('search', 'paris'), newsEdgeKey('search', 'london'));
  assert.equal(newsEdgeKey('search', 'a&b=c d'), 'https://askeden.com/__edge-cache/news/v1/search?q=a%26b%3Dc%20d');
  assert.notEqual(newsEdgeKey('search', 'stories'), newsEdgeKey('stories'));
});

test('news edge cache: the shared stories come from the location\'s cache while fresh; stale, off or after a put: the object', async () => {
  const cache = fakeCache();
  globalThis.caches = { default: cache };
  const env = {};
  env.NEWS = namespace(NewsDesk, env);
  const calls = [];
  const real = env.NEWS.get;
  env.NEWS.get = (name) => { const s = real(name); return { fetch: (u, init) => { calls.push(new URL(u).pathname); return s.fetch(u, init); } }; };
  const now = Date.now();
  assert.deepEqual(await getStories(env, now), { stale: true });
  assert.equal(cache.puts, 0); // a stale answer is never kept
  await putStories(env, { stories: [{ id: 's1', title: 'One' }], provider: 'rss', sample: false, fetchedAt: now });
  calls.length = 0;
  const first = await getStories(env, now + 1000);
  const second = await getStories(env, now + 2000);
  assert.deepEqual(second, first);
  assert.deepEqual(first.stories, [{ id: 's1', title: 'One' }]);
  assert.deepEqual(calls, ['/stories-get']); // the second came from the cache
  // past the object's own 10 minutes the kept copy isn't used
  calls.length = 0;
  assert.deepEqual(await getStories(env, now + 11 * 60e3), { stale: true });
  assert.deepEqual(calls, ['/stories-get']);
  // a put clears this location's copy
  await putStories(env, { stories: [{ id: 's2', title: 'Two' }], provider: 'rss', sample: false, fetchedAt: now + 5000 });
  assert.deepEqual((await getStories(env, now + 6000)).stories, [{ id: 's2', title: 'Two' }]);
  // NEWS_EDGE_CACHE=off: the object every time
  calls.length = 0;
  env.NEWS_EDGE_CACHE = 'off';
  await getStories(env, now + 7000);
  await getStories(env, now + 7000);
  assert.deepEqual(calls, ['/stories-get', '/stories-get']);
});

test('news edge cache: a query\'s search is kept per query, only while fresh', async () => {
  globalThis.caches = { default: fakeCache() };
  const env = {};
  env.NEWS = namespace(NewsDesk, env);
  const now = Date.now();
  await env.NEWS.get('stories').fetch('https://news/search-put', { method: 'POST', body: JSON.stringify({ query: 'Paris', articles: [{ url: 'u1' }], at: now }) });
  const hit = await getSearch(env, 'paris', now + 1000);
  assert.deepEqual(hit.articles, [{ url: 'u1' }]);
  assert.ok(globalThis.caches.default.store.has(newsEdgeKey('search', 'PARIS')));
  assert.deepEqual(await getSearch(env, 'london', now), { stale: true });
  assert.ok(!globalThis.caches.default.store.has(newsEdgeKey('search', 'london')));
  assert.deepEqual(await getSearch(env, 'paris', now + 21 * 60e3), { stale: true });
});

// ── D1 sessions ──

test('D1 vault reads: a "first-unconstrained" session when supported; plain without withSession or with D1_SESSIONS=off', () => {
  const seen = [];
  const session = { prepare: () => 'session' };
  const db = { prepare: () => 'plain', withSession: (c) => { seen.push(c); return session; } };
  assert.equal(vaultReader({ EVES_VAULT_DB: db }), session);
  assert.deepEqual(seen, ['first-unconstrained']);
  assert.equal(vaultReader({ EVES_VAULT_DB: db, D1_SESSIONS: 'off' }), db);
  const old = { prepare: () => 'plain' };
  assert.equal(vaultReader({ EVES_VAULT_DB: old }), old);
  const broken = { prepare: () => 'plain', withSession: () => { throw new Error('nope'); } };
  assert.equal(vaultReader({ EVES_VAULT_DB: broken }), broken);
});
