// Bug sweep round 3, askeden.com Worker and Eden Edu (askeden docs/bug-sweep/r3-ask-eden-site-edu.md, AW3-1…AW3-10):
// each fix with the test that failed before it. The sync's own (AW3-2, AW3-3, AW3-9): r3-sync-eden.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Course, checkGrounding, checkQuiz, checkSet, coursesApi, courseForTurn, groundStatus, recordTurn } from '../src/edu/course.js';
import { ltiAdmin } from '../src/edu/lti.js';
import { cappedText, stripeApi } from '../src/eden/billing.js';
import { keysUnreadError } from '../src/accounts/user-keys.js';
import { namespace } from './fakes.js';

const PROF = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const PASSAGES = [
  { doc: 'dA', name: 'Lecture 5', loc: 'slide 3', text: 'Glycolysis makes a net gain of 2 ATP. It does not need oxygen.' },
  { doc: 'dA', name: 'Lecture 5', loc: 'slide 22', text: 'At complex IV, oxygen is the final electron acceptor and combines with H+ to form water.' },
];

// ─── AW3-1: verified / partial / unverified ─────────────────────────────────

test('AW3-1: an answer whose every quote fails is unverified, not “partly verified”; partial only when some check out and some don’t', () => {
  assert.equal(groundStatus([]), 'general');
  assert.equal(groundStatus([{ ok: true }, { ok: true }]), 'verified');
  assert.equal(groundStatus([{ ok: true }, { ok: false }]), 'partial');
  assert.equal(groundStatus([{ ok: false }, { ok: false }]), 'unverified');
  assert.equal(groundStatus([{ ok: true }], true), 'partial', 'verified quotes, plus a part from general knowledge');
  assert.equal(groundStatus([{ ok: false }], true), 'unverified');

  const none = checkGrounding('X [1].\n<sources>\n[1] S1 "words that are not in the page"\n</sources>', PASSAGES);
  assert.equal(none.status, 'unverified');
  assert.equal(checkGrounding('A [1], B [2].\n<sources>\n[1] S2 "oxygen is the final electron acceptor"\n[2] S1 "made up words here"\n</sources>', PASSAGES).status, 'partial');
  assert.equal(checkGrounding('A [1].\n<sources>\n[1] S2 "oxygen is the final electron acceptor"\n</sources>', PASSAGES).status, 'verified');
  assert.equal(checkGrounding('A marker with no source [1].', PASSAGES).status, 'unverified', 'a cited marker with no source line checks out nowhere');

  const quiz = (qs) => JSON.stringify({ questions: qs.map(([source, quote]) => ({ q: 'Q?', choices: ['a', 'b'], answer: 0, source, quote })) });
  assert.equal(checkQuiz(quiz([['S1', 'invented words go here'], ['S2', 'more invented words here']]), PASSAGES).status, 'unverified');
  assert.equal(checkQuiz(quiz([['S1', 'net gain of 2 ATP'], ['S2', 'more invented words here']]), PASSAGES).status, 'partial');
  assert.equal(checkQuiz(quiz([['S1', 'net gain of 2 ATP']]), PASSAGES).status, 'verified');
  const set = (cards) => JSON.stringify({ title: 'T', cards: cards.map(([source, quote]) => ({ term: 't', def: 'd', source, quote })) });
  assert.equal(checkSet(set([['S1', 'not in the materials at all']]), PASSAGES).status, 'unverified');
  assert.equal(checkSet(set([['S1', 'it does not need oxygen'], ['S9', 'no such source here']]), PASSAGES).status, 'partial');
});

test('AW3-1: the professor’s insights count an unverified turn as unverified (not as a question the materials don’t cover)', async () => {
  const env = {};
  env.COURSES = namespace(Course, env);
  const deps = { call: async (_e, _a, op) => (op === 'get' ? { identities: [] } : {}), limited: async () => {}, readBody: async (r) => JSON.parse((await r.text()) || '{}') };
  const api = (account, method, path, body) => coursesApi(new Request(`https://askeden.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), env, { account }, path.split('?')[0], deps);
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO 201' });
  await api(PROF, 'POST', `/api/chat/courses/${made.id}/docs`, { name: 'Lecture 5', kind: 'text', parts: PASSAGES.map(({ loc, text }) => ({ loc, text })) });
  await api(STUDENT, 'POST', '/api/chat/courses/join', { age13: true, code: made.code });
  const turn = await courseForTurn(env, { account: STUDENT }, made.id, 'oxygen final electron acceptor');
  await recordTurn(env, { account: STUDENT }, turn, { status: 'verified' }, 'why oxygen?');
  await recordTurn(env, { account: STUDENT }, turn, { status: 'unverified' }, 'what does cyanide do?');
  await recordTurn(env, { account: STUDENT }, turn, { status: 'partial' }, 'and water?');
  await recordTurn(env, { account: STUDENT }, turn, { status: 'general' }, 'who discovered ATP?');
  const ins = await api(PROF, 'GET', `/api/chat/courses/${made.id}/insights`);
  assert.equal(ins.questions, 4);
  assert.equal(ins.verifiedShare, 25);
  assert.equal(ins.general, 1, 'the unverified turn is not counted as general knowledge');
  assert.equal(ins.unverified, 1);
});

// ─── AW3-5: French for the new texts ────────────────────────────────────────

test('AW3-5: the www passkey refusal, unreadable keys, Stripe delete notices, course-list error and paid-by notes have French', async () => {
  const where = [process.env.EDEN_HOME && `${process.env.EDEN_HOME}/web/chat`, fileURLToPath(new URL('../../../askeden/web/chat', import.meta.url))].filter(Boolean).find((d) => existsSync(`${d}/i18n-fr-server.js`));
  if (!where) return; // the askeden repo isn't beside this one
  const server = (await import(`${where}/i18n-fr-server.js`)).default;
  const fr = (text) => {
    if (server.exact[text] !== undefined) return server.exact[text];
    for (const [re, rep] of server.patterns) if (re.test(text)) return text.replace(re, rep);
    return text;
  };
  const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const session = read('../src/eden/session.js');
  const chat = read('../src/eden/chat.js');
  const course = read('../src/edu/course.js');
  const texts = [
    /'(Passkeys work on askeden\.com[^']+)'/.exec(session)[1],
    /STRIPE_PENDING = '([^']+)'/.exec(session)[1],
    /STRIPE_REFUSED = '([^']+)'/.exec(session)[1],
    /'(Couldn’t check your courses just now[^']+)'/.exec(course)[1],
    keysUnreadError({ reason: 'read' }).message,
    keysUnreadError({ reason: 'open', providers: ['anthropic', 'openai'] }).message,
    ...[...chat.matchAll(/'(on askeden\.com: [^']+)'/g)].map((m) => m[1]),
  ];
  assert.ok(texts.length >= 10, `${texts.length} texts`);
  for (const t of texts) assert.notEqual(fr(t), t, `no French for: ${t}`);
  assert.match(fr(keysUnreadError({ reason: 'open', providers: ['anthropic'] }).message), /^Eden n’a pas pu ouvrir votre clé \S+ enregistrée/);
  const signin = read('../public/lang/fr-signin.js');
  assert.ok(signin.includes(`"${texts[0]}"`), 'the sign-in page (a tab left open on www) has it too');
  const account = readFileSync(`${where}/i18n-fr-account.js`, 'utf8');
  for (const t of ['Account deleted', 'Your account is deleted']) assert.ok(account.includes(`'${t}':`), t);
});

// ─── AW3-7: LTI registration addresses are the apex ─────────────────────────

test('AW3-7: the tool addresses given for an LTI registration are askeden.com’s even when asked on www', async () => {
  const ADMIN = 'admin-token-long-enough-to-count-1234';
  const env = { LTI_ADMIN_TOKEN: ADMIN };
  env.COURSES = namespace(Course, env);
  const ask = async (host) => (await (await ltiAdmin(new Request(`https://${host}/api/admin/lti`, { headers: { authorization: `Bearer ${ADMIN}` } }), env)).json()).tool;
  const www = await ask('www.askeden.com');
  for (const k of ['login', 'redirect', 'launch', 'deep_link', 'jwks']) assert.match(www[k], /^https:\/\/askeden\.com\/lti\//, k);
  assert.deepEqual(await ask('askeden.com'), www);
  assert.match((await ask('localhost:8791')).login, /^https:\/\/localhost:8791\/lti\/login$/, 'a dev host stays itself');
});

// ─── AW3-8: the Stripe webhook never reads more than 1 MiB ──────────────────

/** A request whose body is `total` bytes, made only as it is read; `pulled()` says how much was. */
function lazyBody(total, headers = {}) {
  let made = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  const body = new ReadableStream({
    pull(c) {
      if (made >= total) { c.close(); return; }
      const n = Math.min(chunk.length, total - made);
      made += n;
      c.enqueue(chunk.slice(0, n));
    },
  });
  const request = new Request('https://askeden.com/api/stripe/webhook', { method: 'POST', body, duplex: 'half', headers: { 'stripe-signature': 't=1,v1=00', ...headers } });
  return { request, pulled: () => made };
}

test('AW3-8: a webhook body over 1 MiB is refused (413) after reading at most about 1 MiB, by Content-Length or by counting', async () => {
  const env = { STRIPE_WEBHOOK_SECRET: 'whsec_testtesttest' };
  const big = lazyBody(50 * 1024 * 1024);
  const r = await stripeApi(big.request, env, {}, '/api/stripe/webhook');
  assert.equal(r.status, 413);
  assert.equal((await r.json()).code, 'too_big');
  assert.ok(big.pulled() <= (1 << 20) + 2 * 64 * 1024, `read ${big.pulled()} bytes of 50 MiB`);

  const said = lazyBody(5 * 1024 * 1024, { 'content-length': String(5 * 1024 * 1024) });
  assert.equal((await stripeApi(said.request, env, {}, '/api/stripe/webhook')).status, 413);
  assert.ok(said.pulled() <= 2 * 64 * 1024, `a Content-Length over the cap: refused before reading (${said.pulled()} bytes)`);

  // under the cap: read whole, and on to the signature check as before
  const small = lazyBody(300 * 1024);
  const ok = await stripeApi(small.request, env, {}, '/api/stripe/webhook');
  assert.equal(ok.status, 400);
  assert.equal((await ok.json()).code, 'bad_signature');
  assert.equal(await cappedText(new Request('https://x/', { method: 'POST', body: 'héllo' }), 10), 'héllo');
  await assert.rejects(cappedText(new Request('https://x/', { method: 'POST', body: 'x'.repeat(11) }), 10), { status: 413 });
});
