// The built-in browser's everyday logic (app/browser-lib.js): node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const lib = require('../../app/browser-lib.js');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) J.A.R.V.I.S./0.1.0 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36';

test('the user agent loses the app’s name and Electron, and nothing else', () => {
  assert.equal(lib.cleanUserAgent(UA, 'J.A.R.V.I.S.'),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36');
  assert.equal(lib.cleanUserAgent('Mozilla/5.0 Chrome/1 Safari/537.36', 'J.A.R.V.I.S.'), 'Mozilla/5.0 Chrome/1 Safari/537.36');
  assert.ok(!lib.cleanUserAgent(UA.replace('J.A.R.V.I.S.', 'JaRViS'), 'J.A.R.V.I.S.').includes('Electron'));
  assert.equal(lib.cleanUserAgent(UA, 'J.A.R.V.I.S.').includes('JARVIS'), false);
  assert.equal(lib.cleanUserAgent('', 'x'), '');
});

test('a real popup is window.open with window features; a link or a bare window.open is a tab', () => {
  assert.equal(lib.isPopup({ url: 'https://accounts.google.com/o/oauth2', disposition: 'new-window', features: 'width=500,height=600' }), true);
  assert.equal(lib.isPopup({ url: 'about:blank', disposition: 'new-window', features: 'popup' }), true, 'a blank one its opener writes');
  assert.equal(lib.isPopup({ url: 'https://example.com', disposition: 'foreground-tab', features: '' }), false, 'target=_blank');
  assert.equal(lib.isPopup({ url: 'https://example.com', disposition: 'new-window', features: '' }), false, 'shift-click');
  assert.equal(lib.isPopup({ url: 'javascript:alert(1)', disposition: 'new-window', features: 'width=10' }), false);
  assert.equal(lib.isPopup({ url: 'file:///etc/passwd', disposition: 'new-window', features: 'width=10' }), false);
  assert.equal(lib.isPopup(), false);
});

test('a popup’s title bar names the site it’s really on', () => {
  assert.equal(lib.popupTitle('https://accounts.google.com/signin', 'Sign in - Google Accounts'), 'accounts.google.com — Sign in - Google Accounts');
  assert.equal(lib.popupTitle('https://www.paypal.com/checkout', ''), 'www.paypal.com');
  assert.equal(lib.popupTitle('https://evil.example/x', 'accounts.google.com'), 'evil.example — accounts.google.com', 'a title can’t pose as another site');
  assert.equal(lib.popupTitle('https://a.example/', 'a.example'), 'a.example');
  assert.equal(lib.popupTitle('about:blank', 'Loading'), 'Loading');
  assert.equal(lib.popupTitle('https://a.example/', `x${'y'.repeat(500)}`).length, 'a.example — '.length + 120);
});

test('a popup opens the size asked for, usable, on screen, centred on its window unless placed', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const near = { x: 100, y: 100, width: 1000, height: 700 };
  assert.deepEqual(lib.popupBounds('width=500,height=600', area, near), { x: 350, y: 150, width: 500, height: 600 });
  assert.deepEqual(lib.popupBounds('popup', area, near), { x: 350, y: 150, width: 500, height: 600 }, 'no size: the usual one');
  assert.deepEqual(lib.popupBounds('width=10,height=10,left=20,top=30', area, near), { x: 20, y: 30, width: 320, height: 240 }, 'big enough to use');
  assert.deepEqual(lib.popupBounds('width=9000,height=9000', area, near), { x: 0, y: 25, width: 1440, height: 875 }, 'no bigger than the screen');
  assert.deepEqual(lib.popupBounds('width=400, height=400, left=5000, top=-900', area), { x: 1040, y: 25, width: 400, height: 400 }, 'never past an edge');
  assert.deepEqual(lib.popupBounds('innerWidth=450,innerHeight=500,screenX=10,screenY=40', area), { x: 10, y: 40, width: 450, height: 500 });
  assert.deepEqual(lib.popupBounds('width=abc', area), { x: 470, y: 163, width: 500, height: 600 }, 'nonsense: centred on the screen');
});

test('a sign-in box comes from the page’s own site or the one it’s going to, or a proxy', () => {
  const page = 'https://intranet.example/home';
  assert.equal(lib.authAllowed({ url: 'https://intranet.example/api', page }), true);
  assert.equal(lib.authAllowed({ url: 'https://other.example/pixel.gif', page }), false, 'another site inside the page');
  assert.equal(lib.authAllowed({ url: 'https://files.example/', page, going: 'https://files.example/' }), true, 'the page it’s going to');
  assert.equal(lib.authAllowed({ url: 'http://proxy.corp:3128/', page, proxy: true }), true);
  assert.equal(lib.authAllowed({ url: 'not a url', page }), false);
  assert.equal(lib.authAllowed(), false);
  assert.equal(lib.authInsecure('http://router.example/'), true);
  assert.equal(lib.authInsecure('https://intranet.example/'), false);
  assert.equal(lib.authInsecure('http://localhost:8080/'), false, 'this Mac');
  assert.equal(lib.authInsecure('http://127.0.0.1:3000/'), false);
});

test('which failed load is a certificate’s, and what’s wrong with it', () => {
  assert.equal(lib.isCertError(-202), true);
  assert.equal(lib.isCertError(-200), true);
  assert.equal(lib.isCertError(-3), false);
  assert.equal(lib.isCertError(-105), false);
  assert.equal(lib.isCertError(-300), false);
  assert.equal(lib.certProblem('net::ERR_CERT_AUTHORITY_INVALID'), 'authority');
  assert.equal(lib.certProblem('net::ERR_CERT_DATE_INVALID'), 'date');
  assert.equal(lib.certProblem('net::ERR_CERT_COMMON_NAME_INVALID'), 'name');
  assert.equal(lib.certProblem('net::ERR_CERT_REVOKED'), 'revoked');
  assert.equal(lib.certProblem('net::ERR_CERT_WEAK_KEY'), 'weak');
  assert.equal(lib.certProblem('net::ERR_CERT_INVALID'), 'other');
});

test('the tabs kept for next time: pages only, each with its back and forward list, the one on show remembered', () => {
  const tabs = [
    { url: 'https://mail.example/inbox', title: 'Inbox', pinned: true, entries: [{ url: 'https://mail.example/inbox', title: 'Inbox' }], index: 0 },
    { skip: true, url: 'https://secret.example/' }, // a private tab
    { url: 'about:blank', title: '', entries: [], index: -1 },
    { url: 'https://news.example/b', title: 'B', entries: [{ url: 'https://news.example/a', title: 'A' }, { url: 'chrome-error://x', title: '' }, { url: 'https://news.example/b', title: 'B' }, { url: 'https://news.example/c', title: 'C' }], index: 2 },
    { url: 'https://rc.example/login?reset=abc', title: 'Sign in', entries: [], index: -1 },
  ];
  const keep = (url) => !url.includes('reset=');
  const s = lib.sessionOf(tabs, { active: 3, keep });
  assert.deepEqual(s.tabs.map((t) => t.url), ['https://mail.example/inbox', 'https://news.example/b']);
  assert.equal(s.active, 1, 'the tab on show, counted among the tabs kept');
  assert.equal(s.tabs[0].pinned, true);
  assert.deepEqual(s.tabs[1].entries.map((e) => e.url), ['https://news.example/a', 'https://news.example/b', 'https://news.example/c']);
  assert.equal(s.tabs[1].index, 1, 'the page on show, after an entry that is left out');
  assert.equal(lib.sessionOf([{ url: 'https://a.example/', title: 'x'.repeat(900) }]).tabs[0].title.length, 300);
  assert.deepEqual(lib.sessionOf([], { active: 4 }), { tabs: [], active: 0 });
});

test('pinned tabs go first; a dragged tab stays within its own group', () => {
  const [a, b, c, d] = [{ n: 'a' }, { n: 'b', pinned: true }, { n: 'c' }, { n: 'd', pinned: true }];
  const names = (list) => list.map((t) => t.n).join('');
  assert.equal(names(lib.pinnedFirst([a, b, c, d])), 'bdac');
  const list = [b, d, a, c];
  assert.equal(names(lib.moveTab(list, c, 2)), 'bdca');
  assert.equal(names(lib.moveTab(list, c, 0)), 'bdca', 'a tab can’t go among the pinned');
  assert.equal(names(lib.moveTab(list, b, 9)), 'dbac', 'a pinned tab stays among the pinned');
  assert.equal(names(lib.moveTab(list, a, 'nonsense')), 'bdac');
  assert.equal(names(lib.moveTab(list, { n: 'x' }, 0)), 'bdac', 'a tab that isn’t there moves nothing');
});

test('the address bar’s list: an open tab to switch to first, a bookmark over a page only visited, often and lately visited pages higher', () => {
  const now = Date.UTC(2026, 8, 30);
  const day = 24 * 60 * 60 * 1000;
  const history = [
    ...Array.from({ length: 12 }, (_, i) => ({ url: 'https://github.com/owner/jarvis', title: 'owner/jarvis', at: now - i * 3600e3 })),
    { url: 'https://gist.github.com/x', title: 'A gist', at: now - 90 * day },
    { url: 'https://example.com/github-tips', title: 'Tips', at: now - day },
    { url: 'https://docs.example.com/', title: 'Docs for GitHub Actions', at: now - 2 * day },
  ];
  const rows = lib.suggest('git', {
    now,
    tabs: [{ id: 7, url: 'https://github.com/owner/jarvis/pulls', title: 'Pull requests', active: false }, { id: 8, url: 'https://github.com/', title: 'GitHub', active: true }],
    bookmarks: [{ url: 'https://gitlab.com/', title: 'GitLab', folder: 'Work/Code' }],
    history,
  });
  assert.deepEqual(rows.map((r) => r.kind), ['tab', 'history', 'bookmark', 'history', 'history', 'history']);
  assert.equal(rows[0].tab, 7);
  assert.equal(rows[1].url, 'https://github.com/owner/jarvis', 'visited twelve times today');
  assert.equal(rows[2].folder, 'Work/Code');
  assert.ok(!rows.some((r) => r.url === 'https://github.com/'), 'the tab on show isn’t offered');
  assert.equal(new Set(rows.map((r) => r.url)).size, rows.length, 'each page once');
  // Every word has to match, in the title or the address.
  assert.deepEqual(lib.suggest('jarvis pulls', { tabs: [{ id: 7, url: 'https://github.com/owner/jarvis/pulls', title: 'Pull requests' }], history }).map((r) => r.url), ['https://github.com/owner/jarvis/pulls']);
  assert.deepEqual(lib.suggest('', { history }), []);
  assert.equal(lib.suggest('a', { history: Array.from({ length: 50 }, (_, i) => ({ url: `https://a${i}.example/`, at: now })) }).length, 8);
  assert.deepEqual(lib.suggest('(', { history: [{ url: 'https://a.example/(x)', at: now }] }).map((r) => r.url), ['https://a.example/(x)'], 'a typed symbol is just a symbol');
});

test('the address bar’s list is quick with a full history and every bookmark', () => {
  const now = Date.now();
  const history = Array.from({ length: 2000 }, (_, i) => ({ url: `https://site${i % 700}.example/page/${i}`, title: `Page ${i} about things`, at: now - i * 60e3 }));
  const bookmarks = Array.from({ length: 5000 }, (_, i) => ({ url: `https://bm${i}.example/`, title: `Bookmark ${i}` }));
  // The quickest of five rounds: what the ranking costs, not what a busy Mac adds to it. A
  // ranking that compared pages with each other would take many seconds here.
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    const started = performance.now();
    for (const q of ['s', 'site1', 'page about', 'bookmark 49', 'zzz']) lib.suggest(q, { history, bookmarks, now });
    best = Math.min(best, performance.now() - started);
  }
  assert.ok(best < 1000, `${Math.round(best)} ms for five words, each against 7,000 pages`); // about 40 ms here
});

test('each site’s zoom is kept by its host; a page on this Mac shares one', () => {
  assert.equal(lib.zoomKey('https://www.nytimes.com/section/world'), 'www.nytimes.com');
  assert.equal(lib.zoomKey('http://localhost:3000/a'), 'localhost:3000');
  assert.equal(lib.zoomKey('file:///Users/me/a.pdf'), 'file://');
  assert.equal(lib.zoomKey('about:blank'), '');
  assert.equal(lib.zoomKey('nonsense'), '');
});
