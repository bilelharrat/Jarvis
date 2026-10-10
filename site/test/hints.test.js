// Q10 hint mode for graded work (src/edu/hints.js, course.js assignments) and Q11 the professor's
// weekly summary (src/edu/weekly.js, course.js `weekly`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Course, courseForTurn, coursesApi, recordTurn } from '../src/edu/course.js';
import { HINT_STYLE, STRUCK, hintStream, locNumber, matchAssignment, parsePages, strikeAnswers, workIntent } from '../src/edu/hints.js';
import { weeklySummary, whereOf } from '../src/edu/weekly.js';
import { namespace } from './fakes.js';

const PROF = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';
const S3 = '44444444-4444-4444-8444-444444444444';

function setup() {
  const env = {};
  env.COURSES = namespace(Course, env);
  const deps = {
    call: async (_env, _account, op) => (op === 'get' ? { identities: [{ provider: 'google', email: 'prof@state.edu' }] } : {}),
    limited: async () => {},
    readBody: async (request) => JSON.parse((await request.text()) || '{}'),
  };
  const api = (account, method, path, body) =>
    coursesApi(new Request(`https://askeden.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), env, { account }, path.split('?')[0], deps);
  return { env, api };
}

const PHYSICS = {
  name: 'Lecture 3 · Kinematics', kind: 'slides',
  parts: [
    { loc: 'slide 2', text: 'Velocity is the rate of change of position. Average velocity is displacement divided by elapsed time.' },
    { loc: 'slide 7', text: 'For constant acceleration, v = v0 + a t and x = x0 + v0 t + one half a t squared.' },
    { loc: 'slide 14', text: 'Projectile motion: horizontal velocity stays constant while vertical motion has constant acceleration g downward.' },
  ],
};

test('pages, page numbers and the classifier', () => {
  assert.deepEqual(parsePages('3-9, 12, 20–22'), [[3, 9], [12, 12], [20, 22]]);
  assert.equal(parsePages(''), null);
  assert.equal(parsePages('all'), null);
  assert.equal(locNumber('slide 14'), 14);
  assert.equal(locNumber('ch. 2 · p. 41'), 41);
  assert.equal(locNumber('section'), null);
  assert.ok(workIntent('Solve problem 3 for me'));
  assert.ok(workIntent('a ball is thrown at 20 m/s, what is the answer to part (b)?'));
  assert.ok(workIntent('is 3x + 2 = 11 right?'));
  assert.ok(workIntent('check my answer for question 2'));
  assert.ok(!workIntent('What is projectile motion?'));
  assert.ok(!workIntent('explain velocity like I am five'));
});

test('the post-check strikes stated final answers, boxed results and long solution code, not hints or checks', () => {
  const strike = (t) => strikeAnswers(t).struck;
  for (const s of ['So x = 5.', 'The answer is 42.', '**Final answer:** 7.5 m/s', 'Therefore, the derivative is f\'(x) = 6x + 2.', 'Thus the speed is 12 m/s.', 'We get $\\boxed{12}$.', 'Hence the integral equals 1/3.']) assert.equal(strike(s), 1, s);
  for (const s of ['What do you get when you subtract 3 from both sides?', 'Your answer is correct! Step 2 is right.', 'The answer is not quite right: check the sign in step 3.', 'So the next step is to factor it. What multiplies to 6?', 'Good. So now you have 2x = 10. What next?', 'Thus the key idea is conservation of energy.']) assert.equal(strike(s), 0, s);
  const mixed = strikeAnswers('Use v = v0 + a t [1]. Plug in what you know. So v = 29.4 m/s.\n\n<sources>\n[1] S2 "v = v0 + a t"\n</sources>');
  assert.equal(mixed.struck, 1);
  assert.match(mixed.text, /^Use v = v0 \+ a t \[1\]\. Plug in what you know\. ~~\[Final answer removed/);
  assert.match(mixed.text, /<sources>\n\[1\] S2 "v = v0 \+ a t"/, 'the sources block is left alone');
  const code = `Here is the idea.\n\n\`\`\`python\n${Array.from({ length: 14 }, (_, i) => `line_${i} = ${i}`).join('\n')}\n\`\`\`\n\nTry it.`;
  const c = strikeAnswers(code);
  assert.equal(c.struck, 1);
  assert.ok(!c.text.includes('line_3'));
  assert.equal(strikeAnswers('```python\nfor i in range(3):\n    print(i)\n```').struck, 0, 'a short example stays');
});

test('the streaming striker passes checked paragraphs on as they finish, code blocks whole', () => {
  const out = [];
  const h = hintStream((t) => out.push(t));
  for (const piece of ['Think about ', 'the sign.\n\nSo x', ' = 5.\n\n```py\nprint(1)\n', '\n```\nWhat did you get?']) h.push(piece);
  assert.equal(out.length, 1, 'only the finished first paragraph so far');
  assert.equal(out[0], 'Think about the sign.\n\n');
  const end = h.end();
  assert.equal(end.struck, 1);
  assert.equal(out.join(''), end.text);
  assert.ok(!end.text.includes('x = 5'));
  assert.match(end.text, /```py\nprint\(1\)\n\n```\nWhat did you get\?$/);
});

test('matching: pasted text, the name, the classifier with retrieval overlap; not for concepts or after the late window', () => {
  const now = Date.UTC(2026, 9, 9);
  const a = { id: 'a1aaaaaaaa', name: 'Problem Set 2', graded: true, due: now + 3 * 864e5, files: [{ doc: 'docphys1', pages: [[7, 14]] }], text: 'A ball is thrown horizontally from a 20 m cliff at 15 m/s. How long until it lands, and how far from the base?' };
  const passages = [{ doc: 'docphys1', loc: 'slide 14' }, { doc: 'docphys1', loc: 'slide 2' }];
  assert.equal(matchAssignment([a], 'a ball is thrown horizontally from a 20 m cliff, how far does it go', [], now).why, 'pasted');
  assert.equal(matchAssignment([a], 'can you help with problem set 2', [], now).why, 'named');
  assert.equal(matchAssignment([a], 'solve this projectile question for me', passages, now).why, 'intent');
  assert.equal(matchAssignment([a], 'What is projectile motion?', passages, now), null, 'a concept question about the same slide is answered normally');
  assert.equal(matchAssignment([a], 'solve this velocity question', [{ doc: 'docphys1', loc: 'slide 2' }], now), null, 'outside the assignment’s pages');
  assert.equal(matchAssignment([{ ...a, graded: false }], 'can you help with problem set 2', [], now), null);
  assert.equal(matchAssignment([a], 'can you help with problem set 2', [], a.due + 15 * 864e5), null, 'two weeks after the due date it ends');
  assert.match(HINT_STYLE, /Never give the final answer/);
});

test('assignments: staff add and list them; students see names and due dates; a matching question gets hint mode and is counted', async () => {
  const { env, api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'PHYS 101' });
  const withDoc = await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, PHYSICS);
  const doc = withDoc.docs[0].id;
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}/assignments`, { name: 'x', files: [{ doc }] }), { status: 403 });
  await assert.rejects(api(PROF, 'POST', `/api/chat/courses/${made.id}/assignments`, { name: 'Empty' }), { status: 400 });
  const a = await api(PROF, 'POST', `/api/chat/courses/${made.id}/assignments`, { name: 'Problem Set 2', due: Date.now() + 864e5, graded: true, files: [{ doc, pages: '7-14' }, { doc: 'nosuchdoc1' }], text: 'A ball is thrown horizontally from a cliff.' });
  assert.equal(a.files.length, 1, 'only the course’s own files');
  assert.equal(a.files[0].pages, '7–14');
  const forStudent = await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/assignments`);
  assert.equal(forStudent.assignments[0].name, 'Problem Set 2');
  assert.equal(forStudent.assignments[0].text, undefined, 'students don’t get the pasted questions');

  const turn = await courseForTurn(env, { account: STUDENT }, made.id, 'solve the projectile motion problem for me: horizontal velocity 15 m/s');
  assert.equal(turn.hint.name, 'Problem Set 2');
  assert.match(turn.block, /HINT MODE[\s\S]*Problem Set 2/);
  const concept = await courseForTurn(env, { account: STUDENT }, made.id, 'what is velocity?');
  assert.equal(concept.hint, undefined);
  assert.doesNotMatch(concept.block, /HINT MODE/);
  const prof = await courseForTurn(env, { account: PROF }, made.id, 'solve the projectile motion problem for me');
  assert.equal(prof.hint, undefined, 'staff are never in hint mode');
  const quiz = await courseForTurn(env, { account: STUDENT }, made.id, 'projectile', { task: 'quiz' });
  assert.equal(quiz.hint, undefined);

  await recordTurn(env, { account: STUDENT }, turn, { status: 'verified' }, 'q');
  const ins = await api(PROF, 'GET', `/api/chat/courses/${made.id}/insights`);
  assert.deepEqual(ins.hints, [{ id: a.id, name: 'Problem Set 2', n: 1, students: 1 }]);
  assert.ok(!JSON.stringify(ins).includes(STUDENT));

  await api(PROF, 'POST', `/api/chat/courses/${made.id}/assignments`, { id: a.id, name: 'Problem Set 2', graded: false, files: [{ doc }] });
  assert.equal((await courseForTurn(env, { account: STUDENT }, made.id, 'solve the projectile motion problem for me')).hint, undefined, 'not graded: normal answers');
  assert.deepEqual((await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/assignments`)).assignments, [], 'students only see active graded ones');
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/assignments/${a.id}/delete`);
  assert.deepEqual((await api(PROF, 'GET', `/api/chat/courses/${made.id}/assignments`)).assignments, []);
});

test('the weekly summary: top confusions with their pages and fixes, gaps only from 3+ students, hint use; staff only', async () => {
  const { env, api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'PHYS 101' });
  const withDoc = await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, PHYSICS);
  for (const s of [STUDENT, S2, S3]) await api(s, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  const t = await courseForTurn(env, { account: STUDENT }, made.id, 'projectile horizontal velocity constant');
  for (const s of [STUDENT, S2, S3]) {
    await recordTurn(env, { account: s }, t, { status: 'partial' }, 'q');
    await recordTurn(env, { account: s }, t, { status: 'general' }, 'What is air resistance?');
    await api(s, 'POST', `/api/chat/courses/${made.id}/quiz-score`, { score: 1, total: 3, topic: 'projectiles', missed: [{ q: 'Which velocity stays constant?', file: PHYSICS.name, at: 'slide 14' }, { q: 'What is v after 2 s?', file: PHYSICS.name, at: 'slide 7' }] });
  }
  const w = await api(PROF, 'GET', `/api/chat/courses/${made.id}/weekly`);
  assert.equal(w.course, 'PHYS 101');
  assert.equal(w.totals.questions, 6);
  assert.equal(w.confusions[0].asks, 3, 'not-covered questions count as gaps, not against the page');
  assert.equal(w.totals.students, 3);
  assert.equal(w.totals.quizAverage, 33);
  assert.equal(w.confusions[0].where, 'Slide 14 of Lecture 3 · Kinematics');
  assert.equal(w.confusions[0].wrong, 3);
  assert.equal(w.confusions[0].missed[0].q, 'Which velocity stays constant?');
  assert.match(w.confusions[0].fix, /^Add a worked example to Slide 14 of Lecture 3/);
  assert.ok(w.confusions.some((c) => c.loc === 'slide 7'));
  assert.equal(w.gaps.length, 1);
  assert.match(w.gaps[0].fix, /Add material on “What is air resistance\?”/);
  assert.ok(w.fixes.length >= 3);
  assert.ok(!JSON.stringify(w).includes(STUDENT));
  await assert.rejects(api(STUDENT, 'GET', `/api/chat/courses/${made.id}/weekly`), { status: 403 });
  const last = await api(PROF, 'GET', `/api/chat/courses/${made.id}/weekly?week=1`);
  assert.equal(last.empty, true);
  assert.equal(last.week.weeksAgo, 1);
  void withDoc;
});

test('weekly: one student’s questions are not a class confusion; gaps need three students', () => {
  const now = Date.now();
  const r = (member, extra) => ({ at: now - 864e5, member, status: 'partial', hits: [{ name: 'Notes', loc: 'page 3' }], q: null, ...extra });
  const one = weeklySummary({ records: [r('a'), r('a'), r('a')], now });
  assert.deepEqual(one.confusions, []);
  const two = weeklySummary({ records: [r('a'), r('b'), r('c', { q: 'why?', status: 'general' }), r('d', { q: 'Why?', status: 'general' })], now });
  assert.equal(two.confusions.length, 1);
  assert.match(two.confusions[0].fix, /^Expand Page 3 of Notes/);
  assert.deepEqual(two.gaps, [], 'two students asking is not enough');
  assert.equal(whereOf('Reader', ''), 'Reader');
});
