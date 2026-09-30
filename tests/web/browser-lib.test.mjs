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
