// Settings › Speaking › JARVIS (on this Mac): the offline voices as a persona's choices
// (personas-voices.js), and the pane script's Chinese fragment (voice_offline.js; its
// sentences are checked in tests/test_offline_voice.py).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));

test('the offline voices are a persona’s choices once they are downloaded', () => {
  const pv = createRequire(import.meta.url)(`${WEB}/features/personas-voices.js`);
  const local = { ready: false, voices: [{ id: 'bm_george', name: 'George · British' }, { id: 'af_heart', name: 'Heart · American' }] };
  assert.deepEqual(pv.options({ local }, {}).map((o) => o.group), ['']);  // not downloaded: none
  const opts = pv.options({ local: { ...local, ready: true } }, {});
  assert.deepEqual(opts.map((o) => [o.group, o.label]), [['', 'The usual voice'], ['local', 'George · British'], ['local', 'Heart · American']]);
  assert.deepEqual(pv.fromValue(opts[2].value), { provider: 'local', id: 'af_heart' });
  // The persona's own offline voice stays a choice before the download.
  const kept = pv.options({ local }, { provider: 'local', id: 'am_michael', name: 'Michael · American' });
  assert.deepEqual(kept.map((o) => [o.group, o.label]), [['', 'The usual voice'], ['local', 'Michael · American']]);
  assert.equal(pv.LOCAL_NAME, 'JARVIS (on this Mac)');
});

test('the offline voice pane has its Chinese fragment', () => {
  const fragment = JSON.parse(readFileSync(`${WEB}/i18n/voice_offline.json`, 'utf8'));
  for (const [en, zh] of Object.entries(fragment.strings)) assert.ok(/[一-鿿]/.test(zh), `no Chinese for ${en}`);
  for (const [re] of fragment.patterns) assert.doesNotThrow(() => new RegExp(re));
  const source = readFileSync(`${WEB}/features/voice_offline.js`, 'utf8');
  assert.match(source, /^\/\/[^\n]*\n[\s\S]*\(\(\) => \{/);  // wrapped: declares no globals
});
