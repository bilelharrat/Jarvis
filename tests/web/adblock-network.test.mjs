// The browser's ad blocker on the network side (app/adblock.js's network and decide, wired by
// main.js's readyAdblock) and its lists (app/adblock-lists.json, app/adblock-build.js):
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ADBLOCK = fileURLToPath(new URL('../../app/adblock.js', import.meta.url));
const require = createRequire(ADBLOCK); // the app's own node_modules
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { FiltersEngine } = require('@ghostery/adblocker');
const adblock = require(ADBLOCK);
const build = require('./adblock-build.js');
const LISTS = JSON.parse(readFileSync(new URL('../../app/adblock-lists.json', import.meta.url), 'utf8'));

// The handlers network() puts on a session, and the filters they were given.
function wired(engine, shielded = () => true) {
  const on = {};
  const ses = { webRequest: {
    onBeforeRequest: (filter, fn) => { on.before = { filter, fn }; },
    onHeadersReceived: (filter, fn) => { on.headers = { filter, fn }; },
  } };
  const blocked = [];
  adblock.network(ses, { engine: () => engine, shielded, pageOf: (d) => (d.resourceType === 'mainFrame' ? d.url : d.page), onBlocked: (d) => blocked.push(d.url) });
  const request = (details) => new Promise((resolve) => on.before.fn({ id: 1, referrer: '', ...details }, resolve));
  return { on, blocked, request };
}

test('only pages’ and frames’ responses wait for the main thread: the engine changes no other', () => {
  const engine = ElectronBlocker.parse("example.test$csp=script-src 'self'", { loadNetworkFilters: true });
  // network() asks for frames' response headers only...
  const { on } = wired(engine);
  assert.deepEqual(on.headers.filter, { urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] });
  // ...since the engine answers every other response unchanged, on a page a $csp filter is for too.
  const answer = (resourceType) => {
    let out;
    engine.onHeadersReceived({
      url: 'https://example.test/x', resourceType, referrer: 'https://example.test/', responseHeaders: { 'Content-Type': ['text/html'] },
    }, (response) => { out = response; });
    return out;
  };
  assert.deepEqual(answer('mainFrame').responseHeaders['content-security-policy'], ["script-src 'self'"]);
  for (const type of ['image', 'script', 'stylesheet', 'font', 'xhr', 'media', 'object', 'ping', 'cspReport', 'webSocket', 'other']) {
    assert.deepEqual(answer(type), {}, `the engine changed a ${type}'s headers: network() must ask for them too`);
  }
});

test('ads are blocked or swapped for a harmless stand-in, and counted; the rest pass', async () => {
  const engine = ElectronBlocker.parse(['||ads.test^', '||gpt.test/gpt.js$script,redirect=noop.js'].join('\n'), { loadNetworkFilters: true });
  engine.updateResources(JSON.stringify({ scriptlets: [], redirects: [{ name: 'noop.js', aliases: [], body: '(function(){})();', contentType: 'application/javascript' }] }), 'test');
  const { request, blocked } = wired(engine);
  const page = 'https://news.test/';
  assert.deepEqual(await request({ url: 'https://ads.test/banner.png', resourceType: 'image', page }), { cancel: true });
  assert.match((await request({ url: 'https://gpt.test/gpt.js', resourceType: 'script', page })).redirectURL, /^data:application\/javascript/);
  assert.deepEqual(await request({ url: 'https://cdn.news.test/app.js', resourceType: 'script', page }), {});
  assert.deepEqual(blocked, ['https://ads.test/banner.png', 'https://gpt.test/gpt.js']);
  // Not on a page the user allowed.
  assert.deepEqual(await wired(engine, () => false).request({ url: 'https://ads.test/x.png', resourceType: 'image', page }), {});
});

test('a malware page or one under a $document rule isn’t opened; an ad host’s page still is', async () => {
  const engine = ElectronBlocker.parse(['||ads.test^', '||scam.test^$doc'].join('\n'), { loadNetworkFilters: true });
  engine.pages = FiltersEngine.parse('||malware.test^', { loadNetworkFilters: true, loadCosmeticFilters: false }); // URLhaus's style: no $doc
  const { request } = wired(engine);
  assert.deepEqual(await request({ url: 'https://malware.test/login', resourceType: 'mainFrame' }), { cancel: true });
  assert.deepEqual(await request({ url: 'https://scam.test/', resourceType: 'mainFrame' }), { cancel: true });
  assert.deepEqual(await request({ url: 'https://ads.test/landing', resourceType: 'mainFrame' }), {}, 'a plain ad-host rule must not stop a page (an ad clicked on purpose)');
});

test('click trackers come off a page’s address from another site, and $removeparam applies', async () => {
  const engine = ElectronBlocker.parse('||shop.test^$removeparam=promo_ref', { loadNetworkFilters: true });
  const { request } = wired(engine);
  assert.deepEqual(await request({ url: 'https://news.test/a?id=7&fbclid=XYZ&gclid=1', resourceType: 'mainFrame', referrer: 'https://social.test/' }), { redirectURL: 'https://news.test/a?id=7' });
  assert.deepEqual(await request({ url: 'https://www.youtube.com/watch?v=1&si=abc', resourceType: 'mainFrame' }), { redirectURL: 'https://www.youtube.com/watch?v=1' });
  assert.deepEqual(await request({ url: 'https://news.test/a?s=1&t=2', resourceType: 'mainFrame' }), {}, "x.com's s and t are only taken off x.com");
  assert.deepEqual(await request({ url: 'https://news.test/a?gclid=1', resourceType: 'mainFrame', referrer: 'https://www.news.test/' }), {}, 'within a site its own parameters stay');
  assert.deepEqual(await request({ url: 'https://shop.test/p?promo_ref=x&q=1', resourceType: 'mainFrame' }), { redirectURL: 'https://shop.test/p?q=1' });
});

test('the lists: Brave’s default set, each with a licence, fetched from its publisher', () => {
  const ids = new Set(LISTS.lists.map((l) => l.id));
  for (const id of ['easylist', 'easyprivacy', 'ubo-filters', 'ubo-filters-2025', 'ubo-filters-2026', 'ubo-filters-general', 'ubo-badware', 'ubo-privacy', 'ubo-quick-fixes', 'ubo-unbreak', 'ubo-resource-abuse', 'ubo-link-shorteners', 'urlhaus', 'brave-specific', 'brave-unbreak', 'brave-firstparty', 'fanboy-cookiemonster', 'ubo-annoyances-cookies', 'fanboy-mobile-notifications']) {
    assert.ok(ids.has(id), `${id} is missing`);
  }
  for (const l of LISTS.lists) {
    assert.ok(l.license, `${l.id} has no licence`);
    assert.match(l.url, /^https:\/\//);
    assert.doesNotMatch(l.url, /ghostery\/adblocker\/master/, `${l.id} comes from Ghostery's stale mirror`);
  }
  assert.ok(LISTS.lists.filter((l) => l.blockPages).every((l) => l.group === 'badware'), 'only malware lists may stop a page');
});

test('preprocessor branches follow the platform: desktop rules on the desktop, phone rules on phones', () => {
  const text = ['!#if env_mobile', '||mobile-only.test^', '!#else', '||desktop-only.test^', '!#endif', '!#if false', '||never.test^', '!#endif'].join('\n');
  const blocks = (platform, host) => {
    const engine = FiltersEngine.parse(text, build.ENGINE_CONFIG);
    engine.updateEnv(build.envFor(platform));
    const { Request } = require('@ghostery/adblocker');
    return Boolean(engine.match(Request.fromRawDetails({ url: `https://${host}/x.js`, type: 'script', sourceUrl: 'https://site.test/' })).match);
  };
  assert.ok(blocks('desktop', 'desktop-only.test'));
  assert.ok(!blocks('desktop', 'mobile-only.test'));
  assert.ok(blocks('ios', 'mobile-only.test'));
  assert.ok(!blocks('ios', 'desktop-only.test'));
  assert.ok(!blocks('desktop', 'never.test'));
});
