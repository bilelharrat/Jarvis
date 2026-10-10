// Screen-reader mode's words (src/jarvis/web/features/accessibility.js), run without a page:
// the script sets window.jarvisAccessibility and stops where the page begins.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/accessibility.js', import.meta.url), 'utf8');
const window = { navigator: { platform: 'Win32' } };
new Function('window', source)(window);
const A = window.jarvisAccessibility;

test('markdown marks are gone and every line ends where a voice pauses', () => {
  const said = A.plainForReader('## Today\n\n- **Meeting** at 3\n- _Call_ Ann\n\nAll `done`');
  assert.equal(said, 'Today. Meeting at 3. Call Ann. All done.');
});

test('links are read by their name or their site, never the address', () => {
  assert.equal(A.plainForReader('See [the docs](https://example.com/a/b?x=1) now.'), 'See the docs now.');
  assert.equal(A.plainForReader('Open https://www.example.com/path/to?q=1 today'), 'Open link to example.com today.');
});

test('emoji and drawing characters are dropped, tables become a list of words', () => {
  assert.equal(A.plainForReader('Done ✅ ━━━━ great 🎉'), 'Done great.');
  assert.equal(A.plainForReader('| Name | Total |\n| --- | --- |\n| Ann | $5 |'), 'Name, Total. Ann, $5.');
});

test('code is announced as code, not as symbols', () => {
  const said = A.plainForReader('Run this:\n```sh\nnpm test\n```\nThen stop.');
  assert.match(said, /Code: npm test\. End of code\./);
  assert.match(said, /Then stop\.$/);
});

test('nothing in, nothing said', () => {
  assert.equal(A.plainForReader(''), '');
  assert.equal(A.plainForReader(null), '');
  assert.equal(A.plainForReader('  \n  '), '');
});

test('the Mac’s glyphs become the keys a Windows user presses', () => {
  assert.equal(A.keyWords('Tap the orb or press ⌥ Space', false), 'Tap the orb or press Ctrl+Alt+Space');
  assert.equal(A.keyWords('⌥⇧ Space what’s this', false), 'Alt+Shift+Space what’s this');
  assert.equal(A.keyWords('Settings ⌘,', false), 'Settings Ctrl+,');
  assert.equal(A.keyWords('split ⌘⇧\\', false), 'split Ctrl+Shift+\\');
  assert.equal(A.keyWords('find ⌘F in the page', false), 'find Ctrl+F in the page');
  assert.equal(A.keyWords('send ↩', false), 'send Enter');
});

test('a glyph is never taken for the first letter of the next word', () => {
  assert.equal(A.keyWords('hold ⌘ to click', false), 'hold Ctrl to click');
  assert.equal(A.keyWords('⌘Click opens a tab', false), 'CtrlClick opens a tab');
});

test('on a Mac the glyphs stay', () => {
  assert.equal(A.keyWords('press ⌥ Space', true), 'press ⌥ Space');
});

test('a question that needs an answer says what, the choices and the keys', () => {
  const said = A.approvalWords(
    { question: 'Send this email to Ann?', detail: 'Subject: **Lunch**', choices: [{ label: 'Send' }, { label: 'Don’t send' }] },
    { yes: 'Alt Shift Y', no: 'Alt Shift N' },
  );
  assert.match(said, /^Needs your OK\. Send this email to Ann\?/);
  assert.match(said, /Subject: Lunch\./);
  assert.match(said, /Choices: 1, Send; 2, Don’t send\./);
  assert.match(said, /Press Alt Shift Y for Send, Alt Shift N to say no, or Tab to the buttons\./);
});

test('a question with one choice has no “no” key', () => {
  const said = A.approvalWords({ question: 'Continue?', choices: [{ label: 'OK' }] }, { yes: 'Alt Shift Y', no: 'Alt Shift N' });
  assert.doesNotMatch(said, /to say no/);
});

test('every sound is a few short notes', () => {
  for (const [name, notes] of Object.entries(A.CUES)) {
    assert.ok(notes.length >= 1 && notes.length <= 5, name);
    const seconds = notes.reduce((sum, [, d]) => sum + d, 0);
    assert.ok(seconds > 0.04 && seconds < 0.6, `${name} lasts ${seconds}s`);
    for (const [freq] of notes) assert.ok(freq === 0 || (freq >= 150 && freq <= 2500), name);
  }
  for (const name of ['listening', 'thinking', 'done', 'approval', 'error']) assert.ok(A.CUES[name], name);
});

test('the window’s words about a Mac are said about a PC, and a Mac keeps its own', () => {
  assert.equal(A.pcWords('Control my Mac without asking', false), 'Control my PC without asking');
  assert.equal(A.pcWords('Kept in the macOS Keychain, in Finder', false), 'Kept in the Windows password store, in File Explorer');
  assert.equal(A.pcWords('Spotlight and the menu bar', false), 'search and the system tray');
  assert.equal(A.pcWords('a MacBook, Machine, Macro', false), 'a MacBook, Machine, Macro');
  assert.equal(A.pcWords('Open System Settings › Privacy & Security › Microphone.', false), 'Open Settings › Privacy & security › Microphone.');
  assert.equal(A.pcWords('Control my Mac', true), 'Control my Mac');
});

test('the edition has its name', () => {
  assert.equal(A.EDITION, 'J.A.R.V.I.S. Daredevil');
});

test('the keys a PC talks on read as the keys', () => {
  assert.equal(A.keyWords('⌃⌥J', false), 'Ctrl+Alt+J');
  assert.equal(A.keyWords('Say “Hey Jarvis” · ⌃⌥J talk', false), 'Say “Hey Jarvis” · Ctrl+Alt+J talk');
  assert.equal(A.keyWords('⌃⌥J', true), '⌃⌥J');
});
