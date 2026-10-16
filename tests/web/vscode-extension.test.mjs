// The editor extension (editors/vscode): its API client against a fake Eden Code API (the
// token sent, never an Origin, only this Mac's own address, errors as the API words them,
// the event stream cut anywhere), what it draws from a hunk (where it sits, the file as it
// was), and the extension itself, run against a stand-in for VS Code's module: its
// commands are the ones package.json names, and a session's file opens with its hunks
// marked, Keep and Undo go to the API, comments are sent together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../editors/vscode');
const { Client, EdenError, Unreachable, findUrl, findToken, keychainToken, isLocal, lineSplitter, KEYCHAIN } = require(path.join(root, 'src/client.js'));
const { hunkPlaces, baseText, sessionLabel, receiptsMarkdown, commentOf, fileLabel } = require(path.join(root, 'src/review.js'));

const TOKEN = 'edc_test';

// ── a fake Eden Code API ──

function hunkOf() {
  // a.py lines 3..7 now: "line 5" became "line five", "line 6" taken out.
  return {
    id: 'h1', n: 1, old_start: 2, old_count: 6, new_start: 2, new_count: 5, kept: false, cut: 0,
    lines: [[' ', 'line 2'], [' ', 'line 3'], [' ', 'line 4'], ['-', 'line 5'], ['-', 'line 6'], ['+', 'line five'], [' ', 'line 7'], [' ', 'line 8'], [' ', 'line 9']],
  };
}

async function fakeApi(folder) {
  const calls = [];
  const streams = [];
  let kept = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized: send Authorization: Bearer <your Eden Code API token>' });
      if (req.headers.origin) return json(403, { error: 'no web pages' });
      const view = () => ({ id: 5, view: 'session', git: true, files: [{ path: 'a.py', status: 'M', added: 1, removed: 2, omitted: false, sensitive: false, hunks: [{ ...hunkOf(), kept }] }], totals: { files: 1, hunks: 1 } });
      const p = url.pathname;
      if (p === '/v1/status') return json(200, { ok: true, app: 'Eden Code' });
      if (p === '/v1/sessions') return json(200, { sessions: [{ id: 5, title: 'Rename line five', folder: 'proj', path: folder, status: 'done', busy: false, files_changed: [path.join(folder, 'a.py')] }] });
      if (p === '/v1/sessions/5/changes') return json(200, view());
      if (p === '/v1/sessions/5/receipts') return json(200, { receipts: [{ n: 9, at: '2026-10-16T10:00:00', text: 'Proof · Changed 1 file · no tests run · risk medium: no tests', receipt: { files: ['a.py'], file_count: 1, tests: null, risk: 'medium', why: 'no tests' } }] });
      if (p === '/v1/sessions/5/hunks' && req.method === 'POST') {
        const body = JSON.parse(raw);
        if (body.action === 'keep') kept = true;
        return json(200, { done: true, said: body.action === 'undo' ? 'Undid 1 change.' : '', changes: view() });
      }
      if (p === '/v1/sessions/5/comments' || p === '/v1/sessions/5/messages') return json(202, { sent: true });
      if (p === '/v1/events') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write('{"type":"hello","ok":true}\n{"type":"ses');
        streams.push(res);
        return undefined;
      }
      return json(404, { error: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => { for (const s of streams) s.destroy(); server.closeAllConnections?.(); server.close(r); });
  return { url, calls, streams, close };
}

function tempProject() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-vscode-'));
  const lines = [];
  for (let i = 1; i <= 12; i += 1) lines.push(i === 5 ? 'line five' : `line ${i}`);
  fs.writeFileSync(path.join(folder, 'a.py'), lines.filter((l) => l !== 'line 6').join('\n') + '\n');
  return folder;
}

// ── the client ──

test('the client sends the token, JSON, no Origin, and maps the API’s answers', async () => {
  const api = await fakeApi('/tmp/x');
  try {
    const c = new Client(api.url, TOKEN);
    assert.equal((await c.status()).ok, true);
    assert.equal((await c.sessions())[0].id, 5);
    const view = await c.changes(5, 'turn', 'a.py');
    assert.equal(view.files[0].path, 'a.py');
    await c.keep(5, 'h1', 'session');
    await c.comments(5, [commentOf('a.py', 4, ' Name it five ', 'line five')]);
    await c.send(5, 'Now add a test');
    assert.equal((await c.receipts(5))[0].receipt.risk, 'medium');
    const [first] = api.calls;
    assert.equal(first.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(first.headers.host, api.url.slice('http://'.length));
    assert.equal(first.headers.origin, undefined);
    const changes = api.calls.find((x) => x.path === '/v1/sessions/5/changes');
    assert.deepEqual(changes.query, { view: 'turn', path: 'a.py' });
    const keep = api.calls.find((x) => x.path === '/v1/sessions/5/hunks');
    assert.equal(keep.headers['content-type'], 'application/json');
    assert.deepEqual(keep.body, { hunk: 'h1', action: 'keep', view: 'session', path: '' });
    const sent = api.calls.find((x) => x.path === '/v1/sessions/5/comments');
    assert.deepEqual(sent.body, { comments: [{ path: 'a.py', line: 5, text: 'Name it five', excerpt: 'line five' }] });
    assert.deepEqual(api.calls.find((x) => x.path === '/v1/sessions/5/messages').body, { text: 'Now add a test' });

    await assert.rejects(new Client(api.url, 'wrong').status(), (e) => e instanceof EdenError && e.status === 401 && /Bearer/.test(e.message));
    await assert.rejects(c.request('GET', '/v1/nothing'), (e) => e instanceof EdenError && e.status === 404);
  } finally {
    await api.close();
  }
  await assert.rejects(new Client(api.url, TOKEN).status(), (e) => e instanceof Unreachable);
});

test('only this Mac’s own address, found as the eden-code command finds it', () => {
  assert.throws(() => new Client('http://example.com:8767', TOKEN), Unreachable);
  assert.equal(isLocal('https://127.0.0.1:8767'), false);
  assert.equal(isLocal('http://127.0.0.1.evil.com:80'), false);
  assert.equal(isLocal('http://localhost:9000/'), true);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-data-'));
  assert.equal(findUrl({ env: {}, folder }), 'http://127.0.0.1:8767');
  fs.writeFileSync(path.join(folder, 'code_api.json'), JSON.stringify({ url: 'http://127.0.0.1:9100' }));
  assert.equal(findUrl({ env: {}, folder }), 'http://127.0.0.1:9100');
  assert.equal(findUrl({ env: { EDEN_CODE_URL: 'http://127.0.0.1:9200/' }, folder }), 'http://127.0.0.1:9200');
  assert.equal(findUrl({ setting: 'http://127.0.0.1:9300', env: { EDEN_CODE_URL: 'http://127.0.0.1:9200' }, folder }), 'http://127.0.0.1:9300');
  assert.equal(findUrl({ setting: 'http://evil.example:80', env: {}, folder }), 'http://127.0.0.1:9100');
  fs.writeFileSync(path.join(folder, 'code_api.json'), JSON.stringify({ url: 'http://evil.example:1' }));
  assert.equal(findUrl({ env: {}, folder }), 'http://127.0.0.1:8767');
});

test('the token: the pasted one, else EDEN_CODE_TOKEN, else the Keychain item the app keeps', async () => {
  const keychain = async () => 'from-keychain';
  assert.equal(await findToken({ secret: ' pasted ', env: { EDEN_CODE_TOKEN: 'env' }, keychain }), 'pasted');
  assert.equal(await findToken({ env: { EDEN_CODE_TOKEN: 'env' }, keychain }), 'env');
  assert.equal(await findToken({ env: {}, keychain }), 'from-keychain');
  let ran;
  const run = (file, args, opts, done) => { ran = { file, args }; done(null, 'edc_abc\n'); };
  assert.equal(await keychainToken(run, 'darwin'), 'edc_abc');
  assert.deepEqual(ran, { file: '/usr/bin/security', args: ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'] });
  assert.deepEqual(KEYCHAIN, { service: 'Jarvis connectors', account: 'code-api:token' });
  assert.equal(await keychainToken(run, 'linux'), '');
  assert.equal(await keychainToken((f, a, o, done) => done(new Error('no item')), 'darwin'), '');
});

test('the event stream: whole JSON lines however the chunks fall', async () => {
  const got = [];
  const split = lineSplitter((e) => got.push(e));
  split('{"type":"he');
  split('llo"}\n\nnot json\n{"type":"ping"}\n{"type":');
  split('"changes","id":5}\n');
  assert.deepEqual(got, [{ type: 'hello' }, { type: 'ping' }, { type: 'changes', id: 5 }]);

  const api = await fakeApi('/tmp/x');
  try {
    const events = [];
    let ended = null;
    const close = new Client(api.url, TOKEN).events((e) => events.push(e), (err) => { ended = err || 'ended'; });
    while (!api.streams.length) await new Promise((r) => setTimeout(r, 10));
    api.streams[0].write('sions","sessions":[]}\n');
    api.streams[0].end();
    while (!ended) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, [{ type: 'hello', ok: true }, { type: 'sessions', sessions: [] }]);
    assert.equal(ended, 'ended');
    close();
    let refused;
    new Client(api.url, 'wrong').events(() => {}, (err) => { refused = err; });
    while (!refused) await new Promise((r) => setTimeout(r, 10));
    assert.ok(refused instanceof EdenError && refused.status === 401);
  } finally {
    await api.close();
  }
});

// ── what's drawn ──

test('a hunk’s place in the file now, and the file as it was', () => {
  const at = hunkPlaces(hunkOf());
  assert.deepEqual(at.added, [4]); // "line five", 0-based
  assert.deepEqual(at.removed, [{ line: 4, texts: ['line 5', 'line 6'] }]);
  assert.equal(at.first, 4);
  assert.deepEqual([at.start, at.end], [1, 7]);

  const now = fs.readFileSync(path.join(tempProject(), 'a.py'), 'utf8');
  const before = baseText(now, [hunkOf()]);
  assert.equal(before, Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  assert.equal(baseText(now.replace('line five', 'line 5!'), [hunkOf()]), null); // changed since
  assert.equal(baseText(now, [{ ...hunkOf(), cut: 3 }]), null); // too big to tell
  // Two hunks, put back bottom to top; a new file's hunk leaves nothing.
  const second = { id: 'h2', n: 2, new_start: 10, lines: [[' ', 'line 11'], ['+', 'extra'], [' ', 'line 12']] };
  const withExtra = now.replace('line 12\n', 'extra\nline 12\n');
  assert.equal(baseText(withExtra, [hunkOf(), second]), before);
  assert.equal(baseText('a\nb\n', [{ new_start: 1, lines: [['+', 'a'], ['+', 'b']] }]), '');
});

test('labels and receipts read as the window says them', () => {
  assert.deepEqual(sessionLabel({ id: 3, title: 'Fix login', folder: 'app', busy: true, files_changed: ['a', 'b'] }),
    { label: 'Fix login', description: 'app · working · 2 files' });
  assert.deepEqual(fileLabel({ path: 'a.py', status: 'A', added: 3, removed: 0 }), { label: 'a.py', description: 'new · +3 −0' });
  const md = receiptsMarkdown({ title: 'Fix login' }, [
    { n: 1, at: '2026-10-16T09:00:00', text: 'Proof · first', receipt: { risk: 'low', why: 'small', files: ['a.py'], file_count: 1, tests: { command: 'pytest', passed: true, passed_count: 4, failed_count: 0 } } },
    { n: 2, at: '2026-10-16T10:00:00', text: 'Proof · second', receipt: { risk: 'high', why: 'tests failed', files: [], file_count: 0, tests: { command: 'npm test', passed: false, passed_count: 0, failed_count: 2 } } },
  ]);
  assert.match(md, /^# Receipts · Fix login/);
  assert.ok(md.indexOf('Proof · second') < md.indexOf('Proof · first')); // newest first
  assert.match(md, /High risk\*\*: tests failed/);
  assert.match(md, /`pytest` passed \(4 passed\)/);
  assert.match(md, /`npm test` failed \(2 failed\)/);
  assert.match(receiptsMarkdown(null, []), /No receipts yet/);
});

// ── the extension, against a stand-in for VS Code ──

function fakeVscode(config) {
  const commands = new Map();
  const shown = [];
  const decorations = [];
  const messages = [];
  class Emitter { constructor() { this.fns = []; this.event = (fn) => { this.fns.push(fn); return { dispose() {} }; }; } fire(v) { for (const f of this.fns) f(v); } }
  class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
  class Uri {
    constructor(scheme, p, query = '') { this.scheme = scheme; this.path = p; this.fsPath = p; this.query = query; }
    static file(p) { return new Uri('file', p); }
    static from({ scheme, path: p, query }) { return new Uri(scheme, p, query); }
  }
  const docs = [];
  const editors = [];
  const openDoc = (uri) => {
    const text = fs.readFileSync(uri.fsPath, 'utf8');
    const lines = text.split('\n');
    const doc = { uri, isDirty: false, languageId: 'python', lineCount: lines.length, getText: () => text, lineAt: (n) => ({ text: lines[n] }) };
    docs.push(doc);
    return doc;
  };
  const vscode = {
    EventEmitter: Emitter, Range, Uri,
    ThemeColor: class { constructor(id) { this.id = id; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(v = '') { this.value = v; } appendMarkdown(v) { this.value += v; } appendCodeblock(v) { this.value += v; } },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
    StatusBarAlignment: { Left: 1 }, OverviewRulerLane: { Left: 1 }, CommentMode: { Preview: 1 },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; },
      executeCommand: async (name, ...args) => { shown.push([name, ...args]); },
    },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createTextEditorDecorationType: (o) => ({ o }),
      registerTreeDataProvider: (id, tree) => { vscode.tree = tree; return { dispose() {} }; },
      showTextDocument: async (doc) => {
        const editor = { document: doc, setDecorations: (type, list) => decorations.push({ type, list }) };
        editors.push(editor);
        return editor;
      },
      get visibleTextEditors() { return editors; },
      onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
      showInformationMessage: async (m) => { messages.push(m); },
      showWarningMessage: async (m) => { messages.push(m); return 'Undo'; },
      showErrorMessage: async (m) => { messages.push(m); },
      showInputBox: async () => 'Please add a test',
      showQuickPick: async (items) => items[0],
      setStatusBarMessage: () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: (k) => config[k] }),
      openTextDocument: async (arg) => (arg && arg.content !== undefined ? { uri: Uri.file('untitled'), content: arg.content } : openDoc(arg)),
      get textDocuments() { return docs; },
      registerTextDocumentContentProvider: (scheme, p) => { vscode.baseProvider = p; return { dispose() {} }; },
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    languages: { registerCodeLensProvider: (sel, p) => { vscode.lensProvider = p; return { dispose() {} }; } },
    comments: { createCommentController: () => ({ dispose() {} }) },
  };
  return { vscode, commands, shown, decorations, messages };
}

function loadExtension(fake) {
  const Module = require('node:module');
  const real = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? fake : real.call(this, request, ...rest); };
  try {
    delete require.cache[path.join(root, 'extension.js')];
    return require(path.join(root, 'extension.js'));
  } finally {
    Module._load = real;
  }
}

test('the extension: its commands, a file reviewed in place, Keep, Undo, comments, receipts', async () => {
  const folder = tempProject();
  const api = await fakeApi(folder);
  const fake = fakeVscode({ url: api.url, view: 'session' });
  const ext = loadExtension(fake.vscode);
  const context = { subscriptions: [], secrets: { get: async () => TOKEN, store: async () => {} } };
  const eden = ext.activate(context);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const named = pkg.contributes.commands.map((c) => c.command).sort();
    assert.deepEqual([...fake.commands.keys()].sort(), named);
    for (const m of Object.values(pkg.contributes.menus).flat()) assert.ok(named.includes(m.command), m.command);

    assert.equal(await eden.connect(true), true);
    const [session] = await fake.vscode.tree.getChildren();
    assert.equal(session.label, 'Rename line five');
    const kids = await fake.vscode.tree.getChildren(session);
    assert.deepEqual(kids.map((k) => k.label), ['a.py', 'Receipts']);

    await fake.commands.get('edenCode.openChanges')(5, 'a.py');
    const abs = path.join(folder, 'a.py');
    const last = (n) => fake.decorations.slice(-3)[n].list;
    assert.deepEqual(last(0).map((r) => r.start.line), [4]); // the added line, tinted
    assert.match(last(2)[0].renderOptions.before.contentText, /2 removed: line 5 ⏎ line 6/);
    const doc = fake.vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
    const lenses = fake.vscode.lensProvider.provideCodeLenses(doc);
    assert.deepEqual(lenses.map((l) => l.command.title), ['Eden · change 1', 'Keep', 'Undo', 'Diff']);

    const base = await fake.vscode.baseProvider.provideTextDocumentContent(fake.vscode.Uri.from({ scheme: 'eden-base', path: abs }));
    assert.match(base, /line 5\nline 6\nline 7/);

    await fake.commands.get('edenCode.keep')(5, 'h1', 'a.py', 1);
    assert.deepEqual(fake.vscode.lensProvider.provideCodeLenses(doc).map((l) => l.command.title), ['Eden · change 1 ✓ kept', 'Un-keep', 'Undo', 'Diff']);
    await fake.commands.get('edenCode.undo')(5, 'h1', 'a.py', 1); // (asked first: the stand-in says Undo)
    assert.ok(fake.messages.includes('Undid 1 change.'));
    const undo = api.calls.filter((c) => c.path === '/v1/sessions/5/hunks').map((c) => c.body.action);
    assert.deepEqual(undo, ['keep', 'undo']);

    const thread = { uri: fake.vscode.Uri.file(abs), range: new fake.vscode.Range(4, 0, 4, 0), comments: [], dispose() { this.gone = true; } };
    await fake.commands.get('edenCode.addComment')({ thread, text: 'Call it five' });
    assert.equal(thread.comments.length, 1);
    assert.match(fake.vscode.lensProvider.provideCodeLenses(doc).at(-1).command.title, /Send 1 comment to the session/);
    await fake.commands.get('edenCode.sendComments')(5);
    const sent = api.calls.find((c) => c.path === '/v1/sessions/5/comments');
    assert.deepEqual(sent.body.comments, [{ path: 'a.py', line: 5, text: 'Call it five', excerpt: 'line five' }]);
    assert.ok(thread.gone);

    await fake.commands.get('edenCode.sendMessage')(5);
    assert.deepEqual(api.calls.find((c) => c.path === '/v1/sessions/5/messages').body, { text: 'Please add a test' });
    await fake.commands.get('edenCode.showReceipts')(session);
    assert.ok(fake.shown.some(([name]) => name === 'markdown.showPreview'));
  } finally {
    eden.dispose();
    await api.close();
  }
});
