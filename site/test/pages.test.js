// askeden.com's pages by who's signed in (src/eden/pages.js): the landing page with "Sign in
// to Eden" at / signed out, the sign-in page at /signin (and back to / once signed in), Eden at
// / signed in; and the sign-in page's files staying inside its strict CSP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://askeden.com';
const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');

let env;
const realFetch = globalThis.fetch;

beforeEach(() => {
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.assets = [];
  env.ASSETS = {
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      env.assets.push(p);
      return new Response(`asset ${p}`, { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=0, must-revalidate' } });
    },
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

function hit(p, { method = 'GET', body, session, token, headers = {} } = {}) {
  const h = { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15', ...headers };
  if (method !== 'GET' && token === undefined) h.origin = ORIGIN;
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, { waitUntil() {} });
}

const setCookies = (r) => r.headers.getSetCookie();

/** An iPhone's account, and a browser it approved: that browser's session cookie value. */
async function signedIn() {
  const made = await (await hit('/api/account/apple', {
    method: 'POST',
    token: null,
    body: { identity_token: await identityToken({ sub: 'pages-user' }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } },
  })).json();
  const start = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await start.json();
  const linkCookie = setCookies(start).find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  const approved = await hit(`/api/link/${link.code}/approve`, { method: 'POST', token: made.token, body: { sealed_key: null, sender_key: null } });
  assert.equal(approved.status, 200, await approved.clone().text());
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: linkCookie } });
  return setCookies(done).find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
}

// /signin adds only Turnstile's script and frame (accounts/turnstile.js) and its own form posts.
const SIGNIN = /^default-src 'none'; script-src 'self' https:\/\/challenges\.cloudflare\.com; frame-src https:\/\/challenges\.cloudflare\.com; style-src 'self'; img-src 'self' data:;/;

// The front, legal and Education pages run the language script (public/lang/site-i18n.js), never inline; the front page also runs the
// films' script (public/home/features.js).
const OTHER_SCRIPT = /<script(?! src="\/lang\/site-i18n\.js" data-page="[a-z-]+"><\/script>)(?! src="\/home\/features\.js" defer><\/script>)/i;
const LANG_ONLY = /script-src 'self'; /;

test('signed out, / is Eden\'s front page (its own CSP, only the language script), never cached, varying by cookie', async () => {
  const home = await hit('/');
  assert.equal(home.status, 200);
  assert.deepEqual(env.assets, ['/home/']);
  assert.match(home.headers.get('content-security-policy'), /^default-src 'none'; script-src 'self'; style-src 'self' https:\/\/fonts\.googleapis\.com; font-src https:\/\/fonts\.gstatic\.com; img-src 'self' data:;/);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal(home.headers.get('vary'), 'cookie');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.deepEqual(setCookies(home), [], 'no cookie, nothing to clear');
  // /download and /jarvis are the same page, cacheable as before.
  const download = await hit('/download');
  assert.equal(env.assets.at(-1), '/jarvis/');
  assert.notEqual(download.headers.get('cache-control'), 'no-store');
  // Eden's own files stay closed.
  assert.equal((await hit('/app.js')).status, 401);
  assert.equal((await hit('/index.html')).status, 200);
  assert.equal(env.assets.at(-1), '/home/');
});

test('the front page shows the plans: Free and Eden Plus, with the Worker\'s own numbers, and /pricing goes there', async () => {
  const pricing = await hit('/pricing');
  assert.equal(pricing.status, 302);
  assert.equal(pricing.headers.get('location'), '/#pricing');
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'home', 'index.html'), 'utf8');
  assert.match(html, /<a href="#pricing">Pricing<\/a>/);
  assert.match(html, /id="pricing"/);
  const { PLUS_PRICE_USD } = await import('../src/eden/billing.js');
  const { MINUTES } = await import('../src/browser/rules.js');
  const { LIMITS } = await import('../src/accounts/account.js');
  assert.match(html, new RegExp(`<b>\\$${PLUS_PRICE_USD}</b><span>/month</span>`));
  assert.match(html, /Included AI every month<\/b>/); // no dollar figure for the allowance (the owner's choice)
  assert.match(html, /Free included AI<\/b> to try Eden/);
  assert.doesNotMatch(html, /\$\d+ of included AI/);
  assert.match(html, new RegExp(`<b>${MINUTES.free} minutes</b>`));
  assert.match(html, new RegExp(`<b>${MINUTES.plus} minutes</b>`));
  // Get Plus signs in, then opens Eden's account page at Plus (account.js #plus); never Stripe from here.
  assert.match(html, /href="\/signin\?return=%2F%23plus">Get Plus</);
  assert.doesNotMatch(html, OTHER_SCRIPT);
  assert.doesNotMatch(html, /stripe\.com/i);
  const { safeReturn } = await import('../public/signin/return.js');
  assert.equal(safeReturn('/#plus'), '/#plus');
});

test('the front page has seven short films (six features and the accuracy chart), each in its own section: muted, lazy, with a poster; its script is the site\'s own; files are served in ranges', async () => {
  const home = await hit('/');
  assert.match(home.headers.get('content-security-policy'), /; media-src 'self'; /);
  const html = read('public/home/index.html');
  const videos = html.match(/<video [^>]*>/g) || [];
  assert.equal(videos.length, 7);
  assert.deepEqual(videos.map((v) => /src="\/jarvis\/(walk-\d)\.mp4"/.exec(v)[1]).sort(), ['walk-1', 'walk-2', 'walk-3', 'walk-4', 'walk-5', 'walk-6', 'walk-7']);
  videos.forEach((v) => {
    const n = /src="\/jarvis\/walk-(\d)\.mp4"/.exec(v)[1];
    assert.match(v, new RegExp(`poster="/jarvis/walk-${n}\\.jpg"`));
    for (const attr of ['controls', 'muted', 'loop', 'playsinline']) assert.match(v, new RegExp(` ${attr}[ >]`), `${n} ${attr}`); // controls show without the script; muted, or no browser starts it
    assert.match(v, /preload="none"/);           // nothing downloads until the film is near
    assert.doesNotMatch(v, / autoplay/);          // the script starts it when it is on screen
    assert.match(v, /aria-label="[^"]{20,}"/);
  });
  assert.equal((html.match(/<section class="feature"/g) || []).length, 7);
  // sound (owner, 2026-10-09): no music, no effects; only the Voice film has audio (its two voices), so only it has a sound button
  assert.equal((html.match(/class="fbtn fsnd"/g) || []).length, 1);
  assert.match(html.split('<section class="feature"').find((sec) => sec.includes('/jarvis/walk-6.mp4')), /class="fbtn fsnd"/);
  for (let n = 1; n <= 7; n++) {
    const bytes = fs.readFileSync(path.join(SITE, `public/jarvis/walk-${n}.mp4`));
    assert.equal(bytes.includes('soun'), n === 6, `walk-${n}: an audio track only in the Voice film`);
  }
  assert.doesNotMatch(html, /\sstyle=|<script>[^<]/i);                       // no inline style, no inline script
  assert.doesNotMatch(html, /eden-ad/);                                      // the old 15-second ad (with a song) is gone from the page
  assert.ok(!fs.existsSync(path.join(SITE, 'public/jarvis/eden-ad.mp4')), 'the old ad file is not served any more');
  assert.match(html, /<script src="\/home\/features\.js" defer><\/script>/);
  // the script is served from this site, and every film and poster is there, small enough for Workers static assets (25 MiB), with the index first
  const js = await hit('/home/features.js');
  assert.equal(js.status, 200);
  assert.equal(env.assets.at(-1), '/home/features.js');
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
  for (let n = 1; n <= 7; n++) {
    for (const f of [`public/jarvis/walk-${n}.mp4`, `public/jarvis/walk-${n}.jpg`]) {
      const size = fs.statSync(path.join(SITE, f)).size;
      assert.ok(size > 10_000 && size < 25 * 1024 * 1024, `${f}: ${size} bytes`);
    }
    const head = fs.readFileSync(path.join(SITE, `public/jarvis/walk-${n}.mp4`)).subarray(0, 262144);
    assert.ok(head.includes('moov'), `walk-${n}: the mp4 index must be at the start of the file`);
    assert.ok(!head.includes('mdat') || head.indexOf('moov') < head.indexOf('mdat'));
  }
  // byte ranges (Safari won't play a video that is not served in them): the ASSETS stand-in here answers `asset /jarvis/walk-1.mp4`
  const whole = 'asset /jarvis/walk-1.mp4';
  const part = await hit('/jarvis/walk-1.mp4', { headers: { range: 'bytes=0-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-4/${whole.length}`);
  assert.equal(part.headers.get('accept-ranges'), 'bytes');
  assert.equal(await part.text(), whole.slice(0, 5));
  const tail = await hit('/jarvis/walk-6.mp4', { headers: { range: 'bytes=-3' } });
  assert.equal(tail.status, 206);
  assert.equal(await tail.text(), 'asset /jarvis/walk-6.mp4'.slice(-3));
  assert.equal((await hit('/jarvis/walk-1.mp4', { headers: { range: `bytes=${whole.length}-` } })).status, 416);
  const all = await hit('/jarvis/walk-2.mp4');
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('accept-ranges'), 'bytes');
});

test('the front page names its company: the footer line and an "Ask Eden by" line, spelled as the legal pages spell it', () => {
  const html = read('public/home/index.html');
  assert.match(html, /<footer>\s*<span>© 2026 Harrat Global Holdings, Inc\.<\/span>/);
  assert.match(html, /<p class="by">Ask Eden by Harrat Global Holdings, Inc\.<\/p>/);
  assert.doesNotMatch(html, /© 2026 Eden</);
  assert.match(read('public/privacy/index.html'), /Harrat Global Holdings, Inc\./);
});

test('a session cookie that no longer works is cleared at / and at /signin', async () => {
  for (const p of ['/', '/signin']) {
    const res = await hit(p, { session: 'jv1.not-a-real.session' });
    assert.equal(res.status, 200, p);
    assert.ok(setCookies(res).some((c) => /^__Host-eden=; .*Max-Age=0/.test(c)), p);
  }
});

test('/signin is the sign-in page with its strict CSP; its files are served, nothing else under it', async () => {
  for (const p of ['/signin', '/signin/']) {
    env.assets.length = 0;
    const res = await hit(p);
    assert.equal(res.status, 200, p);
    assert.deepEqual(env.assets, ['/signin/']);
    assert.match(res.headers.get('content-security-policy'), SIGNIN);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('vary'), 'cookie');
  }
  assert.equal((await hit('/signin/signin.js')).status, 200);
  assert.equal((await hit('/signin/signin.css')).status, 200);
  assert.equal((await hit('/signin/other.js')).status, 302);
});

test('a sign-in that came back to / with ?error= is shown on the sign-in page', async () => {
  const res = await hit('/?error=cancelled&provider=google');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/signin?error=cancelled&provider=google');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('signed in, / is Eden and /signin goes back to /', async () => {
  const session = await signedIn();
  env.assets.length = 0;
  const eden = await hit('/', { session });
  assert.equal(eden.status, 200);
  assert.deepEqual(env.assets, ['/eden/']);
  assert.match(eden.headers.get('content-security-policy'), /^default-src 'self'; script-src 'self';/);
  assert.equal(eden.headers.get('vary'), 'cookie');
  assert.equal(eden.headers.get('cache-control'), 'no-store');
  const signin = await hit('/signin', { session });
  assert.equal(signin.status, 302);
  assert.equal(signin.headers.get('location'), '/');
  assert.equal(signin.headers.get('vary'), 'cookie');
  assert.equal((await hit('/?error=cancelled', { session })).status, 200, 'signed in: Eden, whatever the query');
  assert.equal((await hit('/app.js', { session })).status, 200);
});

test('the sign-in page keeps to its CSP: no inline script or style, nothing from elsewhere', () => {
  const html = read('public/signin/index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline <script>');
  assert.doesNotMatch(html, /<style|\sstyle=/i, 'no inline styles (style-src self)');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no on…= handlers');
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//i, 'nothing from another origin');
  // The three ways in.
  assert.match(html, /href="\/api\/web\/apple"[^>]*>[\s\S]*?Continue with Apple/);
  assert.match(html, /href="\/api\/web\/google"[^>]*>[\s\S]*?Continue with Google/);
  assert.match(html, /Approve from your iPhone/);
  const js = read('public/signin/signin.js');
  for (const call of ['/api/web/config', '/api/web/link', '/api/web/link/poll']) assert.ok(js.includes(`'${call}'`), call);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/, 'text only');
});

test('the landing page has "Sign in to Eden" for the sign-in page', () => {
  const html = read('public/jarvis/index.html');
  assert.ok((html.match(/href="\/signin"[^>]*>Sign in to Eden</g) || []).length >= 1);
});

test('/privacy and /terms: everyone, static, their own strict CSP; linked from the landing page and /signin', async () => {
  for (const p of ['/privacy', '/terms']) {
    env.assets.length = 0;
    const res = await hit(p);
    assert.equal(res.status, 200, p);
    assert.deepEqual(env.assets, [`${p}/`]);
    assert.match(res.headers.get('content-security-policy'), /^default-src 'none'; script-src 'self'; style-src 'self';/);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe-inline/);
    assert.doesNotMatch(read(`public${p}/index.html`), OTHER_SCRIPT);
  }
  const pub = (f) => read(`public/${f}`);
  for (const f of ['jarvis/index.html', 'signin/index.html']) assert.match(pub(f), /href="\/privacy"[\s\S]*href="\/terms"/, f);
  const privacy = pub('privacy/index.html');
  for (const must of ['Harrat Global Holdings, Inc.', 'support@askeden.com', 'October 13, 2026', 'Limited Use', 'Stripe', 'Cloudflare', 'Moonshot', 'don’t sell']) assert.ok(privacy.includes(must), must);
  assert.match(pub('terms/index.html'), /Delaware/);
});

test('EDU_HOST: askedenedu.com serves Edu at its front; askeden.com/edu, edu.askeden.com and www forward to it', async () => {
  const on = { ...env, EDU_HOST: 'askedenedu.com' };
  const front = await worker.fetch(new Request('https://askedenedu.com/'), on, {});
  assert.equal(front.status, 200);
  assert.equal(await front.text(), 'asset /edu-home/');
  const direct = await worker.fetch(new Request('https://askedenedu.com/edu'), on, {});
  assert.equal(direct.status, 200);
  const cases = [['https://askeden.com/edu', 'https://askedenedu.com/'], ['https://askeden.com/edu/terms?x=1', 'https://askedenedu.com/edu/terms?x=1'], ['https://edu.askeden.com/', 'https://askedenedu.com/'], ['https://www.askedenedu.com/edu/privacy', 'https://askedenedu.com/edu/privacy']];
  for (const [from, to] of cases) {
    const out = await worker.fetch(new Request(from), on, {});
    assert.equal(out.status, 301, from);
    assert.equal(out.headers.get('location'), to, from);
  }
  const aasa = await worker.fetch(new Request('https://askedenedu.com/.well-known/apple-app-site-association'), on, {});
  assert.match(await aasa.text(), /com\.askeden\.edu/);
  const other = await worker.fetch(new Request('https://askeden.com/signin'), on, {});
  assert.notEqual(other.status, 301);
});

test('Eden Code\'s site: /eden-code serves it (fonts allowed, no inline script); CODE_HOST makes askedencode.com its front and forwards the page, not the downloads', async () => {
  const out = await worker.fetch(new Request(`${ORIGIN}/eden-code`), env, {});
  assert.equal(out.status, 200);
  assert.equal(await out.text(), 'asset /eden-code-home/');
  const csp = out.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  for (const host of ['askedencode.com', 'www.askedencode.com']) {
    const door = await worker.fetch(new Request(`https://${host}/anything`), env, {});
    assert.equal(door.status, 301);
    assert.equal(door.headers.get('location'), 'https://askeden.com/eden-code');
  }
  const on = { ...env, CODE_HOST: 'askedencode.com' };
  const front = await worker.fetch(new Request('https://askedencode.com/'), on, {});
  assert.equal(front.status, 200);
  assert.equal(await front.text(), 'asset /eden-code-home/');
  const cases = [['https://askeden.com/eden-code', 'https://askedencode.com/'], ['https://www.askedencode.com/x?y=1', 'https://askedencode.com/x?y=1']];
  for (const [from, to] of cases) {
    const fwd = await worker.fetch(new Request(from), on, {});
    assert.equal(fwd.status, 301, from);
    assert.equal(fwd.headers.get('location'), to, from);
  }
  const dl = await worker.fetch(new Request('https://askedencode.com/eden-code/download'), on, {});
  assert.notEqual(dl.status, 301);
  const html = read('public/eden-code-home/index.html');
  assert.doesNotMatch(html, OTHER_SCRIPT);
  assert.doesNotMatch(html, /style=|onclick=/);
  assert.equal((html.match(/<script/g) || []).length, 1); // only /home/features.js (OTHER_SCRIPT above)
  for (let n = 1; n <= 5; n++) assert.match(html, new RegExp(`src="/eden-code-home/film-${n}\\.mp4" poster="/eden-code-home/film-${n}\\.jpg"`));
  const poster = await worker.fetch(new Request(`${ORIGIN}/eden-code-home/film-3.jpg`), env, {});
  assert.equal(poster.status, 200);
  assert.match(html, /href="\/eden-code\/download"/);
  assert.match(html, /href="\/eden-code\/windows"/);
  assert.match(read('public/jarvis/index.html'), /<a href="\/eden-code">Eden Code<\/a>/);
});

test('Eden Secretary and Eden Daredevil at their own names: SECRETARY_HOST and DAREDEVIL_HOST make edensecretary.com and edendaredevil.com the fronts; askedensecretary.com forwards; unset, the names are doorways to askeden.com', async () => {
  // unset: doorways
  for (const host of ['edensecretary.com', 'www.edensecretary.com', 'askedensecretary.com', 'www.askedensecretary.com']) {
    const door = await worker.fetch(new Request(`https://${host}/x`), env, {});
    assert.equal(door.status, 301, host);
    assert.equal(door.headers.get('location'), 'https://askeden.com/eden-secretary', host);
  }
  for (const host of ['edendaredevil.com', 'www.edendaredevil.com']) {
    const door = await worker.fetch(new Request(`https://${host}/x`), env, {});
    assert.equal(door.status, 301, host);
    assert.equal(door.headers.get('location'), 'https://askeden.com/daredevil', host);
  }
  const page = await worker.fetch(new Request(`${ORIGIN}/eden-secretary`), env, {});
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'asset /eden-secretary-home/');
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
  // set
  const on = { ...env, SECRETARY_HOST: 'edensecretary.com', DAREDEVIL_HOST: 'edendaredevil.com' };
  const front = await worker.fetch(new Request('https://edensecretary.com/'), on, {});
  assert.equal(front.status, 200);
  assert.equal(await front.text(), 'asset /eden-secretary-home/');
  const cases = [
    ['https://askedensecretary.com/', 'https://edensecretary.com/'], ['https://www.askedensecretary.com/x?y=1', 'https://edensecretary.com/x?y=1'],
    ['https://www.edensecretary.com/', 'https://edensecretary.com/'], ['https://askeden.com/eden-secretary', 'https://edensecretary.com/'],
    ['https://askeden.com/daredevil', 'https://edendaredevil.com/'], ['https://www.edendaredevil.com/', 'https://edendaredevil.com/'],
  ];
  for (const [from, to] of cases) {
    const fwd = await worker.fetch(new Request(from), on, {});
    assert.equal(fwd.status, 301, from);
    assert.equal(fwd.headers.get('location'), to, from);
  }
  const dare = await worker.fetch(new Request('https://edendaredevil.com/'), on, {});
  assert.equal(dare.status, 200);
  assert.equal(await dare.text(), 'asset /daredevil/');
  for (const [host, p] of [['edensecretary.com', '/jarvis/windows'], ['edendaredevil.com', '/daredevil/windows']]) {
    const dl = await worker.fetch(new Request(`https://${host}${p}`), on, {});
    assert.notEqual(dl.status, 301, p);
  }
  const html = read('public/eden-secretary-home/index.html');
  assert.doesNotMatch(html, /<script|style=|onclick=/);
  assert.match(html, /href="\/jarvis\/download"/);
  assert.match(html, /href="\/jarvis\/windows"/);
  assert.doesNotMatch(html, /J\.A\.R\.V\.I\.S/);   // only the download paths (/jarvis/download, /jarvis/windows) keep the old word
  assert.match(read('public/jarvis/index.html'), /<a href="\/eden-secretary">Eden Secretary<\/a>/);
});

test('EVES has its own site: /eves serves it; EVES_HOST makes evesverification.com its front and edenverification.com forwards; unset, the names are doorways to the accuracy page', async () => {
  const go = async (u, e) => {
    const r = await worker.fetch(new Request(u, { redirect: 'manual' }), e, {});
    return [r.status, r.headers.get('location')];
  };
  for (const host of ['evesverification.com', 'www.evesverification.com', 'edenverification.com', 'www.edenverification.com']) assert.deepEqual(await go(`https://${host}/`, env), [301, 'https://askeden.com/accuracy'], host);
  const pg = await worker.fetch(new Request(`${ORIGIN}/eves`), env, {});
  assert.equal(pg.status, 200);
  assert.equal(await pg.text(), 'asset /eves-home/');
  assert.match(pg.headers.get('content-security-policy'), /media-src 'self'/);
  assert.doesNotMatch(pg.headers.get('content-security-policy'), /unsafe-inline/);
  const on = { ...env, EVES_HOST: 'evesverification.com' };
  const front = await worker.fetch(new Request('https://evesverification.com/'), on, {});
  assert.equal(await front.text(), 'asset /eves-home/');
  for (const [from, to] of [['https://edenverification.com/x?y=1', 'https://evesverification.com/x?y=1'], ['https://www.evesverification.com/', 'https://evesverification.com/'], ['https://askeden.com/eves', 'https://evesverification.com/']]) assert.deepEqual(await go(from, on), [301, to], from);
  const html = read('public/eves-home/index.html');
  assert.doesNotMatch(html, OTHER_SCRIPT);
  assert.doesNotMatch(html, /style=|onclick=|\$\d/);
  // the numbers are the accuracy page's (the same 432 questions), with the limits next to them
  const acc = read('public/accuracy/index.html');
  for (const n of ['9.7%', '18.3%', '21.8%', '24.5%', '7.3%–12.9%', '14.9%–22.2%', '18.1%–25.9%', '20.7%–28.8%', '20.6%', '69.7%']) { assert.ok(html.includes(n), n); }
  assert.ok(acc.includes('9.7%') && acc.includes('24.5%'));
  assert.match(html, /EVES declines more often/);
  assert.match(html, /doesn’t show that EVES beats one/);
  assert.match(html, /answered from memory/);
});

test('askeden.ai and www.askeden.ai forward to askeden.com, keeping path and query', async () => {
  for (const host of ['askeden.ai', 'www.askeden.ai']) {
    const out = await worker.fetch(new Request(`https://${host}/edu?x=1`), env, {});
    assert.equal(out.status, 301);
    assert.equal(out.headers.get('location'), 'https://askeden.com/edu?x=1');
  }
});

test('Eden for Education: /edu is its landing page signed out (only the language script), its app signed in; edu.askeden.com forwards there', async () => {
  const out = await worker.fetch(new Request(`${ORIGIN}/edu`), env, {});
  assert.equal(out.status, 200);
  assert.equal(await out.text(), 'asset /edu-home/');
  assert.match(out.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(out.headers.get('content-security-policy'), LANG_ONLY);
  assert.doesNotMatch(out.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal(out.headers.get('cache-control'), 'no-store');
  const css = await worker.fetch(new Request(`${ORIGIN}/edu-home/edu-home.css`), env, {});
  assert.equal(css.status, 200);
  const edu = await worker.fetch(new Request('https://edu.askeden.com/anything'), env, {});
  assert.equal(edu.status, 301);
  assert.equal(edu.headers.get('location'), 'https://askeden.com/edu');
  for (const host of ['askedenedu.com', 'www.askedenedu.com']) {
    const door = await worker.fetch(new Request(`https://${host}/anything`), env, {});
    assert.equal(door.status, 301);
    assert.equal(door.headers.get('location'), 'https://askeden.com/edu');
  }
  const cookie = await signedIn();
  const app = await worker.fetch(new Request(`${ORIGIN}/edu`, { headers: { cookie: `__Host-eden=${cookie}` } }), env, {});
  assert.equal(await app.text(), 'asset /eden/edu');
  assert.match(app.headers.get('content-security-policy'), /script-src 'self'/);
  const home = read('public/edu-home/index.html');
  assert.match(home, /href="\/signin\?return=%2Fedu"/);
  assert.doesNotMatch(home, OTHER_SCRIPT);
});

test('the site pages in French: /lang/ serves the language script and each page\'s dictionary, nothing else; every page names one that exists', async () => {
  const pages = ['home/index.html', 'signin/index.html', 'link/index.html', 'jarvis/index.html', 'daredevil/index.html', 'privacy/index.html', 'terms/index.html', 'edu-home/index.html', 'edu-home/privacy.html', 'edu-home/terms.html', 'travel-home/index.html'];
  for (const f of pages) {
    const html = read(`public/${f}`);
    const m = /<script src="\/lang\/site-i18n\.js" data-page="([a-z-]+)"><\/script>/.exec(html);
    assert.ok(m, `${f} loads the language script`);
    assert.ok(fs.existsSync(path.join(SITE, `public/lang/fr-${m[1]}.js`)), `${f}: fr-${m[1]}.js`);
    assert.match(html, /data-lang-switch/, `${f} has the EN · FR switch`);
    const res = await hit(`/lang/fr-${m[1]}.js`);
    assert.equal(res.status, 200, m[1]);
    assert.equal(await res.text(), `asset /lang/fr-${m[1]}.js`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal(await (await hit('/lang/site-i18n.js')).text(), 'asset /lang/site-i18n.js');
  assert.notEqual((await hit('/lang/other.js')).status, 200);
  // the legal translations say the English text governs, and keep the company's name
  for (const f of ['privacy', 'terms', 'edu-privacy', 'edu-terms']) {
    const fr = read(`public/lang/fr-${f}.js`);
    assert.ok(fr.includes('Traduction fournie pour information ; en cas de divergence, la version anglaise fait foi.'), f);
  }
  for (const f of ['privacy', 'terms']) assert.ok(read(`public/lang/fr-${f}.js`).includes('Harrat Global Holdings, Inc.'), f);
});

test('/accuracy: the hallucination chart and how it was measured, for everyone, no sign-in, no script, no prices', async () => {
  for (const p of ['/accuracy', '/accuracy/']) {
    env.assets.length = 0;
    const res = await hit(p);
    assert.equal(res.status, 200, p);
    assert.deepEqual(env.assets, ['/accuracy/']);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.match(res.headers.get('content-security-policy'), /^default-src 'none'; script-src 'self'; style-src 'self';/);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe-inline/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(res.headers.get('vary'), null, 'the same page signed in or out');
    assert.deepEqual(setCookies(res), []);
  }
  const css = await hit('/accuracy/accuracy.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await hit('/accuracy/other.css')).status, 302, 'nothing else under it');

  const html = read('public/accuracy/index.html');
  assert.match(html, /<title>How often AI makes things up · Eden<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/askeden\.com\/accuracy">/);
  for (const og of ['og:title', 'og:description', 'og:url', 'og:image']) assert.match(html, new RegExp(`<meta property="${og}" content="[^"]+">`), og);
  assert.match(html, /<link rel="stylesheet" href="\/accuracy\/accuracy\.css">/);
  // the chart: three views, four rows each, intervals and sample sizes; its notes; its link to the method
  assert.equal((html.match(/<li class="row/g) || []).length, 12);
  for (const must of ['How often AI answers make things up', '9.7%', '7.3%–12.9%', 'n=432', 'n=300', 'n=132', "didn't answer 21%",
    'Gemini 3.1 Pro (preview) and Gemini 3.8 Flash got more questions right than EVES did', 'used the web on 41%',
    'without OpenAI', 'Kimi K3']) assert.ok(html.includes(must), must);
  assert.match(html, /<a href="#method">How we measured this<\/a>/);
  assert.match(html, /<section class="method-s" id="method"/);
  // the method credits both question sets, with their licences
  assert.match(html, /href="https:\/\/huggingface\.co\/datasets\/google\/simpleqa-verified"/);
  assert.match(html, /Google DeepMind and Google Research/);
  assert.match(html, /MIT licence/);
  assert.match(html, /href="https:\/\/github\.com\/Mamin78\/MHFPQ"/);
  assert.match(html, /CC BY 4\.0/);
  // no prices, costs or internals; no script, no inline style (the policy allows neither)
  assert.ok(!html.includes('$'), 'no "$" anywhere on the page');
  assert.doesNotMatch(html, /\b(cost|costs|price|prices|spend|spent|budget)\b/i);
  assert.doesNotMatch(html, /eval\/|\.mjs|\.jsonl|analysis\.json|askeden\/|src\//);
  assert.doesNotMatch(html, /<script|\sstyle=|\son[a-z]+=/i);
  // linked from the front page's footer
  assert.match(read('public/home/index.html'), /<footer>[\s\S]*<a href="\/accuracy">Accuracy<\/a>[\s\S]*<\/footer>/);
});

test('the front page\'s accuracy section: the chart is a film (walk-7) with the same numbers as /accuracy in words, EVES by name, French, and Learn more to /accuracy', async () => {
  const html = read('public/home/index.html');
  const m = /<section class="feature" id="f-accuracy" aria-labelledby="f-accuracy-h">([\s\S]*?)<\/section>/.exec(html);
  assert.ok(m, 'the section is there');
  const sec = m[1];
  // a core feature: in the features, right after the first one (before "Several models"), not above the hero
  const at = html.indexOf('id="f-accuracy"');
  assert.ok(html.indexOf('id="f-ask"') < at && at < html.indexOf('id="f-several"'));
  assert.match(sec, /<h2 id="f-accuracy-h">Fewer made-up answers\.<\/h2>/);
  assert.match(sec, /<a class="btn" href="\/accuracy">Learn more<span class="sr"> about how we measured it<\/span><\/a>/);
  assert.equal((await hit('/accuracy')).status, 200);
  // the film: the same size and markup as the other films, described by the text below it
  assert.match(sec, /<video class="fv" src="\/jarvis\/walk-7\.mp4" poster="\/jarvis\/walk-7\.jpg" width="1280" height="720"[^>]* aria-describedby="f-accuracy-what"/);
  assert.match(sec, /<figure class="fvid">/);
  // the same numbers as /accuracy's "All 432" view, in words
  const acc = read('public/accuracy/index.html');
  const all = acc.slice(acc.indexOf('<div class="view view-all">'), acc.indexOf('<div class="view view-sqa">'));
  const want = [...all.matchAll(/<li class="row[^"]*" title="([^:]+): ([\d.]+)% made up \(\d+ of 432\); 95% interval ([\d.]+)%–([\d.]+)%">/g)];
  assert.equal(want.length, 4);
  assert.deepEqual(want.map((w) => w[1]), ['EVES', 'Gemini 3.1 Pro (preview)', 'Gemini 3.8 Flash', 'Claude Sonnet 5.5']);
  const words = /<p class="sr" id="f-accuracy-what">([^<]*)<\/p>/.exec(sec)[1];
  for (const w of want) assert.ok(words.includes(`${w[1]} ${w[2]}% (`) && words.includes(`${w[3]}% to ${w[4]}%`), w[1]);
  // the comparison names EVES (never "Eden" or "Eden with EVES"); the honest caption stays; nothing beyond the numbers
  assert.ok(sec.includes('We asked EVES (Eden’s verification and evaluation system) and three leading AI models'));   // the owner's wording: what EVES is, once
  assert.doesNotMatch(sec.replace('(Eden’s verification and evaluation system)', ''), /\bEden\b/);   // otherwise the comparison says EVES, never Eden
  assert.ok(words.includes('EVES checks the web when needed and says when it isn’t sure; the models answered directly from memory.'));
  assert.ok(!sec.includes('$'), 'no "$" in the section');
  assert.doesNotMatch(sec, /\b(cost|costs|price|prices|spend|spent|budget)\b/i);
  assert.doesNotMatch(sec, /eval\/|\.mjs|\.jsonl|analysis\.json|askeden\/|src\//);
  assert.doesNotMatch(sec, /\sstyle=|<script|\son[a-z]+=/i);
  // French: the section's English strings have their French in fr-home.js (the film itself is English)
  const fr = read('public/lang/fr-home.js');
  for (const x of ['Fewer made-up answers.', 'We asked EVES (Eden’s verification and evaluation system) and three leading AI models the same 432 factual questions. EVES made something up the least often.',
    words, 'Learn more', 'about how we measured it']) assert.ok(fr.includes(`'${x}'`), x);
  assert.match(fr, /'Accuracy': '/);
  assert.doesNotMatch(read('public/home/home.css'), /\.acc-/);      // the chart's own styles are not in the page's stylesheet any more
  // on /accuracy the comparison names EVES too, and its row wears the glass EVES pill with the green check
  assert.equal((acc.match(/\bEden\b/g) || []).length, 7, 'on /accuracy "Eden" is only the site brand (title, site name, header link x2) and the owner\'s definition "Eden’s verification and evaluation system" (description, lead, method)');

  assert.doesNotMatch(acc, /Eden (made|did|declines|asked|picked|sent|is tested)/);
  for (const f of ['public/jarvis/eves-pill.svg', 'public/jarvis/eves-pill-dark.svg']) {           // the word and the green check
    assert.match(read(f), />EVES</, f);
    assert.match(read(f), /<polyline[^>]*stroke="#fff"/, f);
  }
  assert.match(read('public/accuracy/accuracy.css'), /\.row\.eden \.name::before\{[^}]*url\(\/jarvis\/eves-pill\.svg\)/);
});

test('the protective names are doorways: askeden.net/.org and the router names to askeden.com, the Eden Code names to Eden Code, evesverification.com to the accuracy page', async () => {
  const go = async (u, e = env) => {
    const r = await worker.fetch(new Request(u, { redirect: 'manual' }), e, {});
    return [r.status, r.headers.get('location')];
  };
  for (const [from, to] of [
    ['https://askeden.net/', 'https://askeden.com/'], ['https://www.askeden.org/x?y=1', 'https://askeden.com/x?y=1'],
    ['https://edencode.dev/?q=1', 'https://askeden.com/eden-code?q=1'], ['https://www.edencode.app/', 'https://askeden.com/eden-code'],
    ['https://codewitheden.com/', 'https://askeden.com/eden-code'],
    ['https://evesverification.com/', 'https://askeden.com/accuracy'], ['https://www.evesverification.com/x', 'https://askeden.com/accuracy'],
  ]) assert.deepEqual(await go(from, { ...env, CODE_HOST: '' }), [301, to], from);
  assert.deepEqual(await go('https://edencode.dev/?q=1', { ...env, CODE_HOST: 'askedencode.com' }), [301, 'https://askedencode.com/?q=1']);
});

test('Eden Router has its own site: ROUTER_HOST makes edenrouter.com the front, askedenrouter.com forwards, /router is public, and unset the names are doorways', async () => {
  const go = async (u, e) => {
    const r = await worker.fetch(new Request(u, { redirect: 'manual' }), e, {});
    return [r.status, r.headers.get('location')];
  };
  for (const host of ['edenrouter.com', 'www.edenrouter.com', 'askedenrouter.com', 'www.askedenrouter.com']) assert.deepEqual(await go(`https://${host}/`, env), [301, 'https://askeden.com/'], host);
  const on = { ...env, ROUTER_HOST: 'edenrouter.com' };
  assert.deepEqual(await go('https://askedenrouter.com/x?y=1', on), [301, 'https://edenrouter.com/x?y=1']);
  assert.deepEqual(await go('https://www.edenrouter.com/', on), [301, 'https://edenrouter.com/']);
  for (const [u, e] of [['https://edenrouter.com/', on], [`${ORIGIN}/router`, on]]) {
    const r = await worker.fetch(new Request(u), e, {});
    assert.equal(r.status, 200, u);
    assert.equal(env.assets.at(-1), '/router/', u);
  }
  const html = read('public/router/index.html'); // the page itself: no script, no inline style (HOME_CSP)
  assert.match(html, /Eden Router/);
  assert.match(html, /href="\/router\/router\.css"/);
  assert.doesNotMatch(html, /<script(?![^>]*src="\/(router\/router|home\/features)\.js")|style="/);   // the page's own script and the films' player
  assert.match(html, /src="\/router\/film\.mp4" poster="\/router\/film\.jpg" width="1280" height="720" controls muted loop playsinline preload="none"/);
  assert.doesNotMatch(html, / autoplay/);
  for (const f of ['film.mp4', 'film.jpg']) assert.ok(fs.statSync(path.join(SITE, `public/router/${f}`)).size > 10_000 && fs.statSync(path.join(SITE, `public/router/${f}`)).size < 25 * 1024 * 1024, f);
  assert.ok(fs.readFileSync(path.join(SITE, 'public/router/film.mp4')).subarray(0, 262144).includes('moov'), 'film.mp4: the index must be at the start');
  const range = await worker.fetch(new Request(`${ORIGIN}/router/film.mp4`, { headers: { range: 'bytes=0-4' } }), on, {});
  assert.equal(range.status, 206);
  const css = await worker.fetch(new Request(`${ORIGIN}/router/router.css`), on, {});
  assert.equal(css.status, 200);
});

test('Eden Router\'s page is held: without ROUTER_HOST /router is not served', async () => {
  const r = await worker.fetch(new Request(`${ORIGIN}/router`), env, {});
  assert.notEqual(env.assets.at(-1), '/router/');
  assert.notEqual(r.status, 200);
});

test('Eden Mail: /mail is its page signed out and the app signed in; MAIL_HOST puts the page at askedenmail.com and forwards the rest', async () => {
  const out = await worker.fetch(new Request(`${ORIGIN}/mail`), env, {});
  assert.equal(out.status, 200);
  assert.equal(await out.text(), 'asset /mail-home/');
  assert.match(out.headers.get('content-security-policy'), /script-src 'self'/);
  const cookie = await signedIn();
  const app = await worker.fetch(new Request(`${ORIGIN}/mail`, { headers: { cookie: `__Host-eden=${cookie}` } }), env, {});
  assert.equal(await app.text(), 'asset /eden/');
  for (const f of ['mail-home.css', 'icon.png', 'mail-logo.svg']) assert.equal((await worker.fetch(new Request(`${ORIGIN}/mail-home/${f}`), env, {})).status, 200, f);
  // unset: askedenmail.com is a doorway to askeden.com/mail
  const door = await worker.fetch(new Request('https://www.askedenmail.com/anything'), env, {});
  assert.equal(door.status, 301);
  assert.equal(door.headers.get('location'), 'https://askeden.com/mail');
  const on = { ...env, MAIL_HOST: 'askedenmail.com' };
  const front = await worker.fetch(new Request('https://askedenmail.com/'), on, {});
  assert.equal(front.status, 200);
  assert.equal(await front.text(), 'asset /mail-home/');
  // signed in or not, askedenmail.com's front is the page (its cookie is askeden.com's)
  assert.equal(await (await worker.fetch(new Request('https://askedenmail.com/', { headers: { cookie: `__Host-eden=${cookie}` } }), on, {})).text(), 'asset /mail-home/');
  assert.equal((await worker.fetch(new Request('https://askedenmail.com/mail-home/mail-home.css'), on, {})).status, 200);
  const cases = [['https://www.askedenmail.com/', 'https://askedenmail.com/'], ['https://askedenmail.com/signin?return=%2Fmail', 'https://askeden.com/signin?return=%2Fmail'], ['https://askedenmail.com/privacy', 'https://askeden.com/privacy']];
  for (const [from, to] of cases) {
    const res = await worker.fetch(new Request(from), on, {});
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
  const page = read('public/mail-home/index.html');
  assert.match(page, /href="https:\/\/askeden\.com\/signin\?return=%2Fmail"/);
  assert.doesNotMatch(page, /<script/);
  // signed in, /mail is Mail alone: no chat, sidebar or inspector around it, and it can't be closed (askeden web/chat)
  assert.match(read('public/eden/util.js'), /export const MAIL_ONLY = [^\n]*location\.pathname === '\/mail'/);
  assert.match(read('public/eden/mail.css'), /html\.mail-only #app[^{]*\{display:none!important\}/);
  assert.match(read('public/eden/panels.js'), /if \(mailOnly && openKey === 'mail'\) return false;/);
  // and at /mail its API is the site's (/api/chat/…), not /mail/api/… (which answers with a page: "Unexpected token '<'")
  const root = (p) => p.replace(/\/chat(?:\/.*)?$/, '').replace(/\/[^/]*\.html?$/, '').replace(/^\/mail$/, '').replace(/\/$/, '');
  assert.ok(read('public/eden/api.js').includes(".replace(/^\\/mail$/, '')"));
  assert.equal(root('/mail'), '');
  assert.equal(root('/'), '');
});

test('Ask Eden Travel has its own site, held: without TRAVEL_HOST nothing is served and askedentravel.com is a doorway; with it, askedentravel.com is the front', async () => {
  const go = async (u, e) => {
    const r = await worker.fetch(new Request(u, { redirect: 'manual' }), e, {});
    return [r.status, r.headers.get('location')];
  };
  // held: the page, its files and the names all stay off (DEPLOY_FREEZE, the owner's word)
  assert.doesNotMatch(read('wrangler.toml'), /^\s*TRAVEL_HOST\s*=/m, 'TRAVEL_HOST stays commented out until the owner says go');
  assert.doesNotMatch(read('wrangler.toml'), /^\s*\{ pattern = "(www\.)?askedentravel\.com/m, 'askedentravel.com routes stay commented out');
  for (const host of ['askedentravel.com', 'www.askedentravel.com']) assert.deepEqual(await go(`https://${host}/`, env), [301, 'https://askeden.com/'], host);
  for (const p of ['/travel', '/travel-home/travel-home.css', '/travel-home/features.js']) {
    env.assets.length = 0;
    await worker.fetch(new Request(`${ORIGIN}${p}`), env, {});
    assert.ok(!env.assets.includes('/travel-home/') && !env.assets.includes(p), p);
  }
  // on
  const on = { ...env, TRAVEL_HOST: 'askedentravel.com' };
  const front = await worker.fetch(new Request('https://askedentravel.com/'), on, {});
  assert.equal(front.status, 200);
  assert.equal(await front.text(), 'asset /travel-home/');
  const csp = front.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  for (const [from, to] of [['https://www.askedentravel.com/?a=1', 'https://askedentravel.com/?a=1'], [`${ORIGIN}/travel`, 'https://askedentravel.com/'], ['https://askedentravel.com/signin', 'https://askeden.com/signin']]) assert.deepEqual(await go(from, on), [301, to], from);
  for (const p of ['/travel-home/travel-home.css', '/travel-home/features.js', '/travel-home/eden-logo.svg', '/lang/fr-travel-home.js']) {
    const r = await worker.fetch(new Request(`https://askedentravel.com${p}`), on, {});
    assert.equal(r.status, 200, p);
    assert.equal(await r.text(), `asset ${p}`, p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
  }
  for (const f of ['travel-home.css', 'features.js', 'eden-logo.svg']) assert.ok(fs.existsSync(path.join(SITE, 'public/travel-home', f)), f);

  // the page: no inline script or style, its own script and the language script only; one h1, the skip link, the landmarks
  const html = read('public/travel-home/index.html');
  assert.doesNotMatch(html, /style=|onclick=|<style/i);
  for (const m of html.matchAll(/<script[^>]*>/g)) assert.ok(['<script src="/travel-home/features.js" defer>', '<script src="/lang/site-i18n.js" data-page="travel-home">'].includes(m[0]), m[0]);
  assert.equal(html.match(/<h1[\s>]/g).length, 1);
  assert.match(html, /<body>\s*<a class="skip" href="#main">/);
  assert.match(html, /<main id="main">/);
  for (const tag of ['header', 'footer']) assert.match(html, new RegExp(`<${tag}[\\s>]`), tag);
  for (const m of html.matchAll(/<nav[^>]*>/g)) assert.match(m[0], /aria-label="[^"]+"/, m[0]);
  assert.ok(!/<h4/.test(html), 'headings never skip a level');
  // honest claims: it isn't open, the preview says it's illustrative, the numbers carry their source and caveat, no prices
  assert.match(html, /Coming soon/);
  assert.match(html, /Illustrative sample trip/);
  assert.match(html, /not live data/);
  for (const n of ['27%', '16%', '10%', '55%', '485', '16.2%']) assert.ok(html.includes(n), n);
  assert.match(html, /Greetwell survey, August 2026/);
  assert.match(html, /Send My Bag, October 2026/);
  assert.match(html, /self-reported surveys; Eden didn’t run them/);
  assert.doesNotMatch(html, /\$\d|free trial|J\.A\.R\.V\.I\.S|Jarvis/i);
  assert.match(html, /EVES \(Eden’s verification and evaluation system\)/);   // EVES spelled out on first use
  assert.equal((html.match(/Coming later/g) || []).length, 2);                // booking and the pickup link come after the planner
  // the CSS: the cursor stops under reduced motion; 40px targets
  const css = read('public/travel-home/travel-home.css');
  assert.match(css, /prefers-reduced-motion:reduce\)\{[^\n]*h1 u\{animation:none\}/);
  assert.match(css, /\.days button\{min-height:40px/);
  // the French covers the page: every English key in fr-travel-home.js is on the page
  const fr = read('public/lang/fr-travel-home.js');
  const text = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  for (const m of fr.matchAll(/^ {4}'([^']+)':/gm)) assert.ok(text.includes(m[1]) || html.includes(`"${m[1]}"`), `fr-travel-home.js: "${m[1]}" isn't on the page`);
});
