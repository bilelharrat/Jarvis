// jarvis:// links and the Services menu's "Ask JARVIS" Quick Action (app/features/shell-links.js).
// Nothing here opens a link or touches ~/Library: the Quick Action is written to a temp folder
// and read back with macOS's own tools. node --test tests/web/
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const links = require('../../app/features/shell-links.js');
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const onMac = process.platform === 'darwin';

test('a jarvis:// link asks, opens a panel or opens a project; anything else is nothing', () => {
  const p = links.parseLink;
  assert.deepEqual(p('jarvis://ask?text=What%27s%20the%20weather%3F'), { action: 'ask', text: 'What\'s the weather?' });
  assert.deepEqual(p('jarvis://ASK?text=hi'), { action: 'ask', text: 'hi' });
  assert.deepEqual(p('jarvis:ask?text=hi'), { action: 'ask', text: 'hi' });
  assert.deepEqual(p('jarvis://ask/?text=%E4%BD%A0%E5%A5%BD'), { action: 'ask', text: '你好' });
  assert.deepEqual(p('jarvis://ask'), { action: 'ask', text: '' });
  assert.deepEqual(p('jarvis://open?panel=settings'), { action: 'open', panel: 'settings' });
  assert.deepEqual(p('jarvis://open?panel=Brain'), { action: 'open', panel: 'brain' });
  assert.deepEqual(p('jarvis://open'), { action: 'open', panel: '' });
  assert.deepEqual(p('jarvis://code?project=bsh-research-center'), { action: 'code', project: 'bsh-research-center' });
  for (const bad of [
    'https://ask?text=hi', 'javascript:alert(1)', 'jarvis://send?text=hi', 'jarvis://open?panel=terminal',
    'jarvis://code?project=../secrets', 'jarvis://code?project=a/b', 'jarvis://code?project=.ssh', 'jarvis://code',
    `jarvis://code?project=${'x'.repeat(101)}`, 'jarvis://user:pw@ask?text=hi', 'jarvis://ask:99?text=hi', 'not a url',
    `jarvis://ask?text=${'a'.repeat(41_000)}`, 5, null,
  ]) assert.equal(p(bad), null, String(bad).slice(0, 60));
});

test('what a link puts in the request box is one plain line, and capped', () => {
  const text = (t) => links.parseLink(`jarvis://ask?text=${encodeURIComponent(t)}`).text;
  assert.equal(text('line one\nline two\r\n\tthree'), 'line one line two three');
  // Hidden characters that could disguise the words are dropped; emoji joiners stay.
  assert.equal(text('pay \u202Eevil\u202C \u200Bnow\u0007'), 'pay evil now');
  assert.equal(text('👨\u200D👩\u200D👧'), '👨\u200D👩\u200D👧');
  assert.equal(text('x'.repeat(5000)).length, 2000);
  assert.equal(Array.from(text('😀'.repeat(2500))).length, 2000, 'cut between characters, never inside one');
  assert.equal(links.cleanText('  a   b  '), 'a b');
});

test('the Quick Action is written exactly as its golden copy', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ask-jarvis-')), links.SERVICE_BUNDLE);
  for (const [rel, text] of Object.entries(links.serviceFiles())) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  assert.equal(readFileSync(path.join(dir, 'Contents/Info.plist'), 'utf8'), readFileSync(path.join(FIXTURES, 'ask-jarvis.Info.plist'), 'utf8'));
  assert.equal(readFileSync(path.join(dir, 'Contents/document.wflow'), 'utf8'), readFileSync(path.join(FIXTURES, 'ask-jarvis.document.wflow'), 'utf8'));
  assert.equal(links.isOurService(readFileSync(path.join(dir, 'Contents/Info.plist'), 'utf8')), true);
  assert.equal(links.isOurService('<plist><dict><key>CFBundleIdentifier</key><string>com.someone.else</string></dict></plist>'), false);
  if (!onMac || !existsSync('/usr/bin/plutil')) return;
  // macOS reads it: valid property lists, in the canonical form, and a text service named Ask JARVIS.
  for (const file of ['Contents/Info.plist', 'Contents/document.wflow']) {
    execFileSync('/usr/bin/plutil', ['-lint', path.join(dir, file)]);
    assert.equal(execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', path.join(dir, file)]).toString(), readFileSync(path.join(dir, file), 'utf8'));
  }
  // The Services registry's own reader (it reads the bundle; it registers nothing).
  const pbs = '/System/Library/CoreServices/pbs';
  if (existsSync(pbs)) {
    const read = spawnSync(pbs, ['-read_bundle', dir], { encoding: 'utf8', timeout: 20000 });
    const entries = `${read.stdout}${read.stderr}`;
    assert.match(entries, /default = "Ask JARVIS";/);
    assert.match(entries, /NSMessage = runWorkflowAsService;/);
    assert.match(entries, /"public\.utf8-plain-text"/);
    assert.match(entries, /NSRequiredContext = +\{\s*\};/, 'on in the Services menu from the start');
  }
});

test('the Quick Action’s script turns any selection into a link that reads back the same', { skip: !onMac || !existsSync('/usr/bin/osascript') }, () => {
  // Its last line opens the link; here it prints it instead, so nothing is opened.
  const script = links.SERVICE_SCRIPT.replace('/usr/bin/open "$url"', 'printf "%s" "$url"');
  assert.notEqual(script, links.SERVICE_SCRIPT);
  for (const selection of ['  What does “idempotent” mean?\n', 'Ünïcödé & 你好 = 100%', 'rm -rf ~ $(whoami) `id` "\'; open -a Calculator']) {
    const url = execFileSync('/bin/zsh', ['-c', script], { input: selection }).toString();
    assert.match(url, /^jarvis:\/\/ask\?text=[A-Za-z0-9%\-_.!~*'()]*$/, 'all of it encoded: nothing for a shell to run');
    assert.deepEqual(links.parseLink(url), { action: 'ask', text: links.cleanText(selection) });
  }
});
