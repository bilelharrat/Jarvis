// Settings › Conversations for you: the nudge delay (src/jarvis/web/features/scheduling.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/scheduling.js', import.meta.url), 'utf8');

function load({ group = true } = {}) {
  const sent = [];
  const listeners = {};
  const section = { inserted: [], insertBefore(node, before) { this.inserted.push([node, before]); } };
  const list = { closest: () => section };
  function el(tag, cls, text) {
    return {
      tag, className: cls || '', textContent: text || '', children: [],
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(type, fn) { this[`on${type}`] = fn; },
    };
  }
  const window = {
    jarvisFeatures: {
      el,
      send: (m) => sent.push(m),
      on: (type, fn) => { listeners[type] = fn; },
      $: (id) => (group && id === 'delegation-list' ? list : null),
    },
  };
  new Function('window', source)(window);
  return { sent, listeners, section, list };
}

test('the nudge setting shows the saved delay and sends a new one', () => {
  const { listeners, section, sent, list } = load();
  listeners.hello({ prefs: { features: { delegate_nudge_hours: 48 } } });
  const [label, before] = section.inserted[0];
  assert.equal(before, list);  // above the conversations
  const select = label.children[1];
  assert.equal(select.value, '48');
  assert.deepEqual(select.children.map((o) => o.value), ['0', '12', '24', '48', '72']);
  select.value = '0';
  select.onchange();
  assert.deepEqual(sent, [{ type: 'feature_prefs', changes: { delegate_nudge_hours: 0 } }]);
  listeners.prefs({ features: { delegate_nudge_hours: 7 } });  // not one of the choices
  assert.equal(select.value, '24');
  listeners.prefs({ features: {} });
  assert.equal(section.inserted.length, 1);  // drawn once
});

test('without the conversations group the script does nothing', () => {
  const { listeners, section } = load({ group: false });
  assert.doesNotThrow(() => listeners.hello({ prefs: {} }));
  assert.equal(section.inserted.length, 0);
});
