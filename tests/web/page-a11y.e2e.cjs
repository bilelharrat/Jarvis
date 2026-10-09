// Pages made usable with a screen reader (app/page-a11y-preload.js, registered by
// app/features/page-a11y.js) in a real Chromium, against local test pages: unlabeled
// controls and pictures get names marked as guessed, big bold lines become headings with no
// skipped levels and a level 1, main and navigation landmarks are added, cookie banners are
// rejected or hidden, newsletter overlays closed, and nothing that sends a form or that the
// owner opened is touched; with the mode off nothing changes, and turning it off puts every
// attribute back. summary says what's on a page. No window is ever shown; nothing leaves
// 127.0.0.1.
//
//   app/node_modules/.bin/electron tests/web/page-a11y.e2e.cjs      (about 15 s; exit 1 on a failure)
'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-page-a11y-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..', '..', 'app');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#333"/></svg>';

const PAGES = {
  '/labels.html': `<!doctype html><html lang="en"><head><title>Shop</title>
<style>body{margin:20px} .ico{display:inline-block;width:20px;height:20px} button,a{min-width:20px;min-height:20px;display:inline-block}</style></head><body>
<header><a id="logo" href="/"><img id="logo-img" src="/img/acme-logo.svg" width="80" height="24"></a></header>
<div id="tools">
<button id="b-svg"><svg width="16" height="16" aria-hidden="true"><title>Open the menu</title><rect width="16" height="16"/></svg></button>
<button id="b-use"><svg width="16" height="16"><use href="#icon-hamburger"></use></svg></button>
<button id="b-own"><svg width="16" height="16"><title>Print</title><rect width="16" height="16"/></svg></button>
<button id="b-fa"><i class="fa fa-search"></i></button>
<button id="b-x" class="close">×</button>
<button id="b-lig"><span class="material-icons">shopping_cart</span></button>
<button id="b-named" aria-label="Go">→</button>
<button id="b-text" onclick="document.body.dataset.pressed='yes'">Add to bag</button>
<a id="a-cart" href="/cart"><img src="/icons/cart.svg" width="20" height="20"></a>
<a id="a-path" class="ico" href="/account/orders"></a>
<a id="a-ext" class="ico" href="https://twitter.com/acme"><span class="ico"></span></a>
</div>
<form onsubmit="return false">
<div>Zip code: <input id="f-zip" name="zip"></div>
<div><input id="f-ph" placeholder="Email address"> <input id="f-name" name="first_name"></div>
<label for="f-ok">Phone</label><input id="f-ok">
</form>
<img id="i-title" src="/img/x1.svg" title="Store front" width="40" height="40">
<figure><img id="i-cap" src="/img/a8f9c0d2e1.svg" width="40" height="40"><figcaption>Our team in 2025</figcaption></figure>
<img id="i-file" src="/img/red-running-shoes.svg" width="40" height="40">
<img id="i-junk" src="/img/IMG_2034.svg" width="40" height="40">
<img id="i-pixel" src="/img/spacer.svg" width="1" height="1">
<a href="/sale" id="a-sale"><img id="i-inlink" src="/img/sale-badge.svg" width="20" height="20"> Summer sale</a>
<img id="i-empty" src="/img/divider.svg" alt="" width="40" height="4">
</body></html>`,
  '/headings.html': `<!doctype html><html lang="en"><head><title>Deals</title>
<style>body{font-size:16px;margin:20px} .big{font-size:32px;font-weight:700} .price{font-size:30px;font-weight:700} .sub{font-weight:700;font-size:19px}</style></head><body>
<div class="menu" id="top-links"><a href="/a">Phones</a> <a href="/b">Laptops</a> <a href="/c">Tablets</a> <a href="/d">Watches</a></div>
<div id="content">
<div class="big" id="fake-top"><span>Today's deals</span></div>
<p>Hand-picked offers, updated every morning, for everything you need this week.</p>
<div class="price" id="price">$12.99</div>
<h2 id="h-two">Phones</h2><p>Phones of every kind and price, from basic ones to the latest models.</p>
<h4 id="h-four">Refurbished</h4><p>Good as new, with a year's guarantee and free returns for thirty days.</p>
<div class="big" id="div-button" style="cursor:pointer" onclick="void 0">Add to cart</div>
<div class="sub" id="fake-sub">Accessories</div><p>Cases, chargers and cables for all of them, at the best prices around.</p>
<h2 id="h-two-b">Laptops</h2><p>Light ones, fast ones, and ones that last all day on a single charge.</p>
</div></body></html>`,
  '/cookies.html': `<!doctype html><title>News</title><body style="overflow:hidden"><main><h1>News</h1><p>${'The news today. '.repeat(30)}</p></main>
<div id="onetrust-banner-sdk" style="position:fixed;left:0;right:0;bottom:0;padding:20px;background:#eee">
<p>We use cookies to personalise content and ads, and to analyse our traffic.</p>
<button id="accept" onclick="document.body.dataset.choice='accept';this.parentNode.remove()">Accept all</button>
<button id="reject" onclick="document.body.dataset.choice='reject';this.parentNode.remove();document.body.style.overflow=''">Reject all</button>
<button id="settings">Cookie settings</button></div></body>`,
  '/cookies-hide.html': `<!doctype html><title>Recipes</title><body style="overflow:hidden"><main><h1>Recipes</h1><p>${'Soup is good. '.repeat(30)}</p></main>
<div class="cookie-consent" id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.6)"><div style="background:#fff;margin:100px;padding:20px">
<p>This site uses cookies. By continuing you agree to our cookie policy.</p>
<button id="ok" onclick="document.body.dataset.choice='accept'">Accept</button> <button id="more" onclick="document.body.dataset.choice='settings'">Settings</button></div></div></body>`,
  '/cookies-form.html': `<!doctype html><title>Search</title><body><main><h1>Search</h1><p>${'Find things. '.repeat(20)}</p></main>
<div id="consent-dialog" role="dialog" style="position:fixed;left:0;right:0;bottom:0;background:#eee;padding:20px">
<p>Before you continue: we use cookies and data to deliver our services.</p>
<form action="/saved.html" method="get"><input type="hidden" name="set" value="no"><button id="reject">Reject all</button></form>
<form action="/saved.html" method="get"><input type="hidden" name="set" value="yes"><button id="accept">Accept all</button></form></div></body>`,
  '/cookies-inline.html': `<!doctype html><title>Blog</title><body>
<div class="cookie-notice" id="inline"><p>We use cookies on this site.</p><button id="in-accept" onclick="document.body.dataset.choice='accept'">Accept</button>
<button id="in-reject" onclick="document.body.dataset.choice='reject'">Only necessary cookies</button></div>
<main><h1>Blog</h1><p>${'Posts. '.repeat(30)}</p>
<section class="cookie-settings" id="policy"><h2>Cookie settings</h2><p>Here is how we use cookies, and how to change your consent.</p><button id="p-accept">Accept all</button></section></main></body>`,
  '/saved.html': '<!doctype html><title>Saved</title><body><p>saved</p></body>',
  '/newsletter.html': `<!doctype html><title>Boutique</title><body><main id="m"><h1>Boutique</h1><p>${'Lovely things. '.repeat(30)}</p></main>
<script>setTimeout(() => {
  const box = document.createElement('div');
  box.id = 'nl';
  box.className = 'newsletter-modal';
  box.setAttribute('role', 'dialog');
  box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5)';
  box.innerHTML = '<div style="background:#fff;margin:80px;padding:20px"><h2>Get 10% off your first order</h2><p>Join our newsletter.</p>'
    + '<form onsubmit="document.body.dataset.subscribed=1;return false"><input type="email" name="email"><button id="sub">Subscribe</button></form>'
    + '<button id="nl-close" type="button" aria-label="Close" onclick="document.body.dataset.closed=1;document.getElementById(\\'nl\\').remove()">×</button></div>';
  document.body.append(box);
  document.body.style.overflow = 'hidden';
  document.getElementById('m').setAttribute('aria-hidden', 'true');
}, 300);</script></body>`,
  '/owner-modal.html': `<!doctype html><title>Club</title><body><main><h1>Club</h1><p>${'Members news. '.repeat(20)}</p>
<button id="open" style="position:absolute;left:20px;top:200px;width:120px;height:40px" onclick="setTimeout(() => { const box = document.createElement('div'); box.id = 'login'; box.setAttribute('role', 'dialog');
box.style.cssText = 'position:fixed;inset:0;background:#fff'; box.innerHTML = '<h2>Sign in to your account</h2><p>Members only. Sign up or log in to continue.</p><input type=email><input type=password><button>Log in</button>'; document.body.append(box); }, 200)">Members</button>
</main></body>`,
  '/summary.html': `<!doctype html><html lang="en"><head><title>Why soup is good | The Daily Spoon</title></head><body>
<header><nav aria-label="Sections"><a href="/">Home</a> <a href="/food">Food</a> <a href="/sport">Sport</a></nav></header>
<main><article><h1>Why soup is good</h1><p>Soup has warmed people up for thousands of years, and it is still one of the cheapest meals you can make.</p>
<h2>How to start</h2><p>Begin with an onion, a carrot and some celery.</p><img src="/img/soup-bowl.svg" width="50" height="50">
<form aria-label="Newsletter"><input type="email" aria-label="Email"><button>Sign up</button></form>
<table><tr><td>Onion</td><td>1</td></tr></table></article></main>
<footer><p>Copyright The Daily Spoon</p></footer></body></html>`,
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://x').pathname;
      if (pathname.endsWith('.svg')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end(SVG); return; }
      const page = PAGES[pathname];
      if (!page) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let win;
let base;
const tabs = [];
let shown = null;
const PARTITION = 'page-a11y-test';
// (Not throttled: the tab on show in the dock isn't, and a hidden window's timers would be.)
const newTab = () => {
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, preload: path.join(ROOT, 'page-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  tabs.push(view);
  return view;
};

// The app feature, as main.js installs it: the browser's hooks, the window's channel.
const handlers = {};
const featureContext = {
  ipcMain: { on: (...args) => ipcMain.on(...args), handle: (channel, fn) => { handlers[channel] = fn; } },
  send: () => {},
  fromWindow: () => true,
  getWindow: () => win,
  flavor: {},
  browser: {
    partition: PARTITION, tabs: () => tabs.slice(), shown: () => shown, byId: (id) => tabs.find((v) => v.webContents.id === Number(id)) || null,
  },
};
const setMode = (on) => ipcMain.emit('feature:page-a11y:mode', { sender: null }, on);
const call = (action, args = {}) => handlers['feature:page-a11y:call']({ sender: null }, { action, args });
// In the page's own world: what its scripts (and a screen reader) see.
const page = (code) => shown.webContents.executeJavaScript(code, true);
const attr = (id, name) => page(`(() => { const n = document.getElementById(${JSON.stringify(id)}); return n ? n.getAttribute(${JSON.stringify(name)}) : 'MISSING'; })()`);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }
function eq(got, want, what) { assert(got === want, `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

async function load(pathname, wait = 700) {
  await shown.webContents.loadURL(`${base}${pathname}`);
  await sleep(wait);
}
async function settle(ms = 900) {
  await sleep(ms);
}

test('With the mode off, a page is left exactly as it is', async () => {
  setMode(false);
  await load('/labels.html');
  eq(await attr('b-fa', 'aria-label'), null, 'icon button');
  eq(await page('document.documentElement.getAttribute("data-jarvis-a11y")'), null, 'page mark');
  const stats = await call('stats');
  assert(stats.ok && stats.on === false && stats.changes === 0, JSON.stringify(stats));
});

test('Unlabeled buttons, links and fields get a name from the best source, marked as guessed', async () => {
  setMode(true);
  await load('/labels.html');
  const want = {
    'b-svg': 'Open the menu', 'b-use': 'Menu', 'b-fa': 'Search', 'b-x': 'Close', 'b-lig': 'Shopping cart',
    'a-path': 'Orders', 'a-ext': 'Acme, on twitter.com', 'f-zip': 'Zip code', 'f-ph': 'Email address', 'f-name': 'First name',
  };
  for (const [id, name] of Object.entries(want)) {
    eq(await attr(id, 'aria-label'), name, id);
    assert(/^guessed:/.test(await attr(id, 'data-jarvis-a11y-label')), `${id} not marked as guessed`);
    eq(await attr(id, 'aria-description'), 'Label guessed by Jarvis', `${id} description`);
  }
  // The cart link gets its name from its picture (whose alt came from the file name).
  eq(await attr('a-cart', 'aria-label'), null, 'a-cart needs no label of its own');
  eq(await page('document.querySelector("#a-cart img").getAttribute("alt")'), 'Cart', 'cart picture');
  // Ones that had a name keep theirs.
  eq(await attr('b-named', 'aria-label'), 'Go', 'named button');
  eq(await attr('b-own', 'aria-label'), null, 'an svg title a screen reader reads already');
  eq(await attr('b-text', 'aria-label'), null, 'text button');
  eq(await attr('f-ok', 'aria-label'), null, 'labelled field');
  // Nothing a page does changed: its button still works.
  await page('document.getElementById("b-text").click()');
  eq(await page('document.body.dataset.pressed'), 'yes', 'button still works');
});

test('Pictures get alt from a title, a caption or a file name; decorative ones are hidden', async () => {
  eq(await attr('i-title', 'alt'), 'Store front', 'title');
  eq(await attr('i-cap', 'alt'), 'Our team in 2025', 'caption');
  eq(await attr('i-file', 'alt'), 'Red running shoes', 'file name');
  eq(await attr('logo-img', 'alt'), 'Acme logo', 'logo');
  eq(await attr('i-junk', 'alt'), null, 'a camera file name says nothing');
  eq(await attr('i-pixel', 'aria-hidden'), 'true', 'spacer pixel');
  eq(await attr('i-inlink', 'aria-hidden'), 'true', 'picture beside a link\'s words');
  eq(await attr('i-empty', 'aria-hidden'), null, 'alt="" is the page\'s own choice');
  const counts = await page('document.documentElement.getAttribute("data-jarvis-a11y-counts")');
  assert(/labels:10\b/.test(counts) && /images:5\b/.test(counts) && /decorative:2\b/.test(counts), counts);
  assert(Number(await page('document.documentElement.getAttribute("data-jarvis-a11y-fixed")')) >= 16, 'fixed count');
});

test('Turning the mode off puts every attribute back', async () => {
  setMode(false);
  await sleep(200);
  for (const id of ['b-fa', 'a-path', 'f-ph']) eq(await attr(id, 'aria-label'), null, `${id} after off`);
  eq(await attr('i-file', 'alt'), null, 'alt after off');
  eq(await attr('i-pixel', 'aria-hidden'), null, 'aria-hidden after off');
  eq(await page('document.documentElement.getAttribute("data-jarvis-a11y-fixed")'), null, 'count after off');
  setMode(true);
  await sleep(400);
  eq(await attr('b-fa', 'aria-label'), 'Search', 'on again');
});

test('Big bold lines become headings, gaps are closed and the page gets a level 1', async () => {
  await load('/headings.html');
  const level = (id) => page(`(() => { const n = document.getElementById(${JSON.stringify(id)}); return [n.getAttribute('role'), n.getAttribute('aria-level')]; })()`);
  eq(JSON.stringify(await level('fake-top')), JSON.stringify(['heading', '1']), 'big bold line, the page\'s biggest');
  eq(JSON.stringify(await level('h-two')), JSON.stringify([null, null]), 'h2 stays 2');
  eq(JSON.stringify(await level('h-four')), JSON.stringify([null, '3']), 'h4 after h2 is 3');
  eq(JSON.stringify(await level('fake-sub')), JSON.stringify(['heading', '3']), 'bold sub-line');
  eq(JSON.stringify(await level('price')), JSON.stringify([null, null]), 'a price is no heading');
  eq(JSON.stringify(await level('div-button')), JSON.stringify([null, null]), 'a big bold button is no heading');
  eq(await attr('content', 'role'), 'main', 'main landmark');
  eq(await attr('top-links', 'role'), 'navigation', 'navigation landmark');
  const counts = await page('document.documentElement.getAttribute("data-jarvis-a11y-counts")');
  assert(/headings:2\b/.test(counts) && /landmarks:2\b/.test(counts) && /h1:1\b/.test(counts), counts);
});

test('A cookie banner\'s reject button is pressed, never accept', async () => {
  await load('/cookies.html', 900);
  eq(await page('document.body.dataset.choice || ""'), 'reject', 'choice');
  eq(await page('Boolean(document.getElementById("onetrust-banner-sdk"))'), false, 'banner gone');
  const counts = await page('document.documentElement.getAttribute("data-jarvis-a11y-counts")');
  assert(/rejected:1\b/.test(counts), counts);
});

test('A banner with no reject button is hidden, and the page scrolls again', async () => {
  await load('/cookies-hide.html', 900);
  eq(await page('document.body.dataset.choice || ""'), '', 'nothing pressed');
  eq(await attr('banner', 'data-jarvis-a11y-hidden'), 'consent', 'hidden mark');
  eq(await page('getComputedStyle(document.getElementById("banner")).display'), 'none', 'hidden');
  eq(await page('getComputedStyle(document.body).overflowY'), 'auto', `scrolls (${await page('document.body.outerHTML.slice(0, 160)')})`);
});

test('A cookie banner in the page\'s own flow is refused, and a privacy page\'s settings are left alone', async () => {
  await load('/cookies-inline.html', 900);
  eq(await page('document.body.dataset.choice || ""'), 'reject', 'choice');
  eq(await attr('policy', 'data-jarvis-a11y-hidden'), null, 'policy section stays');
  eq(await attr('inline', 'data-jarvis-a11y-hidden'), null, 'never hidden, only refused');
});

test('A reject button that would send a form is not pressed; the banner is hidden instead', async () => {
  await load('/cookies-form.html', 1200);
  assert(shown.webContents.getURL().endsWith('/cookies-form.html'), `navigated to ${shown.webContents.getURL()}`);
  eq(await attr('consent-dialog', 'data-jarvis-a11y-hidden'), 'consent', 'hidden mark');
});

test('A newsletter overlay is closed with its close button, never subscribed, and the page is readable again', async () => {
  await load('/newsletter.html', 1800);
  eq(await page('document.body.dataset.closed || ""'), '1', 'closed');
  eq(await page('document.body.dataset.subscribed || ""'), '', 'never subscribed');
  eq(await attr('m', 'aria-hidden'), null, 'main is back for the screen reader');
  eq(await page('getComputedStyle(document.body).overflowY'), 'auto', `scrolls (${await page('document.body.outerHTML.slice(0, 160)')})`);
});

// In a page that draws (an offscreen window), so the press is a real one, as the owner's
// or JARVIS's hand makes it.
test('An overlay the owner opened a moment ago is left alone', async () => {
  const paper = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, partition: PARTITION,
    preload: path.join(ROOT, 'page-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const holder = { webContents: paper.webContents };
  tabs.push(holder); // a tab of the browser's, as far as the feature knows
  try {
    await paper.loadURL(`${base}/owner-modal.html`);
    await sleep(600);
    const wc = paper.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x: 60, y: 220 });
    wc.sendInputEvent({ type: 'mouseDown', x: 60, y: 220, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 60, y: 220, button: 'left', clickCount: 1 });
    await settle(1500);
    const there = await wc.executeJavaScript('(() => { const n = document.getElementById("login"); return n ? [n.getAttribute("data-jarvis-a11y-hidden"), getComputedStyle(n).display] : null; })()', true);
    assert(there, 'the login box never opened');
    eq(JSON.stringify(there), JSON.stringify([null, 'block']), 'left as it is');
  } finally {
    tabs.splice(tabs.indexOf(holder), 1);
    paper.destroy();
  }
});

test('summary says what\'s on the page: title, landmarks, outline, counts and how it starts', async () => {
  setMode(false);
  await load('/summary.html', 500);
  const r = await call('summary');
  assert(r.ok, JSON.stringify(r));
  eq(r.title, 'Why soup is good | The Daily Spoon', 'title');
  const roles = r.landmarks.map((l) => l.role + (l.label ? `:${l.label}` : '')).join(',');
  assert(roles.includes('main') && roles.includes('navigation:Sections') && roles.includes('banner') && roles.includes('contentinfo') && roles.includes('form:Newsletter'), roles);
  eq(JSON.stringify(r.headings), JSON.stringify([{ level: 1, text: 'Why soup is good' }, { level: 2, text: 'How to start' }]), 'outline');
  assert(r.counts.links === 3 && r.counts.forms === 1 && r.counts.fields === 1 && r.counts.buttons === 1 && r.counts.images === 1 && r.counts.unlabeled === 1 && r.counts.tables === 1, JSON.stringify(r.counts));
  assert(r.start.startsWith('Why soup is good Soup has warmed people'), r.start);
  assert(!('fixed' in r), 'no fixes while off');
  assert(r.tab === shown.webContents.id && r.url.endsWith('/summary.html'), JSON.stringify({ tab: r.tab, url: r.url }));
});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  require(path.join(ROOT, 'features', 'page-a11y.js')).install(featureContext); // registers page-a11y-preload.js
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1000, height: 700 });
  shown = newTab();
  win.contentView.addChildView(shown);
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok     ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAILED ${t.name}\n       ${String(err.message).split('\n').join('\n       ')}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  server.close();
  app.exit(failed ? 1 : 0);
});
