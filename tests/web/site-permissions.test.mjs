// Per-site permissions in the built-in browser (app/site-permissions.js): node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { SitePermissions, kindsFor, originOf, cleanSites, hostOfOrigin } = require('../../app/site-permissions.js');

const MEET = 'https://meet.google.com';
const cam = { mediaTypes: ['video'] };
const both = { mediaTypes: ['audio', 'video'] };
const settle = () => new Promise((r) => setImmediate(r));

test('what Electron asks for, as the kinds a person is asked about', () => {
  assert.deepEqual(kindsFor('media', both), ['camera', 'microphone']);
  assert.deepEqual(kindsFor('media', { mediaTypes: ['audio'] }), ['microphone']);
  assert.deepEqual(kindsFor('media', { mediaType: 'video' }), ['camera']); // a check names one type
  assert.deepEqual(kindsFor('media', { mediaType: 'unknown' }), ['camera', 'microphone']);
  assert.equal(kindsFor('media', {}), null);
  assert.deepEqual(kindsFor('geolocation'), ['location']);
  assert.deepEqual(kindsFor('notifications'), ['notifications']);
  assert.deepEqual(kindsFor('clipboard-read'), ['clipboard']);
  for (const p of ['midi', 'midiSysex', 'hid', 'serial', 'usb', 'openExternal', 'display-capture', 'pointerLock', 'unknown']) assert.equal(kindsFor(p), null, p);
});

test('a site is its origin; local files are one site; anything else is none', () => {
  assert.equal(originOf('https://meet.google.com/abc-defg?x=1'), MEET);
  assert.equal(originOf('http://localhost:3000/a'), 'http://localhost:3000');
  assert.equal(originOf('file:///Users/me/a.pdf'), 'file://');
  for (const u of ['about:blank', 'data:text/html,x', 'javascript:1', 'chrome://gpu', '', null]) assert.equal(originOf(u), '', String(u));
  assert.equal(hostOfOrigin(MEET), 'meet.google.com');
});

test('checks: notifications only once allowed, the rest unless blocked, devices never', () => {
  const p = new SitePermissions();
  const check = (permission, details = {}, origin = MEET) => p.check({ tab: 1, origin, permission, details });
  assert.equal(check('fullscreen'), true);
  assert.equal(check('clipboard-sanitized-write'), true);
  assert.equal(check('notifications'), false, 'a page told "granted" would show notifications without asking');
  assert.equal(check('media', { mediaType: 'video' }), true, 'Meet has to be able to ask');
  assert.equal(check('geolocation'), true);
  for (const perm of ['midi', 'hid', 'serial', 'usb', 'display-capture']) assert.equal(check(perm), false, perm);
  assert.equal(check('media', { mediaType: 'video' }, ''), false, 'no site, no permission');
  p.setDecision(MEET, 'camera', 'block');
  p.setDecision(MEET, 'notifications', 'allow');
  assert.equal(check('media', { mediaType: 'video' }), false);
  assert.equal(check('media', { mediaType: 'audio' }), true);
  assert.equal(check('notifications'), true);
});

test('a request waits for the answer; Allow is kept for the site and answers later requests at once', async () => {
  const saved = [];
  let changes = 0;
  const p = new SitePermissions({ onSave: (sites) => saved.push(JSON.parse(JSON.stringify(sites))), onChange: () => { changes += 1; } });
  let result = null;
  p.request({ tab: 1, origin: MEET, permission: 'media', details: both }).then((ok) => { result = ok; });
  await settle();
  assert.equal(result, null, 'answered before the person did');
  const w = p.waiting(1);
  assert.deepEqual(w.kinds, ['camera', 'microphone']);
  assert.equal(changes, 1);
  // The same ask again while it waits joins it.
  let second = null;
  p.request({ tab: 1, origin: MEET, permission: 'media', details: both }).then((ok) => { second = ok; });
  assert.equal(p.pending.length, 1);
  assert.equal(p.answer(w.id, 'allow'), true);
  await settle();
  assert.equal(result, true);
  assert.equal(second, true);
  assert.deepEqual(saved.at(-1), { [MEET]: { camera: 'allow', microphone: 'allow' } });
  assert.equal(await p.request({ tab: 2, origin: MEET, permission: 'media', details: cam }), true, 'kept for the site, any tab');
  assert.equal(p.pending.length, 0);
});

test('Block is kept; Don’t allow this once keeps nothing; a blocked site is refused without a prompt', async () => {
  const p = new SitePermissions();
  const asked = p.request({ tab: 1, origin: MEET, permission: 'geolocation' });
  p.answer(p.waiting(1).id, 'dismiss');
  assert.equal(await asked, false);
  assert.equal(p.decision(MEET, 'location'), 'ask', 'a dismissal is not remembered');
  const again = p.request({ tab: 1, origin: MEET, permission: 'geolocation' });
  p.answer(p.waiting(1).id, 'block');
  assert.equal(await again, false);
  assert.equal(await p.request({ tab: 1, origin: MEET, permission: 'geolocation' }), false);
  assert.equal(p.pending.length, 0, 'a blocked site is never asked again');
});

test('Allow this time lasts while the tab stays on the site', async () => {
  const p = new SitePermissions();
  const asked = p.request({ tab: 7, origin: MEET, permission: 'media', details: cam });
  p.answer(p.waiting(7).id, 'once');
  assert.equal(await asked, true);
  assert.equal(p.decision(MEET, 'camera'), 'ask', 'nothing kept');
  assert.equal(await p.request({ tab: 7, origin: MEET, permission: 'media', details: cam }), true);
  p.navigated(7, MEET); // another page of the same site
  assert.equal(await p.request({ tab: 7, origin: MEET, permission: 'media', details: cam }), true);
  assert.equal(p.check({ tab: 8, origin: MEET, permission: 'notifications' }), false);
  p.request({ tab: 8, origin: MEET, permission: 'media', details: cam }); // another tab asks again
  assert.equal(p.pending.length, 1);
  p.navigated(7, 'https://example.com');
  const later = p.request({ tab: 7, origin: MEET, permission: 'media', details: cam });
  assert.equal(p.pending.length, 2, 'the grant ended when the tab left the site');
  p.closed(7);
  assert.equal(await later, false);
});

test('a new page drops what the old one asked; a flood of prompts is refused', async () => {
  const p = new SitePermissions();
  const asked = p.request({ tab: 3, origin: MEET, permission: 'notifications' });
  p.navigated(3, MEET);
  assert.equal(await asked, false);
  const flood = [];
  for (let i = 0; i < 10; i++) flood.push(p.request({ tab: 3, origin: `https://s${i}.example`, permission: 'geolocation' }));
  assert.equal(p.pending.length, 6);
  assert.deepEqual((await Promise.all(flood.slice(6))), [false, false, false, false]);
});

test('an answer settles the other prompts it decides', async () => {
  const p = new SitePermissions();
  const a = p.request({ tab: 1, origin: MEET, permission: 'media', details: cam });
  const b = p.request({ tab: 2, origin: MEET, permission: 'media', details: cam });
  assert.equal(p.pending.length, 2);
  p.answer(p.waiting(1).id, 'block');
  assert.deepEqual([await a, await b], [false, false]);
  assert.equal(p.pending.length, 0);
});

test('Settings: change, forget, list; bad input changes nothing', () => {
  const saved = [];
  const p = new SitePermissions({ onSave: (s) => saved.push(Object.keys(s)) });
  assert.equal(p.setDecision(MEET, 'camera', 'allow'), true);
  assert.equal(p.setDecision('https://zoom.us', 'microphone', 'block'), true);
  assert.equal(p.setDecision('meet.google.com', 'camera', 'allow'), false, 'not an origin');
  assert.equal(p.setDecision(MEET, 'midi', 'allow'), false);
  assert.equal(p.setDecision('javascript:alert(1)', 'camera', 'allow'), false);
  assert.deepEqual(p.list().map((s) => s.host), ['meet.google.com', 'zoom.us']);
  p.setDecision(MEET, 'camera', 'ask');
  assert.deepEqual(p.list().map((s) => s.host), ['zoom.us'], 'Ask everywhere is no entry');
  assert.equal(p.forget('https://zoom.us'), true);
  assert.deepEqual(p.list(), []);
  assert.deepEqual(saved.at(-1), []);
  const quiet = new SitePermissions({ remember: false, onSave: () => { throw new Error('a private window saved'); } });
  quiet.setDecision(MEET, 'camera', 'allow');
  assert.equal(quiet.decision(MEET, 'camera'), 'allow');
});

test('each profile’s prompts have ids of their own', () => {
  const owner = new SitePermissions({ prefix: 'o' });
  const priv = new SitePermissions({ prefix: 'x', remember: false });
  owner.request({ tab: 1, origin: MEET, permission: 'notifications' });
  priv.request({ tab: 2, origin: MEET, permission: 'geolocation' });
  assert.equal(owner.waiting(1).id, 'o1');
  assert.equal(priv.waiting(2).id, 'x1');
  assert.equal(owner.answer('x1', 'allow'), false, 'one profile answered another’s prompt');
});

test('a saved file is read defensively', () => {
  const sites = cleanSites({
    [MEET]: { camera: 'allow', microphone: 'sure', midi: 'allow' },
    'not a url': { camera: 'allow' },
    'https://x.example/path': { camera: 'allow' }, // not an origin
    'https://y.example': 'allow',
    'https://z.example': { location: 'block' },
  });
  assert.deepEqual(sites, { [MEET]: { camera: 'allow' }, 'https://z.example': { location: 'block' } });
  assert.deepEqual(cleanSites(null), {});
  assert.deepEqual(cleanSites([1, 2]), {});
});

test('a change in Settings answers a prompt that was waiting for it', async () => {
  let changes = 0;
  const p = new SitePermissions({ onChange: () => { changes += 1; } });
  const asked = p.request({ tab: 1, origin: MEET, permission: 'geolocation' });
  const before = changes;
  p.setDecision(MEET, 'location', 'allow');
  assert.equal(await asked, true);
  assert.equal(p.pending.length, 0);
  assert.ok(changes > before, 'the window was not told the prompt went');
  const refused = p.request({ tab: 2, origin: MEET, permission: 'notifications' });
  p.setDecision(MEET, 'notifications', 'block');
  assert.equal(await refused, false);
});
