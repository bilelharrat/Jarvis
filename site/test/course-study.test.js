// Eden for Education, study features (askeden ROADMAP Q7, Q8; src/edu/course.js): chapter scope enforced in
// retrieval, "Explain this page" grounded on that page, exam plans and their day's pages, and each
// student's spaced-repetition schedule and streak (private, gone when they leave or are removed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Course, bumpStreak, cleanScope, courseBlock, courseForTurn, coursesApi, weekOf } from '../src/edu/course.js';
import { namespace } from './fakes.js';

const PROF = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';

function setup() {
  const env = {};
  env.COURSES = namespace(Course, env);
  const deps = {
    call: async (_env, _account, op) => (op === 'get' ? { identities: [{ provider: 'google', email: 'a@state.edu' }] } : {}),
    limited: async () => {},
    readBody: async (request) => JSON.parse((await request.text()) || '{}'),
  };
  const api = (account, method, path, body) =>
    coursesApi(new Request(`https://askeden.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), env, { account }, path.split('?')[0], deps);
  return { env, api };
}

const WEEK1 = { name: 'Week 1 · Cells', kind: 'slides', parts: [
  { loc: 'slide 1', text: 'The cell membrane is a phospholipid bilayer that controls what enters and leaves the cell.' },
  { loc: 'slide 2', text: 'Osmosis is the movement of water across a semipermeable membrane toward higher solute concentration.' },
  { loc: 'slide 3', text: 'Active transport uses ATP to move ions against their concentration gradient, as the sodium potassium pump does.' },
] };
const WEEK5 = { name: 'Week 5 · Respiration', kind: 'slides', parts: [
  { loc: 'slide 1', text: 'At complex IV oxygen is the final electron acceptor and combines with protons to form water.' },
  { loc: 'slide 2', text: 'Glycolysis splits glucose into two pyruvate and makes a net gain of two ATP without oxygen.' },
] };

async function course() {
  const t = setup();
  const made = await t.api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  const w1 = (await t.api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, WEEK1)).doc;
  const w5 = (await t.api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, WEEK5)).doc;
  await t.api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  return { ...t, id: made.id, w1, w5 };
}

test('weeks from file names; scopes are cleaned', () => {
  assert.equal(weekOf('Week 3 slides'), 3);
  assert.equal(weekOf('BIO wk04 – enzymes'), 4);
  assert.equal(weekOf('W5 Respiration'), 5);
  assert.equal(weekOf('Lecture 5'), null);
  assert.equal(weekOf('Software 2.0'), null);
  assert.equal(cleanScope({ picks: [], upto: '' }), null);
  assert.deepEqual(cleanScope({ picks: [{ doc: 'abcdefghijkl', from: 2, to: 1 }, { doc: 'x' }], upto: 3 }), { picks: [{ doc: 'abcdefghijkl', from: 2 }], upto: 3 });
  assert.throws(() => cleanScope({ upto: 99 }), /week/);
});

test('chapter scope: the professor limits Eden for students, enforced in retrieval', async () => {
  const { env, api, id, w1, w5 } = await course();
  const view = await api(PROF, 'GET', `/api/chat/courses/${id}`);
  assert.deepEqual(view.docs.map((d) => d.week), [1, 5]);
  assert.ok((await courseForTurn(env, { account: STUDENT }, id, 'oxygen final electron acceptor')).passages.some((p) => p.doc === w5));

  // up to week 3: week 5's slides are out of reach for students, not for staff
  await api(PROF, 'POST', `/api/chat/courses/${id}`, { scope: { upto: 3 } });
  const turn = await courseForTurn(env, { account: STUDENT }, id, 'oxygen final electron acceptor');
  assert.ok(turn.passages.every((p) => p.doc !== w5));
  assert.match(turn.block, /limited study help in this course to: material up to week 3/);
  assert.ok((await courseForTurn(env, { account: PROF }, id, 'oxygen final electron acceptor')).passages.some((p) => p.doc === w5));
  const sv = await api(STUDENT, 'GET', `/api/chat/courses/${id}`);
  assert.equal(sv.scope, undefined);
  assert.equal(sv.scoped, 'material up to week 3');
  // a quiz on the whole course stays inside the scope too
  for (let i = 0; i < 5; i++) assert.ok((await courseForTurn(env, { account: STUDENT }, id, '', { task: 'quiz' })).passages.every((p) => p.doc === w1));

  // chosen files and chapters: only slides 2–3 of week 1
  await api(PROF, 'POST', `/api/chat/courses/${id}`, { scope: { picks: [{ doc: w1, from: 1, to: 2 }], upto: null } });
  const t2 = await courseForTurn(env, { account: STUDENT }, id, 'cell membrane phospholipid bilayer osmosis');
  assert.deepEqual(t2.passages.map((p) => p.loc).sort(), ['slide 2']);
  const outline = await api(STUDENT, 'GET', `/api/chat/courses/${id}/outline`);
  assert.deepEqual(outline.docs.map((d) => [d.id, d.parts]), [[w1, [null, 'slide 2', 'slide 3']]]);
  assert.equal((await api(PROF, 'GET', `/api/chat/courses/${id}/outline`)).docs.length, 2);
  // week of a file can be set by the professor; students can't change scope
  await api(PROF, 'POST', `/api/chat/courses/${id}/docs/${w5}`, { week: 2 });
  assert.equal((await api(PROF, 'GET', `/api/chat/courses/${id}`)).docs[1].week, 2);
  await assert.rejects(api(PROF, 'POST', `/api/chat/courses/${id}/docs/${w5}`, { week: 'soon' }), { status: 400 });
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${id}`, { scope: null }), { status: 403 });
  await api(PROF, 'POST', `/api/chat/courses/${id}`, { scope: null });
  assert.equal((await api(STUDENT, 'GET', `/api/chat/courses/${id}`)).scoped, null);
  assert.doesNotMatch(courseBlock({ name: 'x', mode: 'fallback' }, []), /limited/);
});

test('Explain this page: that page comes first, even when the question’s words match others better', async () => {
  const { env, id, w1, w5 } = await course();
  const turn = await courseForTurn(env, { account: STUDENT }, id, 'Explain slide 1 of “Week 1 · Cells” step by step', { focus: { doc: w1, loc: 'slide 1' } });
  assert.deepEqual([turn.passages[0].doc, turn.passages[0].loc], [w1, 'slide 1']);
  assert.equal(turn.passages.filter((p) => p.doc === w1 && p.loc === 'slide 1').length, 1);
  // a page that isn't there (or the student can't see) isn't put in
  const hidden = await courseForTurn(env, { account: STUDENT }, id, 'explain', { focus: { doc: w5, loc: 'slide 9' } });
  assert.ok(hidden.passages.every((p) => p.loc !== 'slide 9'));
});

test('an exam plan’s quiz: questions only from the day’s pages; exams the professor sets; the plan is private', async () => {
  const { env, api, id, w1, w5 } = await course();
  const turn = await courseForTurn(env, { account: STUDENT }, id, '', { task: 'quiz', ranges: [{ doc: w1, from: 1, to: 2 }] });
  assert.deepEqual(turn.passages.map((p) => `${p.doc}:${p.loc}`).sort(), [`${w1}:slide 2`, `${w1}:slide 3`]);
  await api(PROF, 'POST', `/api/chat/courses/${id}`, { exams: [{ title: 'Midterm', date: '2026-11-02', picks: [{ doc: w1 }, { doc: w5 }] }, { title: 'bad', date: 'soon' }] });
  const v = await api(STUDENT, 'GET', `/api/chat/courses/${id}`);
  assert.deepEqual(v.exams.map((e) => [e.title, e.date, e.picks.length]), [['Midterm', '2026-11-02', 2]]);
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${id}`, { exams: [] }), { status: 403 });

  const plan = { exam: '2026-11-02', title: 'Midterm', picks: [{ doc: w1 }], created: 1, days: [{ date: '2026-10-30', read: [{ doc: w1, name: 'Week 1', from: 0, to: 2, fromLoc: 'slide 1', toLoc: 'slide 3' }], review: false, done: false }, { date: '2026-10-31', read: [], review: false, rest: true, kind: 'rest', done: false }, { date: '2026-11-01', read: [], review: true, kind: 'practice', done: false }, { date: '2026-11-02', read: [], review: true, kind: '<b>', done: false }] };
  assert.equal((await api(STUDENT, 'GET', `/api/chat/courses/${id}/plan`)).plan, null);
  await api(STUDENT, 'POST', `/api/chat/courses/${id}/plan`, { plan });
  const kept = (await api(STUDENT, 'GET', `/api/chat/courses/${id}/plan`)).plan;
  assert.equal(kept.days[0].read[0].toLoc, 'slide 3');
  assert.deepEqual(kept.days.slice(1).map((d) => [d.kind ?? null, d.rest ?? false, d.review]), [['rest', true, false], ['practice', false, true], [null, false, true]], 'a review day’s kind is kept (and only a known one)');
  assert.equal((await api(PROF, 'GET', `/api/chat/courses/${id}/plan`)).plan, null, 'each member has their own');
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${id}/plan`, { plan: { exam: 'x' } }), { status: 400 });
  await api(STUDENT, 'POST', `/api/chat/courses/${id}/plan/delete`);
  assert.equal((await api(STUDENT, 'GET', `/api/chat/courses/${id}/plan`)).plan, null);
});

test('spaced repetition: card states per student, later review wins, a streak; gone on leave and remove', async () => {
  const { api, id } = await course();
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const st = (last, s = 3.7) => ({ s, d: 5, due: last + 4 * 864e5, last, reps: 1, lapses: 0, first: last });
  let r = await api(STUDENT, 'POST', `/api/chat/courses/${id}/reviews`, { set: 'mabc123', cards: { k1: st(now), k2: st(now), 'BAD!': st(now), k3: { s: 'x' } }, day: today });
  assert.deepEqual(r.streak, { last: today, count: 1, best: 1 });
  await api(STUDENT, 'POST', `/api/chat/courses/${id}/reviews`, { set: 'mabc123', cards: { k1: st(now - 1000, 99) } }); // an older copy from another device
  const list = await api(STUDENT, 'GET', `/api/chat/courses/${id}/reviews`);
  assert.deepEqual(Object.keys(list.sets.mabc123).sort(), ['k1', 'k2']);
  assert.equal(list.sets.mabc123.k1.s, 3.7);
  assert.deepEqual((await api(PROF, 'GET', `/api/chat/courses/${id}/reviews`)).sets, {}, 'private to each student');
  // a day far from the server's isn't counted
  r = await api(STUDENT, 'POST', `/api/chat/courses/${id}/reviews`, { set: 'mabc123', cards: {}, day: '2020-01-01' });
  assert.equal(r.streak.last, today);
  await api(STUDENT, 'POST', `/api/chat/courses/${id}/reviews/mabc123/delete`);
  assert.deepEqual((await api(STUDENT, 'GET', `/api/chat/courses/${id}/reviews`)).sets, {});

  // leaving drops the schedule, the streak and the plan
  await api(STUDENT, 'POST', `/api/chat/courses/${id}/reviews`, { set: 'mabc123', cards: { k1: st(now) }, day: today });
  await api(STUDENT, 'POST', `/api/chat/courses/${id}/plan`, { plan: { exam: '2026-11-02', days: [] } });
  await api(STUDENT, 'POST', `/api/chat/courses/${id}/leave`);
  const v = await api(PROF, 'GET', `/api/chat/courses/${id}`);
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: v.code });
  const back = await api(STUDENT, 'GET', `/api/chat/courses/${id}/reviews`);
  assert.deepEqual(back, { sets: {}, streak: null });
  assert.equal((await api(STUDENT, 'GET', `/api/chat/courses/${id}/plan`)).plan, null);

  // removed by the professor: the same
  await api(OTHER, 'POST', '/api/chat/courses/join', { age13: true, code: v.code });
  await api(OTHER, 'POST', `/api/chat/courses/${id}/reviews`, { set: 'mabc123', cards: { k1: st(now) }, day: today });
  const m = (await api(PROF, 'GET', `/api/chat/courses/${id}/members`)).members.find((x) => x.role === 'student' && !x.you && x.label);
  for (const x of (await api(PROF, 'GET', `/api/chat/courses/${id}/members`)).members.filter((y) => y.role === 'student')) await api(PROF, 'POST', `/api/chat/courses/${id}/members/${x.id}/remove`);
  assert.ok(m);
  await api(OTHER, 'POST', '/api/chat/courses/join', { age13: true, code: v.code });
  assert.deepEqual(await api(OTHER, 'GET', `/api/chat/courses/${id}/reviews`), { sets: {}, streak: null });
});

test('the server’s streak rule matches the page’s', () => {
  let s = bumpStreak(null, '2026-02-28');
  s = bumpStreak(s, '2026-03-01');
  assert.deepEqual(s, { last: '2026-03-01', count: 2, best: 2 });
  assert.deepEqual(bumpStreak(s, '2026-03-03'), { last: '2026-03-03', count: 1, best: 2 });
});
