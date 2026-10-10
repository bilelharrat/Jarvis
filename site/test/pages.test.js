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
  assert.match(home.headers.get('content-security-policy'), /^default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;/);
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
  for (const must of ['Harrat Global Holdings, Inc.', 'support@askeden.com', 'October 7, 2026', 'Limited Use', 'Stripe', 'Cloudflare', 'Moonshot', 'don’t sell']) assert.ok(privacy.includes(must), must);
  assert.match(pub('terms/index.html'), /Delaware/);
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
  const cookie = await signedIn();
  const app = await worker.fetch(new Request(`${ORIGIN}/edu`, { headers: { cookie: `__Host-eden=${cookie}` } }), env, {});
  assert.equal(await app.text(), 'asset /eden/edu');
  assert.match(app.headers.get('content-security-policy'), /script-src 'self'/);
  const home = read('public/edu-home/index.html');
  assert.match(home, /href="\/signin\?return=%2Fedu"/);
  assert.doesNotMatch(home, OTHER_SCRIPT);
});

test('the site pages in French: /lang/ serves the language script and each page\'s dictionary, nothing else; every page names one that exists', async () => {
  const pages = ['home/index.html', 'signin/index.html', 'link/index.html', 'jarvis/index.html', 'daredevil/index.html', 'privacy/index.html', 'terms/index.html', 'edu-home/index.html', 'edu-home/privacy.html', 'edu-home/terms.html'];
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
  assert.doesNotMatch(sec, /\bEden\b/);
  assert.ok(words.includes('EVES checks the web when needed and says when it isn’t sure; the models answered directly from memory.'));
  assert.ok(!sec.includes('$'), 'no "$" in the section');
  assert.doesNotMatch(sec, /\b(cost|costs|price|prices|spend|spent|budget)\b/i);
  assert.doesNotMatch(sec, /eval\/|\.mjs|\.jsonl|analysis\.json|askeden\/|src\//);
  assert.doesNotMatch(sec, /\sstyle=|<script|\son[a-z]+=/i);
  // French: the section's English strings have their French in fr-home.js (the film itself is English)
  const fr = read('public/lang/fr-home.js');
  for (const x of ['Fewer made-up answers.', 'We asked EVES, our fact-checker, and three leading AI models the same 432 factual questions. EVES made something up the least often.',
    words, 'Learn more', 'about how we measured it']) assert.ok(fr.includes(`'${x}'`), x);
  assert.match(fr, /'Accuracy': '/);
  assert.doesNotMatch(read('public/home/home.css'), /\.acc-/);      // the chart's own styles are not in the page's stylesheet any more
  // on /accuracy the comparison names EVES too, and its row wears the glass EVES pill with the green check
  assert.equal((acc.match(/\bEden\b/g) || []).length, 5, 'on /accuracy "Eden" is only the site brand (title, site name, header link) and "Eden’s answering and fact-checking system"');
  assert.doesNotMatch(acc, /Eden (made|did|declines|asked|picked|sent|is tested)/);
  for (const f of ['public/jarvis/eves-pill.svg', 'public/jarvis/eves-pill-dark.svg']) {           // the word and the green check
    assert.match(read(f), />EVES</, f);
    assert.match(read(f), /<polyline[^>]*stroke="#fff"/, f);
  }
  assert.match(read('public/accuracy/accuracy.css'), /\.row\.eden \.name::before\{[^}]*url\(\/jarvis\/eves-pill\.svg\)/);
});
