// Eden Code's artifacts (web/features/code-artifacts.js): what the pane shows a version from,
// the names a download gets, and which inline code blocks can open as artifacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../../src/jarvis/web/features/code-artifacts.js');

test('a version is shown from the window’s own server, by a real id only', () => {
  const aid = 'a'.repeat(24);
  assert.equal(A.frameSrc(aid, 3), `/f/code-artifacts/${aid}/3`);
  assert.equal(A.frameSrc('../../etc/passwd', 1), '');
  assert.equal(A.frameSrc(`${aid}/x`, 1), '');
  assert.equal(A.frameSrc(aid, 0), '');
  assert.equal(A.frameSrc(aid, 'x'), '');
});

test('a download’s name: the title made safe, the kind’s extension', () => {
  assert.equal(A.fileName('Shop / mockup: v2', 'html'), 'Shop mockup v2.html');
  assert.equal(A.fileName('Counter app', 'react'), 'Counter app.jsx');
  assert.equal(A.fileName('Flow', 'mermaid'), 'Flow.mmd');
  assert.equal(A.fileName('../../x', 'svg'), '.. .. x.svg');
  assert.equal(A.fileName('', 'markdown'), 'artifact.md');
  assert.equal(A.fileName('Café', 'other'), 'Café.txt');
});

test('detects runnable code blocks in chat replies', () => {
  assert.equal(A.detectBlockKind('html', '<!doctype html><html><body><h1>Hi</h1></body></html>'), 'html');
  assert.equal(A.detectBlockKind('jsx', 'export default function App() { return <div>Hello</div>; }'), 'react');
  assert.equal(A.detectBlockKind('svg', '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>'), 'svg');
  assert.equal(A.detectBlockKind('mermaid', 'flowchart TD\n  A[Start] --> B[End]'), 'mermaid');
  assert.equal(A.detectBlockKind('python', 'print("hello world from python")'), '');
});
