// Eden Travel's private beta (travel/beta.js): invites (one email or open, expiry, uses), the gate on the API and the page,
// the waitlist (stored, nothing sent), "Something's wrong" reports (checked context, trip details only with consent, a
// picture typed by its first bytes and kept in chunks, open/done), and the feature counts (allowlisted names only).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/accounts/util.js';
import {
  BETA_CSP, CODE_LEN, FEATURES, REPORTS_A_DAY, adminTravelBeta, betaApi, betaGuard, betaHtml, betaIndexOp, betaPage, cleanContext,
  forgetMember, imageType, normCode, travelGate, usage,
} from '../src/travel/beta.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86400_000;
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';

function index() {
  const m = new Map();
  const clock = { t: T0 };
  const storage = {
    get: async (k) => m.get(k),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix, limit }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit || Infinity)),
  };
  const obj = { m, storage, now: () => clock.t, clock };
  const askIndex = async (_env, op, body = {}) => betaIndexOp(obj, op, structuredClone(body));
  return { ...obj, askIndex };
}
const ON = { TRAVEL_BETA: '1' };
const noOwner = async () => null;
const req = (url, init = {}) => new Request(url, init);
const ident = (emails) => async () => ({ identities: emails.map((email) => ({ email })) });

test('a person’s own object refuses the index ops', async () => {
  const x = index();
  x.m.set('account', { id: A1 });
  await assert.rejects(betaIndexOp(x, 'tbeta-invite-list', {}), (e) => e.status === 404);
});

test('invites: open code, uses counted, expiry, revoke; one-email code needs that email', async () => {
  const x = index();
  const { invite } = await x.askIndex({}, 'tbeta-invite-create', { days: 7, max_uses: 2, note: 'friends' });
  assert.equal(invite.code.length, CODE_LEN);
  assert.equal(invite.state, 'open');
  assert.match(invite.shown, /^[a-z0-9]{4}-[a-z0-9]{4}$/);
  // typed loosely: upper case, a dash, spaces
  assert.deepEqual(await x.askIndex({}, 'tbeta-redeem', { account: A1, code: ` ${invite.shown.toUpperCase()} ` }), { ok: true });
  assert.equal((await x.askIndex({}, 'tbeta-member', { account: A1 })).member, true);
  assert.equal((await x.askIndex({}, 'tbeta-redeem', { account: A1, code: invite.code })).already, true); // no second use
  await x.askIndex({}, 'tbeta-redeem', { account: A2, code: invite.code });
  await assert.rejects(x.askIndex({}, 'tbeta-redeem', { account: '33333333-3333-4333-8333-333333333333', code: invite.code }), (e) => e.code === 'used_up');
  // expiry
  const b = (await x.askIndex({}, 'tbeta-invite-create', { days: 1 })).invite;
  x.clock.t += 2 * DAY;
  await assert.rejects(x.askIndex({}, 'tbeta-redeem', { account: '44444444-4444-4444-8444-444444444444', code: b.code }), (e) => e.code === 'expired');
  // revoked
  const c = (await x.askIndex({}, 'tbeta-invite-create', {})).invite;
  await x.askIndex({}, 'tbeta-invite-revoke', { code: c.code });
  await assert.rejects(x.askIndex({}, 'tbeta-redeem', { account: '55555555-5555-4555-8555-555555555555', code: c.code }), (e) => e.status === 404);
  // for one email
  const d = (await x.askIndex({}, 'tbeta-invite-create', { email: 'Ana@Example.com' })).invite;
  assert.equal(d.email, 'ana@example.com');
  await assert.rejects(x.askIndex({}, 'tbeta-invite-create', { email: 'a@b.co', max_uses: 3 }), (e) => e.status === 400);
  await assert.rejects(x.askIndex({}, 'tbeta-redeem', { account: '66666666-6666-4666-8666-666666666666', code: d.code, emails: ['other@example.com'] }), (e) => e.code === 'other_email');
  await x.askIndex({}, 'tbeta-redeem', { account: '66666666-6666-4666-8666-666666666666', code: d.code, emails: ['ana@example.com'] });
  const list = (await x.askIndex({}, 'tbeta-invite-list')).invites;
  assert.deepEqual(list.map((i) => i.state).sort(), ['expired', 'revoked', 'used', 'used']);
  assert.equal((await x.askIndex({}, 'tbeta-members')).members.length, 3);
  // bad inputs
  await assert.rejects(x.askIndex({}, 'tbeta-invite-create', { days: 0 }), (e) => e.status === 400);
  await assert.rejects(x.askIndex({}, 'tbeta-invite-create', { max_uses: 500 }), (e) => e.status === 400);
  await assert.rejects(x.askIndex({}, 'tbeta-redeem', { account: A1.replace('1111', 'zzzz'), code: d.code }), (e) => e.status === 400);
});

test('the gate: off without TRAVEL_BETA; refuses a non-member; lets a member and the owner in', async () => {
  forgetMember();
  const x = index();
  const r = req('https://askedentravel.com/api/chat/travel');
  await betaGuard(r, {}, { account: A1 }, { askIndex: x.askIndex, owner: noOwner }); // off: nothing asked
  await assert.rejects(betaGuard(r, ON, { account: A1 }, { askIndex: x.askIndex, owner: noOwner }), (e) => e instanceof ApiError && e.status === 403 && e.code === 'beta_invite');
  await betaGuard(r, ON, { account: A1 }, { askIndex: x.askIndex, owner: async () => ({ account: A1 }) }); // the owner
  const { invite } = await x.askIndex({}, 'tbeta-invite-create', {});
  await x.askIndex({}, 'tbeta-redeem', { account: A2, code: invite.code });
  forgetMember();
  await betaGuard(r, ON, { account: A2 }, { askIndex: x.askIndex, owner: noOwner });
  // the page: the beta page for a non-member, null (the app) for a member or with the beta off
  const page = await travelGate(req('https://askedentravel.com/'), ON, { account: A1 }, { askIndex: x.askIndex, owner: noOwner });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Eden Travel is in private beta/);
  assert.equal(await travelGate(req('https://askedentravel.com/'), ON, { account: A2 }, { askIndex: x.askIndex, owner: noOwner }), null);
  assert.equal(await travelGate(req('https://askedentravel.com/'), {}, { account: A1 }, {}), null);
});

test('the beta page: no script, no inline style, escaped, French by Accept-Language', async () => {
  const r = req('https://askeden.com/travel/beta?code=%3Cscript%3E', { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } });
  const res = betaHtml(r, ON, { signedIn: true, code: '<script>', note: '<b>x</b>' });
  const html = await res.text();
  assert.equal(res.headers.get('content-security-policy'), BETA_CSP);
  assert.doesNotMatch(html, /<script|style=|<b>x/);
  assert.match(html, /bêta privée/);
  assert.match(html, /&lt;b&gt;x/);
  const out = await betaHtml(req('https://askeden.com/travel/beta'), ON, {}).text();
  assert.match(out, /Sign in to use an invite/);
  assert.doesNotMatch(out, /name="code"/); // signed out: no code box, a sign-in link
});

const form = (url, fields, headers = {}) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: new URL(url).origin, ...headers }, body: new URLSearchParams(fields).toString() });

test('the page’s forms: waitlist stored (nothing sent), redeem goes to the app, wrong code says why, other sites refused', async () => {
  forgetMember();
  const x = index();
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { fetched.push(a); throw new Error('no network in this test'); };
  try {
    const deps = { askIndex: x.askIndex, owner: noOwner, slowDown: async () => {}, currentSession: async () => ({ session: null }) };
    const w = await betaPage(form('https://askedentravel.com/travel/beta/waitlist', { email: 'Sam@example.org' }), ON, '/travel/beta/waitlist', deps);
    assert.match(await w.text(), /You’re on the list/);
    assert.equal(x.m.get('bw:sam@example.org').email, 'sam@example.org');
    const bad = await betaPage(form('https://askedentravel.com/travel/beta/waitlist', { email: 'nope' }), ON, '/travel/beta/waitlist', deps);
    assert.equal(bad.status, 400);
    assert.equal(fetched.length, 0); // nothing sent anywhere
    const elsewhere = await betaPage(form('https://askedentravel.com/travel/beta/waitlist', { email: 'a@b.co' }, { origin: 'https://evil.example' }), ON, '/travel/beta/waitlist', deps);
    assert.equal(elsewhere.status, 403);
    // redeem, signed in
    const signed = { ...deps, currentSession: async () => ({ session: { account: A1, token: {} } }), call: ident(['me@example.com']) };
    const wrong = await betaPage(form('https://askedentravel.com/travel/beta/redeem', { code: 'zzzz-zzzz' }), ON, '/travel/beta/redeem', signed);
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /isn’t one we know/);
    const { invite } = await x.askIndex({}, 'tbeta-invite-create', {});
    const ok = await betaPage(form('https://askedentravel.com/travel/beta/redeem', { code: invite.shown }), ON, '/travel/beta/redeem', signed);
    assert.equal(ok.status, 303);
    assert.equal(new URL(ok.headers.get('location')).pathname, '/travel');
    assert.equal(x.m.get(`bm:${A1}`).email, 'me@example.com');
    // GET as a member: straight to the app; beta off: /travel
    const again = await betaPage(req('https://askedentravel.com/travel/beta'), ON, '/travel/beta', signed);
    assert.equal(again.status, 302);
    assert.equal((await betaPage(req('https://askedentravel.com/travel/beta'), {}, '/travel/beta', signed)).status, 302);
    assert.equal(await betaPage(req('https://askedentravel.com/travel'), ON, '/travel', signed), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(300_000).fill(7)]).toString('base64');

test('reports: checked context, trip only with consent, picture by its bytes and in chunks, open/done, a daily cap', async () => {
  forgetMember();
  const x = index();
  const { invite } = await x.askIndex({}, 'tbeta-invite-create', {});
  await x.askIndex({}, 'tbeta-redeem', { account: A1, code: invite.code });
  const deps = { askIndex: x.askIndex, owner: noOwner, call: ident(['me@example.com']), limited: async () => {}, readBody: async (r) => r.json() };
  const post = (args) => betaApi(req('https://askedentravel.com/api/chat/travel/beta', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }, body: JSON.stringify({ action: 'feedback', args }) }), ON, { account: A1, token: {} }, deps);
  const context = { view: 'workspace', trip: 'a1b2c3d4e5f60718', day: 2, errors: ['plus_required', 'x'.repeat(500)], version: 'web 2026.10.28', host: 'askedentravel.com', path: '/', viewport: '390x844', extra: 'dropped', place: 'Lisbon' };
  const trip = { title: 'Lisbon', days: [{ stops: [{ name: 'Jerónimos Monastery' }] }] };
  const a = await (await post({ text: 'The map went blank after I moved a stop.', context, consent: false, trip })).json();
  const ra = x.m.get(`bf:${a.id}`);
  assert.equal(ra.trip, null); // no consent: no trip details
  assert.equal(ra.consent, false);
  assert.equal(ra.context.trip, 'a1b2c3d4e5f60718');
  assert.equal(ra.context.errors[1].length, 160);
  assert.equal('extra' in ra.context || 'place' in ra.context, false);
  assert.equal(ra.email, 'me@example.com');
  assert.equal(ra.device, 'iphone');
  assert.equal(ra.status, 'open');
  const b = await (await post({ text: 'Booking button did nothing', context, consent: true, trip, image: { data: PNG } })).json();
  const rb = x.m.get(`bf:${b.id}`);
  assert.deepEqual(rb.trip, trip);
  assert.equal(rb.image.type, 'image/png');
  assert.equal(rb.image.bytes, 300_008);
  assert.ok([...x.m.keys()].filter((k) => k.startsWith(`bfi:${b.id}:`)).length >= 4); // chunked under the 128 KiB value limit
  for (const [k, v] of x.m) if (k.startsWith('bfi:')) assert.ok(v.length <= 96_000);
  // not a picture
  await assert.rejects(post({ text: 'see this', image: { data: Buffer.from('<svg onload=alert(1)>').toString('base64') } }), (e) => e.code === 'bad_type');
  await assert.rejects(post({ text: '' }), (e) => e.status === 400);
  // the owner's dashboard: list, picture, done
  const owner = { askIndex: x.askIndex, owner: async () => ({ account: A2 }), usage: async () => ({ ready: false }) };
  const dash = await (await adminTravelBeta(req('https://askeden.com/api/admin/travel-beta'), ON, '/api/admin/travel-beta', owner)).json();
  assert.equal(dash.feedback.length, 2);
  assert.equal(dash.feedback[0].id, b.id); // newest first
  assert.equal(JSON.stringify(dash.feedback).includes(PNG.slice(0, 40)), false); // pictures aren't in the list
  const img = await adminTravelBeta(req(`https://askeden.com/api/admin/travel-beta/image?id=${b.id}`), ON, '/api/admin/travel-beta/image', owner);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await img.arrayBuffer()).byteLength, 300_008);
  const done = await (await adminTravelBeta(req('https://askeden.com/api/admin/travel-beta', { method: 'POST', body: JSON.stringify({ action: 'feedback-status', id: a.id, status: 'done', note: 'fixed in 0.3' }) }), ON, '/api/admin/travel-beta', owner)).json();
  assert.equal(done.report.status, 'done');
  assert.equal(done.report.note, 'fixed in 0.3');
  // anyone else: 404
  assert.equal((await adminTravelBeta(req('https://askeden.com/api/admin/travel-beta'), ON, '/api/admin/travel-beta', { owner: noOwner })).status, 404);
  // a daily cap per account
  for (let i = 2; i < REPORTS_A_DAY; i++) await post({ text: `report ${i}` });
  await assert.rejects(post({ text: 'one more' }), (e) => e.status === 429);
  // a non-member can't send one while the beta is on
  forgetMember();
  await assert.rejects(betaApi(req('https://askedentravel.com/api/chat/travel/beta', { method: 'POST', body: JSON.stringify({ action: 'feedback', args: { text: 'hello there' } }) }), ON, { account: A2, token: {} }, deps), (e) => e.code === 'beta_invite');
});

test('the owner makes an invite from the dashboard: link on the travel address', async () => {
  const x = index();
  const owner = { askIndex: x.askIndex, owner: async () => ({ account: A2 }) };
  const out = await (await adminTravelBeta(req('https://askeden.com/api/admin/travel-beta', { method: 'POST', body: JSON.stringify({ action: 'invite-create', email: 'ana@example.com', days: 14 }) }), { ...ON, TRAVEL_HOST: 'askedentravel.com' }, '/api/admin/travel-beta', owner)).json();
  assert.equal(out.url, `https://askedentravel.com/travel/beta?code=${out.invite.code}`);
  assert.equal(out.invite.by, `owner (${A2.slice(0, 8)})`);
  const bad = await adminTravelBeta(req('https://askeden.com/api/admin/travel-beta', { method: 'POST', body: JSON.stringify({ action: 'invite-create', days: 900 }) }), ON, '/api/admin/travel-beta', owner);
  assert.equal(bad.status, 400);
});

test('usage: only allowlisted feature names, counts capped, no content', async () => {
  const rows = [];
  const out = await usage({ STATS_SALT: 's' }, { account: A1 }, { 'view:map': 3, plan: 1, 'Lisbon castle': 2, 'trip:a1b2c3d4e5f60718': 1, open: 5000, ask: -1, film: 1.5 }, { device: 'iphone', record: async (_e, ev) => { rows.push(ev); } });
  assert.equal(out.counted, 3);
  assert.deepEqual(rows.map((r) => [r.name, r.tin]), [['view:map', 3], ['plan', 1], ['open', 200]]);
  for (const r of rows) {
    assert.equal(r.kind, 'tfeature');
    assert.equal(r.product, 'travel');
    assert.match(r.user, /^[0-9a-f]{16}$/); // stats.js's scrambled tag, never the account id
    assert.equal(Object.keys(r).some((k) => ['country', 'city', 'region', 'detail'].includes(k)), false);
  }
  assert.ok(FEATURES.has('feedback'));
});

test('helpers: image type by bytes, context cleaning, code normalising', () => {
  assert.equal(imageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
  assert.equal(imageType(Uint8Array.from(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))), 'image/webp');
  assert.equal(imageType(Uint8Array.from(Buffer.from('\0\0\0\x18ftypheic\0\0'))), 'image/heic');
  assert.equal(imageType(Uint8Array.from(Buffer.from('GIF89a......'))), null);
  assert.deepEqual(cleanContext({ view: '<img>', trip: 'nothex', day: 500, path: 'javascript:alert(1)' }), { view: null, trip: null, shared: false, day: null, errors: [], version: null, host: null, path: null, standalone: false, offline: false, viewport: null });
  assert.equal(normCode(' AB3D-K9MX '), 'ab3dk9mx');
});
