// Q12 LTI 1.3 (src/edu/lti.js, lti-store.js) against a fake platform (Canvas-like): registrations, OIDC
// login initiation, the launch's checks (state cookie, one-time state and nonce, RS256 by the platform's
// JWKS, iss/aud/azp/exp/iat/deployment/version/message type), linking an LMS course to an Eden course,
// students and TAs joining with their LMS role, deep linking (a JWT the platform can verify against our
// JWKS), and Names and Roles (client-credentials token with our signed assertion, paged class list).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { Course, coursesApi } from '../src/edu/course.js';
import { STATE_COOKIE, TICKET_COOKIE, checkClaims, forgetPlatformKeys, ltiAdmin, ltiRoute, roleOf, verifyJwt } from '../src/edu/lti.js';
import { b64urlText } from '../src/accounts/util.js';
import { namespace, rsaSigner } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const PLATFORM = 'https://canvas.test.edu';
const CLIENT = '10000000000042';
const DEP = '7:abc123';
const ADMIN = 'admin-token-long-enough-to-count-1234';
const PROF = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const TA = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const M = 'http://purl.imsglobal.org/vocab/lis/v2/membership';
const L = 'https://purl.imsglobal.org/spec/lti/claim/';

const plat = await rsaSigner('PLAT1');
const rogue = await rsaSigner('PLAT1'); // same kid, another key: a forged token
const toolPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', toolPair.privateKey));
const PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;

let env, platform, roster;
const ctx = { waitUntil: () => {} };

beforeEach(() => {
  forgetPlatformKeys();
  env = { LTI_PRIVATE_KEY: PEM, LTI_ADMIN_TOKEN: ADMIN };
  env.COURSES = namespace(Course, env);
  roster = [];
  platform = { tokens: [], assertions: [] };
});

/** The fake platform's endpoints: its JWKS, its token endpoint (checks our assertion against our JWKS), NRPS in two pages. */
const platformFetch = async (url, init = {}) => {
  if (url === `${PLATFORM}/jwks`) return Response.json({ keys: [plat.jwk] });
  if (url === `${PLATFORM}/token`) {
    const form = new URLSearchParams(init.body);
    const assertion = form.get('client_assertion');
    const ours = await (await ltiRoute(new Request(`${ORIGIN}/lti/jwks`), env, ctx, '/lti/jwks')).json();
    const claims = await verifyJwt(assertion, 'https://tool.jwks/', { fetch: async () => Response.json(ours) });
    platform.assertions.push(claims);
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('scope'), 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly');
    return Response.json({ access_token: 'nrps-token', token_type: 'Bearer', expires_in: 3600 });
  }
  if (url.startsWith(`${PLATFORM}/nrps`)) {
    assert.equal(init.headers.authorization, 'Bearer nrps-token');
    const page = url.endsWith('?p=2') ? 2 : 1;
    const members = page === 1 ? roster.slice(0, 2) : roster.slice(2);
    return Response.json({ id: url, members }, { headers: page === 1 ? { link: `<${PLATFORM}/nrps?p=2>; rel="next"` } : {} });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const admin = (method, body, headers = {}) => ltiAdmin(new Request(`${ORIGIN}/api/admin/lti`, { method, headers: { authorization: `Bearer ${ADMIN}`, ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
const REG = { name: 'State U Canvas', issuer: PLATFORM, client_id: CLIENT, deployments: [DEP], auth_url: `${PLATFORM}/auth`, token_url: `${PLATFORM}/token`, jwks_url: `${PLATFORM}/jwks` };
const register = async () => (await (await admin('POST', { action: 'put', ...REG })).json()).reg;

const route = (path, { method = 'GET', form, cookie, headers = {}, session } = {}) => {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  return ltiRoute(new Request(`${ORIGIN}${path}`, { method, headers: h, body: form ? new URLSearchParams(form).toString() : undefined }), env, ctx, path.split('?')[0], { fetch: platformFetch, session: async () => ({ session: session ? { account: session } : null }) });
};
const setCookie = (r, name) => { const c = (r.headers.getSetCookie() || []).find((x) => x.startsWith(`${name}=`)); return c || null; };
const valueOf = (c) => c.split(';')[0].split('=').slice(1).join('=');

async function login(extra = {}) {
  const q = new URLSearchParams({ iss: PLATFORM, login_hint: 'hint-1', target_link_uri: `${ORIGIN}/lti/launch`, client_id: CLIENT, lti_deployment_id: DEP, ...extra });
  const r = await route(`/lti/login?${q}`);
  assert.equal(r.status, 302, await r.clone().text());
  const to = new URL(r.headers.get('location'));
  return { to, state: to.searchParams.get('state'), nonce: to.searchParams.get('nonce'), cookie: setCookie(r, STATE_COOKIE) };
}

function claims(nonce, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: PLATFORM, aud: CLIENT, azp: CLIENT, sub: 'lms-user-1', exp: now + 300, iat: now, nonce, name: 'Sam Student',
    [`${L}message_type`]: 'LtiResourceLinkRequest', [`${L}version`]: '1.3.0', [`${L}deployment_id`]: DEP,
    [`${L}target_link_uri`]: `${ORIGIN}/lti/launch`, [`${L}resource_link`]: { id: 'rl-1' },
    [`${L}context`]: { id: 'ctx-bio201', title: 'BIO 201 · Cell Biology' }, [`${L}roles`]: [`${M}#Learner`],
    'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice': { context_memberships_url: `${PLATFORM}/nrps`, service_versions: ['2.0'] },
    ...over,
  };
}

/** A whole launch: login, the platform's signed token, the form post; returns the launch response and its ticket cookie. */
async function launch(over = {}, { signer = plat, header = {}, tamper } = {}) {
  const l = await login();
  let token = await signer.sign(claims(l.nonce, over), header);
  if (tamper) token = tamper(token);
  const r = await route('/lti/launch', { method: 'POST', form: { id_token: token, state: l.state }, cookie: `${STATE_COOKIE}=${valueOf(l.cookie)}`, headers: { origin: PLATFORM } });
  const t = setCookie(r, TICKET_COOKIE);
  return { r, ticket: t ? `${TICKET_COOKIE}=${valueOf(t)}` : null, l, token };
}
const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)[1];

async function edenCourse(owner = PROF) {
  const deps = { call: async () => ({ identities: [] }), limited: async () => {}, readBody: async (req) => JSON.parse((await req.text()) || '{}') };
  return coursesApi(new Request(`${ORIGIN}/api/chat/courses`, { method: 'POST', body: JSON.stringify({ name: 'BIO 201 in Eden' }) }), env, { account: owner }, '/api/chat/courses', deps);
}
const roleIn = async (course, account) => { const r = await env.COURSES.get(course).fetch('https://course/ping', { method: 'POST', body: JSON.stringify({ account }) }); return r.ok ? (await r.json()).role : null; };

test('registrations: the owner’s server call only; the tool JWKS has the key from the secret', async () => {
  const none = await ltiAdmin(new Request(`${ORIGIN}/api/admin/lti`, { method: 'GET' }), { ...env, LTI_ADMIN_TOKEN: '' });
  assert.equal(none.status, 503);
  assert.equal((await admin('GET', undefined, { authorization: 'Bearer wrong-wrong-wrong-wrong-wrong' })).status, 401);
  assert.equal((await admin('GET', undefined, { origin: ORIGIN })).status, 403, 'never from a web page');
  assert.equal((await admin('POST', { action: 'put', ...REG, jwks_url: 'http://canvas.test.edu/jwks' })).status, 400, 'https only');
  assert.equal((await admin('POST', { action: 'put', ...REG, deployments: [] })).status, 400);
  const reg = await register();
  assert.equal((await admin('POST', { action: 'put', ...REG })).status, 409, 'one registration per issuer and client');
  const list = await (await admin('GET')).json();
  assert.equal(list.regs[0].id, reg.id);
  assert.equal(list.tool.login, `${ORIGIN}/lti/login`);
  assert.equal(list.tool.key, true);
  const jwks = await (await route('/lti/jwks')).json();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].alg, 'RS256');
  assert.ok(jwks.keys[0].kid && !jwks.keys[0].d, 'public only');
  const empty = await ltiRoute(new Request(`${ORIGIN}/lti/jwks`), { ...env, LTI_PRIVATE_KEY: '' }, ctx, '/lti/jwks');
  assert.equal(empty.status, 503);
});

test('login initiation: registered platforms only, our launch URL only; a framed login opens a new tab; state and nonce', async () => {
  await register();
  const l = await login();
  assert.equal(l.to.origin + l.to.pathname, `${PLATFORM}/auth`);
  for (const [k, v] of [['response_type', 'id_token'], ['response_mode', 'form_post'], ['scope', 'openid'], ['prompt', 'none'], ['client_id', CLIENT], ['redirect_uri', `${ORIGIN}/lti/launch`], ['login_hint', 'hint-1']]) assert.equal(l.to.searchParams.get(k), v, k);
  assert.ok(l.state.length >= 40 && l.nonce.length >= 40 && l.state !== l.nonce);
  assert.match(l.cookie, /^__Host-eden-lti=[^;]+; Path=\/; Secure; HttpOnly; SameSite=None; Max-Age=600$/);
  const other = new URLSearchParams({ iss: 'https://moodle.elsewhere.edu', login_hint: 'x', target_link_uri: `${ORIGIN}/lti/launch` });
  assert.equal((await route(`/lti/login?${other}`)).status, 403);
  const wrongTarget = new URLSearchParams({ iss: PLATFORM, login_hint: 'x', target_link_uri: 'https://evil.example/lti/launch', client_id: CLIENT });
  assert.equal((await route(`/lti/login?${wrongTarget}`)).status, 400);
  const wrongDep = new URLSearchParams({ iss: PLATFORM, login_hint: 'x', target_link_uri: `${ORIGIN}/lti/launch`, client_id: CLIENT, lti_deployment_id: 'nope' });
  assert.equal((await route(`/lti/login?${wrongDep}`)).status, 403);
  const framed = await route(`/lti/login?${new URLSearchParams({ iss: PLATFORM, login_hint: 'hint-1', target_link_uri: `${ORIGIN}/lti/launch`, client_id: CLIENT })}`, { headers: { 'sec-fetch-dest': 'iframe' } });
  assert.equal(framed.status, 200);
  assert.equal(framed.headers.get('x-frame-options'), null);
  assert.match(framed.headers.get('content-security-policy'), /frame-ancestors https:/);
  const html = await framed.text();
  assert.match(html, /target="_blank" rel="noopener">Open Eden in a new tab/);
  assert.equal(setCookie(framed, STATE_COOKIE), null, 'no state from a frame');
  // a POSTed login works the same
  const posted = await route('/lti/login', { method: 'POST', form: { iss: PLATFORM, login_hint: 'h', target_link_uri: `${ORIGIN}/lti/launch`, client_id: CLIENT } });
  assert.equal(posted.status, 302);
});

test('the launch is checked in full: cookie, one-time state, nonce, signature, alg, iss, aud/azp, times, version, deployment', async () => {
  await register();
  const good = await launch();
  assert.equal(good.r.status, 200, await good.r.clone().text());
  assert.ok(good.ticket);
  assert.match(setCookie(good.r, TICKET_COOKIE), /SameSite=Lax; Max-Age=900/);
  assert.match(good.r.headers.get('refresh'), /url=\/lti\/continue/);
  assert.match(setCookie(good.r, STATE_COOKIE), /Max-Age=0/);

  // the same state again (a replay) finds nothing
  const replay = await route('/lti/launch', { method: 'POST', form: { id_token: good.token, state: good.l.state }, cookie: `${STATE_COOKIE}=${valueOf(good.l.cookie)}` });
  assert.equal(replay.status, 401);
  // another browser: no matching state cookie
  const l = await login();
  const t = await plat.sign(claims(l.nonce));
  assert.equal((await route('/lti/launch', { method: 'POST', form: { id_token: t, state: l.state } })).status, 401);
  assert.equal((await route('/lti/launch', { method: 'POST', form: { id_token: t, state: l.state }, cookie: `${STATE_COOKIE}=someone-elses` })).status, 401);

  const bad = async (over, opts) => (await launch(over, opts)).r.status;
  assert.equal(await bad({ nonce: 'not-the-nonce' }), 401, 'nonce');
  assert.equal(await bad({}, { signer: rogue }), 401, 'signature by a key the platform doesn’t list');
  assert.equal(await bad({}, { header: { alg: 'HS256' } }), 400, 'HMAC refused');
  assert.equal(await bad({}, { tamper: (tok) => `${b64urlText(JSON.stringify({ alg: 'none' }))}.${tok.split('.')[1]}.` }), 400, 'alg none refused');
  assert.equal(await bad({}, { tamper: (tok) => { const [h, , s] = tok.split('.'); return `${h}.${b64urlText(JSON.stringify({ ...claims('x'), sub: 'admin' }))}.${s}`; } }), 401, 'a changed body fails the signature');
  assert.equal(await bad({ iss: 'https://moodle.elsewhere.edu' }), 401, 'iss');
  assert.equal(await bad({ aud: 'another-tool', azp: 'another-tool' }), 401, 'aud');
  assert.equal(await bad({ aud: [CLIENT, 'another-tool'], azp: 'another-tool' }), 401, 'azp with several audiences');
  assert.equal(await bad({ exp: Math.floor(Date.now() / 1000) - 120 }), 401, 'expired');
  assert.equal(await bad({ iat: Math.floor(Date.now() / 1000) - 3600 }), 401, 'issued too long ago');
  assert.equal(await bad({ iat: Math.floor(Date.now() / 1000) + 600 }), 401, 'issued in the future');
  assert.equal(await bad({ [`${L}version`]: '1.1' }), 401, 'version');
  assert.equal(await bad({ [`${L}deployment_id`]: 'unregistered' }), 401, 'deployment');
  assert.equal(await bad({ [`${L}message_type`]: 'LtiSubmissionReviewRequest' }), 401, 'message type');
  assert.equal(await bad({ [`${L}target_link_uri`]: 'https://evil.example/' }), 401, 'target');
  assert.equal(await bad({ sub: '' }), 401, 'anonymous launch');
  assert.equal(await bad({ [`${L}context`]: undefined }), 401, 'outside a course');
});

test('roles come from context membership only', () => {
  assert.equal(roleOf([`${M}#Instructor`]), 'instructor');
  assert.equal(roleOf([`${M}/Instructor#TeachingAssistant`, `${M}#Instructor`]), 'ta');
  assert.equal(roleOf(['http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor', `${M}#Learner`]), 'learner', 'an institution role isn’t a role in this course');
  assert.equal(roleOf(['Instructor']), 'learner', 'short names don’t count');
  assert.equal(roleOf(undefined), 'learner');
  assert.throws(() => checkClaims({ iss: 'x' }, { reg: { issuer: 'y' }, nonce: 'n', origin: ORIGIN }), { status: 401 });
});

test('a professor links the LMS course; students join with the age check; TAs become TAs; one Eden account per LMS user', async () => {
  await register();
  const course = await edenCourse();
  // signed out: off to sign in, back here after
  const prof = await launch({ sub: 'lms-prof', name: 'Dr. Rivera', [`${L}roles`]: [`${M}#Instructor`] });
  const out = await route('/lti/continue', { cookie: prof.ticket });
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), '/signin?return=%2Flti%2Fcontinue');
  // a student before the course is linked
  const early = await launch();
  assert.match(await (await route('/lti/continue', { cookie: early.ticket, session: STUDENT })).text(), /hasn’t connected this course/);
  // the professor picks their Eden course
  const page = await (await route('/lti/continue', { cookie: prof.ticket, session: PROF })).text();
  assert.match(page, new RegExp(`value="${course.id}"`));
  const csrf = csrfOf(page);
  assert.equal((await route('/lti/continue', { method: 'POST', cookie: prof.ticket, session: PROF, form: { csrf, action: 'link', course: course.id } })).status, 403, 'no Origin: refused');
  assert.equal((await route('/lti/continue', { method: 'POST', cookie: prof.ticket, session: PROF, headers: { origin: ORIGIN }, form: { csrf: 'wrong', action: 'link', course: course.id } })).status, 403, 'wrong CSRF value');
  // someone else's Eden course can't be linked
  const theirs = await edenCourse(OTHER);
  assert.equal((await route('/lti/continue', { method: 'POST', cookie: prof.ticket, session: PROF, headers: { origin: ORIGIN }, form: { csrf, action: 'link', course: theirs.id } })).status, 403);
  const linked = await route('/lti/continue', { method: 'POST', cookie: prof.ticket, session: PROF, headers: { origin: ORIGIN }, form: { csrf, action: 'link', course: course.id } });
  assert.equal(linked.status, 200);
  assert.match(await linked.text(), /Connected/);

  // a student: the age check, then the course
  const s = await launch();
  const sp = await (await route('/lti/continue', { cookie: s.ticket, session: STUDENT })).text();
  assert.match(sp, /13 or older/);
  const sc = csrfOf(sp);
  assert.equal((await route('/lti/continue', { method: 'POST', cookie: s.ticket, session: STUDENT, headers: { origin: ORIGIN }, form: { csrf: sc, action: 'link', course: course.id } })).status, 403, 'a learner can’t link');
  assert.equal((await route('/lti/continue', { method: 'POST', cookie: s.ticket, session: STUDENT, headers: { origin: ORIGIN }, form: { csrf: sc, action: 'join' } })).status, 400, 'no age confirmation');
  const joined = await route('/lti/continue', { method: 'POST', cookie: s.ticket, session: STUDENT, headers: { origin: ORIGIN }, form: { csrf: sc, action: 'join', age13: 'yes' } });
  assert.equal(joined.status, 303);
  assert.equal(joined.headers.get('location'), `/edu#/course/${course.id}`);
  assert.equal(await roleIn(course.id, STUDENT), 'student');
  // the same LMS user can't be connected to a second Eden account
  const again = await launch();
  assert.equal((await route('/lti/continue', { cookie: again.ticket, session: OTHER })).status, 409);

  // a TA in the LMS joins as a TA
  const ta = await launch({ sub: 'lms-ta', [`${L}roles`]: [`${M}/Instructor#TeachingAssistant`] });
  const tp = await (await route('/lti/continue', { cookie: ta.ticket, session: TA })).text();
  assert.match(tp, /as a TA/);
  await route('/lti/continue', { method: 'POST', cookie: ta.ticket, session: TA, headers: { origin: ORIGIN }, form: { csrf: csrfOf(tp), action: 'join' } });
  assert.equal(await roleIn(course.id, TA), 'ta');

  // the professor coming back sees the sync button; Names and Roles maps the class list
  roster = [
    { user_id: 'lms-prof', roles: [`${M}#Instructor`], status: 'Active', name: 'Dr. Rivera' },
    { user_id: 'lms-user-1', roles: [`${M}#Learner`], status: 'Active', name: 'Sam Student' },
    { user_id: 'lms-ta2', roles: [`${M}#Instructor`], status: 'Active', name: 'Pat Co-teacher' },
    { user_id: 'lms-gone', roles: [`${M}#Learner`], status: 'Inactive' },
  ];
  // Pat opened Eden once as a learner in another section… simulate an existing link and a student membership
  await env.COURSES.get('lti:registry').fetch('https://course/lti-user-put', { method: 'POST', body: JSON.stringify({ key: `${(await (await admin('GET')).json()).regs[0].id}|lms-ta2`, account: OTHER }) });
  const back = await launch({ sub: 'lms-prof', [`${L}roles`]: [`${M}#Instructor`] });
  const bp = await (await route('/lti/continue', { cookie: back.ticket, session: PROF })).text();
  assert.match(bp, /Sync the class list/);
  const synced = await route('/lti/continue', { method: 'POST', cookie: back.ticket, session: PROF, headers: { origin: ORIGIN }, form: { csrf: csrfOf(bp), action: 'sync' } });
  const sh = await synced.text();
  assert.equal(synced.status, 200, sh);
  assert.match(sh, /3 people in State U Canvas; 3 have opened Eden\. 1 joined the Eden course and 1 became TAs/);
  assert.equal(await roleIn(course.id, OTHER), 'ta');
  assert.equal(platform.assertions[0].iss, CLIENT);
  assert.equal(platform.assertions[0].aud, `${PLATFORM}/token`);
  // a student can't sync
  const s2 = await launch();
  const s2p = await (await route('/lti/continue', { cookie: s2.ticket, session: STUDENT })).text();
  assert.doesNotMatch(s2p, /Sync/);
});

test('deep linking: the professor picks a course; the platform gets a JWT it can verify against our JWKS', async () => {
  await register();
  const course = await edenCourse();
  const dl = await launch({
    sub: 'lms-prof', [`${L}roles`]: [`${M}#Instructor`], [`${L}message_type`]: 'LtiDeepLinkingRequest', [`${L}resource_link`]: undefined, [`${L}target_link_uri`]: `${ORIGIN}/lti/launch`,
    'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings': { deep_link_return_url: `${PLATFORM}/courses/1/deep_linking_response`, accept_types: ['ltiResourceLink'], data: 'opaque-123' },
  });
  assert.equal(dl.r.status, 200, await dl.r.clone().text());
  const page = await (await route('/lti/continue', { cookie: dl.ticket, session: PROF })).text();
  assert.match(page, /Which Eden course/);
  assert.equal((await route('/lti/continue', { method: 'POST', cookie: dl.ticket, session: PROF, headers: { origin: ORIGIN }, form: { csrf: csrfOf(page), action: 'link', course: course.id } })).status, 400, 'a deep link launch answers with a deep link');
  const res = await route('/lti/continue', { method: 'POST', cookie: dl.ticket, session: PROF, headers: { origin: ORIGIN }, form: { csrf: csrfOf(page), action: 'deeplink', course: course.id } });
  const html = await res.text();
  assert.equal(res.status, 200, html);
  assert.match(res.headers.get('content-security-policy'), /form-action 'self' https:\/\/canvas\.test\.edu/);
  assert.match(html, /<form method="post" action="https:\/\/canvas\.test\.edu\/courses\/1\/deep_linking_response">/);
  const jwt = /name="JWT" value="([^"]+)"/.exec(html)[1];
  const ours = await (await route('/lti/jwks')).json();
  const c = await verifyJwt(jwt, 'https://tool.jwks/dl', { fetch: async () => Response.json(ours) });
  assert.equal(c.iss, CLIENT);
  assert.deepEqual(c.aud, [PLATFORM]);
  assert.equal(c[`${L}message_type`], 'LtiDeepLinkingResponse');
  assert.equal(c[`${L}deployment_id`], DEP);
  assert.equal(c['https://purl.imsglobal.org/spec/lti-dl/claim/data'], 'opaque-123');
  const item = c['https://purl.imsglobal.org/spec/lti-dl/claim/content_items'][0];
  assert.equal(item.type, 'ltiResourceLink');
  assert.equal(item.url, `${ORIGIN}/lti/launch`);
  // the ticket is spent; the LMS course now opens the Eden course for students
  assert.equal((await route('/lti/continue', { cookie: dl.ticket, session: PROF })).status, 401);
  const s = await launch();
  assert.match(await (await route('/lti/continue', { cookie: s.ticket, session: STUDENT })).text(), /Join the Eden course/);
  // a learner can't deep link
  const ldl = await launch({ [`${L}message_type`]: 'LtiDeepLinkingRequest', 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings': { deep_link_return_url: `${PLATFORM}/r` } });
  assert.match(await (await route('/lti/continue', { cookie: ldl.ticket, session: STUDENT })).text(), /Only the course’s instructors/);
});

test('the Worker sends /lti/* here before its cross-site and GET-only rules; the registry object is no course', async () => {
  await register();
  const jwks = await worker.fetch(new Request(`${ORIGIN}/lti/jwks`), env, ctx);
  assert.equal(jwks.status, 200);
  const posted = await worker.fetch(new Request(`${ORIGIN}/lti/launch`, { method: 'POST', headers: { origin: PLATFORM, 'content-type': 'application/x-www-form-urlencoded' }, body: 'id_token=x.y.z&state=abc' }), env, ctx);
  assert.equal(posted.status, 401, 'reached the launch (no state cookie), not refused as cross-site');
  assert.match(await posted.text(), /didn’t start that launch/);
  const adminRes = await worker.fetch(new Request(`${ORIGIN}/api/admin/lti`, { headers: { authorization: `Bearer ${ADMIN}` } }), env, ctx);
  assert.equal(adminRes.status, 200);
  const course = await edenCourse();
  const r = await env.COURSES.get(course.id).fetch('https://course/lti-reg-list', { method: 'POST', body: '{}' });
  assert.equal(r.status, 404, 'a course object never answers registry ops');
});
