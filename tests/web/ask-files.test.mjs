// Documents in the main chat (web/features/ask-files.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const files = require('../../src/jarvis/web/features/ask-files.js');

test('PDFs and text files are taken; pictures stay with the window', () => {
  assert.equal(files.kindOf('lease.pdf', ''), 'pdf');
  assert.equal(files.kindOf('x', 'application/pdf'), 'pdf');
  assert.equal(files.kindOf('notes.md', ''), 'text');
  assert.equal(files.kindOf('data.csv', 'text/csv'), 'text');
  assert.equal(files.kindOf('main.swift', ''), 'text');
  assert.equal(files.kindOf('shot.png', 'image/png'), '');
  assert.equal(files.kindOf('movie.mov', 'video/quicktime'), '');
});

test('a document shows as a page with its extension', () => {
  const url = files.iconUrl('report.pdf');
  assert.ok(url.startsWith('data:image/svg+xml;utf8,'));
  assert.ok(decodeURIComponent(url).includes('>PDF<'));
  assert.ok(!decodeURIComponent(files.iconUrl('a"<b>.js')).includes('<b>'));
});
