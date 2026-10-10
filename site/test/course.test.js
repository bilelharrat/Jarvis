// Eden for Education (src/edu/course.js): courses, join codes, materials, search and the quote check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Course, eraseCourses, summaryIntent, SUMMARY_CHARS, buildIndex, checkGrounding, checkQuiz, checkSet, packVector, courseBlock, courseForTurn, coursesApi, filesForTurn, ocrPages, passageText, recordTurn, riskOf, schoolDomain, searchIndex } from '../src/edu/course.js';
import { namespace } from './fakes.js';

const PROF = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';

function setup(email = 'a.rivera@state.edu') {
  const env = {};
  env.COURSES = namespace(Course, env);
  const deps = {
    call: async (_env, _account, op) => (op === 'get' ? { identities: [{ provider: 'google', email }] } : {}),
    limited: async () => {},
    readBody: async (request) => JSON.parse((await request.text()) || '{}'),
  };
  const api = (account, method, path, body) =>
    coursesApi(new Request(`https://askeden.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), env, { account }, path.split('?')[0], deps);
  return { env, api };
}

const LECTURE = {
  name: 'Lecture 5 · Cellular respiration', kind: 'slides',
  parts: [
    { loc: 'slide 8', text: 'Glycolysis splits glucose into two pyruvate and makes a net gain of 2 ATP. It does not need oxygen.' },
    { loc: 'slide 19', text: 'Energy released as electrons move through complexes I, III and IV pumps H+ into the intermembrane space.' },
    { loc: 'slide 22', text: 'At complex IV oxygen is the final electron acceptor and combines with H+ to form water.' },
  ],
};

test('school email domains', () => {
  assert.equal(schoolDomain('a@State.EDU'), 'state.edu');
  assert.equal(schoolDomain('a@ox.ac.uk'), 'ox.ac.uk');
  assert.equal(schoolDomain('a@unam.edu.mx'), 'unam.edu.mx');
  assert.equal(schoolDomain('a@gmail.com'), null);
  assert.equal(schoolDomain('a@edu.example.com'), null);
});

test('search ranks the passage that answers the question first', () => {
  const index = buildIndex(LECTURE.parts.map((p) => ({ doc: 'd', name: LECTURE.name, ...p })));
  const hits = searchIndex(index, 'Why is oxygen the final electron acceptor?');
  assert.equal(hits[0].loc, 'slide 22');
  assert.deepEqual(searchIndex(index, 'the of and'), []);
});

test('quotes are checked word for word against their source', () => {
  const passages = LECTURE.parts.map((p) => ({ name: LECTURE.name, ...p }));
  const good = 'Oxygen takes the electrons at the end [1]. Glycolysis still works without it [2].\n<sources>\n[1] S3 "oxygen is the final electron acceptor"\n[2] S1 “It does not need oxygen.”\n</sources>';
  assert.equal(checkGrounding(good, passages).status, 'verified');
  const made = 'Cyanide blocks complex IV [1].\n<sources>\n[1] S3 "cyanide binds to complex IV"\n</sources>';
  const r = checkGrounding(made, passages);
  assert.equal(r.status, 'partial');
  assert.equal(r.sources[0].ok, false);
  const missing = 'It forms water [1] and heat [2].\n<sources>\n[1] S3 "combines with H+ to form water"\n</sources>';
  assert.deepEqual(checkGrounding(missing, passages).sources.map((s) => s.ok), [true, false]);
  assert.equal(checkGrounding('Your course materials don’t cover this.', passages).status, 'general');
  assert.equal(checkGrounding('Glycolysis still works [1]. Beyond your course materials, yeast ferment.\n<sources>\n[1] S1 “It does not need oxygen.”\n</sources>', passages).status, 'partial', 'the tutor’s spoken label counts');
  const mixed = good.replace('<sources>', '## General knowledge (not from your course)\nAlso…\n<sources>');
  assert.equal(checkGrounding(mixed, passages).status, 'partial');
});

test('the prompt block follows the course mode and keeps the professor’s instructions', () => {
  const p = [{ name: 'Syllabus', loc: 'page 1', text: 'Office hours are Tuesdays.' }];
  assert.match(courseBlock({ name: 'BIO 201', mode: 'fallback', instructions: 'Use the lecture’s terms.' }, p), /General knowledge \(not from your course\)[\s\S]*Use the lecture’s terms/);
  assert.match(courseBlock({ name: 'BIO 201', mode: 'strict', instructions: '' }, p), /Don’t answer it from general knowledge/);
  assert.match(courseBlock({ name: 'BIO 201', mode: 'strict' }, []), /No passage matched/);
});

test('a professor makes a course, adds material; a student joins by code and studies', async () => {
  const { env, api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201 · Cell Biology', term: 'Fall 2026' });
  assert.equal(made.role, 'owner');
  assert.equal(made.verified, 'state.edu');
  assert.match(made.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const withDoc = await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE);
  assert.equal(withDoc.docs[0].parts, 3);
  await api(PROF, 'POST', `/api/chat/courses/${made.id}`, { mode: 'strict', instructions: 'Ask a guiding question first.' });

  const joined = await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code.toLowerCase() });
  assert.equal(joined.role, 'student');
  assert.equal(joined.code, undefined); // only the professor sees the code and instructions
  assert.equal(joined.instructions, undefined);
  assert.deepEqual((await api(STUDENT, 'GET', '/api/chat/courses')).courses.map((c) => c.role), ['student']);
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE), { status: 403 });

  const turn = await courseForTurn(env, { account: STUDENT }, made.id, 'what does oxygen do at complex IV');
  assert.equal(turn.passages[0].loc, 'slide 22');
  assert.match(turn.block, /Ask a guiding question first[\s\S]*$/);
  await assert.rejects(courseForTurn(env, { account: STRANGER }, made.id, 'oxygen'), { status: 404 });
  await assert.rejects(courseForTurn(env, { account: STUDENT, grant: {} }, made.id, 'oxygen'), { status: 403 });

  await assert.rejects(api(STRANGER, 'POST', '/api/chat/courses/join', { age13: true, code: 'AAAA-BBBB-CCCC' }), { status: 404 });
  await assert.rejects(api(STRANGER, 'POST', '/api/chat/courses/join', { age13: true, code: 'nope' }), { status: 400 });

  // a removed file is gone from search; deleting the course drops it from everyone's list
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs/${withDoc.docs[0].id}/delete`);
  assert.deepEqual((await courseForTurn(env, { account: STUDENT }, made.id, 'oxygen')).passages, []);
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/delete`);
  assert.deepEqual((await api(STUDENT, 'GET', '/api/chat/courses')).courses, []);
  await assert.rejects(api(STRANGER, 'POST', '/api/chat/courses/join', { age13: true, code: made.code }), { status: 404 });
});

test('a course made without a school email is not verified; students can leave', async () => {
  const { api } = setup('someone@gmail.com');
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'Book club' });
  assert.equal(made.verified, null);
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/leave`);
  assert.deepEqual((await api(STUDENT, 'GET', '/api/chat/courses')).courses, []);
  await assert.rejects(api(PROF, 'POST', `/api/chat/courses/${made.id}/leave`), { status: 400 });
});

test('quiz questions are kept only with a quote that is really in their source', () => {
  const passages = LECTURE.parts.map((p) => ({ name: LECTURE.name, ...p }));
  const quiz = { questions: [
    { q: 'Net ATP from glycolysis?', choices: ['1', '2', '4', '36'], answer: 1, explain: 'Two.', source: 'S1', quote: 'makes a net gain of 2 ATP' },
    { q: 'What binds complex IV?', choices: ['a', 'b', 'c', 'd'], answer: 0, explain: '…', source: 'S3', quote: 'cyanide binds tightly to complex IV' },
  ] };
  const r = checkQuiz('```json\n' + JSON.stringify(quiz) + '\n```', passages);
  assert.equal(r.scope, 'quiz');
  assert.deepEqual(r.sources.map((x) => x.ok), [true, false]);
  assert.equal(r.status, 'partial');
  assert.equal(checkQuiz('not json', passages).status, 'general');
});

test('insights: anonymous counts, topics hit, questions not covered; professor only; quizzes not counted', async () => {
  const { env, api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE);
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  const turn = await courseForTurn(env, { account: STUDENT }, made.id, 'oxygen final electron acceptor');
  await recordTurn(env, { account: STUDENT }, turn, { status: 'verified' }, 'why oxygen?');
  await recordTurn(env, { account: STUDENT }, turn, { status: 'general' }, 'How does cyanide kill?');
  await recordTurn(env, { account: PROF }, turn, { status: 'general' }, 'how does  cyanide kill');
  const quiz = await courseForTurn(env, { account: STUDENT }, made.id, '', { quiz: true });
  assert.ok(quiz.passages.length >= 1 && /JSON only/.test(quiz.block));
  await recordTurn(env, { account: STUDENT }, quiz, { status: 'verified' }, 'quiz');
  const ins = await api(PROF, 'GET', `/api/chat/courses/${made.id}/insights`);
  assert.equal(ins.questions, 3);
  assert.equal(ins.students, 2);
  assert.equal(ins.verifiedShare, 33);
  assert.equal(ins.topics[0].loc, 'slide 22');
  assert.deepEqual(ins.gaps, [], 'two students asking is not enough to show the question');
  await api(STRANGER, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  await recordTurn(env, { account: STRANGER }, turn, { status: 'general' }, 'How does cyanide kill??');
  const ins3 = await api(PROF, 'GET', `/api/chat/courses/${made.id}/insights`);
  assert.equal(ins3.gaps.length, 1); // the same question, however it was typed, from three students
  assert.equal(ins3.gaps[0].n, 3);
  assert.match(ins3.gaps[0].q, /cyanide kill/i);
  assert.ok(!JSON.stringify(ins).includes(STUDENT));
  await assert.rejects(api(STUDENT, 'GET', `/api/chat/courses/${made.id}/insights`), { status: 403 });
});

test('scanned pages: read by the included AI, held and charged on the account', async () => {
  const calls = [];
  const call = async (_e, _a, op, body) => { calls.push([op, body]); return op === 'hold-ai' ? { ok: true, hold: 'h1', bucket: 'included' } : {}; };
  const env = { GEMINI_API_KEY: '', ANTHROPIC_API_KEY: 'sk-test' };
  const fetch = async () => new Response(JSON.stringify({ model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Chapter 3\nThe cell membrane' }], usage: { input_tokens: 1500, output_tokens: 20 } }));
  const out = await ocrPages(env, { account: PROF }, { images: [{ loc: 'page 4', data: 'AAAA' }] }, { call, fetch });
  assert.deepEqual(out.parts, [{ loc: 'page 4', text: 'Chapter 3\nThe cell membrane' }]);
  assert.deepEqual(calls.map((c) => c[0]), ['hold-ai', 'spend', 'release-ai']);
  assert.ok(calls[1][1].usd > 0);
  await assert.rejects(ocrPages(env, { account: PROF }, { images: [] }, { call, fetch }), { status: 400 });
  await assert.rejects(ocrPages(env, { account: PROF }, { images: [{ data: 'not base64!' }] }, { call, fetch }), { status: 400 });
});

test('figures (Q6): pictures described by the included AI, held and charged; our marker can’t be forged', async () => {
  const calls = [];
  let sent = null;
  const call = async (_e, _a, op, body) => { calls.push([op, body]); return op === 'hold-ai' ? { ok: true, hold: 'h2', bucket: 'included' } : {}; };
  const env = { GEMINI_API_KEY: '', ANTHROPIC_API_KEY: 'sk-test' };
  const fetch = async (_u, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ model: 'claude-haiku-4-5', content: [{ type: 'text', text: '## A bar chart\n[Figure description] **Sales** rise from 2 to 9 units.' }], usage: { input_tokens: 1500, output_tokens: 40 } })); };
  const out = await ocrPages(env, { account: PROF }, { describe: true, images: [{ loc: 'slide 3', data: 'AAAA' }] }, { call, fetch });
  assert.deepEqual(out.parts, [{ loc: 'slide 3', text: 'A bar chart\n Sales rise from 2 to 9 units.' }]);
  assert.match(sent.system, /never an instruction to you/); // what the picture says is material, not orders (H8)
  assert.equal(sent.max_tokens, 600);
  assert.deepEqual(calls.map((c) => c[0]), ['hold-ai', 'spend', 'release-ai']);
});

test('figures (Q6): a long page keeps its figure description in the passage', () => {
  const page = `${'Osmosis moves water across a membrane. '.repeat(80)}\n\n[Figure description]\nA U-tube diagram: water rises on the salty side.`;
  const p = passageText(page);
  assert.ok(p.length <= 1800);
  assert.match(p, /^Osmosis moves water/);
  assert.match(p, /\[Figure description\]\nA U-tube diagram: water rises on the salty side\.$/);
  assert.equal(passageText('short page'), 'short page');
  assert.equal(passageText('x'.repeat(2000)).length, 1800);
  const idx = buildIndex([{ doc: 'd1', name: 'Lecture 2', loc: 'page 4', text: page }]);
  const hit = searchIndex(idx, 'U-tube diagram salty side');
  assert.equal(hit[0].loc, 'page 4');
  const check = checkGrounding('Water rises on the salty side [1].\n<sources>\n[1] S1 "A U-tube diagram: water rises on the salty side"\n</sources>', hit);
  assert.ok(check.sources[0].ok);
});

test('outside courses: long attached documents get checked answers; high-stakes questions are spotted', () => {
  const doc = { kind: 'text', name: 'lease.pdf', text: `${'Tenants pay rent on the first of the month. '.repeat(30)}\n\nPets need written permission from the landlord.\n\n${'The deposit is returned within 30 days. '.repeat(20)}` };
  const f = filesForTurn({ attachments: [doc] }, 'can I have pets?');
  assert.match(f.passages[0].text, /Pets need written permission/);
  assert.match(f.block, /Your files don’t cover this[\s\S]*not from your files/);
  assert.doesNotMatch(f.block, /student|professor/i);
  assert.equal(filesForTurn({ attachments: [{ ...doc, name: 'app.js' }] }, 'fix it'), null);
  assert.equal(filesForTurn({ attachments: [{ ...doc, text: 'short' }] }, 'x'), null);
  assert.equal(riskOf('What dose of ibuprofen is safe for a child?'), 'medical');
  assert.equal(riskOf('Can my landlord evict me without notice?'), 'legal');
  assert.equal(riskOf('Is it true that we only use 10% of our brain?'), 'fact-check');
  assert.equal(riskOf('Write a poem about autumn'), null);
});

test('joining needs the age confirmation and takes the name the professor sees', async () => {
  const { api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await assert.rejects(api(STUDENT, 'POST', '/api/chat/courses/join', { code: made.code }), { status: 400 });
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code, label: 'Maya Chen' });
  const { members } = await api(PROF, 'GET', `/api/chat/courses/${made.id}/members`);
  assert.deepEqual(members.map((m) => [m.role, m.label]), [['owner', 'Professor'], ['student', 'Maya Chen']]);
  await assert.rejects(api(STUDENT, 'GET', `/api/chat/courses/${made.id}/members`), { status: 403 });
});

test('TAs, removing students, a new join code', async () => {
  const { api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code, label: 'Sam (TA)' });
  await api(STRANGER, 'POST', '/api/chat/courses/join', { age13: true, code: made.code, label: 'Lee' });
  let { members } = await api(PROF, 'GET', `/api/chat/courses/${made.id}/members`);
  const sam = members.find((m) => m.label === 'Sam (TA)'), lee = members.find((m) => m.label === 'Lee');
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}/members/${lee.id}/role`, { role: 'ta' }), { status: 403 });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/members/${sam.id}/role`, { role: 'ta' });
  // a TA adds material and sees insights and the code, but can't remove people or change the code
  const v = await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE);
  assert.ok(v.doc && v.code === made.code && v.role === 'ta');
  await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/insights`);
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}/members/${lee.id}/remove`), { status: 403 });
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}/code`), { status: 403 });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/members/${lee.id}/remove`);
  assert.deepEqual((await api(STRANGER, 'GET', '/api/chat/courses')).courses, []);
  const { code } = await api(PROF, 'POST', `/api/chat/courses/${made.id}/code`);
  assert.notEqual(code, made.code);
  await assert.rejects(api(STRANGER, 'POST', '/api/chat/courses/join', { age13: true, code: made.code }), { status: 404 });
  await api(STRANGER, 'POST', '/api/chat/courses/join', { age13: true, code });
  ({ members } = await api(PROF, 'GET', `/api/chat/courses/${made.id}/members`));
  assert.equal(members.length, 3);
});

test('hidden and scheduled files, exam pauses, the source viewer', async () => {
  const { env, api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  const { doc } = await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE);
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  const src = await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/source?doc=${doc}&loc=${encodeURIComponent('slide 22')}`);
  assert.match(src.text, /final electron acceptor/);
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs/${doc}`, { hidden: true });
  assert.equal((await api(STUDENT, 'GET', `/api/chat/courses/${made.id}`)).docs.length, 0);
  assert.equal((await api(PROF, 'GET', `/api/chat/courses/${made.id}`)).docs[0].hidden, true);
  assert.deepEqual((await courseForTurn(env, { account: STUDENT }, made.id, 'oxygen')).passages, []);
  assert.ok((await courseForTurn(env, { account: PROF }, made.id, 'oxygen')).passages.length >= 1, 'staff still see it');
  await assert.rejects(api(STUDENT, 'GET', `/api/chat/courses/${made.id}/source?doc=${doc}&loc=slide%2022`), { status: 404 });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs/${doc}`, { hidden: false, from: Date.now() + 864e5 });
  assert.equal((await api(STUDENT, 'GET', `/api/chat/courses/${made.id}`)).docs.length, 0, 'not open yet');
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs/${doc}`, { from: null });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}`, { pauses: [{ start: Date.now() - 1000, end: Date.now() + 3600e3, label: 'Midterm' }, { start: 1, end: 2 }] });
  const v = await api(STUDENT, 'GET', `/api/chat/courses/${made.id}`);
  assert.equal(v.paused.label, 'Midterm');
  assert.equal((await api(PROF, 'GET', `/api/chat/courses/${made.id}`)).pauses.length, 1, 'past pauses are dropped');
  await assert.rejects(courseForTurn(env, { account: STUDENT }, made.id, 'oxygen'), { status: 423 });
  await courseForTurn(env, { account: PROF }, made.id, 'oxygen');
});

test('study sets: checked cards, shared sets; quiz scores in insights; synced chats are private; big files in pieces', async () => {
  const { env, api } = setup();
  const passages = LECTURE.parts.map((p) => ({ doc: 'dDDDDDDDDD', name: LECTURE.name, ...p }));
  const set = checkSet(JSON.stringify({ title: 'Respiration', cards: [{ term: 'Final electron acceptor', def: 'Oxygen', source: 'S3', quote: 'oxygen is the final electron acceptor' }, { term: 'X', def: 'Y', source: 'S1', quote: 'made up words here' }] }), passages);
  assert.equal(set.scope, 'set');
  assert.deepEqual(set.sources.map((s) => [s.ok, s.doc]), [[true, 'dDDDDDDDDD'], [false, 'dDDDDDDDDD']]);

  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  const first = await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, { name: 'Textbook', kind: 'pdf', parts: LECTURE.parts.slice(0, 2) });
  const more = await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, { append: first.doc, parts: LECTURE.parts.slice(2) });
  assert.equal(more.parts, 3);
  assert.equal((await courseForTurn(env, { account: STUDENT }, made.id, 'complex IV oxygen water')).passages[0].loc, 'slide 22');
  const turn = await courseForTurn(env, { account: STUDENT }, made.id, '', { task: 'set' });
  assert.match(turn.block, /study set of flashcards/);

  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}/sets`, { title: 'Mine', cards: [{ term: 'a', def: 'b' }, { term: 'c', def: 'd' }] }), { status: 403 });
  const shared = await api(PROF, 'POST', `/api/chat/courses/${made.id}/sets`, { title: 'Unit 3', cards: [{ term: 'a', def: 'b' }, { term: 'c', def: 'd' }, { term: '', def: 'x' }] });
  assert.equal(shared.cards.length, 2);
  assert.deepEqual((await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/sets`)).sets.map((x) => x.title), ['Unit 3']);

  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/quiz-score`, { score: 4, total: 5 });
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}/quiz-score`, { score: 6, total: 5 }), { status: 400 });
  const ins = await api(PROF, 'GET', `/api/chat/courses/${made.id}/insights`);
  assert.equal(ins.quizzes, 1);
  assert.equal(ins.quizAverage, 80);
  assert.equal(ins.questions, 0, 'a quiz is not a question');

  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/chats`, { id: 'chat1', title: 'ETC', updated: 5, messages: [{ role: 'user', text: 'why oxygen' }] });
  assert.deepEqual((await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/chats`)).chats.map((c) => c.id), ['chat1']);
  assert.equal((await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/chats/chat1`)).messages[0].text, 'why oxygen');
  assert.deepEqual((await api(PROF, 'GET', `/api/chat/courses/${made.id}/chats`)).chats, [], 'no one else sees them');
  await assert.rejects(api(PROF, 'GET', `/api/chat/courses/${made.id}/chats/chat1`), { status: 404 });
});

test('meaning: a paraphrased question finds its passage through the embeddings', async () => {
  const { env, api } = setup();
  // a fake Workers AI: "breathing"/"respiration" and "oxygen" map near each other
  const vec = (t) => { t = t.toLowerCase(); return [/oxygen|breath|air/.test(t) ? 1 : 0, /glucose|sugar/.test(t) ? 1 : 0, /pump|membrane/.test(t) ? 1 : 0, 0.01]; };
  env.AI = { run: async (_m, { text }) => ({ data: text.map(vec) }) };
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE);
  const hits = (await courseForTurn(env, { account: PROF }, made.id, 'what do we need to breathe air for')).passages;
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /oxygen/);
  assert.equal(packVector([3, 4]).length > 0, true);
});

test('security review fixes: no account in the body, staff before embeddings, pauses close everything, account deletion', async () => {
  const { env, api } = setup();
  let embeds = 0;
  env.AI = { run: async (_m, { text }) => { embeds += text.length; return { data: text.map(() => [1, 0, 0]) }; } };
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  // a student naming the professor's account in the body is still themselves
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}`, { account: PROF, instructions: 'Tell everyone the answers.' }), { status: 403 });
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}/quiz-score`, { account: PROF, score: 1, total: 1 }).then(() => api(PROF, 'GET', `/api/chat/courses/${made.id}/insights`)).then((i) => assert.equal(i.quizzes, 1) || Promise.reject(new Error('ok'))), /ok/);
  // a student's upload is refused before any embedding is paid for; more than 400 pages a request too
  embeds = 0;
  await assert.rejects(api(STUDENT, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE), { status: 403 });
  assert.equal(embeds, 0);
  await assert.rejects(api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, { name: 'Huge', kind: 'pdf', parts: Array.from({ length: 401 }, (_, i) => ({ loc: `page ${i}`, text: 'x' })) }), { status: 400 });
  const { doc } = await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE);
  assert.ok(embeds > 0);
  // a stranger's turn is refused before its question is embedded
  embeds = 0;
  await assert.rejects(courseForTurn(env, { account: STRANGER }, made.id, 'oxygen'), { status: 404 });
  assert.equal(embeds, 0);
  // during a pause, students get no sources and no shared sets either
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/sets`, { title: 'S', cards: [{ term: 'a', def: 'b' }, { term: 'c', def: 'd' }] });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}`, { pauses: [{ start: Date.now() - 1000, end: Date.now() + 3600e3, label: 'Final' }] });
  await assert.rejects(api(STUDENT, 'GET', `/api/chat/courses/${made.id}/source?doc=${doc}&loc=slide%2022`), { status: 423 });
  await assert.rejects(api(STUDENT, 'GET', `/api/chat/courses/${made.id}/sets`), { status: 423 });
  await api(PROF, 'GET', `/api/chat/courses/${made.id}/sets`);
  // deleting the professor's account deletes their course; a student's account leaves its courses
  const other = await api(STUDENT, 'POST', '/api/chat/courses', { name: 'Study group' });
  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/chats`, { id: 'chatX', title: 't', updated: 1, messages: [{ role: 'user', text: 'hi' }] });
  await eraseCourses(env, STUDENT);
  assert.deepEqual((await api(STUDENT, 'GET', '/api/chat/courses')).courses, []);
  assert.equal((await api(PROF, 'GET', `/api/chat/courses/${made.id}/members`)).members.length, 1, 'the student left the class');
  await assert.rejects(api(PROF, 'GET', `/api/chat/courses/${other.id}`), { status: 404 });
  await eraseCourses(env, PROF);
  assert.deepEqual((await api(PROF, 'GET', '/api/chat/courses')).courses, []);
  await assert.rejects(api(STRANGER, 'POST', '/api/chat/courses/join', { age13: true, code: made.code }), { status: 404 });
});

test('the tutor: the course block spoken like a person; its turns count as questions', async () => {
  const { env, api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE);
  const turn = await courseForTurn(env, { account: PROF }, made.id, 'what does oxygen do', { task: 'tutor' });
  assert.equal(turn.task, 'tutor');
  assert.match(turn.block, /<source id="S1"[\s\S]*Eden, the student’s personal tutor[\s\S]*one question at a time/);
  await recordTurn(env, { account: PROF }, turn, { status: 'verified' }, 'what does oxygen do');
  assert.equal((await api(PROF, 'GET', `/api/chat/courses/${made.id}/insights`)).questions, 1);
});

test('EPUB course materials and attached EPUBs', async () => {
  const { env, api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'US History' });
  const v = await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, { name: 'American Yawp', kind: 'epub', parts: [{ loc: 'ch. 1: The Colonies', text: 'Jamestown, founded in 1607, was the first permanent English settlement in North America.' }] });
  assert.equal(v.docs[0].kind, 'epub');
  assert.equal((await courseForTurn(env, { account: PROF }, made.id, 'first permanent English settlement')).passages[0].loc, 'ch. 1: The Colonies');
  const doc = { kind: 'text', name: 'History.epub', text: `[ch. 1: The Colonies]\n${'Jamestown was founded in 1607. '.repeat(60)}` };
  assert.ok(filesForTurn({ attachments: [doc] }, 'when was Jamestown founded'));
  assert.ok(filesForTurn({ attachments: [{ ...doc, name: 'Deck.pptx' }] }, 'x'));
});

test('summaries: the whole file (or chapter, or the pages around the match), in order, with the comprehensive brief', async () => {
  assert.ok(summaryIntent('Summarize chapter 3') && summaryIntent('can you give me an overview of the lecture') && summaryIntent('tl;dr please') && summaryIntent('what are the key takeaways'));
  assert.ok(!summaryIntent('why does the electron transport chain need oxygen'));
  const { env, api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE);
  const t = await courseForTurn(env, { account: PROF }, made.id, 'summarize the lecture on oxygen', { summary: true });
  assert.deepEqual(t.passages.map((p) => p.loc), ['slide 8', 'slide 19', 'slide 22'], 'the whole (small) file, in its order, not just the best matches');
  assert.match(t.block, /comprehensive[\s\S]*What to remember/);
  // a long book: the chapter asked for; "the latest" picks the newest file
  const para = 'Saving and investing are different activities with different risks. '.repeat(160); // ~11k chars a part
  const book = { name: 'Intelligent Investor', kind: 'epub', parts: [] };
  for (let ch = 1; ch <= 4; ch++) for (let i = 1; i <= 3; i++) book.parts.push({ loc: `ch. ${ch}: Part ${ch} (${i})`, text: (ch === 3 ? 'Margin of safety is the central concept of investment. ' : '') + para });
  await new Promise((r) => setTimeout(r, 5)); // added after the lecture
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, book);
  const c3 = await courseForTurn(env, { account: PROF }, made.id, 'summarize chapter 3', { summary: true });
  assert.ok(c3.passages.every((p) => p.loc.startsWith('ch. 3')), c3.passages.map((p) => p.loc).join());
  assert.equal(c3.passages.length, 3);
  const latest = await courseForTurn(env, { account: PROF }, made.id, 'summarize the latest reading', { summary: true });
  assert.ok(latest.passages.every((p) => p.name === 'Intelligent Investor'));
  assert.ok(latest.passages.reduce((n, p) => n + p.text.length, 0) <= SUMMARY_CHARS + 12_000);
});

test('a summary’s model by the material’s length: Luna for short, Flash for long, with the reason shown', async () => {
  const { summaryModel, SUMMARY_SHORT_CHARS } = await import('../src/eden/chat.js');
  const m = (id) => ({ id, name: id, efforts: [{ level: 'low' }, { level: 'medium' }, { level: 'high' }] });
  const cfg = { maxEffort: 'high', models: ['gpt-6-luna', 'gemini-3.8-flash', 'gemini-3.1-pro-preview'].map(m) };
  assert.deepEqual(summaryModel(cfg, 9000).override, { model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(summaryModel(cfg, SUMMARY_SHORT_CHARS + 1).override, { model: 'gemini-3.8-flash', effort: 'low' });
  assert.match(summaryModel(cfg, 9000).why, /reads all of it/);
  assert.equal(summaryModel({ maxEffort: 'high', models: [m('gemini-3.1-pro-preview')] }, 9000), null, 'no cheap model: the router decides');
});

test('the notebook: private notes per student, newest copy wins, gone when they leave', async () => {
  const { api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/notes`, { id: 'note1', title: 'Respiration', body: '## ETC\nOxygen is the **final** acceptor.', updated: 100 });
  const { notes } = await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/notes`);
  assert.deepEqual(notes.map((n) => [n.id, n.title, n.snippet]), [['note1', 'Respiration', 'ETC Oxygen is the final acceptor.']]);
  assert.equal((await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/notes/note1`)).body, '## ETC\nOxygen is the **final** acceptor.');
  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/notes`, { id: 'note1', title: 'Old', body: 'stale', updated: 50 });
  assert.equal((await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/notes/note1`)).title, 'Respiration', 'an older copy doesn’t overwrite');
  assert.deepEqual((await api(PROF, 'GET', `/api/chat/courses/${made.id}/notes`)).notes, [], 'the professor can’t see them');
  await assert.rejects(api(PROF, 'GET', `/api/chat/courses/${made.id}/notes/note1`), { status: 404 });
  await api(STUDENT, 'POST', `/api/chat/courses/${made.id}/leave`);
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  assert.deepEqual((await api(STUDENT, 'GET', `/api/chat/courses/${made.id}/notes`)).notes, [], 'leaving deletes them');
});

test('course passages reach the prompt inside the guard’s markers; quotes are still checked against the plain text', async () => {
  const { env, api } = setup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, LECTURE);
  const wrap = (p) => `<<<U>>>${p.text}<<<END>>>`;
  const t = await courseForTurn(env, { account: PROF }, made.id, 'oxygen final electron acceptor', { wrap });
  assert.match(t.block, /<<<U>>>At complex IV oxygen[\s\S]*?<<<END>>>/);
  assert.ok(!t.passages[0].text.includes('<<<U>>>'), 'the passages themselves stay plain');
  assert.equal(checkGrounding('It is the acceptor [1].\n<sources>\n[1] S1 "oxygen is the final electron acceptor"\n</sources>', t.passages).status, 'verified');
});
