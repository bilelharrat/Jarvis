// Pages made usable with a screen reader, the pure parts: how app/page-a11y-preload.js turns
// an icon's class, a file's name or a link's address into a name, which banner buttons it
// will press (a reject, a close: never one that buys, signs in or subscribes), how it closes
// up heading levels, and when the window (web/features/page_a11y.js) wants the fixes, with
// every sentence it shows having its Chinese. The pages themselves: page-a11y.e2e.cjs.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const H = require('../../app/page-a11y-preload.js');
const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const source = readFileSync(`${WEB}/features/page_a11y.js`, 'utf8');
const fragment = JSON.parse(readFileSync(`${WEB}/i18n/page_a11y.json`, 'utf8'));

test('an icon class or a file name becomes a name a person would say', () => {
  const cases = {
    'icon-shopping-cart': 'Shopping cart', 'fa-xmark': 'Close', 'bi-x-lg': 'Close', 'glyphicon-home': 'Home', 'chevron-left': 'Previous',
    'arrow_right_24px': 'Next', 'search-btn': 'Search', 'hamburger': 'Menu', 'red-running-shoes.jpg': 'Red running shoes',
    'acme-logo.svg': 'Acme logo', 'userProfile': 'Account', 'is-active': '', 'newsArticles': 'News articles', 'more_vert': 'More', 'icon-user': 'Account', 'heart-outline': 'Favourites',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(H.words(raw), want, raw);
  for (const junk of ['IMG_2034.jpg', 'a8f9c0d2e1.png', 'DSC00012.JPG', 'spacer.gif', 'icon', '24px', 'fa fa-lg', '3f9a1c2b7d']) assert.equal(H.words(junk), '', junk);
});

test('only the classes that name an icon count', () => {
  assert.equal(H.iconWords('fa fa-search fa-lg'), 'Search');
  assert.equal(H.iconWords('btn btn-primary header-toggle'), '');
  assert.equal(H.iconWords('svg-icon icon-cart'), 'Cart');
  assert.equal(H.iconWords('mdi mdi-bell-outline'), 'Notifications');
});

test('glyphs and ligatures stand for their word', () => {
  assert.equal(H.glyphWords('×'), 'Close');
  assert.equal(H.glyphWords(' ☰ '), 'Menu');
  assert.equal(H.glyphWords('›'), 'Next');
  assert.ok(H.symbolOnly('') && H.symbolOnly('×') && !H.symbolOnly('Go') && !H.symbolOnly('2'));
  assert.equal(H.ligatureWords('shopping_cart'), 'Shopping cart');
  assert.equal(H.ligatureWords('Add to bag'), '');
});

test('a link\'s address says where it goes', () => {
  const page = 'https://shop.example/products/42';
  assert.equal(H.linkWords('/account/orders', page), 'Orders');
  assert.equal(H.linkWords('/', page), 'Home');
  assert.equal(H.linkWords('/blog/2026/10/why-soup-is-good.html', page), 'Why soup is good');
  assert.equal(H.linkWords('/p/12345', page), ''); // an id says nothing
  assert.equal(H.linkWords('https://twitter.com/', page), 'Twitter');
  assert.equal(H.linkWords('https://www.facebook.com/acme', page), 'Acme, on facebook.com');
  assert.equal(H.linkWords('mailto:hi@shop.example?subject=x', page), 'Email hi@shop.example');
  assert.equal(H.linkWords('tel:+44 20 7946 0000', page), 'Call +44 20 7946 0000');
  for (const none of ['#', 'javascript:void(0)', '', 'ftp://x/y']) assert.equal(H.linkWords(none, page), '', none);
});

test('a banner\'s reject buttons are found, in several languages, and nothing else', () => {
  for (const yes of ['Reject all', 'Reject All Cookies', 'Decline', 'Only necessary cookies', 'Necessary only', 'Use necessary cookies only',
    'Reject non-essential cookies', 'I do not accept', 'Continue without accepting', 'Alle ablehnen', 'Tout refuser', 'Rechazar todo', 'Refuse.']) {
    assert.ok(H.rejectWords(yes), yes);
  }
  for (const no of ['Accept all', 'Accept', 'OK', 'Agree', 'Cookie settings', 'Manage options', 'Reject and subscribe', 'Sign in to reject', '']) {
    assert.ok(!H.rejectWords(no), no);
  }
  for (const yes of ['Close', '×', 'No thanks', 'No, thanks', 'Not now', 'Maybe later', 'Continue to site', 'Dismiss']) assert.ok(H.closeWords(yes), yes);
  for (const no of ['Subscribe', 'Sign up', 'Close and subscribe', 'Log in', 'Buy now', 'Get my code']) assert.ok(!H.closeWords(no), no);
});

test('an overlay is told by what it says and how much it covers', () => {
  assert.equal(H.overlayKind('We use cookies to improve your experience. Accept all Reject all'), 'consent');
  assert.equal(H.overlayKind('Get 10% off your first order. Join our newsletter.', { email: true, covers: 0.5 }), 'newsletter');
  assert.equal(H.overlayKind('Get 10% off your first order', { covers: 0.05 }), ''); // a strip in the page, not over it
  assert.equal(H.overlayKind('Members only. Sign in to continue reading.', { covers: 0.9 }), 'wall');
  assert.equal(H.overlayKind('Your basket: 2 items, $24.', { covers: 0.6 }), '');
});

test('skipped heading levels are closed up, never raised', () => {
  assert.deepEqual(H.closeGaps([1, 3, 3, 5, 2, 4]), [1, 2, 2, 3, 2, 3]);
  assert.deepEqual(H.closeGaps([2, 4, 4, 5, 2, 3]), [2, 3, 3, 4, 2, 3]);
  assert.deepEqual(H.closeGaps([1, 2, 3, 2, 3, 4]), [1, 2, 3, 2, 3, 4]); // nothing to do
  assert.deepEqual(H.closeGaps([3, 1, 4]), [3, 1, 2]);
  assert.deepEqual(H.closeGaps([]), []);
});

test('a big bold line\'s level comes from the page\'s own headings nearest in size', () => {
  const known = [{ level: 2, size: 24 }, { level: 3, size: 19 }, { level: 4, size: 16 }];
  assert.equal(H.levelForSize(32, 16, known), 2); // never a second level 1
  assert.equal(H.levelForSize(19, 16, known), 3);
  assert.equal(H.levelForSize(17, 16, known), 4);
  assert.equal(H.levelForSize(32, 16, []), 2);
  assert.equal(H.levelForSize(24, 16, []), 3);
  assert.equal(H.levelForSize(19, 16, []), 4);
});

// The window script's helper, loaded as the window loads it (without a page: no features).
function windowHelper() {
  const sandbox = { window: {}, console };
  vm.runInNewContext(source, sandbox);
  return sandbox.window.jarvisPageA11y;
}

test('the window wants the fixes while screen-reader mode is on, unless they are turned off', () => {
  const P = windowHelper();
  assert.equal(P.wanted({ effective: true }, {}), true);
  assert.equal(P.wanted({ effective: true }, { a11y_page_fixes: true }), true);
  assert.equal(P.wanted({ effective: true }, { a11y_page_fixes: false }), false);
  assert.equal(P.wanted({ effective: false }, { a11y_page_fixes: true }), false);
  assert.equal(P.wanted(null, {}), false);
});

test('every sentence the window script shows has its Chinese', () => {
  const shown = [...source.matchAll(/t\('([^']+)'\)/g)].map((m) => m[1]);
  const said = [...source.matchAll(/message: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(shown.length >= 2);
  for (const text of [...shown, ...said]) assert.ok(fragment.strings[text], `no Chinese for: ${text}`);
  for (const [en, zh] of Object.entries(fragment.strings)) assert.ok(en.trim() && zh.trim() && /[一-鿿]/.test(zh), en);
});
