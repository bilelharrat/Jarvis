// Small helpers of the window's app.js, taken from its source (it's one of the window's
// classic scripts): node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = readFileSync(fileURLToPath(new URL('../../src/jarvis/web/app.js', import.meta.url)), 'utf8');

// A function's whole source, from `function name(` to its closing brace.
function source(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js has no function ${name}`);
  let depth = 0;
  for (let i = APP.indexOf('{', start); i < APP.length; i++) {
    if (APP[i] === '{') depth++;
    else if (APP[i] === '}' && --depth === 0) return APP.slice(start, i + 1);
  }
  throw new Error(`function ${name} never ends`);
}
const load = (...names) => new Function(`${names.map(source).join('\n')}\nreturn { ${names.join(', ')} };`)();

const { dateFormat } = load('dateFormat');
const { setProp, setAttr } = load('setProp', 'setAttr');

test('a long list’s dates read as toLocale…String wrote them, Invalid Date and all', () => {
  const kinds = [
    [{ hour: 'numeric', minute: '2-digit', second: '2-digit' }, (d, o) => d.toLocaleTimeString(undefined, o)],  // Activity
    [{ weekday: 'long', month: 'short', day: 'numeric' }, (d, o) => d.toLocaleDateString(undefined, o)],  // History's days
    [{ hour: 'numeric', minute: '2-digit' }, (d, o) => d.toLocaleTimeString(undefined, o)],  // History's times
  ];
  const ats = [Date.now(), new Date(2026, 9, 5, 9, 4, 7).toISOString(), 1759654800000, 0, null, undefined, '', 'nope', NaN, 8.64e15, 8.64e15 + 1];
  for (const [options, old] of kinds) {
    const format = dateFormat(options);
    for (const at of ats) assert.equal(format(at), old(new Date(at), options), `${JSON.stringify(options)} ${String(at)}`);
  }
  assert.equal(dateFormat({ hour: 'numeric' })('nope'), 'Invalid Date');
});

test('a property or an attribute is written only when it changes', () => {
  const writes = [];
  const node = {
    shown: false,
    attrs: { 'aria-pressed': 'false' },
    get hidden() { return this.shown; },
    set hidden(v) { writes.push(`hidden=${v}`); this.shown = v; },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    setAttribute(name, value) { writes.push(`${name}=${value}`); this.attrs[name] = String(value); },
  };
  setProp(node, 'hidden', false);
  setAttr(node, 'aria-pressed', 'false');
  assert.deepEqual(writes, []);
  setProp(node, 'hidden', true);
  setProp(node, 'hidden', true);
  setAttr(node, 'aria-pressed', 'true');
  setAttr(node, 'aria-pressed', 'true');
  setAttr(node, 'data-mode', 'plan');  // one it hasn't got yet
  assert.deepEqual(writes, ['hidden=true', 'aria-pressed=true', 'data-mode=plan']);
  assert.equal(node.hidden, true);
  assert.equal(node.getAttribute('data-mode'), 'plan');
});
