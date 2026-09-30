// Notarization and stapling: the owner's steps, with the credentials they stored once with
// `xcrun notarytool store-credentials <profile> …` (JARVIS_NOTARY_PROFILE names it). Apple
// checks what's submitted, and --wait keeps us here for its verdict; a rejection prints
// Apple's log of why. Stapling puts the ticket on the app (or the disk image), so Gatekeeper
// accepts it without asking Apple over the network.
'use strict';

const path = require('path');
const { BuildError, run, say } = require('./util');

// notarytool's JSON answer, from its output (it can print a progress line or two first).
function parseSubmission(text) {
  for (const line of String(text).trim().split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { return JSON.parse(trimmed); } catch { /* not the answer */ }
  }
  try { return JSON.parse(text); } catch { return null; }
}

// runner: util.run, or a stand-in in tests (nothing here is ever sent from a test).
function notarize(file, profile, { runner = run } = {}) {
  say(`  submitting ${path.basename(file)} to Apple's notary service (this waits for the verdict)`);
  const done = runner('/usr/bin/xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { allowFail: true });
  const answer = parseSubmission(done.stdout);
  if (answer && answer.status === 'Accepted') {
    say(`  accepted (${answer.id})`);
    return answer;
  }
  if (!answer || !answer.id) {
    throw new BuildError(`notarytool couldn't submit ${path.basename(file)}:\n${(done.stderr || done.stdout).trim().slice(-1500)}`);
  }
  // Apple's own account of each problem, file by file.
  const log = runner('/usr/bin/xcrun', ['notarytool', 'log', answer.id, '--keychain-profile', profile], { allowFail: true });
  console.error(log.stdout || log.stderr);
  throw new BuildError(`Apple didn't notarize ${path.basename(file)}: ${answer.status}${answer.message ? ` (${answer.message})` : ''}. Its log is above (notarytool log ${answer.id}).`);
}

function staple(file, { runner = run } = {}) {
  runner('/usr/bin/xcrun', ['stapler', 'staple', file]);
  runner('/usr/bin/xcrun', ['stapler', 'validate', file]);
  say(`  stapled ${path.basename(file)}`);
}

// The app goes to Apple as a zip that keeps its symlinks and signatures (ditto, not zip).
function zipApp(app, zip) {
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  return zip;
}

module.exports = { notarize, staple, zipApp, parseSubmission };
