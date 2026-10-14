// Eden Code's window for the keyboard and screen readers (Daredevil depends on it), and the
// CSS fixes that go with it, checked in the source (the real look is checked in the app):
// the transcript is a quiet log with one short live status line; every field has a name;
// the panes' toggles are buttons that say their state; status glyphs are read as words;
// the notices' stack never swallows clicks; the editing bubble, the PR base picker and the
// menus in a browser tab are readable; the effort sliders show the keyboard focus.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const web = (f) => readFileSync(new URL(`../../src/jarvis/web/${f}`, import.meta.url), 'utf8');
const html = web('index.html');

// ── A1, A2: the transcript and the composer ──

test('the transcript is a log that is not read as it streams; the composer has a name', () => {
  const timeline = html.match(/<ol id="deck-timeline"[^>]*>/)[0];
  assert.match(timeline, /role="log"/);
  assert.match(timeline, /aria-live="off"/);
  assert.match(timeline, /aria-label="Transcript"/);
  assert.match(html, /<textarea id="deck-input"[^>]*aria-label="Message Eden Code"/);
});

test('the status line says a finished turn once, in short', () => {
  const { finishedLine } = require('../../src/jarvis/web/features/code-a11y.js');
  const done = { id: 7, task_kind: 'code', status: 'done', files: ['a.py', 'b.py', 'c.py'], label: 'Fix login' };
  assert.equal(finishedLine(done, 7), 'Eden Code finished: 3 files changed.');
  assert.equal(finishedLine({ ...done, files: ['a.py'] }, 7), 'Eden Code finished: 1 file changed.');
  assert.equal(finishedLine({ ...done, files: [] }, 7), 'Eden Code finished.');
  assert.equal(finishedLine(done, 2), 'Eden Code (Fix login) finished: 3 files changed.');  // another session's
  assert.equal(finishedLine({ ...done, status: 'failed' }, 7), 'Eden Code stopped with an error.');
  assert.equal(finishedLine({ ...done, status: 'stopped' }, 7), '');  // the owner stopped it
  assert.equal(finishedLine({ ...done, task_kind: 'research' }, 7), '');
  assert.equal(finishedLine(null, 7), '');
  const zh = JSON.parse(web('i18n/code-a11y.json'));
  for (const [pattern] of zh.patterns) assert.ok(new RegExp(pattern).test(finishedLine(done, 2)) || pattern, pattern);
  assert.ok(zh.patterns.some(([p]) => new RegExp(p).test(finishedLine(done, 2))));
  assert.ok(zh.patterns.some(([p]) => new RegExp(p).test(finishedLine(done, 7))));
});

// ── A4: the panes ──

const PANES = ['code_changes.js', 'code_git.js', 'code-verify.js', 'code_pr.js', 'code-board.js', 'code-sessions.js', 'code-cloud.js'];

test('every field in the panes has a name of its own, not only a placeholder', () => {
  for (const file of PANES) {
    const src = web(`features/${file}`);
    for (const [, name] of src.matchAll(/\b(\w+)\.placeholder = /g)) {
      // (an aria-label, or a <label> round it: labelled('Name', nameIn))
      assert.match(src, new RegExp(`\\b${name}\\.setAttribute\\('aria-label'|labelled\\('[^']+', ${name}\\)`), `${file}: ${name} has only a placeholder`);
    }
  }
});

test('the panes’ toggles say their state, and are reached by the keyboard', () => {
  const changes = web('features/code_changes.js');
  assert.doesNotMatch(changes, /'role', 'tab'/);  // (tabs promise arrow keys and panels)
  assert.match(changes, /seg\.setAttribute\('role', 'group'\)/);
  assert.match(changes, /b\.setAttribute\('aria-pressed', String\(id === view\)\)/);
  const git = web('features/code_git.js');
  assert.match(git, /const name = el\('button', 'jcx-gpath', file\.path\);/);
  assert.match(git, /name\.setAttribute\('aria-expanded', String\(state\.open\.has\(id\)\)\)/);
  assert.match(web('features/code_git.css'), /\.deck\.jc button\.jcx-gpath:focus-visible \{ outline: 2px solid/);
  const board = web('features/code-board.js');
  assert.match(board, /cards\.setAttribute\('role', 'list'\)/);
  assert.match(board, /card\.setAttribute\('role', 'listitem'\)/);
  assert.match(board, /if \(hadFocus\) toggle\.focus\(\)/);  // closing never loses the focus
  const verify = web('features/code-verify.js');
  assert.match(verify, /if \(back && back\.isConnected && typeof back\.focus === 'function'\) back\.focus\(\);/);
});

test('status glyphs are read as words', () => {
  const { markWord } = require('../../src/jarvis/web/features/code-verify.js');
  assert.deepEqual(['passed', 'failed', 'running', 'error', 'warning', 'skipped', undefined].map(markWord),
    ['Passed', 'Failed', 'Running', 'Error', 'Warning', 'Skipped', 'Skipped']);
  const verify = web('features/code-verify.js');
  assert.doesNotMatch(verify, /el\('span', `cv-(mark|sev) /);  // (each goes through mark())
  const zh = JSON.parse(web('i18n/code-verify.json')).strings;
  for (const w of ['Passed', 'Error', 'Warning']) assert.ok(zh[w], w);
});

// ── the CSS fixes (U1, U2, U3, U5, A3) ──

test('U1: the notices’ stack sits top right over Eden Code and never takes a click itself', () => {
  assert.match(web('eden-code.css'), /body\.eden-code:has\(> #cc:not\(\[hidden\]\)\) #cards \{ top: 76px; right: 24px; left: auto; bottom: auto; \}/);
  const css = web('app.css');
  assert.match(css, /\.cards \{ pointer-events: none; \}\n\.cards > \* \{ pointer-events: auto; \}/);
  assert.doesNotMatch(css, /\.cards:empty \{ display: none/);  // (kept: a live region a reader knows)
});

test('U2: the bubble being edited is a card with ink text, its buttons too', () => {
  const css = web('features/code-sessions.css');
  assert.match(css, /body:not\(\[data-skin\]\) \.jc-user\.cs-editing \{ background: var\(--eden-content\); color: var\(--eden-text\);/);
  assert.match(css, /\.jc-user\.cs-editing \.cs-editor-row \.jc-btn:not\(\.filled\) \{ color: rgb\(var\(--c-ink\)\); \}/);
  // (both tokens have their dark twins)
  const eden = web('eden-code.css');
  assert.equal((eden.match(/--eden-content:/g) || []).length, 2);
});

test('U3: the pull request’s base branch picker is wide enough for its name', () => {
  assert.match(web('features/code_pr.css'), /\.jcx-pr-base \.jcs-select \{ font: 12px var\(--mono\); max-width: min\(260px, 50vw\); \}/);
});

test('U5: in a browser tab the menus are all but opaque, light and dark', () => {
  const css = web('app.css');
  assert.match(css, /html:not\(\[data-contrast\]\) body:not\(\.in-app\) \.jc-menu \{ background: rgb\(250 250 252 \/ 0\.94\); \}/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n  html:not\(\[data-contrast\]\) body:not\(\.in-app\) \.jc-menu \{ background: rgb\(44 44 50 \/ 0\.94\); \}/);
});

test('A3: the effort sliders show the keyboard focus, after the rule that drew the thumb', () => {
  const css = web('app.css');
  const thumb = css.indexOf('.jc-slider #ep-range::-webkit-slider-thumb, .jc-slider #jcs-effort::-webkit-slider-thumb {');
  const focus = css.indexOf('.jc-slider #ep-range:focus-visible::-webkit-slider-thumb');
  assert.ok(thumb > 0 && focus > thumb, 'the focus ring must come after (and so win over) the thumb rule');
  assert.match(css, /\.jc-slider:has\(> input:focus-visible\) \{ outline: 2px solid rgb\(var\(--c-accent\) \/ 0\.8\);/);
});
