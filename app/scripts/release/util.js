// Small things every step of the dist build shares: running a command (its output kept in
// the build log), hashing, copying and a clear failure.
'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class BuildError extends Error {}

let logFile = null;
function setLog(file) {
  logFile = file;
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
}
function log(line) {
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
}
function say(line) {
  console.log(line);
  log(line);
}

// Runs a command to the end: {status, stdout, stderr}. Throws BuildError when it fails,
// unless allowFail. Arguments are never put through a shell.
function run(command, args, { cwd, env, allowFail = false, input, quiet = false } = {}) {
  log(`$ ${[command, ...args].map((a) => (/[\s'"$]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const done = spawnSync(command, args, {
    cwd, env: env || process.env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  const stdout = done.stdout || '';
  const stderr = done.stderr || '';
  if (!quiet) {
    if (stdout.trim()) log(stdout.trimEnd());
    if (stderr.trim()) log(stderr.trimEnd());
  }
  if (done.error) {
    if (allowFail) return { status: -1, stdout, stderr: String(done.error.message) };
    throw new BuildError(`${command} couldn't run: ${done.error.message}`);
  }
  if (done.status !== 0 && !allowFail) {
    const tail = (stderr.trim() || stdout.trim()).split('\n').slice(-12).join('\n');
    throw new BuildError(`${command} ${args.slice(0, 3).join(' ')} failed (exit ${done.status}):\n${tail}`);
  }
  return { status: done.status, stdout, stderr };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// A folder copied as macOS apps need it: symlinks kept as symlinks, modes kept.
function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  run('/usr/bin/ditto', [from, to]);
}

function sizeOf(root) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  };
  if (fs.statSync(root).isDirectory()) walk(root);
  else total = fs.statSync(root).size;
  return total;
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

module.exports = { BuildError, setLog, log, say, run, sha256File, sha256Text, copyTree, sizeOf, megabytes };
