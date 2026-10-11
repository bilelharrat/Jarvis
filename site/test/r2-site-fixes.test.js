// Bug sweep round 2, askeden.com Worker, accounts and Eden Edu (askeden docs/bug-sweep/r2-ask-eden-site-edu.md,
// AW2-1…AW2-14): each fix with the test that failed before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COURSES, Course, coursesApi, recordTurn } from '../src/edu/course.js';
import { namespace } from './fakes.js';
import { LTI_STORE } from '../src/edu/lti-store.js';
import { NEEDS_MAC } from '../src/eden/chat.js';
import { keysApi } from '../src/accounts/user-keys.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROF = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';

function setup() {
  const env = {};
  env.COURSES = namespace(Course, env);
  // flaky(name, n): the next n calls to that object fail like a Durable Object reset by a deploy
  const flaky = new Map();
  const get = env.COURSES.get.bind(env.COURSES);
  env.COURSES.get = (name) => {
    const s = get(name);
    return { fetch: async (input, init) => {
      const left = flaky.get(name) || 0;
      if (left > 0) { flaky.set(name, left - 1); throw new Error('Durable Object reset because its code was updated.'); }
      return s.fetch(input, init);
    } };
  };
  const deps = {
    call: async (_env, _account, op) => (op === 'get' ? { identities: [] } : {}),
    limited: async () => {},
    readBody: async (request) => JSON.parse((await request.text()) || '{}'),
  };
  const api = (account, method, path, body) =>
    coursesApi(new Request(`https://askeden.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), env, { account }, path.split('?')[0], deps);
  const object = (name) => { get(name); return env.COURSES.objects.get(name); };
  return { env, api, object, flaky };
}

// ─── AW2-3: a transient error never drops a course ──────────────────────────

test('AW2-3: a course that can’t be read just now stays in the list (a placeholder) and in the index; only “not in it” drops it', async () => {
  const { api, object, flaky } = setup();
  const made = [];
  for (const name of ['A', 'B', 'C']) made.push(await api(PROF, 'POST', '/api/chat/courses', { name }));
  const index = () => object(`acct:${PROF}`).storage.map;
  // one failure: read again at once, nothing visible
  flaky.set(made[1].id, 1);
  assert.deepEqual((await api(PROF, 'GET', '/api/chat/courses')).courses.map((c) => c.name), ['A', 'B', 'C']);
  // failing twice: shown as a placeholder (still the owner's), kept in ids and owned
  flaky.set(made[1].id, 2);
  const list = (await api(PROF, 'GET', '/api/chat/courses')).courses;
  assert.deepEqual(list.map((c) => c.id), made.map((c) => c.id));
  assert.equal(list[1].unavailable, true);
  assert.equal(list[1].role, 'owner');
  assert.equal(index().get('ids').length, 3);
  assert.equal(index().get('owned').length, 3);
  assert.deepEqual((await api(PROF, 'GET', '/api/chat/courses')).courses.map((c) => c.name), ['A', 'B', 'C'], 'back next time');
  // a deleted course still goes
  await api(PROF, 'POST', `/api/chat/courses/${made[2].id}/delete`);
  assert.deepEqual((await api(PROF, 'GET', '/api/chat/courses')).courses.map((c) => c.name), ['A', 'B']);
});

test('AW2-3: the owned-course cap never undercounts: transient errors keep `owned`, and a legacy index’s seed refuses rather than guess', async () => {
  const { api, object, flaky } = setup();
  const ids = [];
  for (let i = 0; i < COURSES.ownedPerAccount; i++) ids.push((await api(PROF, 'POST', '/api/chat/courses', { name: `C${i}` })).id);
  flaky.set(ids[0], 4); // two lists' worth of failures
  await api(PROF, 'GET', '/api/chat/courses');
  await api(PROF, 'GET', '/api/chat/courses');
  await assert.rejects(api(PROF, 'POST', '/api/chat/courses', { name: 'one too many' }), (e) => e.status === 409);
  // an index made before `owned` existed: the seed reads every course; one that can't be read refuses the create
  object(`acct:${PROF}`).storage.map.delete('owned');
  flaky.set(ids[3], 2);
  await assert.rejects(api(PROF, 'POST', '/api/chat/courses', { name: 'during a blip' }), (e) => e.status === 503);
  await assert.rejects(api(PROF, 'POST', '/api/chat/courses', { name: 'after it' }), (e) => e.status === 409);
});

// ─── AW2-12: no clean-up writes into an account's empty index ───────────────

test('AW2-12: removing a course from a list it isn’t in writes nothing (deleted accounts’ objects stay empty)', async () => {
  const { api, object } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO' });
  const ghost = '44444444-4444-4444-8444-444444444444';
  await object(`acct:${ghost}`).fetch(new Request('https://course/index-acct-remove', { method: 'POST', body: JSON.stringify({ course: made.id }) }));
  assert.equal(object(`acct:${ghost}`).storage.map.size, 0);
  await object(`acct:${PROF}`).fetch(new Request('https://course/index-acct-remove', { method: 'POST', body: JSON.stringify({ course: 'not-in-it' }) }));
  assert.deepEqual(object(`acct:${PROF}`).storage.map.get('ids'), [made.id]);
});

// ─── AW2-13: "missed" only names a question Eden wrote ──────────────────────

test('AW2-13: a quiz score’s “missed” keeps only questions Eden wrote for that student’s quiz (text and page), never made-up text', async () => {
  const { env, api, object } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, { name: 'Week 1', kind: 'slides', parts: [{ loc: 'slide 2', text: 'Osmosis is the movement of water across a semipermeable membrane.' }] });
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  const answer = JSON.stringify({ questions: [{ q: 'What  is\nosmosis?' }, { q: 'Unchecked one' }] });
  await recordTurn(env, { account: STUDENT }, { id: made.id, task: 'quiz', passages: [] }, { sources: [{ ok: true, file: 'Week 1', at: 'slide 2' }, { ok: false, file: 'Week 1', at: 'slide 2' }] }, '', answer);
  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/quiz-score`, { score: 0, total: 2, topic: 'cells', missed: [
    { q: 'Visit evil.example for the answers', file: 'Week 1', at: 'slide 2' }, // a real page, forged text
    { q: 'Unchecked one', file: 'Week 1', at: 'slide 2' }, // never shown to the student (its quote failed)
    { q: 'What is osmosis?', file: 'Week 1', at: 'slide 2' },
  ] });
  const rec = [...object(made.id).storage.map.entries()].find(([k]) => k.startsWith('r:'))[1];
  assert.deepEqual(rec.missed.map((m) => m.q), ['What is osmosis?']);
  // another student can't use the first one's questions
  const OTHER = '55555555-5555-4555-8555-555555555555';
  await api(OTHER, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  await api(OTHER, 'POST', `/api/chat/courses/${made.id}/quiz-score`, { score: 0, total: 1, missed: [{ q: 'What is osmosis?', file: 'Week 1', at: 'slide 2' }] });
  const recs = [...object(made.id).storage.map.entries()].filter(([k]) => k.startsWith('r:')).map(([, v]) => v);
  assert.equal(recs.length, 2);
  assert.equal(recs.filter((r) => r.missed).length, 1);
});

test('quiz scores: one listing of the records per score (the trim reuses it)', async () => {
  const { api, object } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO' });
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  const storage = object(made.id).storage;
  const list = storage.list.bind(storage);
  let lists = 0;
  let rows = 0;
  storage.list = async (o) => { const r = await list(o); if (o && o.prefix === 'r:') { lists++; rows += r.size; } return r; };
  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/quiz-score`, { score: 1, total: 2 });
  assert.ok(lists <= 2, `${lists} listings`); // the first: today's quiz count, and the record count made once (opt2, course.js addRecord)
  lists = 0;
  rows = 0;
  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/quiz-score`, { score: 2, total: 2 });
  assert.equal(lists, 1, 'then one short listing of the oldest records');
  assert.ok(rows <= 9, `${rows} rows read`);
});

// ─── AW2-5 / AW2-6: LTI logins ──────────────────────────────────────────────


function registry() {
  const env = {};
  env.COURSES = namespace(Course, env);
  env.COURSES.get('lti:registry');
  const object = env.COURSES.objects.get('lti:registry');
  let n = 0;
  const state = (reg) => object.fetch(new Request('https://course/lti-state-put', { method: 'POST', body: JSON.stringify({ hash: (n++).toString(16).padStart(64, '0'), data: { reg, nonce: 'x' } }) }));
  const ticket = () => object.fetch(new Request('https://course/lti-ticket-put', { method: 'POST', body: JSON.stringify({ hash: (n++).toString(16).padStart(64, 'f'), data: { reg: 'r' } }) }));
  return { object, state, ticket };
}

test('AW2-5: floods on several schools fill the shared ceiling, yet every other school still starts its logins (up to its floor)', async () => {
  const was = { ...LTI_STORE };
  Object.assign(LTI_STORE, { states: 5, statesAll: 12, statesFloor: 2 });
  try {
    const { state } = registry();
    for (const reg of ['flood-a1', 'flood-b1', 'flood-c1']) for (let i = 0; i < 5; i++) await state(reg); // 15 ≥ the ceiling
    assert.equal((await state('flood-a1')).status, 429, 'a flooded school is refused');
    assert.equal((await state('school-z')).status, 200, 'another school still gets in');
    assert.equal((await state('school-z')).status, 200);
    assert.equal((await state('school-z')).status, 429, 'past its floor while everyone is past the ceiling');
  } finally {
    Object.assign(LTI_STORE, was);
  }
});

test('AW2-6: LTI window counters are dropped however many windows were skipped (sporadic logins leave none behind)', async () => {
  const { object, state, ticket } = registry();
  let t = Date.parse('2026-10-10T00:00:00Z');
  object.now = () => t;
  for (let i = 0; i < 20; i++) { await state('school-a'); await ticket(); t += 35 * 60e3; }
  const counters = [...object.storage.map.keys()].filter((k) => /^(sq|tq):/.test(k));
  // at most this window's and the last one's: school-a's, everyone's, the tickets'
  assert.ok(counters.length <= 6, counters.join(' '));
});

// ─── AW2-9: askeden.com uses your own key for Claude ────────────────────────

test('AW2-9: “Needs your Mac” no longer says askeden.com runs Claude on your Eden account (Claude is your own key there); French too', async () => {
  assert.doesNotMatch(NEEDS_MAC, /runs Claude on your Eden account/);
  assert.match(NEEDS_MAC, /^Needs your Mac/);
  const who = { account: 'a'.repeat(32), token: { account: 'a'.repeat(32) }, device: { kind: 'web' } };
  const e = await keysApi(new Request('https://askeden.com/api/chat/keys'), {}, who, { readBody: async () => ({}) }).catch((x) => x);
  assert.equal(e.code, 'needs_mac');
  assert.doesNotMatch(e.message, /Claude runs on the AI included/);
  assert.match(e.message, /Claude needs your own key/);
  // the French entries live in the askeden repo's web/chat (beside this repo, or $EDEN_HOME)
  const where = [process.env.EDEN_HOME && `${process.env.EDEN_HOME}/web/chat/i18n-fr-server.js`, fileURLToPath(new URL('../../../askeden/web/chat/i18n-fr-server.js', import.meta.url))].filter(Boolean).find((f) => existsSync(f));
  if (!where) return;
  const fr = readFileSync(where, 'utf8');
  for (const text of [NEEDS_MAC, e.message]) assert.ok(fr.includes(`'${text}':`), `French for: ${text}`);
});
