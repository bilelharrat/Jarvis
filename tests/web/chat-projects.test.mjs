// Projects for the main chat (web/features/chat-projects.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const h = require('../../src/jarvis/web/features/chat-projects.js');

const listing = {
  active: 'b',
  current: 's2',
  items: [
    { id: 'a', name: 'Trip', conversations: [{ session_id: 's1' }] },
    { id: 'b', name: 'Launch', conversations: [{ session_id: 's2' }] },
  ],
};

test('the chip names the open project', () => {
  assert.equal(h.chipLabel(listing), 'Launch');
  assert.equal(h.chipLabel({ ...listing, active: '' }), '');
  assert.equal(h.chipLabel(null), '');
});

test('the project a conversation is in', () => {
  assert.equal(h.projectOf(listing, 's1').id, 'a');
  assert.equal(h.projectOf(listing, 'zz'), null);
  assert.equal(h.projectOf(listing, ''), null);
});

test('projects keep PDFs and text, not pictures', () => {
  assert.equal(h.kindOf('report.pdf', ''), 'pdf');
  assert.equal(h.kindOf('notes.md', ''), 'text');
  assert.equal(h.kindOf('data', 'application/json'), 'text');
  assert.equal(h.kindOf('photo.png', 'image/png'), '');
  assert.equal(h.kindOf('archive.zip', 'application/zip'), '');
});

test('sizes read short', () => {
  assert.equal(h.size(950), '950');
  assert.equal(h.size(12400), '12k');
});
