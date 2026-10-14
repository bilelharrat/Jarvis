// The fleet for screen readers and the keyboard alone (F16): the agent board read as lists of
// cards that each say who, where it stands and what it does or asks; the arrows between
// cards; ⌥⌘↓/↑ between sessions (web/features/code-board.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const board = require('../../src/jarvis/web/features/code-board.js');
const source = readFileSync(new URL('../../src/jarvis/web/features/code-board.js', import.meta.url), 'utf8');

test('a card says in one line which session, where it stands and what it does or asks', () => {
  const { cardSpeech } = board;
  const task = { id: 3, title: 'Add a retry', folder: 'jarvis', busy: true, last_action: 'Editing hub.py', files_changed: ['a', 'b'] };
  assert.equal(cardSpeech(task, 'working', null, { branch: 'main', added: 10, removed: 3 }),
    'Session 3, Add a retry, working: Editing hub.py. jarvis, branch main. 2 files, 10 lines added, 3 removed.');
  const ask = { question: 'Eden Code in jarvis wants to run a command' };
  assert.equal(cardSpeech({ ...task, files_changed: [] }, 'needs', ask),
    'Session 3, Add a retry, needs you: Eden Code in jarvis wants to run a command. jarvis.');
  assert.equal(cardSpeech({ id: 4, prompt: 'Fix it\nand more', folder: 'web', busy: false, status: 'waiting', result: 'Fixed.' }, 'done'),
    'Session 4, Fix it, done: Fixed. web.');
  assert.match(cardSpeech({ id: 5, folder: 'x', busy: false, status: 'resting' }, 'resting'), /^Session 5, New session, resting: Resting/);
});

test('the arrows move between cards in a lane and across lanes, skipping empty ones', () => {
  const { moveIn } = board;
  const lanes = [[7], [5, 4, 2], [], [1], []];
  assert.deepEqual(moveIn(lanes, { lane: 1, index: 0 }, 'ArrowDown'), { lane: 1, index: 1 });
  assert.deepEqual(moveIn(lanes, { lane: 1, index: 2 }, 'ArrowDown'), { lane: 1, index: 2 });  // stays at the end
  assert.deepEqual(moveIn(lanes, { lane: 1, index: 0 }, 'ArrowUp'), { lane: 1, index: 0 });
  assert.deepEqual(moveIn(lanes, { lane: 1, index: 2 }, 'ArrowRight'), { lane: 3, index: 0 });  // over the empty lane
  assert.deepEqual(moveIn(lanes, { lane: 1, index: 2 }, 'ArrowLeft'), { lane: 0, index: 0 });
  assert.deepEqual(moveIn(lanes, { lane: 3, index: 0 }, 'ArrowRight'), { lane: 3, index: 0 });  // the last lane
  assert.deepEqual(moveIn(lanes, { lane: 1, index: 1 }, 'End'), { lane: 1, index: 2 });
  assert.deepEqual(moveIn(lanes, { lane: 1, index: 2 }, 'Home'), { lane: 1, index: 0 });
  assert.equal(moveIn(lanes, { lane: 1, index: 0 }, 'a'), null);
  assert.equal(moveIn([[], []], { lane: 0, index: 0 }, 'ArrowDown'), null);
});

test('⌥⌘↓/↑ go round the sessions in the board order', () => {
  const { nextSession } = board;
  assert.equal(nextSession([3, 9, 1], 9, 1), 1);
  assert.equal(nextSession([3, 9, 1], 1, 1), 3);  // round the end
  assert.equal(nextSession([3, 9, 1], 3, -1), 1);
  assert.equal(nextSession([3, 9, 1], null, 1), 3);
  assert.equal(nextSession([3, 9, 1], null, -1), 1);
  assert.equal(nextSession([], 3, 1), null);
});

test('the board is drawn as lists of list items, one card in the Tab order', () => {
  assert.match(source, /cards\.setAttribute\('role', 'list'\)/);
  assert.match(source, /card\.setAttribute\('role', 'listitem'\)/);
  assert.match(source, /card\.setAttribute\('aria-label', cardSpeech\(/);
  assert.match(source, /card\.tabIndex = task\.id === B\.focusId \? 0 : -1/);
  // An approval answered from the keys is the card's own button pressed: its checks stay.
  assert.match(source, /pressed\.click\(\)/);
});
