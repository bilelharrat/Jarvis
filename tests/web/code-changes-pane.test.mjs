// The Changes pane is the code_changes feature's alone (web/features/code_changes.js):
// app.js's old one, which built every file's diff even while collapsed and was shadowed by
// the feature's pane, is gone. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const WEB = new URL('../../src/jarvis/web/', import.meta.url);

test('Changes is drawn by its feature, not by an old copy in app.js', () => {
  const app = readFileSync(new URL('app.js', WEB), 'utf8');
  const feature = readFileSync(new URL('features/code_changes.js', WEB), 'utf8');
  assert.match(feature, /F\.registerPane\('diff', \{/);
  assert.doesNotMatch(app, /function renderDiffPane|renderDiffPane\(/);
  // (feature panes are drawn before app.js's own: one registered for 'diff' always wins)
  assert.match(app, /const featurePane = featurePanes\.get\(currentPane\);\n\s*if \(featurePane\) return featurePane\.render\(body, t\);/);
});
