// Settings › Chats (web/features/channels.js): every sentence it shows has its Chinese in
// web/i18n/channels.json or the window's own i18n-zh.json, and it declares no globals.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const source = readFileSync(`${WEB}/features/channels.js`, 'utf8');
const fragment = JSON.parse(readFileSync(`${WEB}/i18n/channels.json`, 'utf8'));
const core = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
const strings = { ...core.strings, ...fragment.strings };
const patterns = [...core.patterns, ...fragment.patterns].map(([re, rep]) => [new RegExp(re), rep]);

function chinese(text) {
  const key = text.replace(/\s+/g, ' ').trim();
  if (!key || key in strings) return true;
  return patterns.some(([re]) => re.test(key));
}

// The sentences in the script: quoted text that starts with a capital or carries the
// typographic marks the window's own words use. Code (selectors, ids, keys) doesn't.
function sentences() {
  const found = new Set();
  for (const m of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    const s = m[1];
    if (/^[A-Z(]/.test(s) && /[a-z]/.test(s) && !/^[A-Z_]+$/.test(s) && !s.includes('${')) found.add(s);
  }
  return [...found];
}

test('every sentence Settings › Chats shows has its Chinese', () => {
  const all = sentences();
  assert.ok(all.length > 40, `only ${all.length} found`);
  const missing = all.filter((s) => !chinese(s));
  assert.deepEqual(missing, []);
});

test('the dynamic ones are covered by patterns', () => {
  for (const title of ['Telegram', 'iMessage', 'Slack', 'Discord']) {
    assert.ok(chinese(`Use ${title}`), `Use ${title}`);
    assert.ok(chinese(`Heads-ups sent to ${title}`), title);
  }
  assert.ok(chinese('Telegram Bot token') && chinese('Slack App-level token'));
  assert.ok(chinese('Paired with Ann (@ann).') && chinese('Connected @jarvis_bot.'));
  for (const kind of ['request', 'reply', 'voice note', 'refused', 'heads-up', 'approval card']) assert.ok(chinese(kind), kind);
  for (const who of ['you', 'someone else']) assert.ok(chinese(who), who);
});

test('the fragment is well formed', () => {
  assert.equal(typeof fragment.strings, 'object');
  for (const [en, zh] of Object.entries(fragment.strings)) {
    assert.equal(typeof zh, 'string', en);
    assert.ok(/[一-鿿]/.test(zh), `no Chinese for ${en}`);
  }
  for (const [re, rep] of fragment.patterns) assert.doesNotThrow(() => new RegExp(re), rep);
});
