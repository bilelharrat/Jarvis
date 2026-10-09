// The Windows downloads behind askeden.com routes (GitHub pre-releases in the Jarvis repo, like Ask Eden for
// Mac), J.A.R.V.I.S. Daredevil's page, and the buttons for them on the front page and the apps page.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import worker, { WINDOWS, askEdenAssets, windowsInstaller } from '../src/worker.js';

// The repo's owner is whoever Ask Eden for Mac already names: not spelled again here.
const BASE = new URL(askEdenAssets().zip).pathname.split('/').slice(1, 3).join('/'); // owner/repo
const asset = (tag, file) => `https://github.com/${BASE}/releases/download/${tag}/${file}`;
const get = (path, env = {}, init = {}) => worker.fetch(new Request(`https://askeden.com${path}`, init), env, {});
const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');

const ROUTES = {
  '/download/windows': 'ask-eden',
  '/eden-code/windows': 'eden-code',
  '/jarvis/windows': 'jarvis',
  '/daredevil/windows': 'daredevil',
  '/jarvis/daredevil': 'daredevil',
};

test('each Windows address redirects to its installer, a file of a GitHub pre-release', async () => {
  for (const [path, key] of Object.entries(ROUTES)) {
    const res = await get(path);
    assert.equal(res.status, 302, path);
    const { tag, file } = WINDOWS[key];
    assert.equal(res.headers.get('location'), asset(tag, file), path);
    assert.match(file, /^[\w.-]+-x64\.exe$/, path);
    assert.ok(file.includes(WINDOWS[key].version), `${path}: the file is of the version named`);
    assert.ok(tag.endsWith(`-v${WINDOWS[key].version}`), `${path}: the tag is of the version named`);
  }
});

test('J.A.R.V.I.S. Daredevil has an installer of its own, not J.A.R.V.I.S.\'s', async () => {
  const jarvis = (await get('/jarvis/windows')).headers.get('location');
  const dare = (await get('/daredevil/windows')).headers.get('location');
  assert.notEqual(dare, jarvis);
  assert.match(dare, /Daredevil-Setup/);
  assert.equal((await get('/jarvis/daredevil')).headers.get('location'), dare);
});

test('wrangler.toml may name another tag and file, and only plain ones count', () => {
  const other = windowsInstaller('jarvis', { WINDOWS_JARVIS_TAG: 'jarvis-windows-v0.2.0', WINDOWS_JARVIS_FILE: 'J-A-R-V-I-S--Setup-0.2.0-x64.exe' });
  assert.equal(other.url, asset('jarvis-windows-v0.2.0', 'J-A-R-V-I-S--Setup-0.2.0-x64.exe'));
  assert.deepEqual([other.version, other.size], ['', 0], 'a build the code does not know has no version or size to show');
  for (const bad of [{ WINDOWS_JARVIS_TAG: '../evil' }, { WINDOWS_JARVIS_FILE: 'run.sh' }, { WINDOWS_JARVIS_FILE: '../x.exe' }, { WINDOWS_JARVIS_TAG: 'a/b' }]) {
    assert.equal(windowsInstaller('jarvis', bad).url, windowsInstaller('jarvis').url, JSON.stringify(bad));
  }
});

test('/windows/latest.json says each installer\'s version and size, for the page', async () => {
  const res = await get('/windows/latest.json');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /json/);
  const info = await res.json();
  assert.deepEqual(Object.keys(info).sort(), ['ask-eden', 'daredevil', 'eden-code', 'jarvis']);
  for (const [key, one] of Object.entries(info)) {
    assert.equal(one.version, WINDOWS[key].version);
    assert.ok(one.size > 50e6, `${key}: ${one.size}`);
  }
});

test('only a plain read of a Windows address is answered', async () => {
  assert.equal((await get('/download/windows', {}, { method: 'POST' })).status, 405);
  assert.equal((await get('/download/windows', {}, { method: 'HEAD' })).status, 302);
});

test('/daredevil is its page, with the landing pages\' policy, and opens in the browser from an iPhone', async () => {
  const seen = [];
  const env = { ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('<html>page</html>', { headers: { 'content-type': 'text/html' } }); } } };
  const res = await get('/daredevil', env);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['/daredevil/']);
  assert.match(res.headers.get('content-security-policy'), /fonts\.googleapis\.com/);
  const links = await (await get('/.well-known/apple-app-site-association')).json();
  const eden = links.applinks.details.find((d) => d.appIDs.some((id) => id.endsWith('.com.askeden.eden')));
  assert.ok(eden.components.some((c) => c['/'] === '/daredevil*' && c.exclude === true));
});

// ── the buttons ──

test('the front page: download for Mac and for Windows, and a slot of its own for J.A.R.V.I.S. Daredevil', () => {
  const html = read('home/index.html');
  for (const href of ['/download/mac', '/download/windows', '/daredevil/windows', '/daredevil', '/download', '/signin']) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
  assert.match(html, /Download for Windows/);
  assert.match(html, /J\.A\.R\.V\.I\.S\. Daredevil/);
  // its policy allows no script and no inline style (default-src 'none'; style-src 'self')
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /<style/);
  assert.match(html, /<html lang="en">/);
});

test('the front page can be read by a screen reader: landmarks, headings in order, names for every link', () => {
  const html = read('home/index.html');
  assert.match(html, /<main[ >]/);
  assert.match(html, /<header/);
  assert.match(html, /<footer/);
  const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
  assert.equal(levels[0], 1);
  for (let i = 1; i < levels.length; i += 1) assert.ok(levels[i] <= levels[i - 1] + 1, `heading levels jump: ${levels.join(',')}`);
  assert.equal(levels.filter((l) => l === 1).length, 1, 'one h1');
  // a link that is only an image or an icon has a name
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)) {
    const text = m[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<img[^>]*>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    assert.ok(text.length > 0 || /aria-label=/.test(m[0]), `a link with no name: ${m[0].slice(0, 80)}`);
  }
  // icons that only decorate are hidden from a screen reader
  for (const m of html.matchAll(/<svg\b[^>]*>/g)) assert.match(m[0], /aria-hidden="true"/, m[0]);
});

test('the apps page: Windows downloads beside the Mac ones, and J.A.R.V.I.S. Daredevil', () => {
  const html = read('jarvis/index.html');
  for (const href of ['/jarvis/windows', '/eden-code/windows', '/download/windows', '/daredevil/windows', '/daredevil', '/jarvis/download', '/eden-code/download', '/download/mac']) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
  assert.match(html, /<a class="home" href="\/">Eden home<\/a>/); // (kept: eden.test.js)
  assert.match(html, /Windows 10 or 11/);
});

test('J.A.R.V.I.S. Daredevil\'s page: a skip link, landmarks, the download, the guide, and nothing to hide', () => {
  const html = read('daredevil/index.html');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<a class="skip" href="#main">/);
  assert.match(html, /<main id="main"/);
  assert.match(html, /<h1>[^<]*Daredevil/);
  assert.ok(html.includes('href="/daredevil/windows"'));
  for (const word of ['NVDA', 'JAWS', 'Narrator', 'Outlook', 'punctuation', 'Ctrl+Alt+J', 'More info', 'Run anyway']) assert.ok(html.includes(word), word);
  const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
  assert.equal(levels.filter((l) => l === 1).length, 1, 'one h1');
  for (let i = 1; i < levels.length; i += 1) assert.ok(levels[i] <= levels[i - 1] + 1, `heading levels jump: ${levels.join(',')}`);
  for (const m of html.matchAll(/<svg\b[^>]*>/g)) assert.match(m[0], /aria-hidden="true"/, m[0]);
  for (const m of html.matchAll(/<img\b[^>]*>/g)) assert.match(m[0], /\balt=/, m[0]);
});
