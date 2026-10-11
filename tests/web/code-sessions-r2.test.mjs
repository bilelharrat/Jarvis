// Eden Code's composer, "#" notes and project search: the round 2 bug sweep's fixes
// (askeden/docs/bug-sweep/r2-eden-code-sessions.md CA2-4, CA2-5, CA2-8, CA2-12, CA2-13). The
// composer's functions are taken from app.js's own source and run with stand-ins for the
// window around them. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const APP = readFileSync(new URL('../../src/jarvis/web/app.js', import.meta.url), 'utf8');
const MEMORY = readFileSync(new URL('../../src/jarvis/web/features/code-memory.js', import.meta.url), 'utf8');
const SEARCH = readFileSync(new URL('../../src/jarvis/web/features/code-search.js', import.meta.url), 'utf8');
const SESSIONS = readFileSync(new URL('../../src/jarvis/web/features/code-sessions.js', import.meta.url), 'utf8');

// The source of one top-level declaration (a function, or a const up to its end), found by
// matching its braces outside strings, template literals and comments.
function declaration(name) {
  const start = APP.search(new RegExp(`^(function ${name}\\(|const ${name} = )`, 'm'));
  assert.ok(start >= 0, `${name} not found in app.js`);
  let depth = 0;
  let seen = false;
  const stack = [];  // template literals and their ${ } nesting
  for (let i = start; i < APP.length; i++) {
    const c = APP[i];
    const inTemplate = stack.length && stack[stack.length - 1] === '`';
    if (inTemplate) {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); continue; }
      if (c === '$' && APP[i + 1] === '{') { stack.push('{'); depth++; i++; }
      continue;
    }
    if (c === '/' && APP[i + 1] === '/') { i = APP.indexOf('\n', i); continue; }
    if (c === '/' && APP[i + 1] === '*') { i = APP.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"') {
      for (i++; APP[i] !== c; i++) if (APP[i] === '\\') i++;
      continue;
    }
    if (c === '`') { stack.push('`'); continue; }
    if (c === '{') { depth++; seen = true; if (stack.length) stack.push('{'); }
    if (c === '}') {
      depth--;
      if (stack.length && stack[stack.length - 1] === '{') stack.pop();
      if (seen && depth === 0) return APP.slice(start, i + 1);
    }
    if (c === ';' && depth === 0 && APP.startsWith('const', start)) return APP.slice(start, i + 1);
  }
  throw new Error(`${name}: no end`);
}


// One page (a window, or a split-view pane: each runs its own app.js) with its "!" commands.
function page(taskId) {
  const sent = [];
  const notes = [];
  const node = () => ({ append() {}, querySelector: () => node(), classList: { toggle() {} }, scrollTop: 0, scrollHeight: 0, textContent: '' });
  const ctx = { sent, notes, deckProject: '/p/demo', send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; },
    el: () => node(), $: () => node(), jcNote: (t) => notes.push(t), projectFilesChanged() {} };
  vm.createContext(ctx);
  const names = ['bangContext', 'bangEntries', 'BANG_PAGE', 'runBang', 'onBang', 'projectBangKey', 'MESSAGE_MAX', 'codePoints', 'tooLong'];
  vm.runInContext(`let bangRef = 0;\n${names.map(declaration).join('\n')}\nObject.assign(globalThis, { runBang, onBang, bangContext, tooLong, codePoints, MESSAGE_MAX });`, ctx);
  ctx.task = { id: taskId };
  return ctx;
}

test('two pages\' "!" commands never take each other\'s output (CA2-5)', () => {
  const A = page(1), B = page(2);
  A.runBang(A.task, 'npm test');
  B.runBang(B.task, 'cat .env');
  const [refA, refB] = [A.sent[0].ref, B.sent[0].ref];
  assert.notEqual(refA, refB);  // (before: b1 and b1)
  assert.match(refA, /^[a-z0-9]+-b1$/);
  assert.ok(refA.length <= 40);  // (the backend keeps 40 characters of a ref)
  // Even if B's answer reached A (an old backend sending to every window), A ignores it.
  const answerB = { type: 'task_bash', ref: refB, command: 'cat .env', output: 'SECRET=xyz', code: 0 };
  A.onBang(answerB); B.onBang(answerB);
  A.onBang({ type: 'task_bash', ref: refA, command: 'npm test', output: '12 passing', code: 0 });
  assert.equal(JSON.stringify(A.bangContext.get(1).map((r) => r.command)), '["npm test"]');
  assert.equal(JSON.stringify(B.bangContext.get(2).map((r) => r.command)), '["cat .env"]');
});

test('the composer counts characters as the backend does: an emoji is one (CA2-13)', () => {
  const w = page(1);
  assert.equal(w.codePoints('a😀b'), 3);
  assert.equal(w.tooLong('😀'.repeat(60000)), false);  // 60,000 characters (before: "120,000")
  assert.deepEqual(w.notes, []);
  assert.equal(w.tooLong('😀'.repeat(w.MESSAGE_MAX + 1)), true);
  assert.match(w.notes[0], /^That message is 100,001 characters/);
  assert.equal(w.tooLong('x'.repeat(w.MESSAGE_MAX)), false);
});

function features(current) {
  const handlers = {};
  const sent = [];
  const appended = [];
  const node = (tag) => ({ tag, children: [], dataset: {}, value: '', setAttribute() {}, append(...c) { this.children.push(...c); },
    addEventListener(k, fn) { (this.on ||= {})[k] = fn; }, remove() {}, focus() {}, replaceChildren(...c) { this.children = c; }, contains: () => true,
    classList: { toggle() {} }, isConnected: false });
  const timeline = { append: (li) => appended.push(li) };
  const F = { on: (k, fn) => { handlers[k] = fn; }, send: (m) => { sent.push(m); return true; }, currentTask: () => current,
    $: (id) => (id === 'deck-timeline' ? timeline : null), el: (t) => node(t) };
  return { F, handlers, sent, appended, node };
}

test('a "#" note typed with no session open shows where to save it (CA2-4)', () => {
  const w = features(null);
  const ctx = { jarvisFeatures: w.F, document: { createElement: w.node }, Event: class {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(MEMORY, ctx);
  w.handlers.cw_memory_ask({ type: 'cw_memory_ask', ref: 'r1', id: 0, text: 'always use tabs', choices: [{ target: 'project' }], last: 'project' });
  assert.equal(w.appended.length, 1);  // (before: none, and the note was lost)
  w.handlers.cw_memory_ask({ type: 'cw_memory_ask', ref: 'r2', id: 7, text: 'x', choices: [{ target: 'project' }], last: 'project' });
  assert.equal(w.appended.length, 1);  // a session's own note waits for that session
  const open = features({ id: 3 });
  const ctx2 = { jarvisFeatures: open.F, document: { createElement: open.node }, Event: class {} };
  ctx2.globalThis = ctx2;
  vm.createContext(ctx2);
  vm.runInContext(MEMORY, ctx2);
  open.handlers.cw_memory_ask({ type: 'cw_memory_ask', ref: 'r3', id: 0, text: 'y', choices: [], last: 'project' });
  assert.equal(open.appended.length, 0);  // another session is open: not dropped into it
});

test('a search out while the window reconnects is asked again (CA2-12)', () => {
  const w = features(null);
  let view = null;
  const ctx = { jarvisFeatures: w.F, document: { createElement: w.node }, Event: class {}, setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    JarvisEditor: { where: () => ({ directory: '/p/demo' }), registerView: (_k, v) => { view = v; }, open() {} } };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH, ctx);
  const into = w.node('div');
  view.render(into);
  const input = into.children[0].children[0].children[0];
  input.value = 'needle';
  input.on.input();
  input.on.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.equal(w.sent.length, 1);
  w.handlers.hello({ type: 'hello' });  // connected again: the answer went to the old socket
  assert.equal(w.sent.length, 2);
  assert.notEqual(w.sent[1].ref, w.sent[0].ref);
  w.handlers.cw_search({ type: 'cw_search', ref: w.sent[1].ref, total: 0, files: [] });
  w.handlers.hello({ type: 'hello' });  // nothing out: nothing asked
  assert.equal(w.sent.length, 2);
});

test('edit and resend refuses a message over the limit in the window, never cut (CA2-8)', () => {
  assert.match(SESSIONS, /n > 100000\) \{  \/\/ \(CA2-8\)/);
  assert.match(SESSIONS, /\[\.\.\.text\]\.length/);
});
