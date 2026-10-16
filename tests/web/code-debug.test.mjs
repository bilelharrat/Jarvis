// Eden Code's Debug pane (web/features/code-debug.js; the backend is features/code_debugger.py
// and code_dap.py): its words for a run, breakpoints written as file:line, the pane drawing a
// stopped run and sending what the owner does (take over, step, open a variable, evaluate,
// add a breakpoint), the debuggers listed with their install commands when there's no run,
// and the Settings switch. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const D = require('../../src/jarvis/web/features/code-debug.js');
const source = readFileSync(new URL('../../src/jarvis/web/features/code-debug.js', import.meta.url), 'utf8');

test('a run’s state in words', () => {
  assert.equal(D.stateWords({ state: 'stopped', reason: 'breakpoint' }), 'Stopped at a breakpoint');
  assert.equal(D.stateWords({ state: 'stopped', reason: 'pause' }), 'Paused');
  assert.equal(D.stateWords({ state: 'stopped', reason: 'odd' }), 'Stopped');
  assert.equal(D.stateWords({ state: 'running' }), 'Running');
  assert.equal(D.stateWords({ state: 'ended', reason: 'The program ended (exit code 1).' }), 'The program ended (exit code 1).');
  assert.equal(D.stateWords(null), '');
});

test('breakpoints, paths and install commands', () => {
  assert.deepEqual(D.parseBreakpoint('src/app.py:42'), { file: 'src/app.py', line: 42 });
  assert.deepEqual(D.parseBreakpoint(' a.py:3 if x > 1 '), { file: 'a.py', line: 3, condition: 'x > 1' });
  for (const bad of ['', 'a.py', 'a.py:0', 'a.py:x']) assert.equal(D.parseBreakpoint(bad), null, bad);
  assert.equal(D.shortPath('/p/app/src/a.py', '/p/app'), 'src/a.py');
  assert.equal(D.shortPath('/private/tmp/app/a.py', '/tmp/app'), 'a.py');
  assert.equal(D.shortPath('/usr/lib/x.py', '/p/app'), '/usr/lib/x.py');
  assert.equal(D.installCommand('debugpy isn’t installed for /v/python. Install it with: /v/python -m pip install debugpy'), '/v/python -m pip install debugpy');
  assert.equal(D.installCommand('lldb-dap comes with Xcode’s command-line tools: xcode-select --install'), 'xcode-select --install');
  assert.equal(D.installCommand('Node.js isn’t installed (https://nodejs.org).'), '');
});

test('the buttons a run has', () => {
  const stopped = Object.fromEntries(D.controls({ state: 'stopped' }).map(([a, , on]) => [a, on]));
  assert.deepEqual(stopped, { continue: true, next: true, stepIn: true, stepOut: true, pause: false, stop: true });
  const running = Object.fromEntries(D.controls({ state: 'running' }).map(([a, , on]) => [a, on]));
  assert.equal(running.pause, true);
  assert.equal(running.next, false);
  assert.deepEqual(D.controls({ state: 'ended' }), []);
});

function stand() {
  const document = makeDocument();
  const el = elFor(document);
  const pane = el('div');
  pane.id = 'jc-pane';
  const body = el('div');
  body.id = 'jc-pane-body';
  pane.append(body);
  const general = el('div');
  general.id = 'jcs-general';
  general.append(el('div', 'jcs-foot'));
  document.body.append(pane, general);
  const handlers = {};
  const sent = [];
  const panes = new Map();
  const F = {
    el, t: (x) => x, $: (id) => document.getElementById(id),
    send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerPane: (id, p) => panes.set(id, p), registerMoreItem() {}, openPane() {},
    currentTask: () => ({ id: 7, kind: 'code', path: '/p/app' }),
  };
  const scope = { window: { jarvisFeatures: F }, document, currentPane: 'cw-debug', navigator: { clipboard: { writeText() {} } }, setTimeout };
  load(source, scope);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  return { document, body, fire, sent, pane: panes.get('cw-debug') };
}

const byText = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);

const RUN = {
  adapter: 'debugpy', language: 'python', driver: 'agent', control: 'agent', request: 'launch', target: '/p/app/prog.py',
  state: 'stopped', reason: 'breakpoint', exception: '', thread: 1, steps: 2, steps_max: 300, seconds: 65, seconds_max: 1200,
  frames: [{ id: 1000, name: 'main', file: '/p/app/prog.py', line: 3 }, { id: 1001, name: '<module>', file: '/p/app/prog.py', line: 1 }],
  scopes: [{ name: 'Locals', ref: 100, expensive: false, variables: [{ name: 'line', value: '3', type: 'int', ref: 0 }, { name: 'data', value: '{…}', type: 'dict', ref: 101 }] }],
  breakpoints: { '/p/app/prog.py': [{ line: 3, condition: '', verified: true, message: '' }, { line: 99, condition: '', verified: false, message: 'no code there' }] },
  output: ['hello'],
};

test('a stopped run: its stack, variables, breakpoints; the owner takes over, steps, opens, evaluates', () => {
  const w = stand();
  w.pane.render(w.body);
  assert.deepEqual(w.sent.at(-1), { type: 'dbg_state', id: 7 });
  assert.match(w.body.textContent, /Checking…/);
  w.fire('dbg_state', { id: 7, on: true, run: RUN, adapters: [] });
  const text = w.body.textContent;
  assert.match(text, /Stopped at a breakpoint/);
  assert.match(text, /Eden Code has the debugger/);
  assert.match(text, /prog\.py:3/);
  assert.match(text, /prog\.py:99/);
  assert.match(text, /no code there/);
  assert.match(text, /Steps 2\/300 · 1\/20 min/);
  assert.ok(w.body.querySelector('.dbg-output').hasAttribute('data-no-i18n'));  // (the program’s words, as data)
  byText(w.body, 'Take over').click();
  assert.deepEqual(w.sent.at(-1), { type: 'dbg_do', id: 7, action: 'take' });
  assert.equal(byText(w.body, 'Step over').disabled, true);  // (busy till the answer)
  w.fire('dbg_state', { id: 7, on: true, run: { ...RUN, control: 'user' } });
  byText(w.body, 'Step over').click();
  assert.deepEqual(w.sent.at(-1), { type: 'dbg_do', id: 7, action: 'next' });
  assert.equal(byText(w.body, 'Step into').disabled, true);  // (busy till the answer)
  w.fire('dbg_state', { id: 7, on: true, run: { ...RUN, control: 'user' } });
  assert.match(w.body.textContent, /You have the debugger/);
  assert.ok(byText(w.body, 'Hand back'));
  byText(w.body, '▸').click();
  assert.deepEqual(w.sent.at(-1), { type: 'dbg_do', id: 7, action: 'expand', ref: 101 });
  w.fire('dbg_vars', { id: 7, ref: 101, variables: [{ name: "'k'", value: "'v'", ref: 0 }] });
  assert.match(w.body.textContent, /'k'.*'v'/);
  const form = w.body.querySelectorAll('form')[0];
  form.querySelector('input').value = 'line + 1';
  form.dispatchEvent(w.document.event('submit'));
  assert.deepEqual(w.sent.at(-1), { type: 'dbg_do', id: 7, action: 'evaluate', expression: 'line + 1' });
  w.fire('dbg_eval', { id: 7, expression: 'line + 1', result: '4' });
  assert.match(w.body.textContent, /line \+ 14/);
  const bpForm = w.body.querySelectorAll('form')[1];
  bpForm.querySelector('input').value = 'nope';
  bpForm.dispatchEvent(w.document.event('submit'));
  assert.match(w.body.textContent, /Write it as file:line/);
  w.body.querySelectorAll('form')[1].querySelector('input').value = 'src/a.py:12 if n > 2';
  w.body.querySelectorAll('form')[1].dispatchEvent(w.document.event('submit'));
  assert.deepEqual(w.sent.at(-1), { type: 'dbg_do', id: 7, action: 'breakpoint', file: 'src/a.py', line: 12, condition: 'n > 2', on: true });
  w.body.querySelectorAll('.dbg-frame')[1].click();
  assert.deepEqual(w.sent.at(-1), { type: 'dbg_do', id: 7, action: 'frame', frame: 1001 });
  w.fire('dbg_error', { id: 7, error: 'The program isn’t stopped.' });
  assert.match(w.body.textContent, /The program isn’t stopped\./);
  w.fire('dbg_state', { id: 99, on: true, run: null });  // (another session’s: left)
  assert.match(w.body.textContent, /You have the debugger/);
});

test('no run: the debuggers with install commands, and a run of the owner’s own', () => {
  const w = stand();
  w.pane.render(w.body);
  w.fire('dbg_state', {
    id: 7, on: true, run: null,
    adapters: [
      { id: 'python', name: 'debugpy', languages: ['python'], available: false, install: 'Install it with: python3 -m pip install debugpy' },
      { id: 'lldb', name: 'lldb-dap', languages: ['swift', 'c'], available: true, install: '' },
    ],
  });
  const text = w.body.textContent;
  assert.match(text, /debugpy.*Not installed/);
  assert.match(text, /lldb-dap.*Ready/);
  assert.ok(byText(w.body, 'Copy'));
  const form = w.body.querySelector('.dbg-start');
  assert.equal(form.querySelectorAll('option').length, 1);  // (only the ones that are here)
  form.dispatchEvent(w.document.event('submit'));
  assert.match(w.body.textContent, /Say which program to debug\./);
  const again = w.body.querySelector('.dbg-start');
  again.querySelector('#dbg-program').value = '-m pytest';
  again.querySelector('#dbg-args').value = 'tests/a.py -x';
  again.dispatchEvent(w.document.event('submit'));
  assert.deepEqual(w.sent.at(-1), { type: 'dbg_do', id: 7, action: 'launch', language: 'lldb', module: 'pytest', args: 'tests/a.py -x', stop_on_entry: false });
});

test('the Settings switch turns the debugger off and follows the prefs', () => {
  const w = stand();
  const sw = w.document.getElementById('dbg-setting');
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  sw.click();
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_debugger: false } });
  w.fire('prefs', { features: { code_debugger: true } });
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  w.fire('prefs', { features: { code_debugger: false } });
  assert.equal(sw.getAttribute('aria-checked'), 'false');
});
