// Eden Code for smaller models (web/features/code-lean.js): the model menu's line for a
// model on this Mac, and Settings' lean mode default. node --test tests/web/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lean = require('../../src/jarvis/web/features/code-lean.js');

test('a model on this Mac shows what it weighs, how much it reads and where it runs', () => {
  assert.equal(lean.localNote({ size: 4_683_087_332, context: 32768, server: 'Ollama', tools: true }), '4.7 GB · 32k context · Ollama');
  assert.equal(lean.localNote({ size: 274_302_450, context: 131072, server: 'LM Studio', tools: false }), '274 MB · 128k context · no tool calling · LM Studio');
  assert.equal(lean.localNote({ size: 42e9, context: 1_048_576, server: 'Ollama' }), '42 GB · 1M context · Ollama');
  assert.equal(lean.localNote({ server: 'Ollama', needs_add: true }), 'Ollama · add and use');
  // whatever a server sent oddly is left out, never shown as NaN
  assert.equal(lean.localNote({ size: 'huge', context: -1, provider_name: 'Ollama' }), 'Ollama');
  assert.equal(lean.localNote(null), '');
});

test('lean mode is automatic unless Settings says otherwise', () => {
  assert.equal(lean.modeOf({}), 'auto');
  assert.equal(lean.modeOf({ code_lean_mode: 'off' }), 'off');
  assert.equal(lean.modeOf({ code_lean_mode: 'sometimes' }), 'auto');
  assert.deepEqual(lean.MODES.map(([id]) => id), ['auto', 'on', 'off']);
});

test('the composer menu lists models on this Mac under their own heading, unadded ones too', () => {
  const app = readFileSync(new URL('../../src/jarvis/web/app.js', import.meta.url), 'utf8');
  assert.match(app, /heading: 'On this Mac'/);
  assert.match(app, /m\.needs_add \? useLocalModel\(m\) : pickModel\(m\.ref\)/);
  assert.match(app, /case 'local_model_ready': if \(ev\.ref\) pickModel\(ev\.ref\)/);
  assert.match(app, /!m\.eden && !m\.builtin && !m\.local/);  // not twice, under Your models too
});
