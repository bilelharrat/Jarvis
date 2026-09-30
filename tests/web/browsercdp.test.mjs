// A browser tab over the DevTools protocol (app/browser-cdp.js), with a fake debugger: it
// attaches once and lazily, every call has a time limit, it won't attach over the page's open
// developer tools, a detach (or a new page) makes earlier refs stale, and it keeps the tab's
// console and requests. node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { TabCdp, CdpError } = require('../../app/browser-cdp.js');

function fakeTab({ devtools = false, answers = {} } = {}) {
  const dbg = new EventEmitter();
  dbg.attached = false;
  dbg.calls = [];
  dbg.attaches = 0;
  dbg.attach = () => { dbg.attached = true; dbg.attaches += 1; };
  dbg.isAttached = () => dbg.attached;
  dbg.detach = () => { dbg.attached = false; };
  dbg.sendCommand = (method, params, session) => {
    dbg.calls.push({ method, params, session });
    if (method === 'Hang') return new Promise(() => {});
    if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'MAIN' } } });
    if (answers[method]) return Promise.resolve(answers[method](params, session));
    return Promise.resolve({});
  };
  const wc = { id: 7, debugger: dbg, isDestroyed: () => false, isDevToolsOpened: () => devtools };
  return { wc, dbg, emit: (method, params = {}, session = '') => dbg.emit('message', {}, method, params, session) };
}

test('it attaches once, lazily, and learns the main frame', async () => {
  const { wc, dbg } = fakeTab();
  const cdp = new TabCdp(wc);
  assert.equal(dbg.attaches, 0);
  await Promise.all([cdp.ensure(), cdp.ensure(), cdp.ensure()]);
  assert.equal(dbg.attaches, 1);
  assert.equal(cdp.mainFrameId, 'MAIN');
  for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable', 'Target.setAutoAttach']) {
    assert.ok(dbg.calls.some((c) => c.method === domain), domain);
  }
  await cdp.ensure();
  assert.equal(dbg.attaches, 1);
});

test('every call has a time limit', async () => {
  const { wc } = fakeTab();
  const cdp = new TabCdp(wc);
  await cdp.ensure();
  const started = Date.now();
  await assert.rejects(cdp.send('Hang', {}, { timeout: 60 }), (err) => err instanceof CdpError && err.code === 'timeout' && /Hang/.test(err.message));
  assert.ok(Date.now() - started < 1000);
});

test("it doesn't attach while the page's developer tools are open", async () => {
  const { wc, dbg } = fakeTab({ devtools: true });
  await assert.rejects(new TabCdp(wc).ensure(), (err) => err.code === 'devtools' && /developer tools/.test(err.message));
  assert.equal(dbg.attaches, 0);
});

test('a detach lets go, and the next use attaches again as for a new page', async () => {
  const { wc, dbg } = fakeTab();
  const cdp = new TabCdp(wc);
  await cdp.ensure();
  const gen = cdp.docGen;
  const waiting = cdp.waitFor(() => false, 10000);
  dbg.attached = false;
  dbg.emit('detach', {}, 'DevTools opened');
  assert.equal(cdp.attached, false);
  assert.equal(await waiting, null); // no one is left waiting on a gone session
  await assert.rejects(cdp.send('Page.enable'), (err) => err.code === 'detached');
  await cdp.ensure();
  assert.equal(dbg.attaches, 2);
  assert.ok(cdp.docGen > gen, 'refs from before the detach are stale');
});

test('a new main-frame document bumps the generation; frames inside it and same-page moves do not', async () => {
  const { wc, emit } = fakeTab();
  const cdp = new TabCdp(wc);
  await cdp.ensure();
  const gen = cdp.docGen;
  emit('Page.frameNavigated', { frame: { id: 'CHILD', parentId: 'MAIN' } });
  emit('Page.navigatedWithinDocument', { frameId: 'MAIN', url: 'https://x.example/#b' });
  assert.equal(cdp.docGen, gen);
  emit('Page.frameNavigated', { frame: { id: 'MAIN' } });
  assert.equal(cdp.docGen, gen + 1);
  emit('Page.frameNavigated', { frame: { id: 'OOPIF' } }, 'child-session'); // another process's frame
  assert.equal(cdp.docGen, gen + 1);
});

test("it keeps the page's console, not Electron's own warnings, and caps it", async () => {
  const { wc, emit } = fakeTab();
  const cdp = new TabCdp(wc);
  await cdp.ensure();
  emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: '%cElectron Security Warning (Insecure Content-Security-Policy)' }] });
  emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }, { type: 'number', value: 42 }], stackTrace: { callFrames: [{ url: 'http://localhost:5173/a.js', lineNumber: 3 }] } });
  emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' } } });
  emit('Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource: 404', url: 'http://localhost:5173/x.json' } }, 'child');
  assert.deepEqual(cdp.console.map((m) => [m.level, m.text]), [
    ['error', 'boom 42'], ['error', 'Uncaught TypeError: x is undefined'], ['error', 'Failed to load resource: 404'],
  ]);
  assert.equal(cdp.console[0].url, 'http://localhost:5173/a.js');
  assert.equal(cdp.console[2].frame, 'iframe');
  for (let i = 0; i < 500; i++) emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: `n${i}` }] });
  assert.equal(cdp.console.length, 300);
  assert.equal(cdp.console.at(-1).text, 'n499');
});

test('it follows each request to its answer or failure, and knows what is still loading', async () => {
  let now = 1000;
  const { wc, emit } = fakeTab();
  const cdp = new TabCdp(wc, { now: () => now });
  await cdp.ensure();
  emit('Network.requestWillBeSent', { requestId: 'a', type: 'Fetch', request: { method: 'GET', url: 'http://localhost/api' } });
  emit('Network.requestWillBeSent', { requestId: 'b', type: 'XHR', request: { method: 'POST', url: 'http://localhost/save' } });
  emit('Network.requestWillBeSent', { requestId: 'c', type: 'WebSocket', request: { method: 'GET', url: 'ws://localhost/live' } });
  assert.equal(cdp.busy(), 2); // a socket isn't a load
  now += 30;
  emit('Network.responseReceived', { requestId: 'a', response: { status: 404, mimeType: 'application/json' } });
  emit('Network.loadingFinished', { requestId: 'a', encodedDataLength: 12 });
  emit('Network.loadingFailed', { requestId: 'b', errorText: 'net::ERR_CONNECTION_REFUSED' });
  assert.equal(cdp.busy(), 0);
  const [a, b] = cdp.requests;
  assert.deepEqual([a.status, a.done, a.ms, a.bytes], [404, true, 30, 12]);
  assert.deepEqual([b.failed, b.method], ['net::ERR_CONNECTION_REFUSED', 'POST']);
  emit('Network.requestWillBeSent', { requestId: 'd', type: 'Fetch', request: { method: 'GET', url: 'http://localhost/poll' } });
  now += 10000;
  assert.equal(cdp.busy(5000), 0, 'a long poll does not count as loading forever');
  for (let i = 0; i < 600; i++) emit('Network.requestWillBeSent', { requestId: `r${i}`, type: 'Image', request: { method: 'GET', url: `http://localhost/${i}.png` } });
  assert.equal(cdp.requests.length, 400);
});

test('waitFor hears the next matching event, or gives up', async () => {
  const { wc, emit } = fakeTab();
  const cdp = new TabCdp(wc);
  await cdp.ensure();
  const chooser = cdp.waitFor((m) => m === 'Page.fileChooserOpened', 2000);
  emit('Page.loadEventFired');
  emit('Page.fileChooserOpened', { backendNodeId: 9, mode: 'selectSingle' }, 'S1');
  const heard = await chooser;
  assert.deepEqual([heard.method, heard.params.backendNodeId, heard.session], ['Page.fileChooserOpened', 9, 'S1']);
  assert.equal(await cdp.waitFor(() => false, 30), null);
});

test('frames in other processes are tracked as sessions, and forgotten when they go', async () => {
  const { wc, dbg, emit } = fakeTab();
  const cdp = new TabCdp(wc);
  await cdp.ensure();
  emit('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://pay.example/' } });
  emit('Target.attachedToTarget', { sessionId: 'W1', targetInfo: { type: 'service_worker', targetId: 'SW' } });
  assert.deepEqual([...cdp.sessions.keys()], ['S1']);
  await new Promise((r) => setImmediate(r));
  assert.ok(dbg.calls.some((c) => c.method === 'Runtime.enable' && c.session === 'S1'), 'its console is kept too');
  emit('Target.detachedFromTarget', { sessionId: 'S1' });
  assert.equal(cdp.sessions.size, 0);
});
