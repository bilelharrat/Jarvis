// askeden.com/travel/accuracy (src/travel/accuracy-page.js): the public page and JSON of how often Eden Travel's checks
// were reported wrong, from the global index's counts. A fake index, a fake edge cache and a fixed clock; nothing live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACC_CSS, ACC_PAGE, accuracyHtml, accuracySummary, lastMonths, pctText, travelAccuracyPage } from '../src/travel/accuracy-page.js';
import { Storage } from './fakes.js';
import { GLOBAL, accuracyIndexOp } from '../src/travel/accuracy.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const ON = { EDEN_TRAVEL: '1' };
const get = (path, method = 'GET') => new Request(`https://askeden.com${path}`, { method });
// the index's tacc-read answer: newest first
const MONTHS = [
  { month: '2026-10', kinds: {
    hours: { google_places: { shown: 1240, wrong: 3, changed: 7 } },
    travel: { google_routes: { shown: 800, wrong: 0, changed: 2 } },
    price: { google_places: { shown: 12, wrong: 1, changed: 0 } },
    window: { venue_site: { shown: 45, wrong: 2, changed: 0 } },
  } },
  { month: '2026-09', kinds: { hours: { google_places: { shown: 500, wrong: 1, changed: 1 } }, access: { google_places: { shown: 29, wrong: 1, changed: 0 } } } },
  { month: '2025-09', kinds: { hours: { google_places: { shown: 9999, wrong: 999, changed: 0 } } } }, // 13 months back: not shown
];
function edgeCache() {
  const map = new Map();
  return { map, async match(req) { const r = map.get(req.url); return r ? r.clone() : undefined; }, async put(req, res) { map.set(req.url, res.clone()); } };
}
const deps = (months = MONTHS, extra = {}) => { let reads = 0; return { reads: () => reads, read: async () => { reads++; return { months }; }, cache: edgeCache(), now: () => NOW, ...extra }; };

test('summary: last 12 months, per kind and source, rates only from 30 checks', () => {
  assert.deepEqual(lastMonths('2026-01', 3), ['2026-01', '2025-12', '2025-11']);
  const s = accuracySummary(MONTHS, '2026-10');
  assert.equal(s.from, '2025-11');
  assert.equal(s.months_with_counts, 2); // 2025-09 is outside the window
  const hours = s.kinds.find((k) => k.kind === 'hours');
  assert.deepEqual([hours.shown, hours.wrong, hours.changed], [1740, 4, 8]);
  assert.equal(hours.wrong_rate, Math.round(1e6 * 4 / 1740) / 1e6);
  assert.equal(hours.months.length, 2);
  const price = s.kinds.find((k) => k.kind === 'price');
  assert.equal(price.wrong_rate, null, '12 checks: no rate');
  const access = s.kinds.find((k) => k.kind === 'access');
  assert.equal(access.shown, 29); assert.equal(access.wrong_rate, null, '29 checks: still no rate');
  const win = s.kinds.find((k) => k.kind === 'window');
  assert.equal(win.changed, null, 'booking windows: changed isn’t counted');
  assert.equal(win.wrong_rate, Math.round(1e6 * 2 / 45) / 1e6);
  const venue = s.sources.find((x) => x.source === 'venue_site');
  assert.equal(venue.changed, null);
  assert.equal(s.all.shown, 1740 + 800 + 12 + 29 + 45);
  assert.equal(s.all.changed_of, s.all.shown - 45);
  assert.equal(pctText(0, 30), '0%'); assert.equal(pctText(1, 29), null); assert.equal(pctText(1, 2000), '<0.1%'); assert.equal(pctText(3, 100), '3.0%'); assert.equal(pctText(25, 100), '25%');
  // a source the index doesn't take never shows
  const odd = accuracySummary([{ month: '2026-10', kinds: { hours: { elsewhere: { shown: 100, wrong: 50, changed: 0 } } } }], '2026-10');
  assert.equal(odd.all.shown, 0);
});

test('page: Paper, no script or inline style, method, too few to rate, escaped, noindex by default', () => {
  const html = accuracyHtml(accuracySummary(MONTHS, '2026-10'), { at: NOW });
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.doesNotMatch(html, /<script|\sstyle=|\son[a-z]+=/i);
  assert.match(html, /How often Eden Travel’s checks are wrong/);
  assert.match(html, /Opening hours<\/th><td>1,740<\/td><td>4<\/td><td><b>0\.2%<\/b>/);
  assert.match(html, /Price<\/th><td>12<\/td><td>1<\/td><td><span class="few">too few to rate/);
  assert.match(html, /Booking windows<\/th><td>45<\/td><td>2<\/td><td><b>4\.4%<\/b><\/td><td>not counted/);
  assert.match(html, /Reports undercount/);
  assert.match(html, /What doesn’t count/);
  assert.match(html, /November 2025 to October 2026/);
  assert.match(html, /\/travel\/accuracy\.css/);
  assert.doesNotMatch(html, /9,999/, 'a month outside the last 12 stays out');
  const indexed = accuracyHtml(accuracySummary([], '2026-10'), { at: NOW, index: true });
  assert.doesNotMatch(indexed, /noindex/);
  assert.match(indexed, /No checks counted yet/);
  assert.doesNotMatch(ACC_CSS, /url\(http/);
});

test('route: off without EDEN_TRAVEL, other paths not ours, POST refused', async () => {
  const d = deps();
  assert.equal(await travelAccuracyPage(get('/travel/accuracy'), {}, '/travel/accuracy', d), null);
  assert.equal(await travelAccuracyPage(get('/travel/other'), ON, '/travel/other', d), null);
  assert.equal(await travelAccuracyPage(get('/travel'), ON, '/travel', d), null);
  assert.equal((await travelAccuracyPage(get('/travel/accuracy', 'POST'), ON, '/travel/accuracy', d)).status, 405);
  assert.equal(d.reads(), 0);
});

test('route: HTML and JSON, public, an hour at the edge, noindex until the flag, one read an hour', async () => {
  const d = deps();
  const r = await travelAccuracyPage(get('/travel/accuracy?x=1'), ON, '/travel/accuracy', d);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), `public, max-age=${ACC_PAGE.cacheS}`);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /script-src/);
  const html = await r.text();
  // the same page again (another query): from the edge cache, the index isn't asked
  const again = await travelAccuracyPage(get('/travel/accuracy'), ON, '/travel/accuracy', d);
  assert.equal(await again.text(), html);
  assert.equal(d.reads(), 1);

  const j = await travelAccuracyPage(get('/travel/accuracy.json'), ON, '/travel/accuracy.json', d);
  assert.equal(j.headers.get('access-control-allow-origin'), '*');
  assert.equal(j.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  const data = await j.json();
  assert.equal(data.min_sample, 30);
  assert.equal(data.kinds.find((k) => k.kind === 'price').wrong_rate, null);
  assert.equal(data.read_at, new Date(NOW).toISOString());
  assert.doesNotMatch(JSON.stringify(data), /"(place|trip|account|name|id)"/, 'counts only');

  const head = await travelAccuracyPage(get('/travel/accuracy', 'HEAD'), ON, '/travel/accuracy', d);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');

  const css = await travelAccuracyPage(get('/travel/accuracy.css'), ON, '/travel/accuracy.css', d);
  assert.match(css.headers.get('content-type'), /text\/css/);

  // the owner's go: indexable, its own cache copy
  const open = await travelAccuracyPage(get('/travel/accuracy'), { ...ON, TRAVEL_ACCURACY_INDEX: '1' }, '/travel/accuracy', d);
  assert.equal(open.headers.get('x-robots-tag'), null);
  assert.doesNotMatch(await open.text(), /noindex/);
});

test('route: the index unreachable → 503, never cached', async () => {
  const cache = edgeCache();
  const failing = { read: async () => { throw new Error('down'); }, cache, now: () => NOW };
  const r = await travelAccuracyPage(get('/travel/accuracy'), ON, '/travel/accuracy', failing);
  assert.equal(r.status, 503); assert.equal(r.headers.get('cache-control'), 'no-store');
  const j = await travelAccuracyPage(get('/travel/accuracy.json'), ON, '/travel/accuracy.json', failing);
  assert.equal(j.status, 503);
  assert.equal(cache.map.size, 0);
});

test('route: reads the real index through ACCOUNTS (tacc-add → tacc-read → page)', async () => {
  const global = { storage: new Storage(), env: {}, now: () => NOW };
  await accuracyIndexOp(global, 'tacc-add', { counts: { '2026-10': { 'hours:google_places': [40, 2, 1], 'window:venue_site': [3, 0, 0] } } });
  const env = { ...ON, ACCOUNTS: { idFromName: (n) => n, get: (n) => ({ fetch: async (url, init) => {
    assert.equal(n, GLOBAL);
    return Response.json(await accuracyIndexOp(global, new URL(url).pathname.slice(1), JSON.parse(init.body)));
  } }) } };
  const r = await travelAccuracyPage(get('/travel/accuracy.json'), env, '/travel/accuracy.json', { cache: null, now: () => NOW });
  const data = await r.json();
  const hours = data.kinds.find((k) => k.kind === 'hours');
  assert.deepEqual([hours.shown, hours.wrong, hours.changed, hours.wrong_rate], [40, 2, 1, 0.05]);
  assert.equal(data.kinds.find((k) => k.kind === 'window').wrong_rate, null);
});
