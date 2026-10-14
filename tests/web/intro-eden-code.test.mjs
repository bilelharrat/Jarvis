// Eden Code's Setup (web/features/intro.js in a window marked data-app="eden-code"), walked in
// a stand-in window (tests/web/fixtures/stand-dom.mjs): every card says Eden Code, never
// Eden Secretary or Jarvis, the last card has no voice examples, Models points at Eden Code's
// own "Models & API keys", and the boot-up sound card reads and sets Eden Code's own choice
// through the app's bridge (feature:boot-sound), not Eden Secretary's boot_sound (round 3,
// U3-1 and U3-2). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const source = readFileSync(new URL('../../src/jarvis/web/features/intro.js', import.meta.url), 'utf8');
const NAMES = /Eden Secretary|Jarvis|JARVIS|J\.A\.R\.V\.I\.S/;

function stand({ eden = true, bridge = null } = {}) {
  const document = makeDocument();
  if (eden) document.body.setAttribute('data-app', 'eden-code');
  const handlers = {};
  const sent = [];
  const F = {
    el: elFor(document), $: (id) => document.getElementById(id),
    send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
  };
  const window = { jarvisFeatures: F, addEventListener() {}, jarvisApp: bridge ? { feature: bridge } : undefined };
  load(source, { window, document, setInterval: () => 0, clearInterval() {} });
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  fire('hello', { state: 'idle', prefs: { boot_sound: true } });
  fire('connectors', { catalog: [{ id: 'gh', name: 'GitHub', category: 'Developer', blurb: 'Repos', auth: 'oauth' }], connections: [] });
  return { document, window, sent, fire, $: F.$ };
}

// Everything a card shows: its words and its controls' names.
function words(document) {
  const card = document.getElementById('intro-card');
  const foot = document.getElementById('intro-next');
  const out = [card.textContent, foot.textContent];
  const walk = (n) => { for (const c of n.children || []) { for (const a of ['aria-label', 'title', 'placeholder']) if (c.getAttribute(a)) out.push(c.getAttribute(a)); walk(c); } };
  walk(card);
  return out.join(' | ');
}

test('Eden Code’s Setup names Eden Code on every card, and its last card has no voice examples', () => {
  const w = stand();
  w.window.jarvisIntro.open();
  const seen = [];
  for (let i = 0; i < 12; i++) {
    const id = w.window.jarvisIntro.card();
    if (id === 'claude') w.fire('ops_claude', { state: 'missing' });
    if (id === 'models') w.fire('providers', { providers: [] });
    seen.push(id);
    const text = words(w.document);
    assert.doesNotMatch(text, NAMES, `card ${id}: ${text.match(NAMES)}`);
    if (id === 'done') {
      assert.match(text, /Start using Eden Code/);
      assert.doesNotMatch(text, /“Eden,/, 'a voice example in Eden Code');
      break;
    }
    if (id === 'models') assert.match(text, /Models & API keys/);
    w.$('intro-next').click();
  }
  assert.deepEqual(seen, ['welcome', 'sound', 'claude', 'accounts:Developer', 'models', 'done']);
});

test('Eden Code’s boot-up sound card reads and sets Eden Code’s own choice, through the app', async () => {
  const calls = [];
  let kept = false;
  const bridge = { invoke: (ch, v) => { calls.push([ch, v]); if (typeof v === 'boolean') kept = v; return Promise.resolve(kept); } };
  const w = stand({ bridge });
  w.window.jarvisIntro.open('sound');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls[0], ['feature:boot-sound', undefined], 'asked the app what holds');
  const radios = () => w.document.getElementById('intro-card').querySelectorAll('[role=radio]');
  assert.deepEqual(radios().map((b) => b.getAttribute('aria-checked')), ['false', 'true'], 'shows the app’s Off');
  radios()[0].click();  // On
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.at(-1), ['feature:boot-sound', true]);
  assert.equal(kept, true);
  assert.ok(!w.sent.some((m) => m.type === 'set_prefs'), 'Eden Secretary’s boot_sound was set');
  assert.deepEqual(radios().map((b) => b.getAttribute('aria-checked')), ['true', 'false']);
});

test('Eden Secretary’s Setup still sets its own boot_sound', () => {
  const w = stand({ eden: false });
  w.window.jarvisIntro.open('sound');
  w.document.getElementById('intro-card').querySelectorAll('[role=radio]')[1].click();
  assert.deepEqual(w.sent.at(-1), { type: 'set_prefs', changes: { boot_sound: false } });
});
