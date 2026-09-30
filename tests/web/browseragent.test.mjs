// The browser agent's pure parts (app/browser-agent-core.js): snapshots, refs, what changed,
// screenshot marks, keys, addresses. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../../app/browser-agent-core.js');

// A small accessibility tree the way CDP's Accessibility.getFullAXTree gives it.
let nextId = 1;
function node(role, name, { backend, children = [], props = {}, value, ignored = false, description } = {}) {
  const id = String(nextId++);
  return {
    nodeId: id, role: { value: role }, name: name === undefined ? undefined : { value: name }, ignored,
    backendDOMNodeId: backend, childIds: children.map((c) => c.nodeId), _children: children,
    properties: Object.entries(props).map(([k, v]) => ({ name: k, value: { value: v } })),
    value: value === undefined ? undefined : { value }, description: description ? { value: description } : undefined,
  };
}
function flatten(root) {
  const out = [];
  const walk = (n) => { out.push(n); for (const c of n._children) walk(c); };
  walk(root);
  return out;
}
function page(extra = []) {
  return node('RootWebArea', 'Checkout', { backend: 1, children: [
    node('banner', '', { backend: 2, children: [node('link', 'Home', { backend: 3 })] }),
    node('main', '', { backend: 4, children: [
      node('heading', 'Your cart', { backend: 5, props: { level: 1 } }),
      node('generic', '', { backend: 6, children: [node('StaticText', 'Order total: $56.26', { backend: 7 })] }),
      node('textbox', 'Email', { backend: 8, props: { required: true, focusable: true }, value: 'me@example.com' }),
      node('textbox', 'Password', { backend: 9, value: '••••••' }),
      node('checkbox', 'Gift wrap', { backend: 10, props: { checked: 'false' } }),
      node('button', 'Place order', { backend: 11, children: [node('StaticText', 'Place order', { backend: 12 })] }),
      node('Iframe', 'Payment', { backend: 13 }),
      ...extra,
    ] }),
  ] });
}
const frame = (root) => ({ nodes: flatten(root), session: '', frameId: 'F' });
const child = node('RootWebArea', 'Pay', { backend: 1, children: [node('textbox', 'Card holder', { backend: 2 })] });

function snapshotOf(table, root = page(), opts = {}) {
  return core.buildSnapshot({
    frames: { main: frame(root), pay: { nodes: flatten(child), session: 'S', frameId: 'P' } },
    main: 'main',
    childFrame: (key, backend) => (key === 'main' && backend === 13 ? 'pay' : ''),
    inView: (key, backend) => key === 'main' && backend <= 8,
    table,
    ...opts,
  });
}

test('a snapshot shows roles, names, values and states, with refs on what can be acted on', () => {
  const table = new core.RefTable(new core.RefRegistry(), 7);
  const snap = snapshotOf(table);
  const text = core.renderLines(snap.lines).text;
  assert.match(text, /document "Checkout"/);
  assert.match(text, /\[e\d+\] link "Home" \(in view\)/);
  assert.match(text, /heading "Your cart" \(level 1\)/);
  assert.match(text, /"Order total: \$56\.26"/);
  assert.match(text, /\[e\d+\] textbox "Email" = "me@example.com" \(required, in view\)/);
  assert.match(text, /\[e\d+\] textbox "Password" = "\(hidden\)"/); // a password's bullets never show
  assert.match(text, /\[e\d+\] checkbox "Gift wrap" \(unchecked\)/);
  assert.match(text, /\[e\d+\] button "Place order"\n/); // its own words aren't repeated as text
  assert.match(text, /\[e\d+\] iframe "Payment"\n.*\[e\d+\] textbox "Card holder"/); // the frame's document, inside it
  assert.equal(snap.first, true);
  assert.ok(!/^[+~]/m.test(text), 'no change marks on the first snapshot');
});

test('refs are stable for the same element and unique across tabs', () => {
  const registry = new core.RefRegistry();
  const a = new core.RefTable(registry, 1);
  const b = new core.RefTable(registry, 2);
  const first = core.renderLines(snapshotOf(a).lines).text;
  const again = core.renderLines(snapshotOf(a).lines).text;
  const ref = (text, re) => text.split('\n').find((l) => re.test(l)).match(/\[(e\d+)\]/)[1];
  assert.equal(ref(first, /"Place order"/), ref(again, /"Place order"/));
  const other = core.renderLines(snapshotOf(b).lines).text;
  assert.notEqual(ref(first, /"Place order"/), ref(other, /"Place order"/));
  const mine = ref(first, /"Place order"/);
  assert.ok(a.lookup(mine).entry);
  assert.match(b.lookup(mine).error, new RegExp(`${mine} belongs to tab 1`));
  assert.match(a.lookup('e999999').error, /no e999999/);
  assert.match(a.lookup('button').error, /isn't a ref/);
});

test('a new page makes every earlier ref stale, and its refs never reuse their numbers', () => {
  const table = new core.RefTable(new core.RefRegistry(), 1);
  const text = core.renderLines(snapshotOf(table).lines).text;
  const old = text.match(/\[(e\d+)\] link "Home"/)[1];
  table.newDocument(1);
  assert.match(table.lookup(old).error, /earlier snapshot/);
  const fresh = core.renderLines(snapshotOf(table).lines).text.match(/\[(e\d+)\] link "Home"/)[1];
  assert.notEqual(fresh, old);
  assert.ok(Number(fresh.slice(1)) > Number(old.slice(1)));
});

test('what changed since the last snapshot is marked', () => {
  const table = new core.RefTable(new core.RefRegistry(), 1);
  snapshotOf(table);
  const dialog = node('dialog', 'Sign in', { backend: 50, props: { modal: true }, children: [node('textbox', 'Name', { backend: 51 })] });
  const changed = page([dialog]);
  const flat = flatten(changed);
  flat.find((n) => n.name && n.name.value === 'Gift wrap').properties = [{ name: 'checked', value: { value: 'true' } }];
  const snap = snapshotOf(table, changed);
  const text = core.renderLines(snap.lines).text;
  assert.match(text, /^\+\s+\[e\d+\] dialog "Sign in" \(modal\)/m);
  assert.match(text, /^\+\s+\[e\d+\] textbox "Name"/m);
  assert.match(text, /^~\s+\[e\d+\] checkbox "Gift wrap" \(checked\)/m);
  assert.match(text, /^ \s+\[e\d+\] link "Home"/m); // unchanged
  assert.deepEqual(snap.counts, { added: 2, changed: 1, removed: 0 });
  assert.equal(snap.first, false);
  // Scrolling (in view) or focus alone isn't a change.
  const again = snapshotOf(table, changed, { inView: () => true });
  assert.equal(again.counts.changed, 0);
});

test('interactive snapshots keep only what can be acted on, and within scopes to one element', () => {
  const table = new core.RefTable(new core.RefRegistry(), 1);
  const small = core.renderLines(snapshotOf(table, page(), { interactive: true }).lines).text;
  assert.ok(!/Order total/.test(small));
  assert.match(small, /textbox "Email"/);
  const iframeRef = small.match(/\[(e\d+)\] iframe "Payment"/)[1];
  const scoped = core.renderLines(snapshotOf(table, page(), { within: iframeRef }).lines).text;
  assert.deepEqual(scoped.split('\n').map((l) => l.trim().replace(/\[e\d+\] /, '')), ['iframe "Payment"', 'textbox "Card holder"']);
});

test('a long list of options shows its first twelve and a count', () => {
  const options = Array.from({ length: 40 }, (_, i) => node('option', `Country ${i}`, { backend: 100 + i }));
  const select = node('combobox', 'Country', { backend: 99, props: { expanded: 'false' }, children: options });
  const text = core.renderLines(snapshotOf(new core.RefTable(new core.RefRegistry(), 1), page([select])).lines).text;
  assert.match(text, /Country 11/);
  assert.ok(!/Country 12"/.test(text));
  assert.match(text, /… 28 more options/);
});

test('long snapshots are paged by line within the budget', () => {
  const many = Array.from({ length: 300 }, (_, i) => node('button', `Button number ${i} with a long label to fill the page`, { backend: 1000 + i }));
  const snap = snapshotOf(new core.RefTable(new core.RefRegistry(), 1), page(many));
  const first = core.renderLines(snap.lines, { budget: 4000 });
  assert.ok(first.text.length <= 4000);
  assert.ok(first.next > 0 && first.next < snap.lines.length);
  const second = core.renderLines(snap.lines, { offset: first.next, budget: 4000 });
  assert.equal(second.start, first.next);
  assert.notEqual(second.text.split('\n')[0], first.text.split('\n')[0]);
  const last = core.renderLines(snap.lines, { offset: snap.lines.length - 2 });
  assert.equal(last.next, 0);
});

test('names and values are capped and ignored nodes are skipped', () => {
  const long = 'x'.repeat(500);
  const root = node('RootWebArea', 'T', { backend: 1, children: [
    node('button', long, { backend: 2 }),
    node('generic', '', { backend: 3, ignored: true, children: [node('link', 'Inside ignored', { backend: 4 })] }),
  ] });
  const text = core.renderLines(core.buildSnapshot({ frames: { m: frame(root) }, main: 'm', table: new core.RefTable(new core.RefRegistry(), 1) }).lines).text;
  assert.ok(text.includes(`${'x'.repeat(99)}…`));
  assert.match(text, /link "Inside ignored"/);
});

test('marks sit by their elements, inside the viewport, without piling up', () => {
  const items = [
    { ref: 'e1', x: 10, y: 40, width: 100, height: 30 },
    { ref: 'e2', x: 12, y: 42, width: 100, height: 30 }, // almost on top of e1
    { ref: 'e3', x: 790, y: 0, width: 50, height: 20 }, // at the right and top edges
    { ref: 'e4', x: 10, y: 2000, width: 50, height: 20 }, // off screen: no mark
    { ref: 'e5', x: 10, y: 10, width: 0, height: 0 }, // no size: no mark
  ];
  const marks = core.layoutMarks(items, { width: 800, height: 600 });
  assert.deepEqual(marks.map((m) => m.ref), ['e1', 'e2', 'e3']);
  for (const m of marks) {
    assert.ok(m.label.x >= 0 && m.label.x + m.label.width <= 800);
    assert.ok(m.label.y >= 0 && m.label.y + m.label.height <= 600);
  }
  assert.ok(!core.intersects(marks[0].label, marks[1].label), 'the second label moved off the first');
  assert.equal(core.layoutMarks(items, { width: 800, height: 600 }, { max: 1 }).length, 1);
});

test('key names become CDP key events, shortcuts type nothing', () => {
  assert.deepEqual(
    (({ key, code, keyCode, text, modifiers }) => ({ key, code, keyCode, text, modifiers }))(core.parseKey('Enter')),
    { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 },
  );
  const selectAll = core.parseKey('Cmd+A');
  assert.equal(selectAll.modifiers, 4);
  assert.equal(selectAll.text, undefined);
  assert.deepEqual(selectAll.commands, ['selectAll']);
  assert.equal(core.parseKey('Shift+a').text, 'A');
  assert.equal(core.parseKey('a').printable, true);
  assert.equal(core.parseKey('Shift+Tab').modifiers, 8);
  assert.equal(core.parseKey('F5').key, 'F5');
  assert.equal(core.parseKey('Hyper+X'), null);
  assert.equal(core.parseKey('NotAKey'), null);
  assert.equal(core.parseKey(''), null);
});

test('URL waits take globs or a piece of the address', () => {
  assert.ok(core.urlMatches('https://shop.example/checkout/review', '**/checkout/**'));
  assert.ok(core.urlMatches('https://shop.example/cart', 'https://shop.example/*'));
  assert.ok(!core.urlMatches('https://shop.example/cart/x', 'https://shop.example/*'));
  assert.ok(core.urlMatches('https://shop.example/thanks?order=1', 'thanks'));
  assert.ok(!core.urlMatches('https://shop.example/', ''));
});

test('only pages on this Mac count as local', () => {
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:8000/x', 'http://[::1]:3000/', 'https://app.localhost/']) assert.ok(core.isLoopback(url), url);
  for (const url of ['https://example.com', 'http://localhost.evil.com/', 'file:///tmp/x.html', 'http://128.0.0.1/', 'not a url']) assert.ok(!core.isLoopback(url), url);
});

test('risky presses: sending, paying, deleting and form submits, not plain links', () => {
  assert.ok(core.risky('Place order'));
  assert.ok(core.risky('Delete account'));
  assert.ok(core.risky('Next', { submits: true }));
  assert.ok(!core.risky('Next'));
  assert.ok(!core.risky('Delete this post', { role: 'link' }));
  assert.ok(core.risky('Send', { role: 'link', submits: true }));
});
