// Eden Code's composer (web/app.js) and session list (web/code-store.js): the round 1 bug
// sweep's fixes (askeden/docs/bug-sweep/r1-eden-code-sessions.md CA1, CA5, CA7, CA9). The
// composer's functions are taken from app.js's own source and run with stand-ins for the
// window around them. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const APP = readFileSync(new URL('../../src/jarvis/web/app.js', import.meta.url), 'utf8');

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

function composer({ task = null, project = 'demo' } = {}) {
  const sent = [];
  const asked = [];
  const notes = [];
  const node = () => ({ append() {}, querySelector: () => node(), classList: { toggle() {} }, scrollTop: 0, scrollHeight: 0, textContent: '' });
  const ctx = {
    sent, asked, notes,
    deckProject: project,
    attachments: [],
    pending: { dirs: new Set(), plugins: new Set() },
    awaitingNewSession: false,
    currentTask: () => task,
    composerState: () => ({ t: task, mode: task ? task.mode : 'ask', modelId: 'opus' }),
    JC_MODES: ['ask', 'edits', 'smart', 'auto', 'plan'].map((id) => ({ id })),
    autoCapable: () => true,
    confirmBypass: (kind, _text, then) => { asked.push(kind); ctx.confirmed = then; },
    send: (msg) => { sent.push(JSON.parse(JSON.stringify(msg))); return true; },  // (this realm's objects)
    unsent: () => false,
    jcNote: (text) => notes.push(text),
    takePending() {}, clearAttachments() {}, renderComposer() {}, openEffort() {}, applyEffort() {},
    featureSessionFields: () => ({}), featureSendFields: () => ({}),
    featureSlash: new Map(),
    codeDefaults: {},
    EFFORTS: ['low', 'medium', 'high', 'xhigh', 'max'],
    el: () => node(),
    $: () => node(),
  };
  vm.createContext(ctx);
  const names = ['SLASH_MODE_IDS', 'SLASH_WITHOUT_SESSION', 'slashWithoutSession', 'localSlash', 'setMode', 'sendToSession',
    'MESSAGE_MAX', 'codePoints', 'tooLong', 'withRan', 'bangContext', 'bangEntries', 'BANG_PAGE', 'runBang', 'saveMemory', 'projectBangKey'];
  vm.runInContext(`let bangRef = 0;\n${names.map(declaration).join('\n')}\n` +
    `Object.assign(globalThis, { localSlash, sendToSession, bangContext, MESSAGE_MAX, withRan });`, ctx);
  return ctx;
}

test('/BYPASS, /Bypass and /bypass all ask, with Touch ID, before Bypass (CA1)', () => {
  for (const typed of ['/bypass', '/BYPASS', '/Bypass', '/ByPaSs']) {
    const w = composer({ task: { id: 4, mode: 'ask' } });
    assert.equal(w.sendToSession(typed), true, typed);
    assert.deepEqual(w.asked, ['bypass'], typed);  // the confirm (and its Touch ID check) first
    assert.deepEqual(w.sent, [], typed);  // nothing sent till it's a yes
    w.confirmed();
    assert.deepEqual(w.sent, [{ type: 'task_mode', id: 4, mode: 'auto' }], typed);
  }
  const w = composer({ task: { id: 4, mode: 'ask' } });
  w.sendToSession('/PLAN');  // every mode command, whatever its capitals
  assert.deepEqual(w.sent, [{ type: 'task_mode', id: 4, mode: 'plan' }]);
});

test('! and # with no session open run in the project, never a new session\'s prompt (CA5)', () => {
  const w = composer();
  assert.equal(w.sendToSession('!ls -la'), true);
  assert.equal(w.sent.length, 1);
  assert.deepEqual({ ...w.sent[0], ref: undefined }, { type: 'task_bash', directory: 'demo', command: 'ls -la', ref: undefined });
  assert.equal(w.sendToSession('#always use tabs'), true);
  assert.deepEqual(w.sent[1], { type: 'task_memory', directory: 'demo', text: 'always use tabs' });
  assert.ok(!w.sent.some((m) => m.type === 'task_new'));
  // What ! ran goes with the project's next new session, as with a session's next message.
  w.bangContext.set('project:demo', [{ command: 'ls -la', output: 'a.txt\n', code: 0 }]);
  w.sendToSession('tidy these up');
  const fresh = w.sent.find((m) => m.type === 'task_new');
  assert.match(fresh.prompt, /^I ran this in the project first:[\s\S]*\$ ls -la\na\.txt[\s\S]*tidy these up$/);
  assert.equal(w.bangContext.has('project:demo'), false);
  const s = composer({ task: { id: 2, mode: 'ask' } });
  s.sendToSession('!npm test');
  assert.equal(s.sent[0].type, 'task_bash');
  assert.equal(s.sent[0].id, 2);
});

test('a message over the limit stays in the composer and says so, never cut (CA7)', () => {
  const w = composer({ task: { id: 2, mode: 'ask' } });
  assert.equal(w.sendToSession('x'.repeat(w.MESSAGE_MAX + 1)), false);  // false: the composer keeps it
  assert.deepEqual(w.sent, []);
  assert.match(w.notes[0], /100,000/);
  // ! output that would make it too long is what's shortened: the user's words go whole.
  const words = `${'y'.repeat(60000)} END-OF-MESSAGE`;
  w.bangContext.set(2, [{ command: 'cat big.log', output: 'z'.repeat(80000), code: 0 }]);
  assert.equal(w.sendToSession(words), true);
  const went = w.sent[0].text;
  assert.ok(went.endsWith(words) && went.length <= w.MESSAGE_MAX);
  assert.ok(went.includes('$ cat big.log\n…z'));
  const none = composer();
  assert.equal(none.sendToSession('p'.repeat(none.MESSAGE_MAX + 5)), false);
  assert.deepEqual(none.sent, []);
});

test('the session list comes back whole from the hub\'s patches (CA9)', () => {
  const { createTasksPatcher } = require('../../src/jarvis/web/code-store.js');
  const whole = createTasksPatcher();
  const hello = { type: 'hello', seq: 1, tasks: [{ id: 3, title: 'c' }, { id: 2, title: 'b' }, { id: 1, title: 'a' }] };
  assert.equal(whole(hello), hello);
  const renamed = whole({ type: 'tasks_patch', seq: 2, items: [{ id: 2, title: 'B' }], removed: [] });
  assert.deepEqual(renamed, { type: 'tasks', seq: 2, items: [{ id: 3, title: 'c' }, { id: 2, title: 'B' }, { id: 1, title: 'a' }] });
  const next = whole({ type: 'tasks_patch', seq: 3, items: [{ id: 4, title: 'd' }], removed: [1] });
  assert.deepEqual(next.items.map((t) => t.id), [4, 3, 2]);
  const ev = { type: 'task_log', id: 3 };
  assert.equal(whole(ev), ev);  // anything else as it came
  const full = whole({ type: 'tasks', items: [{ id: 9 }] });  // a whole list (a feature's own): taken as is
  assert.deepEqual(full.items, [{ id: 9 }]);
  assert.deepEqual(whole({ type: 'tasks_patch', items: [{ id: 8 }], removed: [] }).items.map((t) => t.id), [9, 8]);
  // app.js puts every event through it first, so the store and the features see whole lists.
  assert.match(APP, /function heard\(ev\) \{\n {2}ev = wholeTasks\(ev\);/);
});
